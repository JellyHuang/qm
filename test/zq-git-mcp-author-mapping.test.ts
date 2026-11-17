import assert from "node:assert/strict";
import { test } from "node:test";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import {
  createAuthorMapping,
  createRecordingSink,
  type AuthorMapping,
  type AuthorNotificationSink,
} from "../src/zq/git-mcp/author-mapping.ts";
import { hashEmail, hashName } from "../src/zq/git-mcp/names.ts";
import { UNMAPPED_RETENTION_DAYS, unmappedCutoff } from "../src/zq/git-mcp/unmapped-queue.ts";
import type { UpdatedCommit } from "../src/zq/git-mcp/client.ts";
import type { CommitBatch } from "../src/zq/git-mcp/poller.ts";
import { memoryMap } from "./support/memory-map.ts";

const alice = { personId: "p-alice", mattermostUser: "mm-alice" };
const bob = { personId: "p-bob", mattermostUser: "mm-bob" };

const POLL = {
  ZQ_GIT_MCP_URL: "http://127.0.0.1:8765/mcp",
  ZQ_GIT_MCP_SECRET: "a-shared-secret-0123456789",
  ZQ_GIT_POLL: "1",
};

const config = zqConfigFromEnv({
  ...POLL,
  ZQ_GIT_BOT_NAMES: "dependabot",
  ZQ_GIT_EXTERNAL_DOMAINS: "@partnerco",
  ZQ_GIT_AUTHOR_MAPPING: "1",
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

const bind = (mapping: AuthorMapping, name: string, person = alice, departedAt?: number) =>
  mapping.aliases.insert({
    kind: "person",
    name,
    ...person,
    ...(departedAt === undefined ? {} : { departedAt }),
    addedBy: "pm",
  });

function build(
  sink?: AuthorNotificationSink,
  shared = maps(),
  clock = { now: 1000 },
  overrides: Partial<typeof config> = {},
  log?: (line: string) => void,
) {
  const mapping = createAuthorMapping({
    config: { ...config, ...overrides },
    map: shared.map,
    now: () => clock.now,
    ...(sink ? { sink } : {}),
    ...(log ? { log } : {}),
  })!;
  return { mapping, shared, clock };
}

test("people are grouped across repositories and branches by name, excluded kinds never reach the sink", async () => {
  const sink = createRecordingSink();
  const { mapping } = build(sink);
  await bind(mapping, "Alice Example", alice);
  await bind(mapping, "Bob Example", bob);
  const result = await mapping.mapper.map([
    batch("client", "main", [
      commit("c1", "alice@a.example", "Alice Example"),
      commit("c2", "zqbot@corp.example", "ZQBot.compiler"),
      commit("c3", "wang@partnerco", "Wang"),
    ]),
    batch("server", "dev", [
      commit("s1", "other@b.example", "ALICE  example", "dev"),
      commit("s2", "bob@corp.example", "Bob Example", "dev"),
    ]),
    batch("client", "feature", [commit("c4", "bob@corp.example", "bob example", "feature")]),
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
      ["p-alice", ["client/main/c1", "server/dev/s1"]],
      ["p-bob", ["server/dev/s2", "client/feature/c4"]],
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
      commit("c1", "zqbot@corp.example", "ZQBot.compiler"),
      commit("c2", "wang@partnerco"),
      commit("c3", "nobody@corp.example", "Nobody"),
      commit("c4", "@partnerco", "Eve"),
      commit("c5", "", "Frank"),
      commit("c6", "noat", "Gina"),
    ]),
  ]);
  assert.deepEqual(sink.sent, []);
  assert.deepEqual(sink.sentToPm, []);
  assert.deepEqual(result.byPerson, []);
  assert.deepEqual(
    result.unmapped.map((u) => [u.name, u.reason, u.commits]),
    [
      ["Nobody", "no_match", 1],
      ["Eve", "invalid_email", 1],
      ["Frank", "invalid_email", 1],
      ["Gina", "invalid_email", 1],
    ],
  );
});

test("the queue keeps one entry per normalised name, lists the emails seen and counts each commit once", async () => {
  const { mapping, clock } = build();
  const first = batch("client", "main", [
    commit("c1", "Nobody@Corp.example", "Nobody"),
    commit("c2", "nobody+a@corp.example", "NOBODY"),
  ]);
  await mapping.mapper.map([first]);
  clock.now = 2000;
  await mapping.mapper.map([first, batch("server", "dev", [commit("s1", "other@corp.example", " nobody ")])]);
  const open = await mapping.queue.list();
  assert.equal(open.length, 1);
  assert.deepEqual(
    {
      nameKey: open[0]!.nameKey,
      emails: open[0]!.emails,
      name: open[0]!.name,
      status: open[0]!.status,
      count: open[0]!.count,
      firstSeenAt: open[0]!.firstSeenAt,
      lastSeenAt: open[0]!.lastSeenAt,
      exampleRepo: open[0]!.exampleRepo,
      exampleSha: open[0]!.exampleSha,
    },
    {
      nameKey: "nobody",
      emails: ["nobody@corp.example", "nobody+a@corp.example", "other@corp.example"],
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

test("a generic name is queued under its name and its email, a normal name under its name only", async () => {
  const { mapping, shared } = build();
  await mapping.mapper.map([
    batch("client", "main", [
      commit("c1", "x@y.example", "HOST123\\admin"),
      commit("c2", "z@y.example", "HOST123\\admin"),
      commit("c3", "p@q.example", "Pat"),
      commit("c4", "r@q.example", "Pat"),
    ]),
  ]);
  assert.deepEqual([...shared.tables.get("zq_git_unmapped_authors")!.keys()].sort(), [
    "host123\\admin|x@y.example",
    "host123\\admin|z@y.example",
    "pat",
  ]);
});

test("the queue stores no commit message content, and the key of an empty name is the email", async () => {
  const { mapping, shared } = build();
  await mapping.mapper.map([batch("client", "main", [commit("c1", "a@b.example", ""), commit("c2", "", "")])]);
  const stored = JSON.stringify([...shared.tables.get("zq_git_unmapped_authors")!.values()]);
  assert.ok(!stored.includes("secret subject"));
  assert.deepEqual([...shared.tables.get("zq_git_unmapped_authors")!.keys()].sort(), ["(none)", "email:a@b.example"]);
});

test("binding a name closes its queue row and the author maps from then on, unbinding reopens the queue", async () => {
  const sink = createRecordingSink();
  const { mapping, clock } = build(sink);
  const author = { name: "Alice Home", email: "alice.home@example.org" };
  await mapping.mapper.map([batch("client", "main", [commit("c1", author.email, author.name)])]);
  clock.now = 3000;
  assert.equal(await bind(mapping, "alice home"), true);
  const resolved = await mapping.queue.resolve(author, "p-alice", "pm");
  assert.deepEqual([resolved?.status, resolved?.closedBy, resolved?.personId], ["resolved", "pm", "p-alice"]);
  assert.deepEqual(await mapping.queue.list(), []);
  assert.equal((await mapping.queue.list("resolved")).length, 1);
  const again = await mapping.mapper.map([batch("client", "main", [commit("c2", author.email, author.name)])]);
  assert.deepEqual(
    again.byPerson.map((g) => g.person.personId),
    ["p-alice"],
  );
  await mapping.aliases.remove("Alice Home");
  await mapping.mapper.map([batch("client", "main", [commit("c3", author.email, author.name)])]);
  const [reopened] = await mapping.queue.list();
  assert.deepEqual([reopened?.status, reopened?.count], ["open", 2]);
  assert.equal(await mapping.queue.resolve({ name: "Never Seen", email: "n@s.example" }, "p-alice", "pm"), null);
});

test("an ignored queue entry stays ignored and keeps counting", async () => {
  const { mapping } = build();
  const author = { name: "Nobody", email: "nobody@corp.example" };
  await mapping.mapper.map([batch("client", "main", [commit("c1", author.email, author.name)])]);
  const ignored = await mapping.queue.ignore(author, "pm");
  assert.equal(ignored?.status, "ignored");
  await mapping.mapper.map([batch("client", "main", [commit("c2", author.email, author.name)])]);
  assert.deepEqual(await mapping.queue.list(), []);
  const [entry] = await mapping.queue.list("ignored");
  assert.equal(entry?.count, 2);
});

test("the queue and the name rows survive a restart", async () => {
  const shared = maps();
  const before = build(undefined, shared);
  await before.mapping.mapper.map([batch("client", "main", [commit("c1", "n@corp.example", "Nobody")])]);
  await bind(before.mapping, "Nobody", bob);
  await before.mapping.queue.resolve({ name: "Nobody", email: "n@corp.example" }, "p-bob", "pm");
  await before.mapping.mapper.map([batch("client", "main", [commit("c2", "o@corp.example", "Other")])]);
  const after = build(undefined, shared);
  assert.deepEqual(
    (await after.mapping.queue.list()).map((e) => e.nameKey),
    ["other"],
  );
  assert.deepEqual(
    (await after.mapping.queue.list("resolved")).map((e) => e.nameKey),
    ["nobody"],
  );
  const result = await after.mapping.mapper.map([batch("client", "main", [commit("c3", "zz@corp.example", "NOBODY")])]);
  assert.deepEqual(
    result.byPerson.map((g) => g.person.personId),
    ["p-bob"],
  );
});

test("the default configuration records notices in a dry-run sink and sends nothing anywhere", async () => {
  const { mapping } = build();
  await bind(mapping, "Alice Example");
  await mapping.mapper.handle([batch("client", "main", [commit("c1", "a@x.example", "Alice Example")])]);
  const sink = mapping.sink as ReturnType<typeof createRecordingSink>;
  assert.deepEqual(
    sink.sent.map((n) => [n.person.mattermostUser, n.commits.length]),
    [["mm-alice", 1]],
  );
});

test("a departed person's commits go to the PM sink and not to the person, undepart restores", async () => {
  const sink = createRecordingSink();
  const { mapping } = build(sink);
  await bind(mapping, "Dana Example", bob);
  await bind(mapping, "Dana Home", bob);
  await mapping.aliases.setDeparted("p-bob", true);
  const result = await mapping.mapper.map([
    batch("client", "main", [commit("c1", "d@x.example", "Dana Example"), commit("c2", "d@x.example", "dana home")]),
    batch("server", "dev", [commit("s1", "d@x.example", "Dana Example", "dev")]),
  ]);
  assert.equal(sink.sent.length, 0);
  assert.deepEqual(
    sink.sentToPm.map((n) => [n.person.personId, n.authorName, n.commits.map((c) => `${c.repo}/${c.sha}`)]),
    [["p-bob", "Dana Example", ["client/c1", "client/c2", "server/s1"]]],
  );
  assert.deepEqual(result.byPerson, []);
  assert.deepEqual(await mapping.queue.list(), []);
  await mapping.aliases.setDeparted("p-bob", false);
  await mapping.mapper.map([batch("client", "main", [commit("c9", "d@x.example", "Dana Example")])]);
  assert.deepEqual(
    sink.sent.map((n) => n.person.personId),
    ["p-bob"],
  );
  assert.equal(sink.sentToPm.length, 1);
});

test("a bot sharing nothing but a departed person's email stays dropped and reaches neither sink nor queue", async () => {
  const sink = createRecordingSink();
  const { mapping } = build(sink);
  await bind(mapping, "Dana Example", bob, 5);
  await mapping.mapper.map([batch("client", "main", [commit("c1", "dana@corp.example", "ZQBot.compiler")])]);
  assert.deepEqual([sink.sent, sink.sentToPm], [[], []]);
  assert.deepEqual(await mapping.queue.list(), []);
});

test("a commit by an ignored identity produces zero notices and zero queue rows and one counter per name hash", async () => {
  const sink = createRecordingSink();
  const lines: string[] = [];
  const shared = maps();
  const { mapping } = build(sink, shared, { now: 1000 }, {}, (line) => lines.push(line));
  await mapping.aliases.insert({ kind: "ignored", name: "pipeline-sync", reason: "automation", addedBy: "pm" });
  await mapping.aliases.insert({ kind: "ignored", name: "Visiting Student", reason: "external", addedBy: "pm" });
  const result = await mapping.mapper.map([
    batch("client", "main", [
      commit("c1", "@partnerco", "pipeline-sync"),
      commit("c2", "", "Pipeline-Sync"),
      commit("c3", "v@univ.example", "visiting student"),
    ]),
  ]);
  assert.deepEqual([sink.sent, sink.sentToPm, sink.claimAttempts], [[], [], []]);
  assert.equal(shared.tables.get("zq_git_unmapped_authors")!.size, 0);
  assert.deepEqual(
    result.ignored.map((i) => [i.nameHash, i.reason, i.commits]),
    [
      [hashName("pipeline-sync"), "automation", 2],
      [hashName("visiting student"), "external", 1],
    ],
  );
  assert.deepEqual(lines, [
    `zq git author ignored: ${hashName("pipeline-sync")} reason=automation commits=2`,
    `zq git author ignored: ${hashName("visiting student")} reason=external commits=1`,
  ]);
});

test("an ignore entry with a condition that does not match queues the author", async () => {
  const { mapping } = build();
  await mapping.aliases.insert({
    kind: "ignored",
    name: "pipeline-sync",
    reason: "automation",
    emailCondition: "@partnerco",
    addedBy: "pm",
  });
  await mapping.mapper.map([
    batch("client", "main", [
      commit("c1", "@partnerco", "pipeline-sync"),
      commit("c2", "x@elsewhere.example", "pipeline-sync"),
    ]),
  ]);
  assert.deepEqual(
    (await mapping.queue.list()).map((e) => [e.nameKey, e.count]),
    [["pipeline-sync", 1]],
  );
});

test("author only: a different committer changes nothing", async () => {
  const sink = createRecordingSink();
  const { mapping } = build(sink);
  await bind(mapping, "Alice Example");
  const withCommitter = {
    ...commit("c1", "a@x.example", "Alice Example"),
    committerName: "Bob Example",
    committerEmail: "bob@corp.example",
  };
  await mapping.mapper.map([batch("client", "main", [withCommitter])]);
  assert.deepEqual(
    sink.sent.map((n) => n.person.personId),
    ["p-alice"],
  );
});

test("a failing sink fails the handler so the poller retries, without double counting the queue", async () => {
  const failing: AuthorNotificationSink = {
    ...createRecordingSink(),
    async deliver() {
      throw new Error("sink down");
    },
  };
  const { mapping } = build(failing);
  await bind(mapping, "Alice Example");
  const batches = [
    batch("client", "main", [
      commit("c1", "a@x.example", "Alice Example"),
      commit("c2", "nobody@corp.example", "Nobody"),
    ]),
  ];
  await assert.rejects(mapping.mapper.handle(batches), /sink down/);
  await assert.rejects(mapping.mapper.handle(batches), /sink down/);
  assert.equal((await mapping.queue.list())[0]?.count, 1);
});

test("logs carry only hashes of the name and the address", async () => {
  const lines: string[] = [];
  const { mapping } = build(undefined, maps(), { now: 1000 }, {}, (line) => lines.push(line));
  await mapping.mapper.map([batch("client", "main", [commit("c1", "nobody@corp.example", "Nobody Person")])]);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes(hashEmail("NOBODY@corp.example")));
  assert.ok(lines[0]!.includes(hashName("nobody  person")));
  assert.ok(!/nobody|corp/i.test(lines[0]!));
});

const DAY = 86_400_000;

test("with the switch off nothing instantiates a map and no mapper exists", () => {
  const asked: string[] = [];
  const off = zqConfigFromEnv({ ZQ_GIT_BOT_NAMES: "dependabot" }).gitAuthors;
  assert.equal(off.mapping, false);
  const mapping = createAuthorMapping({
    config: off,
    map: <T>(table: string) => {
      asked.push(table);
      return memoryMap<T>();
    },
  });
  assert.equal(mapping, undefined);
  assert.deepEqual(asked, []);
  assert.equal(zqConfigFromEnv({ ZQ_GIT_AUTHOR_MAPPING: "0" }).gitAuthors.mapping, false);
  assert.equal(zqConfigFromEnv({ ...POLL, ZQ_GIT_AUTHOR_MAPPING: "1" }).gitAuthors.mapping, true);
});

test("with the switch on exactly the two author tables are requested", () => {
  const asked: string[] = [];
  createAuthorMapping({
    config,
    map: <T>(table: string) => {
      asked.push(table);
      return memoryMap<T>();
    },
  });
  assert.deepEqual(asked.sort(), ["zq_git_author_aliases", "zq_git_unmapped_authors"]);
});

test("the retention and reopen settings default to 180 days and off, and reject bad values", () => {
  const defaults = zqConfigFromEnv({}).gitAuthors;
  assert.deepEqual([defaults.queueRetentionDays, defaults.ignoredReopenDays], [180, 0]);
  const set = zqConfigFromEnv({ ZQ_GIT_UNMAPPED_RETENTION_DAYS: "30", ZQ_GIT_IGNORED_REOPEN_DAYS: "7" }).gitAuthors;
  assert.deepEqual([set.queueRetentionDays, set.ignoredReopenDays], [30, 7]);
  assert.throws(() => zqConfigFromEnv({ ZQ_GIT_UNMAPPED_RETENTION_DAYS: "0" }), /ZQ_GIT_UNMAPPED_RETENTION_DAYS/);
  assert.throws(() => zqConfigFromEnv({ ZQ_GIT_IGNORED_REOPEN_DAYS: "-1" }), /ZQ_GIT_IGNORED_REOPEN_DAYS/);
});

test("the cutoff is the retention in days before now", () => {
  assert.equal(UNMAPPED_RETENTION_DAYS, 180);
  assert.equal(unmappedCutoff(1_000 * DAY), 820 * DAY);
  assert.equal(unmappedCutoff(1_000 * DAY, 30), 970 * DAY);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => unmappedCutoff(1, bad), /whole number of days/);
});

test("pruning removes only resolved and ignored entries older than the retention and never open ones", async () => {
  const clock = { now: 0 };
  const { mapping } = build(undefined, maps(), clock);
  const see = (name: string, sha: string) =>
    mapping.mapper.map([batch("client", "main", [commit(sha, `${name}@corp.example`, name)])]);
  const ref = (name: string) => ({ name, email: `${name}@corp.example` });
  await see("open", "o1");
  await see("resolved", "r1");
  await see("ignored", "i1");
  await see("recent", "n1");
  await mapping.queue.resolve(ref("resolved"), "p-alice", "pm");
  await mapping.queue.ignore(ref("ignored"), "pm");
  clock.now = 100 * DAY;
  await see("recent", "n2");
  await mapping.queue.ignore(ref("recent"), "pm");
  clock.now = 181 * DAY;
  assert.equal(await mapping.queue.prune(), 2);
  assert.deepEqual(
    (await mapping.queue.list()).map((e) => e.nameKey),
    ["open"],
  );
  assert.deepEqual(
    (await mapping.queue.list("ignored")).map((e) => e.nameKey),
    ["recent"],
  );
  assert.deepEqual(await mapping.queue.list("resolved"), []);
  clock.now = 281 * DAY;
  assert.equal(await mapping.queue.prune(), 1);
  assert.equal(await mapping.queue.prune(), 0);
});

test("an ignored author that is still seen is kept past the retention", async () => {
  const clock = { now: 0 };
  const { mapping } = build(undefined, maps(), clock);
  const noisy = { name: "Noisy", email: "noisy@corp.example" };
  await mapping.mapper.map([batch("client", "main", [commit("c1", noisy.email, noisy.name)])]);
  await mapping.queue.ignore(noisy, "pm");
  clock.now = 179 * DAY;
  await mapping.mapper.map([batch("client", "main", [commit("c2", noisy.email, noisy.name)])]);
  clock.now = 200 * DAY;
  assert.equal(await mapping.queue.prune(), 0);
});

test("an ignored author reopens after the configured days and stays silent forever by default", async () => {
  for (const [days, reopened] of [
    [0, false],
    [30, true],
  ] as const) {
    const clock = { now: 0 };
    const { mapping } = build(undefined, maps(), clock, { ignoredReopenDays: days });
    const noisy = { name: "Noisy", email: "noisy@corp.example" };
    await mapping.mapper.map([batch("client", "main", [commit("c1", noisy.email, noisy.name)])]);
    await mapping.queue.ignore(noisy, "pm");
    clock.now = 29 * DAY;
    await mapping.mapper.map([batch("client", "main", [commit("c2", noisy.email, noisy.name)])]);
    assert.deepEqual((await mapping.queue.list()).length, 0);
    clock.now = 31 * DAY;
    await mapping.mapper.map([batch("client", "main", [commit("c3", noisy.email, noisy.name)])]);
    assert.equal((await mapping.queue.list()).length, reopened ? 1 : 0);
    assert.equal((await mapping.queue.list(reopened ? "open" : "ignored"))[0]?.count, 3);
  }
});
