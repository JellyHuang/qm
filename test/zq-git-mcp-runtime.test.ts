import assert from "node:assert/strict";
import { test } from "node:test";
import { createSweeper, type Sweeper } from "../src/util/sweeper.ts";
import { GitMcpUnreachable } from "../src/zq/git-mcp/client.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import type { CommitSink } from "../src/zq/git-mcp/sink.ts";
import { createGitMcpRuntime } from "../src/zq/git-mcp/runtime.ts";
import { createFakeGitMcp, sharedLease } from "./support/fake-git-mcp.ts";

const SERVICE = { ZQ_GIT_MCP_URL: "http://127.0.0.1:8765/mcp", ZQ_GIT_MCP_SECRET: "a-shared-secret-0123456789" };

function world(env: NodeJS.ProcessEnv = { ...SERVICE, ZQ_GIT_POLL: "1" }, options: { sink?: CommitSink } = {}) {
  const service = createFakeGitMcp();
  const lease = sharedLease();
  const sweepers: { work: () => unknown; intervalMs: number; opts?: { label?: string; immediate?: boolean } }[] = [];
  const maps: string[] = [];
  const clients: { url: string; secret: string }[] = [];
  const lines = { info: [] as string[], error: [] as string[] };
  let clock = 1_000_000;
  const deps = {
    config: zqConfigFromEnv(env),
    leaderLease: lease,
    map: (table: string) => {
      maps.push(table);
      throw new Error("this phase creates no table");
    },
    createSweeper: (
      work: () => unknown,
      intervalMs: number,
      opts?: { label?: string; immediate?: boolean },
    ): Sweeper => {
      sweepers.push({ work, intervalMs, ...(opts ? { opts } : {}) });
      return { start() {}, stop: async () => {} };
    },
    createClient: (options: { url: string; secret: string }) => {
      clients.push(options);
      return service.client;
    },
    log: { info: (l: string) => lines.info.push(l), error: (l: string) => lines.error.push(l) },
    now: () => clock,
    ...(options.sink ? { sink: options.sink } : {}),
  };
  return {
    service,
    lease,
    sweepers,
    maps,
    clients,
    lines,
    advance: (ms: number) => void (clock += ms),
    runtime: createGitMcpRuntime(deps),
    fire: () => sweepers[0]!.work(),
  };
}

const recordingSink = (failures = 0) => {
  const seen: string[] = [];
  let left = failures;
  const sink: CommitSink = {
    async record(batches) {
      if (left-- > 0) throw new Error("sink is down");
      for (const batch of batches)
        for (const commit of batch.commits) seen.push(`${batch.repo}/${batch.branch}:${commit.sha}`);
    },
  };
  return { sink, seen };
};

for (const [name, env] of [
  ["with defaults", {}],
  ["with only the service address and secret", SERVICE],
  ["with ZQ_GIT_POLL=0", { ...SERVICE, ZQ_GIT_POLL: "0" }],
] as const) {
  test(`${name} nothing is built, scheduled, requested, leased or created`, async () => {
    const w = world(env);
    assert.equal(w.runtime, undefined);
    assert.equal(w.sweepers.length, 0);
    assert.equal(w.clients.length, 0);
    assert.equal(w.service.requests.length, 0);
    assert.deepEqual(w.lease.keys, []);
    assert.deepEqual(w.maps, []);
  });
}

test("with ZQ_GIT_POLL=1 there is one sweeper, one client for the service, the lease key zq:git-mcp and no table", async () => {
  const w = world();
  assert.ok(w.runtime);
  assert.equal(w.sweepers.length, 1);
  assert.equal(w.sweepers[0]!.intervalMs, 300_000);
  assert.equal(w.sweepers[0]!.opts?.label, "zq git commit poller");
  assert.deepEqual(w.clients, [{ url: SERVICE.ZQ_GIT_MCP_URL, secret: SERVICE.ZQ_GIT_MCP_SECRET }]);
  assert.equal(w.service.requests.length, 0);
  w.service.push("client", "a");
  await w.fire();
  assert.deepEqual(w.lease.keys, ["zq:git-mcp"]);
  assert.deepEqual(w.maps, []);
  assert.ok(w.service.requests.length > 0);
});

test("every poll names itself qm-poller and the contract is verified before each poll", async () => {
  const w = world();
  w.service.push("client", "a");
  await w.fire();
  await w.fire();
  assert.equal(w.service.requests[0]!.kind, "verify");
  assert.deepEqual([...new Set(w.service.polls().map((r) => r.caller))], ["qm-poller"]);
  assert.equal(w.service.requests.filter((r) => r.kind === "verify").length, 2);
});

test("the first poll records baselines, says so, reports nothing and counts as normal", async () => {
  const sink = recordingSink();
  const w = world(undefined, { sink: sink.sink });
  w.service.push("client", "a", "b");
  await w.fire();
  assert.ok(w.lines.info.some((l) => l.includes("baseline recorded for client")));
  assert.deepEqual(sink.seen, []);
  assert.deepEqual(w.lines.error, []);
  assert.equal(w.runtime!.status().lastResult, "baseline");
  assert.equal(w.runtime!.status().consecutiveFailures, 0);
  await w.fire();
  assert.equal(w.runtime!.status().lastResult, "ok");
});

test("new commits are counted per repo and branch, written nowhere else, and acknowledged after the handler", async () => {
  const w = world();
  w.service.push("client", "a");
  await w.fire();
  w.service.push("client", "b", "c");
  await w.fire();
  assert.ok(w.lines.info.includes("[zq git poll] client/main: 2 commits (updated)"));
  assert.equal(w.service.storedTip("client"), "c");
  assert.deepEqual(w.maps, []);
  assert.deepEqual(w.runtime!.status(), {
    lastPollAt: 1_000_000,
    lastResult: "ok",
    consecutiveFailures: 0,
    pendingAck: 0,
  });
});

test("a failing handler leaves the commits un-acked, shows them as pending and they come again exactly once into the sink", async () => {
  const sink = recordingSink(1);
  const w = world(undefined, { sink: sink.sink });
  w.service.push("client", "a");
  await w.fire();
  w.service.push("client", "b");
  await w.fire();
  assert.equal(w.service.storedTip("client"), "a");
  assert.deepEqual(w.runtime!.status(), {
    lastPollAt: 1_000_000,
    lastResult: "handler_failed",
    consecutiveFailures: 1,
    pendingAck: 1,
  });
  await w.fire();
  assert.equal(w.service.storedTip("client"), "b");
  assert.deepEqual(sink.seen, ["client/main:b"]);
  assert.deepEqual(w.runtime!.status(), {
    lastPollAt: 1_000_000,
    lastResult: "ok",
    consecutiveFailures: 0,
    pendingAck: 0,
  });
});

test("an ack lost to an unreachable service redelivers the batch, and the sink still sees each sha once", async () => {
  const sink = recordingSink();
  const w = world(undefined, { sink: sink.sink });
  w.service.push("client", "a");
  await w.fire();
  w.service.push("client", "b");
  let polls = 0;
  const original = w.service.client.checkUpdates;
  w.service.client.checkUpdates = async (caller, ack, repo) => {
    if (++polls === 2) throw new GitMcpUnreachable("connection reset");
    return original(caller, ack, repo);
  };
  await w.fire();
  assert.equal(w.runtime!.status().lastResult, "unreachable");
  assert.equal(w.runtime!.status().pendingAck, 1);
  assert.equal(w.service.storedTip("client"), "a");
  await w.fire();
  assert.equal(w.service.storedTip("client"), "b");
  assert.deepEqual(sink.seen, ["client/main:b"]);
});

test("an unreachable service is a visible failure, never no updates, and the log line is rate limited", async () => {
  const w = world();
  w.service.push("client", "a");
  w.service.state.down = true;
  for (let i = 0; i < 4; i++) await w.fire();
  assert.deepEqual(w.runtime!.status(), {
    lastPollAt: 1_000_000,
    lastResult: "unreachable",
    consecutiveFailures: 4,
    pendingAck: 0,
  });
  assert.equal(w.lines.error.length, 1);
  assert.match(w.lines.error[0]!, /unreachable: connect ECONNREFUSED/);
  assert.equal(w.service.polls().length, 0);
  w.advance(11 * 60_000);
  await w.fire();
  assert.equal(w.lines.error.length, 2);
  assert.match(w.lines.error[1]!, /\(3 similar failures not logged\)/);
  w.service.state.down = false;
  await w.fire();
  assert.equal(w.runtime!.status().lastResult, "baseline");
  assert.equal(w.runtime!.status().consecutiveFailures, 0);
});

test("a contract violation stops polling with an error and a visible state, and polling resumes once the service matches", async () => {
  const w = world();
  w.service.push("client", "a");
  await w.fire();
  w.service.state.drift = true;
  const before = w.service.polls().length;
  await w.fire();
  await w.fire();
  assert.equal(w.service.polls().length, before);
  assert.equal(w.runtime!.status().lastResult, "contract_violation");
  assert.equal(w.runtime!.status().consecutiveFailures, 2);
  assert.equal(w.lines.error.length, 1);
  assert.match(w.lines.error[0]!, /contract_violation: .*forbidden tools: push_files.*not polling/);
  w.service.state.drift = false;
  await w.fire();
  assert.equal(w.runtime!.status().lastResult, "ok");
  assert.equal(w.service.polls().length, before + 1);
});

function instance(
  service: ReturnType<typeof createFakeGitMcp>,
  lease: ReturnType<typeof sharedLease>,
  sink?: CommitSink,
) {
  let work!: () => unknown;
  const runtime = createGitMcpRuntime({
    config: zqConfigFromEnv({ ...SERVICE, ZQ_GIT_POLL: "1" }),
    leaderLease: lease,
    createSweeper: (fn) => {
      work = fn;
      return { start() {}, stop: async () => {} };
    },
    createClient: () => service.client,
    log: { info() {}, error() {} },
    ...(sink ? { sink } : {}),
  })!;
  return { runtime, fire: () => work() };
}

test("after a restart the new runtime continues from the service's stored tips and an un-acked batch is reported again", async () => {
  const service = createFakeGitMcp();
  const lease = sharedLease();
  const before = instance(service, lease);
  service.push("client", "a");
  await before.fire();
  service.push("client", "b", "c");
  await before.fire();
  assert.equal(service.storedTip("client"), "c");

  const afterRestart = recordingSink();
  const restarted = instance(service, lease, afterRestart.sink);
  await restarted.fire();
  assert.deepEqual(afterRestart.seen, []);
  service.push("client", "d");
  await restarted.fire();
  assert.deepEqual(afterRestart.seen, ["client/main:d"]);

  service.push("client", "e");
  const crashing = recordingSink(1);
  await instance(service, lease, crashing.sink).fire();
  assert.deepEqual(crashing.seen, []);
  assert.equal(service.storedTip("client"), "d");
  const recovered = recordingSink();
  await instance(service, lease, recovered.sink).fire();
  assert.deepEqual(recovered.seen, ["client/main:e"]);
  assert.equal(service.storedTip("client"), "e");
});

test("two instances sharing one lease never poll at once: the standby asks the service nothing", async () => {
  const service = createFakeGitMcp();
  const lease = sharedLease();
  const works: (() => unknown)[] = [];
  const build = () =>
    createGitMcpRuntime({
      config: zqConfigFromEnv({ ...SERVICE, ZQ_GIT_POLL: "1" }),
      leaderLease: lease,
      createSweeper: (work) => {
        works.push(work);
        return { start() {}, stop: async () => {} };
      },
      createClient: () => service.client,
      log: { info() {}, error() {} },
    })!;
  const leader = build();
  const standby = build();
  service.push("client", "a");
  let release!: () => void;
  service.state.gate = new Promise<void>((resolve) => (release = resolve));
  const first = works[0]!();
  await new Promise((resolve) => setImmediate(resolve));
  await works[1]!();
  assert.equal(standby.status().lastResult, "standby");
  assert.equal(service.requests.filter((r) => r.kind === "check_updates").length, 1);
  release();
  await first;
  assert.equal(leader.status().lastResult, "baseline");
  assert.equal(service.requests.filter((r) => r.kind === "check_updates").length, 1);
});

test("stop halts the schedule and waits for the tick in flight", async () => {
  const service = createFakeGitMcp();
  const runtime = createGitMcpRuntime({
    config: zqConfigFromEnv({ ...SERVICE, ZQ_GIT_POLL: "1" }),
    leaderLease: sharedLease(),
    createSweeper: createSweeper,
    createClient: () => service.client,
    log: { info() {}, error() {} },
  })!;
  service.push("client", "a");
  let release!: () => void;
  service.state.gate = new Promise<void>((resolve) => (release = resolve));
  runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.polls().length, 1);
  let stopped = false;
  const stopping = runtime.stop().then(() => void (stopped = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(runtime.status().lastResult, "baseline");
});
