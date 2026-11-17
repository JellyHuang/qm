import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthorAliases, type AuthorAlias } from "../src/zq/git-mcp/author-aliases.ts";
import { classifyAuthor, createAuthorResolver, type AuthorClass, type MatchedBy } from "../src/zq/git-mcp/authors.ts";
import {
  createMemoryPeopleDirectory,
  createMattermostPeopleDirectory,
  normaliseEmail,
} from "../src/zq/git-mcp/people.ts";
import { memoryMap } from "./support/memory-map.ts";

const rules = {
  externalDomains: ["@pipeline.invalid", "partner.example"],
  botNames: ["ExampleBot.compiler", "jenkins"],
};

const zhang = { personId: "p-zhang", mattermostUser: "mm-zhang" };
const li = { personId: "p-li", mattermostUser: "mm-li" };
const wang = { personId: "p-wang", mattermostUser: "mm-wang" };

const directory = createMemoryPeopleDirectory([
  { emails: ["zhang@corp.example"], person: zhang },
  { emails: ["Li@Corp.Example"], person: li },
  { emails: ["wang@corp.example", "w@corp.example"], person: wang },
  { emails: ["shared@corp.example"], person: zhang },
  { emails: ["shared@corp.example"], person: li },
]);

function fixture() {
  const aliases = createAuthorAliases({ map: memoryMap<AuthorAlias>(), now: () => 1 });
  const resolver = createAuthorResolver({
    rules,
    directory,
    aliases,
    domainAliases: { "old.example": "corp.example" },
  });
  return { aliases, resolver };
}

const person = (p: typeof zhang, matchedBy: MatchedBy): AuthorClass => ({
  kind: "person",
  ...p,
  matchedBy,
});

const table: Array<[string, { email: string; name?: string }, AuthorClass]> = [
  [
    "bot by name",
    { name: "ExampleBot.compiler", email: "x@corp.example" },
    { kind: "bot", name: "ExampleBot.compiler" },
  ],
  [
    "bot by local part",
    { name: "Someone", email: "examplebot.compiler@corp.example" },
    { kind: "bot", name: "Someone" },
  ],
  ["bot by local part with plus tag", { name: "", email: "jenkins+ci@corp.example" }, { kind: "bot", name: "jenkins" }],
  [
    "external domain",
    { name: "Wang", email: "wang@pipeline.invalid" },
    { kind: "external", domain: "pipeline.invalid" },
  ],
  [
    "external sub-domain and case",
    { name: "Li", email: "Li@Dev.Partner.Example" },
    { kind: "external", domain: "dev.partner.example" },
  ],
  ["company email", { email: "zhang@corp.example" }, person(zhang, "email")],
  ["company email in other case", { email: " ZHANG@Corp.EXAMPLE " }, person(zhang, "email")],
  ["directory email stored in mixed case", { email: "li@corp.example" }, person(li, "email")],
  ["plus addressing", { email: "zhang+build@corp.example" }, person(zhang, "email")],
  ["second address of the same person", { email: "w@corp.example" }, person(wang, "email")],
  [
    "gmail style dots are not folded",
    { email: "zh.ang@corp.example", name: "Z" },
    { kind: "unmapped", email: "zh.ang@corp.example", name: "Z", reason: "no_match" },
  ],
  ["domain alias", { email: "zhang@old.example" }, person(zhang, "domain_alias")],
  [
    "not a notifiable suffix match",
    { email: "zhang@notpartner.example", name: "Z" },
    { kind: "unmapped", email: "zhang@notpartner.example", name: "Z", reason: "no_match" },
  ],
  [
    "unknown",
    { email: "nobody@corp.example", name: "N" },
    { kind: "unmapped", email: "nobody@corp.example", name: "N", reason: "no_match" },
  ],
  [
    "no at sign",
    { email: "nobody", name: "x" },
    { kind: "unmapped", email: "nobody", name: "x", reason: "invalid_email" },
  ],
  [
    "two people share the address",
    { email: "shared@corp.example" },
    { kind: "ambiguous", email: "shared@corp.example", candidates: [zhang, li] },
  ],
];

for (const [name, author, expected] of table)
  test(`classification: ${name}`, async () => {
    assert.deepEqual(await fixture().resolver.resolve(author), expected);
  });

test("normalisation lower-cases, trims and drops plus tags only", () => {
  assert.equal(normaliseEmail("  A.B+tag@Corp.Example "), "a.b@corp.example");
  assert.equal(normaliseEmail("a@b+c.example"), "a@b+c.example");
});

test("the classifier alone leaves company addresses to the mapping stage", () => {
  assert.equal(classifyAuthor({ name: "Zhang", email: "zhang@corp.example" }, rules), undefined);
});

test("an alias maps an extra commit address and removing it unmaps the author again", async () => {
  const { aliases, resolver } = fixture();
  const author = { email: "Zhang.Private@Example.org", name: "Zhang" };
  assert.equal((await resolver.resolve(author)).kind, "unmapped");
  await aliases.add("zhang.private@example.org", zhang, "pm");
  await aliases.add("ZHANG.PRIVATE@example.org", zhang, "pm");
  assert.equal((await aliases.list()).length, 1);
  assert.deepEqual(await resolver.resolve(author), person(zhang, "alias"));
  await aliases.remove("zhang.private@example.org", zhang.personId);
  assert.equal((await resolver.resolve(author)).kind, "unmapped");
});

test("two people sharing an alias make the author ambiguous", async () => {
  const { aliases, resolver } = fixture();
  await aliases.add("team@example.org", zhang, "pm");
  await aliases.add("team@example.org", li, "pm");
  assert.deepEqual(await resolver.resolve({ email: "team@example.org" }), {
    kind: "ambiguous",
    email: "team@example.org",
    candidates: [li, zhang],
  });
});

test("an address that matches the directory wins over an alias", async () => {
  const { aliases, resolver } = fixture();
  await aliases.add("zhang@corp.example", li, "pm");
  assert.deepEqual(await resolver.resolve({ email: "zhang@corp.example" }), person(zhang, "email"));
});

test("the Mattermost adapter asks for the normalised address and de-duplicates user ids", async () => {
  const asked: string[] = [];
  const adapter = createMattermostPeopleDirectory(async (email) => {
    asked.push(email);
    return ["u1", "u1", "u2"];
  });
  assert.deepEqual(await adapter.findByEmail(" Zhang+x@Corp.Example"), [
    { personId: "u1", mattermostUser: "u1" },
    { personId: "u2", mattermostUser: "u2" },
  ]);
  assert.deepEqual(asked, ["zhang@corp.example"]);
});

test("an alias must be an email address", async () => {
  await assert.rejects(fixture().aliases.add("nobody", zhang, "pm"), /email address/);
});
