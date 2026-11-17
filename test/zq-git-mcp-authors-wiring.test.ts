import assert from "node:assert/strict";
import { test } from "node:test";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createAuthorAliases, type AuthorAlias } from "../src/zq/git-mcp/author-aliases.ts";
import { createRecordingSink } from "../src/zq/git-mcp/author-mapping.ts";
import { hashEmail, hashName } from "../src/zq/git-mcp/names.ts";
import { createMattermostPeopleDirectory, type PeopleDirectory, type Person } from "../src/zq/git-mcp/people.ts";
import { createGitMcpRuntime } from "../src/zq/git-mcp/runtime.ts";
import type { UnmappedAuthor } from "../src/zq/git-mcp/unmapped-queue.ts";
import { createFakeGitMcp, sharedLease, type FakeAuthor } from "./support/fake-git-mcp.ts";
import { memoryMap } from "./support/memory-map.ts";

const SERVICE = { ZQ_GIT_MCP_URL: "http://127.0.0.1:8765/mcp", ZQ_GIT_MCP_SECRET: "a-shared-secret-0123456789" };
const POLL = { ...SERVICE, ZQ_GIT_POLL: "1" };
const MAPPING = {
  ...POLL,
  ZQ_GIT_AUTHOR_MAPPING: "1",
  ZQ_GIT_BOT_NAMES: "dependabot",
  ZQ_GIT_EXTERNAL_DOMAINS: "@partnerco",
};
const FALLBACK = { ...MAPPING, ZQ_GIT_MATTERMOST_EMAIL_FALLBACK: "1" };
const ALIASES = "zq_git_author_aliases";
const QUEUE = "zq_git_unmapped_authors";

const alice: FakeAuthor = { name: "Alice Example", email: "Alice.Example+ci@corp.example" };
const bob: FakeAuthor = { name: "Bob Example", email: "bob.example@corp.example" };
const stranger: FakeAuthor = { name: "Wang", email: "wang.home@example.org" };
const twin: FakeAuthor = { name: "Chen", email: "chen@corp.example" };
const bot: FakeAuthor = { name: "ExampleBot.compiler", email: "examplebot@corp.example" };
const vendor: FakeAuthor = { name: "Zhao", email: "zhao@partnerco" };
const broken: FakeAuthor = { name: "Root", email: "root" };
const scripted: FakeAuthor = { name: "pipeline-sync", email: "@partnerco" };

const people = {
  alice: { personId: "p-alice", mattermostUser: "mm-alice" },
  bob: { personId: "p-bob", mattermostUser: "mm-bob" },
};

const MATTERMOST: Record<string, string[]> = {
  "alice.example+ci@corp.example": ["mm-alice"],
  "bob.example@corp.example": ["mm-bob"],
  "chen@corp.example": ["mm-chen-1", "mm-chen-2"],
};

type Rows = Map<string, Map<string, unknown>>;

interface Seed {
  person?: { name: string; person: Person; departedAt?: number };
  ignore?: { name: string; reason: "automation" | "external"; emailCondition?: string };
}

async function seed(rows: Rows, seeds: Seed[]) {
  if (!rows.has(ALIASES)) rows.set(ALIASES, new Map());
  const aliases = createAuthorAliases({ map: memoryMap<AuthorAlias>(rows.get(ALIASES) as Map<string, AuthorAlias>) });
  for (const { person, ignore } of seeds) {
    if (person)
      await aliases.insert({
        kind: "person",
        name: person.name,
        ...person.person,
        ...(person.departedAt === undefined ? {} : { departedAt: person.departedAt }),
        addedBy: "pm",
      });
    if (ignore) await aliases.insert({ kind: "ignored", ...ignore, addedBy: "pm" });
  }
}

const SEEDS: Seed[] = [
  { person: { name: "Alice Example", person: people.alice } },
  { person: { name: "Bob Example", person: people.bob } },
];

function world(
  env: NodeJS.ProcessEnv,
  options: {
    people?: PeopleDirectory;
    rows?: Rows;
    service?: ReturnType<typeof createFakeGitMcp>;
    failAliasReads?: boolean;
  } = {},
) {
  const service = options.service ?? createFakeGitMcp();
  const sweepers: (() => unknown)[] = [];
  const requested: string[] = [];
  const rows: Rows = options.rows ?? new Map();
  const lines: string[] = [];
  const lookups: string[] = [];
  const authorSink = createRecordingSink();
  const directory =
    options.people ??
    createMattermostPeopleDirectory(async (email) => {
      lookups.push(email);
      return MATTERMOST[email] ?? [];
    });
  const failures = { unmappedInserts: 0, aliasReads: options.failAliasReads === true };
  const runtime = createGitMcpRuntime({
    config: zqConfigFromEnv(env),
    leaderLease: sharedLease(),
    people: directory,
    authorSink,
    map: <T>(table: string): DurableMap<T> => {
      requested.push(table);
      if (!rows.has(table)) rows.set(table, new Map());
      const inner = memoryMap<T>(rows.get(table) as Map<string, T>);
      if (table === ALIASES)
        return {
          ...inner,
          async get(id: string) {
            if (failures.aliasReads) throw new Error("alias store is down");
            return inner.get(id);
          },
        } as DurableMap<T>;
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
const counts = (rows: Rows) => Object.fromEntries(queued(rows).map((e) => [e.nameKey, e.count]));

async function afterBaseline(
  env: NodeJS.ProcessEnv = MAPPING,
  options: Parameters<typeof world>[1] = {},
  seeds = SEEDS,
) {
  const rows = options.rows ?? new Map();
  await seed(rows, seeds);
  const w = world(env, { ...options, rows });
  w.service.push("client", "base");
  await w.fire();
  return w;
}

test("the defaults, the service address alone, the poll alone and settings without the mapping switch request no author table and look nobody up", async () => {
  const envs = [
    {},
    SERVICE,
    POLL,
    { ...POLL, ZQ_GIT_BOT_TOKENS: "bot,robot", ZQ_GIT_GENERIC_NAMES: "admin", ZQ_GIT_IDENTITY_ADMINS: "p-admin" },
    { ...POLL, ZQ_GIT_BIND_MAX_PER_PERSON: "3", ZQ_GIT_BOT_NAMES: "dependabot", ZQ_GIT_EXTERNAL_DOMAINS: "@partnerco" },
  ];
  for (const env of envs) {
    const w = world(env);
    w.service.push("client", "a");
    await w.fire();
    w.service.authoredBy(stranger, "b");
    w.service.authoredBy(alice, "c");
    w.service.push("client", "b", "c");
    await w.fire();
    assert.deepEqual(w.requested, [], JSON.stringify(env));
    assert.deepEqual(w.lookups, []);
    assert.deepEqual([w.authorSink.sent, w.authorSink.sentToPm, w.authorSink.claimAttempts], [[], [], []]);
    assert.equal(w.runtime?.identity, undefined);
    assert.deepEqual([...w.rows.keys()], []);
  }
});

test("the mapping alone requests exactly the two tables, builds no identity service and looks nobody up in the directory", async () => {
  const w = world(MAPPING);
  assert.deepEqual([...w.requested].sort(), [ALIASES, QUEUE]);
  w.service.push("client", "a");
  await w.fire();
  w.service.authoredBy(alice, "b");
  w.service.authoredBy(stranger, "c");
  w.service.push("client", "b", "c");
  await w.fire();
  assert.deepEqual(w.lookups, []);
  assert.equal(w.runtime?.identity, undefined);
  assert.deepEqual([...w.requested].sort(), [ALIASES, QUEUE]);
  assert.deepEqual([w.authorSink.sent, w.authorSink.sentToPm, w.authorSink.claimAttempts], [[], [], []]);
});

test("the bind switch builds the identity service and requests no further table", () => {
  const w = world({ ...MAPPING, ZQ_GIT_AUTHOR_BIND: "1" });
  assert.ok(w.runtime?.identity);
  assert.deepEqual([...w.requested].sort(), [ALIASES, QUEUE]);
});

test("the mapping switches without the poll or the mapping are configuration errors", () => {
  assert.throws(
    () => zqConfigFromEnv({ ...SERVICE, ZQ_GIT_AUTHOR_MAPPING: "1" }),
    /ZQ_GIT_AUTHOR_MAPPING needs ZQ_GIT_POLL=1/,
  );
  assert.throws(() => zqConfigFromEnv({ ZQ_GIT_AUTHOR_MAPPING: "1" }), /ZQ_GIT_AUTHOR_MAPPING needs ZQ_GIT_POLL=1/);
  assert.throws(
    () => zqConfigFromEnv({ ...POLL, ZQ_GIT_AUTHOR_BIND: "1" }),
    /ZQ_GIT_AUTHOR_BIND needs ZQ_GIT_AUTHOR_MAPPING=1/,
  );
  assert.throws(
    () => zqConfigFromEnv({ ...POLL, ZQ_GIT_MATTERMOST_EMAIL_FALLBACK: "1" }),
    /ZQ_GIT_MATTERMOST_EMAIL_FALLBACK needs ZQ_GIT_AUTHOR_MAPPING=1/,
  );
});

test("the Mattermost email fallback without Mattermost refuses to start and requests no table, the mapping alone does not need Mattermost", () => {
  const requested: string[] = [];
  const build = (env: NodeJS.ProcessEnv) =>
    createGitMcpRuntime({
      config: zqConfigFromEnv(env),
      leaderLease: sharedLease(),
      map: (table) => {
        requested.push(table);
        return memoryMap();
      },
      createSweeper: () => ({ start() {}, stop: async () => {} }),
    });
  assert.throws(() => build(FALLBACK), /ZQ_GIT_MATTERMOST_EMAIL_FALLBACK needs Mattermost/);
  assert.deepEqual(requested, []);
  assert.ok(build(MAPPING));
  assert.deepEqual([...requested].sort(), [ALIASES, QUEUE]);
});

test("each commit of a service batch is classified by name: people are recorded, the rest is queued or dropped", async () => {
  const w = await afterBaseline();
  w.service.authoredBy(alice, "s1", "s2");
  w.service.authoredBy(bob, "s3");
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
      ["p-alice", ["s1", "s2"]],
      ["p-bob", ["s3"]],
    ],
  );
  assert.deepEqual(
    Object.fromEntries(queued(w.rows).map((e) => [e.nameKey, [e.reason, e.count, e.status, e.candidates]])),
    {
      wang: ["no_match", 1, "open", []],
      chen: ["no_match", 1, "open", []],
      root: ["invalid_email", 1, "open", []],
    },
  );
  assert.deepEqual(w.lookups, []);
});

test("with the fallback on, an unbound author is matched by verified email, two people make it ambiguous, a name binding still wins", async () => {
  const w = await afterBaseline(FALLBACK, {}, [{ person: { name: "Bob Example", person: people.bob } }]);
  w.service.authoredBy({ name: "Alice Renamed", email: alice.email }, "f1");
  w.service.authoredBy(bob, "f2");
  w.service.authoredBy(twin, "f3");
  w.service.authoredBy(stranger, "f4");
  w.service.push("client", "f1", "f2", "f3", "f4");
  await w.fire();
  assert.deepEqual(
    w.authorSink.sent.map((n) => [n.person.personId, n.commits.map((c) => c.sha)]),
    [
      ["mm-alice", ["f1"]],
      ["p-bob", ["f2"]],
    ],
  );
  assert.deepEqual(Object.fromEntries(queued(w.rows).map((e) => [e.nameKey, [e.reason, e.candidates]])), {
    chen: ["ambiguous", ["mm-chen-1", "mm-chen-2"]],
    wang: ["no_match", []],
  });
  assert.deepEqual([...w.lookups].sort(), [
    "alice.example+ci@corp.example",
    "chen@corp.example",
    "wang.home@example.org",
  ]);
});

test("a commit by an ignored identity produces zero notices and zero queue rows through the whole poll", async () => {
  const w = await afterBaseline(MAPPING, {}, [...SEEDS, { ignore: { name: "pipeline-sync", reason: "automation" } }]);
  w.service.authoredBy(scripted, "i1", "i2", "i3");
  w.service.push("client", "i1", "i2", "i3");
  await w.fire();
  assert.equal(w.runtime!.status().lastResult, "ok");
  assert.equal(w.service.storedTip("client"), "i3");
  assert.deepEqual([w.authorSink.sent, w.authorSink.sentToPm, w.authorSink.claimAttempts], [[], [], []]);
  assert.deepEqual(queued(w.rows), []);
  assert.ok(
    w.lines.includes(`[zq git poll] zq git author ignored: ${hashName("pipeline-sync")} reason=automation commits=3`),
  );
});

test("a departed person's commits are recorded for the PM and not for the person", async () => {
  const w = await afterBaseline(MAPPING, {}, [
    { person: { name: "Alice Example", person: people.alice, departedAt: 1 } },
  ]);
  w.service.authoredBy(alice, "d1", "d2");
  w.service.push("client", "d1", "d2");
  await w.fire();
  assert.deepEqual(w.authorSink.sent, []);
  assert.deepEqual(
    w.authorSink.sentToPm.map((n) => [n.person.personId, n.commits.map((c) => c.sha)]),
    [["p-alice", ["d1", "d2"]]],
  );
  assert.deepEqual(queued(w.rows), []);
});

test("a failed handler and a lost acknowledgement count each sha once and record each person once", async () => {
  const w = await afterBaseline();
  w.service.authoredBy(stranger, "u1", "u2");
  w.service.authoredBy(broken, "u3");
  w.service.authoredBy(alice, "u4");
  w.service.push("client", "u1", "u2", "u3", "u4");
  w.failures.unmappedInserts = 2;
  await w.fire();
  assert.equal(w.runtime!.status().lastResult, "handler_failed");
  assert.equal(w.service.storedTip("client"), "base");
  assert.deepEqual(counts(w.rows), { wang: 2 });
  assert.equal(w.authorSink.sent.length, 0);
  await w.fire();
  assert.equal(w.runtime!.status().lastResult, "ok");
  assert.equal(w.service.storedTip("client"), "u4");
  assert.deepEqual(counts(w.rows), { wang: 2, root: 1 });
  assert.equal(w.authorSink.sent.length, 1);
  await w.fire();
  assert.deepEqual(counts(w.rows), { wang: 2, root: 1 });
  assert.equal(w.authorSink.sent.length, 1);
});

test("after a restart the persisted queue is kept and redelivered commits are not counted again", async () => {
  const service = createFakeGitMcp();
  const first = await afterBaseline(MAPPING, { service });
  first.service.authoredBy(stranger, "r1", "r2");
  first.service.authoredBy(broken, "r3");
  first.service.push("client", "r1", "r2", "r3");
  first.failures.unmappedInserts = 2;
  await first.fire();
  assert.equal(first.service.storedTip("client"), "base");
  assert.deepEqual(counts(first.rows), { wang: 2 });

  const second = world(MAPPING, { service, rows: first.rows });
  assert.deepEqual(counts(second.rows), { wang: 2 });
  await second.fire();
  assert.equal(second.service.storedTip("client"), "r3");
  assert.deepEqual(counts(second.rows), { wang: 2, root: 1 });
  const entry = queued(second.rows).find((e) => e.nameKey === "wang")!;
  assert.deepEqual(entry.recentShas, ["r1", "r2"]);
});

test("a failing name store leaves the commits un-acknowledged and they are mapped after recovery", async () => {
  const rows: Rows = new Map();
  await seed(rows, SEEDS);
  const w = world(MAPPING, { rows });
  w.service.push("client", "base");
  await w.fire();
  w.failures.aliasReads = true;
  w.service.authoredBy(alice, "p1");
  w.service.push("client", "p1");
  await w.fire();
  assert.equal(w.runtime!.status().lastResult, "handler_failed");
  assert.equal(w.service.storedTip("client"), "base");
  w.failures.aliasReads = false;
  await w.fire();
  assert.equal(w.service.storedTip("client"), "p1");
  assert.deepEqual(
    w.authorSink.sent.map((n) => n.person.personId),
    ["p-alice"],
  );
  assert.deepEqual(queued(w.rows), []);
});

test("a failing directory with the fallback on leaves the commits un-acknowledged and they are mapped after recovery", async () => {
  let down = true;
  const directory: PeopleDirectory = {
    async findByEmail() {
      if (down) throw new Error("directory is down");
      return [{ personId: "mm-alice", mattermostUser: "mm-alice" }];
    },
  };
  const w = await afterBaseline(FALLBACK, { people: directory }, []);
  w.service.authoredBy(alice, "p1");
  w.service.push("client", "p1");
  await w.fire();
  assert.equal(w.runtime!.status().lastResult, "handler_failed");
  assert.equal(w.service.storedTip("client"), "base");
  down = false;
  await w.fire();
  assert.equal(w.service.storedTip("client"), "p1");
  assert.deepEqual(
    w.authorSink.sent.map((n) => n.person.personId),
    ["mm-alice"],
  );
});

test("log lines carry hashes and never an address, a name or a domain", async () => {
  const w = await afterBaseline(MAPPING, {}, [...SEEDS, { ignore: { name: "pipeline-sync", reason: "automation" } }]);
  w.service.authoredBy(stranger, "l1");
  w.service.authoredBy(broken, "l2");
  w.service.authoredBy(alice, "l3");
  w.service.authoredBy(scripted, "l4");
  w.service.push("client", "l1", "l2", "l3", "l4");
  await w.fire();
  const text = w.lines.join("\n");
  assert.ok(text.includes(hashEmail(stranger.email)));
  assert.ok(text.includes(hashName(stranger.name)));
  assert.ok(text.includes(hashName(scripted.name)));
  for (const secret of [
    stranger.email,
    stranger.name,
    "example.org",
    "corp.example",
    alice.name,
    broken.name,
    scripted.name,
    "partnerco",
  ])
    assert.ok(!text.includes(secret), secret);
});

test("nothing is sent: the recording sink is the only consumer and only the two author tables exist", async () => {
  const w = await afterBaseline();
  w.service.authoredBy(alice, "m1");
  w.service.authoredBy(bob, "m2");
  w.service.push("client", "m1", "m2");
  await w.fire();
  assert.equal(w.authorSink.sent.length, 2);
  assert.deepEqual([...w.rows.keys()].sort(), [ALIASES, QUEUE]);
  assert.equal(w.rows.get(ALIASES)!.size, 2);
  assert.equal(w.rows.get(QUEUE)!.size, 0);
});
