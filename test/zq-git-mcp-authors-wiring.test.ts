import assert from "node:assert/strict";
import { test } from "node:test";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createRecordingSink, hashEmail } from "../src/zq/git-mcp/author-mapping.ts";
import { createMattermostPeopleDirectory, type PeopleDirectory } from "../src/zq/git-mcp/people.ts";
import { createGitMcpRuntime } from "../src/zq/git-mcp/runtime.ts";
import type { UnmappedAuthor } from "../src/zq/git-mcp/unmapped-queue.ts";
import { createFakeGitMcp, sharedLease, type FakeAuthor } from "./support/fake-git-mcp.ts";
import { memoryMap } from "./support/memory-map.ts";

const SERVICE = { ZQ_GIT_MCP_URL: "http://127.0.0.1:8765/mcp", ZQ_GIT_MCP_SECRET: "a-shared-secret-0123456789" };
const BOTH = {
  ...SERVICE,
  ZQ_GIT_POLL: "1",
  ZQ_GIT_AUTHOR_MAPPING: "1",
  ZQ_GIT_BOT_NAMES: "ZQBot.compiler",
  ZQ_GIT_EXTERNAL_DOMAINS: "@yizhu",
};
const ALIASES = "zq_git_author_aliases";
const QUEUE = "zq_git_unmapped_authors";

const zhang: FakeAuthor = { name: "Zhang Wei", email: "Zhang.Wei+ci@corp.example" };
const li: FakeAuthor = { name: "Li Na", email: "li.na@corp.example" };
const stranger: FakeAuthor = { name: "Wang", email: "wang.home@example.org" };
const twin: FakeAuthor = { name: "Chen", email: "chen@corp.example" };
const bot: FakeAuthor = { name: "ZQBot.compiler", email: "zqbot@corp.example" };
const vendor: FakeAuthor = { name: "Zhao", email: "zhao@yizhu" };
const broken: FakeAuthor = { name: "Root", email: "root" };

const MATTERMOST: Record<string, string[]> = {
  "zhang.wei@corp.example": ["mm-zhang"],
  "li.na@corp.example": ["mm-li"],
  "chen@corp.example": ["mm-chen-1", "mm-chen-2"],
};

type Rows = Map<string, Map<string, unknown>>;

function world(
  env: NodeJS.ProcessEnv,
  options: { people?: PeopleDirectory; rows?: Rows; service?: ReturnType<typeof createFakeGitMcp> } = {},
) {
  const service = options.service ?? createFakeGitMcp();
  const sweepers: (() => unknown)[] = [];
  const requested: string[] = [];
  const rows: Rows = options.rows ?? new Map();
  const lines: string[] = [];
  const lookups: string[] = [];
  const authorSink = createRecordingSink();
  const people =
    options.people ??
    createMattermostPeopleDirectory(async (email) => {
      lookups.push(email);
      return MATTERMOST[email] ?? [];
    });
  const failures = { unmappedInserts: 0 };
  const runtime = createGitMcpRuntime({
    config: zqConfigFromEnv(env),
    leaderLease: sharedLease(),
    people,
    authorSink,
    map: <T>(table: string): DurableMap<T> => {
      requested.push(table);
      if (!rows.has(table)) rows.set(table, new Map());
      const inner = memoryMap<T>(rows.get(table) as Map<string, T>);
      if (table !== QUEUE) return inner;
      return {
        ...inner,
        async insertIfAbsent(id: string, value: T) {
          if (failures.unmappedInserts > 0 && --failures.unmappedInserts === 0) throw new Error("store is down");
          return inner.insertIfAbsent(id, value);
        },
      } as DurableMap<T>;
    },
    createSweeper: (work) => {
      sweepers.push(work);
      return { start() {}, stop: async () => {} };
    },
    createClient: () => service.client,
    log: { info: (l) => lines.push(l), error: (l) => lines.push(l) },
  });
  return {
    service,
    requested,
    rows,
    lines,
    lookups,
    failures,
    authorSink,
    runtime,
    fire: async () => {
      await sweepers[0]?.();
    },
  };
}

const queued = (rows: Rows) => [...(rows.get(QUEUE)?.values() ?? [])] as UnmappedAuthor[];
const counts = (rows: Rows) => Object.fromEntries(queued(rows).map((e) => [e.email, e.count]));

async function afterBaseline(options: Parameters<typeof world>[1] = {}) {
  const w = world(BOTH, options);
  w.service.push("client", "base");
  await w.fire();
  return w;
}

test("the defaults, the service address alone and the poll alone request no author table", async () => {
  for (const env of [{}, SERVICE, { ...SERVICE, ZQ_GIT_POLL: "1" }]) {
    const w = world(env);
    w.service.push("client", "a");
    await w.fire();
    w.service.authoredBy(stranger, "b");
    w.service.push("client", "b");
    await w.fire();
    assert.deepEqual(w.requested, []);
    assert.deepEqual(w.lookups, []);
    assert.deepEqual(w.authorSink.sent, []);
  }
});

test("the author mapping without the poll is a configuration error", () => {
  assert.throws(
    () => zqConfigFromEnv({ ...SERVICE, ZQ_GIT_AUTHOR_MAPPING: "1" }),
    /ZQ_GIT_AUTHOR_MAPPING needs ZQ_GIT_POLL=1/,
  );
  assert.throws(() => zqConfigFromEnv({ ZQ_GIT_AUTHOR_MAPPING: "1" }), /ZQ_GIT_AUTHOR_MAPPING needs ZQ_GIT_POLL=1/);
});

test("the author mapping without Mattermost refuses to start and requests no table", () => {
  const requested: string[] = [];
  assert.throws(
    () =>
      createGitMcpRuntime({
        config: zqConfigFromEnv(BOTH),
        leaderLease: sharedLease(),
        map: (table) => {
          requested.push(table);
          return memoryMap();
        },
        createSweeper: () => ({ start() {}, stop: async () => {} }),
      }),
    /ZQ_GIT_AUTHOR_MAPPING needs Mattermost/,
  );
  assert.deepEqual(requested, []);
});

test("with both switches on exactly the two author tables are requested, once each", async () => {
  const w = world(BOTH);
  assert.deepEqual([...w.requested].sort(), [ALIASES, QUEUE]);
  w.service.push("client", "a");
  await w.fire();
  assert.deepEqual([...w.requested].sort(), [ALIASES, QUEUE]);
});

test("each commit of a service batch is classified: people are recorded, the rest is queued or dropped", async () => {
  const w = await afterBaseline();
  w.service.authoredBy(zhang, "s1", "s2");
  w.service.authoredBy(li, "s3");
  w.service.authoredBy(stranger, "s4");
  w.service.authoredBy(twin, "s5");
  w.service.authoredBy(bot, "s6");
  w.service.authoredBy(vendor, "s7");
  w.service.authoredBy(broken, "s8");
  w.service.push("client", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8");
  await w.fire();
  assert.equal(w.runtime!.status().lastResult, "ok");
  assert.equal(w.service.storedTip("client"), "s8");
  assert.deepEqual(
    w.authorSink.sent.map((n) => [n.person.personId, n.commits.map((c) => c.sha)]),
    [
      ["mm-zhang", ["s1", "s2"]],
      ["mm-li", ["s3"]],
    ],
  );
  assert.deepEqual(
    Object.fromEntries(queued(w.rows).map((e) => [e.email, [e.reason, e.count, e.status, e.candidates]])),
    {
      "wang.home@example.org": ["no_match", 1, "open", []],
      "chen@corp.example": ["ambiguous", 1, "open", ["mm-chen-1", "mm-chen-2"]],
      root: ["invalid_email", 1, "open", []],
    },
  );
  assert.deepEqual([...w.lookups].sort(), [
    "chen@corp.example",
    "li.na@corp.example",
    "wang.home@example.org",
    "zhang.wei@corp.example",
  ]);
});

test("a failed handler and a lost acknowledgement count each sha once and record each person once", async () => {
  const w = await afterBaseline();
  w.service.authoredBy(stranger, "u1", "u2");
  w.service.authoredBy(broken, "u3");
  w.service.authoredBy(zhang, "u4");
  w.service.push("client", "u1", "u2", "u3", "u4");
  w.failures.unmappedInserts = 2;
  await w.fire();
  assert.equal(w.runtime!.status().lastResult, "handler_failed");
  assert.equal(w.service.storedTip("client"), "base");
  assert.deepEqual(counts(w.rows), { "wang.home@example.org": 2 });
  assert.equal(w.authorSink.sent.length, 0);
  await w.fire();
  assert.equal(w.runtime!.status().lastResult, "ok");
  assert.equal(w.service.storedTip("client"), "u4");
  assert.deepEqual(counts(w.rows), { "wang.home@example.org": 2, root: 1 });
  assert.equal(w.authorSink.sent.length, 1);
  await w.fire();
  assert.deepEqual(counts(w.rows), { "wang.home@example.org": 2, root: 1 });
  assert.equal(w.authorSink.sent.length, 1);
});

test("after a restart the persisted queue is kept and redelivered commits are not counted again", async () => {
  const service = createFakeGitMcp();
  const first = await afterBaseline({ service });
  first.service.authoredBy(stranger, "r1", "r2");
  first.service.authoredBy(broken, "r3");
  first.service.push("client", "r1", "r2", "r3");
  first.failures.unmappedInserts = 2;
  await first.fire();
  assert.equal(first.service.storedTip("client"), "base");
  assert.deepEqual(counts(first.rows), { "wang.home@example.org": 2 });

  const second = world(BOTH, { service, rows: first.rows });
  assert.deepEqual(counts(second.rows), { "wang.home@example.org": 2 });
  await second.fire();
  assert.equal(second.service.storedTip("client"), "r3");
  assert.deepEqual(counts(second.rows), { "wang.home@example.org": 2, root: 1 });
  const entry = queued(second.rows).find((e) => e.email === "wang.home@example.org")!;
  assert.deepEqual(entry.recentShas, ["r1", "r2"]);
});

test("a failing directory leaves the commits un-acknowledged and they are mapped after recovery", async () => {
  let down = true;
  const people: PeopleDirectory = {
    async findByEmail() {
      if (down) throw new Error("directory is down");
      return [{ personId: "mm-zhang", mattermostUser: "mm-zhang" }];
    },
  };
  const w = await afterBaseline({ people });
  w.service.authoredBy(zhang, "p1");
  w.service.push("client", "p1");
  await w.fire();
  assert.equal(w.runtime!.status().lastResult, "handler_failed");
  assert.equal(w.service.storedTip("client"), "base");
  down = false;
  await w.fire();
  assert.equal(w.service.storedTip("client"), "p1");
  assert.deepEqual(
    w.authorSink.sent.map((n) => n.person.personId),
    ["mm-zhang"],
  );
  assert.deepEqual(queued(w.rows), []);
});

test("log lines carry email hashes and never an address, a name or a domain", async () => {
  const w = await afterBaseline();
  w.service.authoredBy(stranger, "l1");
  w.service.authoredBy(broken, "l2");
  w.service.authoredBy(zhang, "l3");
  w.service.push("client", "l1", "l2", "l3");
  await w.fire();
  const text = w.lines.join("\n");
  assert.ok(text.includes(hashEmail(stranger.email)));
  assert.ok(text.includes(hashEmail(broken.email)));
  for (const secret of [stranger.email, stranger.name, "example.org", "corp.example", zhang.name, broken.name])
    assert.ok(!text.includes(secret), secret);
});

test("nothing is sent: the recording sink is the only consumer and only the two author tables exist", async () => {
  const w = await afterBaseline();
  w.service.authoredBy(zhang, "m1");
  w.service.authoredBy(li, "m2");
  w.service.push("client", "m1", "m2");
  await w.fire();
  assert.equal(w.authorSink.sent.length, 2);
  assert.deepEqual([...w.rows.keys()].sort(), [ALIASES, QUEUE]);
  assert.equal(w.rows.get(ALIASES)!.size, 0);
  assert.equal(w.rows.get(QUEUE)!.size, 0);
});
