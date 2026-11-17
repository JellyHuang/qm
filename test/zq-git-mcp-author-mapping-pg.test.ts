import assert from "node:assert/strict";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createAuthorMapping } from "../src/zq/git-mcp/author-mapping.ts";
import { createMemoryPeopleDirectory } from "../src/zq/git-mcp/people.ts";
import { tenantTest as test } from "./support/tenant-test.ts";
import { testMap } from "./support/test-database.ts";

const li = { personId: "p-li", mattermostUser: "mm-li" };

test("the unmapped queue and alias table persist and resolve on Postgres", async (t) => {
  if (!process.env.DATABASE_URL) return t.skip("DATABASE_URL is not set");
  const tables = new Map<string, DurableMap<never>>();
  const map = <T>(table: string) => {
    if (!tables.has(table)) tables.set(table, testMap<never>());
    return tables.get(table) as unknown as DurableMap<T>;
  };
  const build = () =>
    createAuthorMapping({
      config: zqConfigFromEnv({}).gitAuthors,
      directory: createMemoryPeopleDirectory([{ emails: ["li@corp.example"], person: li }]),
      map,
    });
  const before = build();
  const commits = [
    {
      sha: "c1",
      authorName: "N",
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
  assert.deepEqual([entry?.email, entry?.count, entry?.exampleSha], ["nobody@corp.example", 1, "c1"]);
  await after.queue.resolve("nobody@corp.example", li, "pm");
  assert.deepEqual(await after.queue.list(), []);
  const result = await build().mapper.map([batch]);
  assert.deepEqual(
    result.byPerson.map((g) => g.person.personId),
    ["p-li"],
  );
});
