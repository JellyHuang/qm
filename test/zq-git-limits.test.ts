import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import { createToolContext } from "../src/tools/primitives.ts";
import { scopeId } from "../src/types.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createAuthorResolver } from "../src/zq/git/authors.ts";
import { createGitAudit, resultBytes, type GitAuditRow } from "../src/zq/git/audit.ts";
import { DEFAULT_GIT_LIMITS, GitRateLimited, createGitLimits, type GitLimitsConfig } from "../src/zq/git/limits.ts";
import { createGitReadonly, setZqGit, zqGit } from "../src/zq/git/readonly.ts";
import { keyFileFrom, type GitRunner } from "../src/zq/git/runner.ts";
import { createZqRuntime } from "../src/zq/runtime.ts";
import { GIT_REPOS } from "../src/zq/git/validate.ts";
import { testMap } from "./support/test-database.ts";

const MINUTE = 60_000;
const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 5, 10, 0, 0);
const BRANCH_ROW = `main\u001f${"a".repeat(40)}\u001f2026-01-05T10:00:00+00:00\n`;

function setup(limits: Partial<GitLimitsConfig> = {}) {
  let clock = START;
  const now = () => clock++;
  const runs: string[][] = [];
  const output = { stdout: BRANCH_ROW };
  const runner: GitRunner = {
    async run(_dir, args) {
      runs.push([...args]);
      return { stdout: Buffer.from(output.stdout), truncated: false, cutBytes: 0 };
    },
  };
  const audit = createGitAudit({ map: testMap<GitAuditRow>(), now });
  const gate = createGitLimits({
    config: { ...DEFAULT_GIT_LIMITS, ...limits },
    bytesSince: audit.bytesSince,
    now,
  });
  const readonly = createGitReadonly({
    config: { dir: "/clones", remotes: {} },
    runner,
    audit,
    limits: gate,
    now,
  });
  return {
    readonly,
    audit,
    runs,
    output,
    advance: (ms: number) => void (clock += ms),
  };
}

const refused = (promise: Promise<unknown>) => assert.rejects(promise, (e) => e instanceof GitRateLimited);

test("the per-person calls-per-minute limit refuses, audits rate_limited, starts no git and recovers next minute", async () => {
  const { readonly, audit, runs, advance } = setup({ callsPerMinute: 2 });
  await readonly.branches("alice", "server");
  await readonly.branches("alice", "server");
  assert.equal(runs.length, 2);
  await assert.rejects(readonly.branches("alice", "server"), /rate_limited: at most 2 git calls per minute/);
  assert.equal(runs.length, 2);
  await readonly.branches("bob", "server");
  assert.equal(runs.length, 3);
  const rows = await audit.rows();
  assert.deepEqual(
    rows.map((r) => [r.principal, r.result]),
    [
      ["alice", "ok"],
      ["alice", "ok"],
      ["alice", "rate_limited"],
      ["bob", "ok"],
    ],
  );
  assert.equal(rows[2]!.bytes, 0);
  advance(MINUTE);
  await readonly.branches("alice", "server");
  assert.equal(runs.length, 4);
});

test("the global calls-per-minute limit refuses everyone and recovers after the window", async () => {
  const { readonly, audit, runs, advance } = setup({ globalCallsPerMinute: 3 });
  for (const who of ["a", "b", "c"]) await readonly.branches(who, "server");
  await assert.rejects(readonly.branches("d", "server"), /QM is at its 3 git calls per minute/);
  await refused(readonly.commit("a", "server", "abcdef1"));
  assert.equal(runs.length, 3);
  assert.deepEqual(
    (await audit.rows()).slice(3).map((r) => [r.tool, r.result]),
    [
      ["git_branches", "rate_limited"],
      ["git_commit", "rate_limited"],
    ],
  );
  advance(MINUTE);
  await readonly.branches("d", "server");
  assert.equal(runs.length, 4);
});

test("refused calls do not use up the window", async () => {
  const { readonly, advance } = setup({ callsPerMinute: 1 });
  await readonly.branches("alice", "server");
  for (let i = 0; i < 5; i++) await refused(readonly.branches("alice", "server"));
  advance(MINUTE);
  await readonly.branches("alice", "server");
});

test("the daily byte budget is strict: a result that would cross it is refused with no content and no bytes, and a smaller call still fits", async () => {
  const probe = setup();
  const full = await probe.readonly.branches("alice", "server");
  const size = resultBytes(full);
  const { readonly, audit, runs, output, advance } = setup({ dailyBytes: size + 40 });
  await readonly.branches("alice", "server");
  assert.equal((await audit.rows())[0]!.bytes, size);
  advance(5 * MINUTE);
  let content: unknown;
  await assert.rejects(
    readonly.branches("alice", "server").then((value) => (content = value)),
    /rate_limited: this result would exceed the daily git read budget of \d+ bytes/,
  );
  assert.equal(content, undefined);
  assert.equal(runs.length, 2);
  const rows = await audit.rows();
  assert.deepEqual([rows[1]!.result, rows[1]!.bytes], ["rate_limited", 0]);
  assert.equal(await audit.bytesSince("alice", 0), size);
  assert.ok((await readonly.branches("bob", "server")).branches.length > 0);
  output.stdout = "";
  assert.deepEqual((await readonly.branches("alice", "server")).branches, []);
  output.stdout = BRANCH_ROW;
  advance(DAY);
  await readonly.branches("alice", "server");
});

test("a person already at the budget is refused before any git process starts and the budget resets the next UTC day", async () => {
  const { readonly, audit, runs, advance } = setup({ dailyBytes: 1 });
  await refused(readonly.branches("alice", "server"));
  assert.equal(runs.length, 1);
  assert.equal((await audit.rows())[0]!.bytes, 0);
  await audit.audited("alice", "git_branches", {}, async () => ({ truncated: false }));
  advance(MINUTE);
  await assert.rejects(readonly.branches("alice", "server"), /daily git read budget of 1 bytes is spent/);
  assert.equal(runs.length, 1);
  advance(DAY);
  await refused(readonly.branches("alice", "server"));
  assert.equal(runs.length, 2);
});

test("the fetch path is not subject to the read limits", async () => {
  const { readonly, runs } = setup({ callsPerMinute: 1, globalCallsPerMinute: 1, dailyBytes: 1 });
  await assert.rejects(readonly.fetchRepo("server"), /no remote configured/);
  assert.equal(runs.length, 0);
});

test("a commit author is matched only when exactly one person has that email", async () => {
  const directory: Record<string, string[]> = {
    "alice@example.test": ["mm-alice"],
    "twin@example.test": ["mm-one", "mm-two"],
    "dup@example.test": ["mm-same", "mm-same"],
  };
  const seen: string[] = [];
  const resolver = createAuthorResolver({
    mmUserIdsOfEmail: async (email) => {
      seen.push(email);
      return directory[email] ?? [];
    },
  });
  assert.deepEqual(await resolver.resolve("  Alice@Example.test "), { kind: "person", mmUserId: "mm-alice" });
  assert.deepEqual(await resolver.resolve("nobody@example.test"), { kind: "unmatched" });
  assert.deepEqual(await resolver.resolve("twin@example.test"), { kind: "unmatched" });
  assert.deepEqual(await resolver.resolve("dup@example.test"), { kind: "person", mmUserId: "mm-same" });
  assert.deepEqual(await resolver.resolve("not-an-email"), { kind: "unmatched" });
  assert.deepEqual(await resolver.resolve(""), { kind: "unmatched" });
  assert.equal(seen.includes("not-an-email"), false);
  const failing = createAuthorResolver({
    mmUserIdsOfEmail: async () => {
      throw new Error("directory down");
    },
  });
  assert.deepEqual(await failing.resolve("alice@example.test"), { kind: "unmatched" });
});

function toolsFor(principal: string, opts: { readOnly?: boolean } = {}) {
  const ctx = createToolContext({
    sandbox: { profile: { backend: "sprites" } } as never,
    provision: async () => ({ id: "h", rootDir: "/workspace" }),
    writableScopeId: scopeId("channel", "C1"),
    readOnlyScopeIds: [],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    deploy: {} as never,
    acl: {} as never,
    createdBy: principal,
  });
  return createAgentTools({ current: ctx }, opts);
}

const GIT_TOOLS = ["git_recent_commits", "git_commit", "git_diff", "git_file_at", "git_blame", "git_branches"];
const run = (tool: { execute: unknown } | undefined, params: unknown) => {
  assert.ok(tool);
  return (tool.execute as (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }>)("t", params);
};

test("git tools exist only when the module is enabled and the turn is not read-only", async () => {
  const names = (tools: ReturnType<typeof toolsFor>) => tools.map((t) => t.name).filter((n) => n.startsWith("git_"));
  setZqGit(undefined);
  assert.deepEqual(names(toolsFor("alice@example.test")), []);
  const { readonly } = setup();
  setZqGit(readonly);
  try {
    assert.equal(zqGit(), readonly);
    assert.deepEqual(names(toolsFor("alice@example.test")), GIT_TOOLS);
    assert.deepEqual(names(toolsFor("alice@example.test", { readOnly: true })), []);
  } finally {
    setZqGit(undefined);
  }
});

test("git tools call the module as the turn's person, reject other repositories before git runs and report errors as text", async () => {
  const { readonly, audit, runs } = setup({ callsPerMinute: 2 });
  setZqGit(readonly);
  try {
    const tools = toolsFor("alice@example.test");
    const branches = tools.find((t) => t.name === "git_branches");
    const out = await run(branches, { repo: "server" });
    assert.deepEqual(JSON.parse(out.content[0]!.text).branches, [
      { name: "main", sha: "a".repeat(40), date: "2026-01-05T10:00:00+00:00" },
    ]);
    assert.equal((await audit.rows())[0]!.principal, "alice@example.test");

    const outside = await run(
      tools.find((t) => t.name === "git_commit"),
      { repo: "secrets", sha: "abcdef1" },
    );
    assert.match(outside.content[0]!.text, /^\[error\] /);
    assert.equal(runs.length, 1);
    assert.equal((await audit.rows()).at(-1)!.result, "denied:repo_not_allowed");

    const limited = await run(branches, { repo: "server" });
    assert.match(limited.content[0]!.text, /^\[error\] rate_limited: /);
    assert.equal(runs.length, 1);

    const schema = JSON.stringify(branches!.parameters);
    for (const repo of GIT_REPOS) assert.ok(schema.includes(`"${repo}"`));
  } finally {
    setZqGit(undefined);
  }
});

test("the git limits default sanely and every one is configurable and validated", () => {
  const defaults = zqConfigFromEnv({}).git.limits;
  assert.deepEqual(defaults, { callsPerMinute: 30, globalCallsPerMinute: 120, dailyBytes: 20 * 1024 * 1024 });
  const set = zqConfigFromEnv({
    ZQ_GIT_CALLS_PER_MINUTE: "5",
    ZQ_GIT_GLOBAL_CALLS_PER_MINUTE: "50",
    ZQ_GIT_DAILY_BYTES: "1048576",
  }).git.limits;
  assert.deepEqual(set, { callsPerMinute: 5, globalCallsPerMinute: 50, dailyBytes: 1048576 });
  for (const name of ["ZQ_GIT_CALLS_PER_MINUTE", "ZQ_GIT_GLOBAL_CALLS_PER_MINUTE", "ZQ_GIT_DAILY_BYTES"])
    for (const bad of ["0", "-1", "1.5", "lots"])
      assert.throws(() => zqConfigFromEnv({ [name]: bad }), new RegExp(name));
});

test("the deploy key is written to a private file for the call only and removed even when it fails", async () => {
  let seen = "";
  const withKey = keyFileFrom(async () => "KEY-MATERIAL");
  await withKey(async (file) => {
    seen = file;
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
    assert.equal(readFileSync(file, "utf8"), "KEY-MATERIAL\n");
  });
  assert.equal(existsSync(seen), false);
  await assert.rejects(
    withKey(async (file) => {
      seen = file;
      throw new Error("fetch failed");
    }),
    /fetch failed/,
  );
  assert.equal(existsSync(dirname(seen)), false);
  const noKey = keyFileFrom(async () => {
    throw new Error("no key");
  });
  await assert.rejects(
    noKey(async () => "unreachable"),
    /no key/,
  );
});

test("the runtime builds the module only when enabled and offers an author resolver from the Mattermost lookup", async () => {
  const chat = {
    sendDm: async () => {},
    sendButtons: async () => {},
    mmUserIdOf: async () => undefined,
    principalOf: async () => undefined,
    mmUserIdsOfEmail: async (email: string) => (email === "alice@example.test" ? ["mm-alice"] : []),
  };
  const build = (env: NodeJS.ProcessEnv, readKey?: () => Promise<string>) =>
    createZqRuntime({
      config: zqConfigFromEnv(env),
      call: async () => "{}",
      chat,
      map: () => testMap(),
      leaderLease: { hold: async (_key, fn) => fn(new Promise<void>(() => {})) },
      createSweeper: () => ({ start() {}, stop: async () => {} }),
      ...(readKey ? { readKey } : {}),
    });
  assert.equal(build({}).git, undefined);
  const on = { ZQ_GIT_READONLY: "1", ZQ_GIT_DIR: "/clones" };
  assert.throws(() => build(on), /keychain/);
  const runtime = build(on, async () => "KEY");
  assert.ok(runtime.git);
  assert.deepEqual(await runtime.commitAuthors?.resolve("Alice@example.test"), {
    kind: "person",
    mmUserId: "mm-alice",
  });
  assert.deepEqual(await runtime.commitAuthors?.resolve("bob@example.test"), { kind: "unmatched" });
});
