import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAuthor, createAuthorResolver, unmappedAuthors, type AuthorClass } from "../src/zq/git-mcp/authors.ts";

const rules = {
  externalDomains: ["@pipeline.invalid", "partner.example"],
  botNames: ["ExampleBot.compiler", "jenkins"],
};

test("bot names listed in the rules are bots by author name or by the part before the at sign", () => {
  assert.deepEqual(classifyAuthor({ name: "ExampleBot.compiler", email: "bot@corp.example" }, rules), {
    kind: "bot",
    name: "ExampleBot.compiler",
  });
  assert.deepEqual(classifyAuthor({ name: "Someone", email: "examplebot.compiler@corp.example" }, rules), {
    kind: "bot",
    name: "Someone",
  });
  assert.deepEqual(classifyAuthor({ name: "Jenkins", email: "ci@corp.example" }, rules), {
    kind: "bot",
    name: "Jenkins",
  });
});

test("authors from listed non-company domains are external, including subdomains and any letter case", () => {
  assert.deepEqual(classifyAuthor({ name: "Wang", email: "wang@pipeline.invalid" }, rules), {
    kind: "external",
    domain: "pipeline.invalid",
  });
  assert.deepEqual(classifyAuthor({ name: "Li", email: "Li@Dev.Partner.Example" }, rules), {
    kind: "external",
    domain: "dev.partner.example",
  });
  assert.equal(classifyAuthor({ name: "Zhang", email: "zhang@corp.example" }, rules), undefined);
  assert.equal(classifyAuthor({ name: "Zhang", email: "zhang@notpartner.example" }, rules), undefined);
});

test("an address without an at sign is never mapped to a person", () => {
  assert.deepEqual(classifyAuthor({ name: "x", email: "nobody" }, rules), { kind: "unmapped" });
});

test("the stub resolver maps nobody and the real mapper is only asked about company addresses", async () => {
  assert.deepEqual(await unmappedAuthors.resolve({ email: "zhang@corp.example" }), { kind: "unmapped" });
  const asked: string[] = [];
  const resolver = createAuthorResolver({
    rules,
    map: async (email): Promise<AuthorClass> => {
      asked.push(email);
      return { kind: "person", mmUserId: "u1" };
    },
  });
  assert.deepEqual(await resolver.resolve({ email: " Zhang@Corp.Example " }), { kind: "person", mmUserId: "u1" });
  assert.deepEqual(await resolver.resolve({ name: "ExampleBot.compiler", email: "bot@corp.example" }), {
    kind: "bot",
    name: "ExampleBot.compiler",
  });
  assert.deepEqual(await resolver.resolve({ email: "wang@pipeline.invalid" }), {
    kind: "external",
    domain: "pipeline.invalid",
  });
  assert.deepEqual(asked, ["zhang@corp.example"]);
  assert.deepEqual(await createAuthorResolver({ rules }).resolve({ email: "zhang@corp.example" }), {
    kind: "unmapped",
  });
});
