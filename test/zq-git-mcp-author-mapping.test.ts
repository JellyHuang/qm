import assert from "node:assert/strict";
import { test } from "node:test";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import {
  createAuthorMapping,
  createRecordingSink,
  hashEmail,
  type AuthorNotificationSink,
} from "../src/zq/git-mcp/author-mapping.ts";
import type { UpdatedCommit } from "../src/zq/git-mcp/client.ts";
import { createMemoryPeopleDirectory } from "../src/zq/git-mcp/people.ts";
import type { CommitBatch } from "../src/zq/git-mcp/poller.ts";
import { memoryMap } from "./support/memory-map.ts";

const zhang = { personId: "p-zhang", mattermostUser: "mm-zhang" };
const li = { personId: "p-li", mattermostUser: "mm-li" };

const directory = createMemoryPeopleDirectory([
  { emails: ["zhang@corp.example"], person: zhang },
  { emails: ["li@corp.example"], person: li },
  { emails: ["shared@corp.example"], person: zhang },
  { emails: ["shared@corp.example"], person: li },
]);

const config = zqConfigFromEnv({
  ZQ_GIT_BOT_NAMES: "ZQBot.compiler",
  ZQ_GIT_EXTERNAL_DOMAINS: "@yizhu",
}).gitAuthors;

const commit = (sha: string, authorEmail: string, authorName = "A", branch = "main"): UpdatedCommit => ({
  sha,
  authorName,
  authorEmail,
  date: "2026-01-01T00:00:00Z",
  subject: `secret subject ${sha}`,
  branch,
});

const batch = (repo: string, branch: string, commits: UpdatedCommit[]): CommitBatch => ({
  repo,
  branch,
  status: "updated",
  commits,
});

function maps() {
  const tables = new Map<string, Map<string, unknown>>();
  const map = <T>(table: string): DurableMap<T> => {
    if (!tables.has(table)) tables.set(table, new Map());
    return memoryMap<T>(tables.get(table) as Map<string, T>);
  };
  return { tables, map };
}

function build(sink?: AuthorNotificationSink, shared = maps(), clock = { now: 1000 }) {
  const mapping = createAuthorMapping({
    config,
    directory,
    map: shared.map,
    now: () => clock.now,
    ...(sink ? { sink } : {}),
  });
  return { mapping, shared, clock };
}

test("people are grouped across repositories and branches, excluded kinds never reach the sink", async () => {
  const sink = createRecordingSink();
  const { mapping } = build(sink);
  const result = await mapping.mapper.map([
    batch("client", "main", [
      commit("c1", "Zhang@corp.example"),
      commit("c2", "ZQBot.compiler@corp.example", "ZQBot.compiler"),
      commit("c3", "wang@yizhu"),
    ]),
    batch("server", "dev", [
      commit("s1", "zhang+x@corp.example", "Z", "dev"),
      commit("s2", "li@corp.example", "L", "dev"),
    ]),
    batch("client", "feature", [commit("c4", "li@corp.example", "L", "feature")]),
  ]);
  assert.deepEqual(
    result.commits.map((c) => [c.sha, c.author.kind]),
    [
      ["c1", "person"],
      ["c2", "bot"],
      ["c3", "external"],
      ["s1", "person"],
      ["s2", "person"],
      ["c4", "person"],
    ],
  );
  assert.deepEqual(
    result.byPerson.map((g) => [g.person.personId, g.commits.map((c) => `${c.repo}/${c.branch}/${c.sha}`)]),
    [
      ["p-zhang", ["client/main/c1", "server/dev/s1"]],
      ["p-li", ["server/dev/s2", "client/feature/c4"]],
    ],
  );
  assert.deepEqual(result.unmapped, []);
  assert.deepEqual(sink.sent, result.byPerson);
  assert.deepEqual(await mapping.queue.list(), []);
});

test("bots, external and unmapped authors produce no sink call", async () => {
  const sink = createRecordingSink();
  const { mapping } = build(sink);
  const result = await mapping.mapper.map([
    batch("client", "main", [
      commit("c1", "ZQBot.compiler@corp.example", "ZQBot.compiler"),
      commit("c2", "wang@yizhu"),
      commit("c3", "nobody@corp.example", "Nobody"),
      commit("c4", "shared@corp.example", "Shared"),
    ]),
  ]);
  assert.deepEqual(sink.sent, []);
  assert.deepEqual(result.byPerson, []);
  assert.deepEqual(
    result.unmapped.map((u) => [u.email, u.reason, u.commits]),
    [
      ["nobody@corp.example", "no_match", 1],
      ["shared@corp.example", "ambiguous", 1],
    ],
  );
});

test("the queue keeps one entry per normalised address and counts each commit once", async () => {
  const { mapping, clock } = build();
  const first = batch("client", "main", [
    commit("c1", "Nobody@Corp.example", "Nobody"),
    commit("c2", "nobody+a@corp.example"),
  ]);
  await mapping.mapper.map([first]);
  clock.now = 2000;
  await mapping.mapper.map([first, batch("server", "dev", [commit("s1", "nobody@corp.example", "Nobody")])]);
  const open = await mapping.queue.list();
  assert.equal(open.length, 1);
  assert.deepEqual(
    {
      email: open[0]!.email,
      name: open[0]!.name,
      status: open[0]!.status,
      count: open[0]!.count,
      firstSeenAt: open[0]!.firstSeenAt,
      lastSeenAt: open[0]!.lastSeenAt,
      exampleRepo: open[0]!.exampleRepo,
      exampleSha: open[0]!.exampleSha,
    },
    {
      email: "nobody@corp.example",
      name: "Nobody",
      status: "open",
      count: 3,
      firstSeenAt: 1000,
      lastSeenAt: 2000,
      exampleRepo: "client",
      exampleSha: "c1",
    },
  );
});

test("the queue stores no commit message content and ambiguous entries list the candidates", async () => {
  const { mapping, shared } = build();
  await mapping.mapper.map([batch("client", "main", [commit("c1", "shared@corp.example", "Shared")])]);
  const stored = JSON.stringify([...shared.tables.get("zq_git_unmapped_authors")!.values()]);
  assert.ok(!stored.includes("secret subject"));
  const [entry] = await mapping.queue.list();
  assert.deepEqual(entry!.candidates, ["p-zhang", "p-li"]);
  assert.equal(entry!.reason, "ambiguous");
});

test("resolving adds an alias, the entry leaves the open list and the author maps from then on", async () => {
  const sink = createRecordingSink();
  const { mapping, clock } = build(sink);
  const batches = [batch("client", "main", [commit("c1", "zhang.home@example.org", "Zhang")])];
  await mapping.mapper.map(batches);
  clock.now = 3000;
  const resolved = await mapping.queue.resolve("Zhang.Home@Example.org", zhang, "pm");
  assert.deepEqual([resolved?.status, resolved?.closedBy, resolved?.personId], ["resolved", "pm", "p-zhang"]);
  assert.deepEqual(await mapping.queue.list(), []);
  assert.equal((await mapping.queue.list("resolved")).length, 1);
  const again = await mapping.mapper.map([batch("client", "main", [commit("c2", "zhang.home@example.org")])]);
  assert.deepEqual(
    again.byPerson.map((g) => g.person.personId),
    ["p-zhang"],
  );
  assert.equal(sink.sent.length, 1);
  await mapping.aliases.remove("zhang.home@example.org", "p-zhang");
  await mapping.mapper.map([batch("client", "main", [commit("c3", "zhang.home@example.org")])]);
  const [reopened] = await mapping.queue.list();
  assert.deepEqual([reopened?.status, reopened?.count], ["open", 2]);
  assert.equal(await mapping.queue.resolve("never@seen.example", zhang, "pm"), null);
});

test("an ignored author stays ignored and keeps counting", async () => {
  const { mapping } = build();
  await mapping.mapper.map([batch("client", "main", [commit("c1", "nobody@corp.example")])]);
  const ignored = await mapping.queue.ignore("nobody@corp.example", "pm");
  assert.equal(ignored?.status, "ignored");
  await mapping.mapper.map([batch("client", "main", [commit("c2", "nobody@corp.example")])]);
  assert.deepEqual(await mapping.queue.list(), []);
  const [entry] = await mapping.queue.list("ignored");
  assert.equal(entry?.count, 2);
});

test("the queue and aliases survive a restart", async () => {
  const shared = maps();
  const before = build(undefined, shared);
  await before.mapping.mapper.map([batch("client", "main", [commit("c1", "nobody@corp.example", "Nobody")])]);
  await before.mapping.queue.resolve("nobody@corp.example", li, "pm");
  await before.mapping.mapper.map([batch("client", "main", [commit("c2", "other@corp.example", "Other")])]);
  const after = build(undefined, shared);
  assert.deepEqual(
    (await after.mapping.queue.list()).map((e) => e.email),
    ["other@corp.example"],
  );
  assert.deepEqual(
    (await after.mapping.queue.list("resolved")).map((e) => e.email),
    ["nobody@corp.example"],
  );
  const result = await after.mapping.mapper.map([batch("client", "main", [commit("c3", "nobody@corp.example")])]);
  assert.deepEqual(
    result.byPerson.map((g) => g.person.personId),
    ["p-li"],
  );
});

test("the default configuration records notices in a dry-run sink and sends nothing anywhere", async () => {
  const { mapping } = build();
  await mapping.mapper.handle([batch("client", "main", [commit("c1", "zhang@corp.example")])]);
  const sink = mapping.sink as ReturnType<typeof createRecordingSink>;
  assert.deepEqual(
    sink.sent.map((n) => [n.person.mattermostUser, n.commits.length]),
    [["mm-zhang", 1]],
  );
});

test("a failing sink fails the handler so the poller retries, without double counting the queue", async () => {
  const failing: AuthorNotificationSink = {
    async deliver() {
      throw new Error("sink down");
    },
  };
  const { mapping } = build(failing);
  const batches = [batch("client", "main", [commit("c1", "zhang@corp.example"), commit("c2", "nobody@corp.example")])];
  await assert.rejects(mapping.mapper.handle(batches), /sink down/);
  await assert.rejects(mapping.mapper.handle(batches), /sink down/);
  assert.equal((await mapping.queue.list())[0]?.count, 1);
});

test("logs carry only a hash of the address", async () => {
  const lines: string[] = [];
  const shared = maps();
  const mapping = createAuthorMapping({ config, directory, map: shared.map, log: (line) => lines.push(line) });
  await mapping.mapper.map([batch("client", "main", [commit("c1", "nobody@corp.example", "Nobody")])]);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes(hashEmail("NOBODY@corp.example")));
  assert.ok(!lines[0]!.includes("nobody"));
});
