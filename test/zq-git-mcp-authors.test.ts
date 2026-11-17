import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthorAliases, type AuthorAlias, type IgnoreReason } from "../src/zq/git-mcp/author-aliases.ts";
import { createAuthorResolver, type AuthorClass } from "../src/zq/git-mcp/authors.ts";
import { encodeNameId, nameKey, normaliseEmail } from "../src/zq/git-mcp/names.ts";
import {
  createMattermostPeopleDirectory,
  createMemoryPeopleDirectory,
  type PeopleDirectory,
} from "../src/zq/git-mcp/people.ts";
import { memoryMap } from "./support/memory-map.ts";

const rules = {
  externalDomains: ["@partnerco", "partner.example"],
  botNames: ["dependabot"],
  botTokens: ["bot"],
};

const alice = { personId: "p-alice", mattermostUser: "mm-alice" };
const bob = { personId: "p-bob", mattermostUser: "mm-bob" };
const carol = { personId: "p-carol", mattermostUser: "mm-carol" };

function fixture(options: { directory?: PeopleDirectory; rules?: typeof rules } = {}) {
  const aliases = createAuthorAliases({ map: memoryMap<AuthorAlias>(), now: () => 1 });
  const resolver = createAuthorResolver({
    rules: options.rules ?? rules,
    aliases,
    ...(options.directory ? { directory: options.directory } : {}),
  });
  const bind = (name: string, person = alice, extra: { emailCondition?: string; departedAt?: number } = {}) =>
    aliases.insert({ kind: "person", name, ...person, ...extra, addedBy: "pm" });
  const ignore = (name: string, reason: IgnoreReason = "automation", emailCondition?: string) =>
    aliases.insert({
      kind: "ignored",
      name,
      reason,
      ...(emailCondition ? { emailCondition } : {}),
      addedBy: "pm",
    });
  return { aliases, resolver, bind, ignore };
}

const byName = (p: typeof alice, extra: object = {}): AuthorClass => ({
  kind: "person",
  matchedBy: "name",
  ...p,
  ...extra,
});

test("pinyin and CJK names bound to one person both map to them, a third spelling does not", async () => {
  const { resolver, bind } = fixture();
  await bind("Alice Example");
  await bind("艾丽丝");
  assert.deepEqual(await resolver.resolve({ name: "艾丽丝", email: "a@personal.example" }), byName(alice));
  assert.deepEqual(await resolver.resolve({ name: "Alice Example", email: "alice@x.example" }), byName(alice));
  assert.equal((await resolver.resolve({ name: "Alice-Example", email: "alice@x.example" })).kind, "unmapped");
});

test("full-width, case, whitespace and invisible-character variants of a name map the same", async () => {
  const { resolver, bind } = fixture();
  await bind("alice example");
  for (const name of [
    "ＡＬＩＣＥ  EXAMPLE",
    "  Alice\t Example ",
    "ALICE EXAMPLE",
    "Alice​ Exam﻿ple",
    "Alice　Example",
  ])
    assert.deepEqual(await resolver.resolve({ name, email: "x@y.example" }), byName(alice), JSON.stringify(name));
});

test("first-l, first_l and first.l are three different names", async () => {
  const { resolver, bind } = fixture();
  await bind("first-l", alice);
  await bind("first_l", bob);
  assert.deepEqual(await resolver.resolve({ name: "first-l", email: "x@y.example" }), byName(alice));
  assert.deepEqual(await resolver.resolve({ name: "first_l", email: "x@y.example" }), byName(bob));
  assert.equal((await resolver.resolve({ name: "first.l", email: "x@y.example" })).kind, "unmapped");
});

test("a DOMAIN prefix is kept: the plain name does not match the prefixed one and the prefixed binding does", async () => {
  const { resolver, bind } = fixture();
  await bind("alice.e");
  assert.equal((await resolver.resolve({ name: "ACME\\alice.e", email: "x@y.example" })).kind, "unmapped");
  await bind("ACME\\alice.e");
  assert.deepEqual(await resolver.resolve({ name: "acme\\ALICE.e", email: "x@y.example" }), byName(alice));
});

test("a renamed duplicate maps to its own person and the plain name to the other", async () => {
  const { resolver, bind } = fixture();
  await bind("justin", alice);
  await bind("justin01", bob);
  assert.deepEqual(await resolver.resolve({ name: "Justin", email: "j@x.example" }), byName(alice));
  assert.deepEqual(await resolver.resolve({ name: "justin01", email: "j@x.example" }), byName(bob));
});

test("a name has one row: a second bind of the same normalised name is rejected by the store", async () => {
  const { aliases, bind } = fixture();
  assert.equal(await bind("Alice Example", alice), true);
  assert.equal(await bind("ALICE  example", bob), false);
  assert.deepEqual(
    (await aliases.list()).map((row) => [row.nameKey, row.kind === "person" ? row.personId : ""]),
    [["alice example", "p-alice"]],
  );
});

test("row ids escape the separator and the escape character", () => {
  assert.equal(encodeNameId(nameKey("A|B%C")), "a%7Cb%25c");
});

test("a row with an email condition that does not match falls through to the next rule", async () => {
  const { resolver, bind } = fixture();
  await bind("host123\\admin", alice, { emailCondition: "x@y.example" });
  assert.deepEqual(await resolver.resolve({ name: "HOST123\\admin", email: "X@Y.example" }), byName(alice));
  const other = await resolver.resolve({ name: "HOST123\\admin", email: "z@y.example" });
  assert.deepEqual(other, { kind: "unmapped", email: "z@y.example", name: "HOST123\\admin", reason: "no_match" });
});

test("a malformed email with a bound name maps, unbound goes to the queue as invalid_email and is never external", async () => {
  const { resolver, bind } = fixture();
  await bind("eve");
  for (const email of ["@partnerco", "eve", "", "eve@", "a@b@c"])
    assert.deepEqual(await resolver.resolve({ name: "Eve", email }), byName(alice), email);
  for (const email of ["@partnerco", "frank", "", "frank@", "@"]) {
    const result = await resolver.resolve({ name: "Frank", email });
    assert.equal(result.kind, "unmapped", email);
    assert.equal(result.kind === "unmapped" && result.reason, "invalid_email", email);
  }
});

test("a usable email in an external domain is dropped unless the name is bound", async () => {
  const { resolver, bind } = fixture();
  assert.deepEqual(await resolver.resolve({ name: "Frank", email: "f@dev.partner.example" }), {
    kind: "external",
    domain: "dev.partner.example",
  });
  assert.equal((await resolver.resolve({ name: "Frank", email: "f@notpartner.example" })).kind, "unmapped");
  await bind("frank");
  assert.deepEqual(await resolver.resolve({ name: "Frank", email: "f@partnerco" }), byName(alice));
});

const botTable: Array<[string, string, string, "bot" | "unmapped"]> = [
  ["ExampleBot.compiler", "ExampleBot.compiler", "x@corp.example", "bot"],
  ["jenkins-bot", "jenkins-bot", "x@corp.example", "bot"],
  ["bot-deploy", "bot-deploy", "x@corp.example", "bot"],
  ["build.bot@corp.example", "Someone", "build.bot@corp.example", "bot"],
  ["Abbott", "Abbott", "x@corp.example", "unmapped"],
  ["Talbot", "Talbot", "x@corp.example", "unmapped"],
  ["Botha", "Botha", "x@corp.example", "unmapped"],
  ["Robotham", "Robotham", "x@corp.example", "unmapped"],
  ["Bob", "Bob", "x@corp.example", "unmapped"],
  ["uppercase BOT", "BOT", "x@corp.example", "bot"],
  ["bracket form", "renovate[bot]", "x@corp.example", "bot"],
  ["digit boundary", "build2bot", "x@corp.example", "bot"],
  ["fused lower", "dependabotx", "x@corp.example", "unmapped"],
  ["fused upper", "EXAMPLEBOT", "x@corp.example", "unmapped"],
  ["exact list entry", "Dependabot", "x@corp.example", "bot"],
  ["domain is ignored", "Ann", "ann@bot.example.com", "unmapped"],
];

for (const [label, name, email, expected] of botTable)
  test(`bot rule: ${label} is ${expected}`, async () => {
    const result = await fixture().resolver.resolve({ name, email });
    assert.equal(result.kind, expected);
  });

test("an empty token list turns the token rule off but keeps the exact list", async () => {
  const { resolver } = fixture({ rules: { ...rules, botTokens: [] } });
  assert.equal((await resolver.resolve({ name: "ExampleBot.compiler", email: "x@corp.example" })).kind, "unmapped");
  assert.equal((await resolver.resolve({ name: "dependabot", email: "x@corp.example" })).kind, "bot");
});

test("a bound bot-looking name beats the rule, and an unbound bot sharing a departed person's email stays a bot", async () => {
  const people = createMemoryPeopleDirectory([{ emails: ["dana@corp.example"], person: carol }]);
  const { resolver, bind } = fixture({ directory: people });
  await bind("Dana Example", carol, { departedAt: 5 });
  assert.deepEqual(await resolver.resolve({ name: "ExampleBot.compiler", email: "dana@corp.example" }), {
    kind: "bot",
    name: "ExampleBot.compiler",
  });
  await bind("ExampleBot.compiler", bob);
  assert.deepEqual(await resolver.resolve({ name: "ExampleBot.compiler", email: "dana@corp.example" }), byName(bob));
});

test("a departed person's row resolves as a departed person", async () => {
  const { resolver, bind } = fixture();
  await bind("Dana Example", carol, { departedAt: 5 });
  assert.deepEqual(
    await resolver.resolve({ name: "dana example", email: "d@x.example" }),
    byName(carol, { departed: true }),
  );
});

test("an ignored name is dropped whatever the email, and beats the bot and external rules", async () => {
  const { resolver, ignore } = fixture();
  await ignore("pipeline-sync", "automation");
  await ignore("ExampleBot.compiler", "automation");
  await ignore("Visiting Student", "external");
  for (const email of ["@partnerco", "", "plain", "x@corp.example", "p@partnerco"])
    assert.deepEqual(await resolver.resolve({ name: "Pipeline-Sync", email }), {
      kind: "ignored",
      reason: "automation",
      nameKey: "pipeline-sync",
    });
  assert.deepEqual(await resolver.resolve({ name: "ExampleBot.compiler", email: "x@corp.example" }), {
    kind: "ignored",
    reason: "automation",
    nameKey: "examplebot.compiler",
  });
  assert.equal((await resolver.resolve({ name: "visiting student", email: "v@partnerco" })).kind, "ignored");
});

test("an ignore row with an email condition applies only to that email and otherwise falls through", async () => {
  const { resolver, ignore } = fixture();
  await ignore("pipeline-sync", "automation", "@partnerco");
  assert.equal((await resolver.resolve({ name: "pipeline-sync", email: "@PartnerCo" })).kind, "ignored");
  assert.deepEqual(await resolver.resolve({ name: "pipeline-sync", email: "x@elsewhere.example" }), {
    kind: "unmapped",
    email: "x@elsewhere.example",
    name: "pipeline-sync",
    reason: "no_match",
  });
});

test("no fuzzy matching: an email local part equal to a person's name does not map", async () => {
  const { resolver, bind } = fixture();
  await bind("alice");
  assert.equal((await resolver.resolve({ name: "A. Example", email: "alice@corp.example" })).kind, "unmapped");
});

const DIRECTORY: Record<string, string[]> = { "gina@corp.example": ["u1"], "twin@corp.example": ["u1", "u2"] };

test("the Mattermost email match is last, only when a directory is given, and keeps the plus tag", async () => {
  const asked: string[] = [];
  const directory = createMattermostPeopleDirectory(async (email) => {
    asked.push(email);
    return DIRECTORY[email] ?? [];
  });
  const off = fixture();
  assert.equal((await off.resolver.resolve({ name: "Gina", email: "gina@corp.example" })).kind, "unmapped");
  const on = fixture({ directory });
  assert.deepEqual(await on.resolver.resolve({ name: "Gina", email: "Gina@Corp.Example" }), {
    kind: "person",
    matchedBy: "mattermost_email",
    personId: "u1",
    mattermostUser: "u1",
  });
  assert.equal((await on.resolver.resolve({ name: "Twin", email: "twin@corp.example" })).kind, "ambiguous");
  assert.equal((await on.resolver.resolve({ name: "Gina", email: "gina+ci@corp.example" })).kind, "unmapped");
  await on.resolver.resolve({ name: "Nobody", email: "" });
  assert.deepEqual(asked, ["gina@corp.example", "twin@corp.example", "gina+ci@corp.example"]);
});

test("a bound name beats the Mattermost email match", async () => {
  const directory = createMemoryPeopleDirectory([{ emails: ["gina@corp.example"], person: carol }]);
  const { resolver, bind } = fixture({ directory });
  await bind("gina", bob);
  assert.deepEqual(await resolver.resolve({ name: "Gina", email: "gina@corp.example" }), byName(bob));
});

test("the Mattermost adapter asks for the trimmed lower-case address and de-duplicates user ids", async () => {
  const asked: string[] = [];
  const adapter = createMattermostPeopleDirectory(async (email) => {
    asked.push(email);
    return ["u1", "u1", "u2"];
  });
  assert.deepEqual(await adapter.findByEmail(" Zhang+x@Corp.Example"), [
    { personId: "u1", mattermostUser: "u1" },
    { personId: "u2", mattermostUser: "u2" },
  ]);
  assert.deepEqual(asked, ["zhang+x@corp.example"]);
});

test("email normalisation trims and lower-cases and does not strip plus tags", () => {
  assert.equal(normaliseEmail("  A.B+tag@Corp.Example "), "a.b+tag@corp.example");
});
