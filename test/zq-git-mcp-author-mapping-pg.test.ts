import assert from "node:assert/strict";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createAuthorMapping } from "../src/zq/git-mcp/author-mapping.ts";
import { tenantTest as test } from "./support/tenant-test.ts";
import { testMap } from "./support/test-database.ts";

const POLL = {
  ZQ_GIT_MCP_URL: "http://127.0.0.1:8765/mcp",
  ZQ_GIT_MCP_SECRET: "a-shared-secret-0123456789",
  ZQ_GIT_POLL: "1",
};

const alice = { personId: "p-alice", mattermostUser: "mm-alice" };

test("the unmapped queue and the name rows persist, resolve and refuse a second insert of one name on Postgres", async (t) => {
  if (!process.env.DATABASE_URL) return t.skip("DATABASE_URL is not set");
  const tables = new Map<string, DurableMap<never>>();
  const map = <T>(table: string) => {
    if (!tables.has(table)) tables.set(table, testMap<never>());
    return tables.get(table) as unknown as DurableMap<T>;
  };
  const build = () =>
    createAuthorMapping({
      config: zqConfigFromEnv({ ...POLL, ZQ_GIT_AUTHOR_MAPPING: "1" }).gitAuthors,
      map,
    })!;
  const before = build();
  const commits = [
    {
      sha: "c1",
      authorName: "Nobody Example",
      authorEmail: "Nobody@corp.example",
      date: "2026-01-01T00:00:00Z",
      subject: "s",
      branch: "main",
    },
  ];
  const batch = { repo: "client", branch: "main", status: "updated" as const, commits };
  await before.mapper.map([batch]);
  await before.mapper.map([batch]);
  const after = build();
  const [entry] = await after.queue.list();
  assert.deepEqual(
    [entry?.nameKey, entry?.emails, entry?.count, entry?.exampleSha],
    ["nobody example", ["nobody@corp.example"], 1, "c1"],
  );
  const row = { kind: "person" as const, name: "Nobody Example", ...alice, addedBy: "pm" };
  assert.equal(await after.aliases.insert(row), true);
  assert.equal(await after.aliases.insert({ ...row, name: "NOBODY  example", personId: "p-other" }), false);
  assert.equal((await after.aliases.get("nobody example"))?.kind, "person");
  await after.queue.resolve({ name: "Nobody Example", email: "nobody@corp.example" }, "p-alice", "pm");
  assert.deepEqual(await after.queue.list(), []);
  const result = await build().mapper.map([batch]);
  assert.deepEqual(
    result.byPerson.map((g) => g.person.personId),
    ["p-alice"],
  );
});
