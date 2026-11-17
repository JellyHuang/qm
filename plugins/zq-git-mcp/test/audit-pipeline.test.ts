import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { sleep } from "../src/async.ts";
import { AuditUnavailableError, type AuditRow, type AuditTarget } from "../src/audit.ts";
import { createAuditPipeline, type AuditAlarmEvent, type AuditPipeline } from "../src/audit-pipeline.ts";
import { makeRoot } from "./support/fixtures.ts";

const { root, cleanup } = makeRoot("zqgit-spool-");
after(cleanup);
let counter = 0;

const row = (n: number, at = Date.now()): AuditRow => ({
  id: `id-${String(n).padStart(4, "0")}`,
  at,
  principal: "tester",
  tool: "read_file",
  args: {},
  bytes: n,
  truncated: false,
  result: "ok",
  ms: 1,
  cache_hit: false,
});

function fakeTarget() {
  const state = { down: false, stored: [] as AuditRow[], failAfter: Infinity };
  const target: AuditTarget = {
    async record(entry) {
      if (state.down || state.stored.length >= state.failAfter)
        throw new Error("connection refused postgres://user:secret@db.example/qm");
      if (!state.stored.some((existing) => existing.id === entry.id)) state.stored.push(entry);
    },
  };
  return { state, target };
}

function pipelineFor(
  target: AuditTarget,
  options: Partial<Parameters<typeof createAuditPipeline>[0]> & { dir?: string } = {},
) {
  const dir = options.dir ?? join(root, `spool-${counter++}`);
  const events: AuditAlarmEvent[] = [];
  const lines: string[] = [];
  const pipeline = createAuditPipeline({
    target,
    onFailure: "serve",
    spoolDir: dir,
    spoolMaxBytes: 1024 * 1024,
    spoolMaxAgeMs: 3_600_000,
    retryInitialMs: 10,
    retryMaxMs: 40,
    alarm: (event) => events.push(event),
    log: (line) => lines.push(line),
    ...options,
  });
  return { pipeline, dir, events, lines };
}

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(10);
  }
  return check();
}

const ids = (rows: AuditRow[]) => rows.map((entry) => entry.id);
const stopAfter = async (pipeline: AuditPipeline, fn: () => Promise<void>) => {
  try {
    await fn();
  } finally {
    await pipeline.stop();
  }
};

describe("serve mode", () => {
  test("a database outage never fails the call, spools in order, raises alarms and replays once each on recovery", async () => {
    const { state, target } = fakeTarget();
    const { pipeline, dir, events, lines } = pipelineFor(target);
    await pipeline.start();
    await stopAfter(pipeline, async () => {
      await pipeline.record(row(1));
      state.down = true;
      for (const n of [2, 3, 4]) await pipeline.record(row(n));
      const degraded = pipeline.health();
      assert.equal(degraded.auditDegraded, true);
      assert.equal(degraded.auditBacklog, 3);
      assert.match(degraded.auditLastError ?? "", /connection refused/);
      assert.doesNotMatch(degraded.auditLastError ?? "", /secret|postgres:\/\//);
      assert.ok(events.some((event) => event.kind === "audit_write_failed"));
      assert.ok(lines.length >= 1);
      for (const line of lines) assert.equal(JSON.parse(line).component, "zq-git-mcp");
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      for (const file of readdirSync(dir)) assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
      await sleep(60);
      assert.equal(pipeline.health().auditBacklog, 3);
      state.down = false;
      assert.equal(await until(() => pipeline.health().auditBacklog === 0), true);
      assert.deepEqual(ids(state.stored), ["id-0001", "id-0002", "id-0003", "id-0004"]);
      assert.equal(pipeline.health().auditDegraded, false);
      assert.ok(events.some((event) => event.kind === "audit_recovered"));
      assert.deepEqual(readdirSync(dir), []);
    });
  });

  test("rows recorded while a backlog exists queue behind it so the order is kept", async () => {
    const { state, target } = fakeTarget();
    const { pipeline } = pipelineFor(target, { retryInitialMs: 30, retryMaxMs: 30 });
    await pipeline.start();
    await stopAfter(pipeline, async () => {
      state.down = true;
      await pipeline.record(row(1));
      state.down = false;
      await pipeline.record(row(2));
      await pipeline.record(row(3));
      assert.equal(await until(() => state.stored.length === 3), true);
      assert.deepEqual(ids(state.stored), ["id-0001", "id-0002", "id-0003"]);
    });
  });

  test("a failure in the middle of a replay keeps the rest and never inserts a row twice", async () => {
    const { state, target } = fakeTarget();
    const { pipeline } = pipelineFor(target);
    await pipeline.start();
    await stopAfter(pipeline, async () => {
      state.down = true;
      for (const n of [1, 2, 3, 4, 5]) await pipeline.record(row(n));
      state.down = false;
      state.failAfter = 2;
      assert.equal(await until(() => state.stored.length === 2), true);
      await sleep(60);
      assert.equal(pipeline.health().auditBacklog, 3);
      state.failAfter = Infinity;
      assert.equal(await until(() => pipeline.health().auditBacklog === 0), true);
      assert.deepEqual(ids(state.stored), ["id-0001", "id-0002", "id-0003", "id-0004", "id-0005"]);
    });
  });

  test("the spool survives a restart and is replayed on startup", async () => {
    const down = fakeTarget();
    down.state.down = true;
    const dir = join(root, `restart-${counter++}`);
    const first = pipelineFor(down.target, { dir, retryInitialMs: 5000, retryMaxMs: 5000 });
    await first.pipeline.start();
    for (const n of [1, 2, 3]) await first.pipeline.record(row(n));
    await first.pipeline.stop();
    assert.equal(readdirSync(dir).length, 1);
    assert.equal(
      readFileSync(join(dir, readdirSync(dir)[0] ?? ""), "utf8")
        .trim()
        .split("\n").length,
      3,
    );
    const up = fakeTarget();
    const second = pipelineFor(up.target, { dir });
    assert.equal(second.pipeline.health().auditBacklog, 0);
    await second.pipeline.start();
    await stopAfter(second.pipeline, async () => {
      assert.deepEqual(ids(up.state.stored), ["id-0001", "id-0002", "id-0003"]);
      assert.equal(second.pipeline.health().auditBacklog, 0);
      assert.deepEqual(readdirSync(dir), []);
    });
  });

  test("reaching the spool size bound drops new rows loudly with a counter and an alarm", async () => {
    const { state, target } = fakeTarget();
    state.down = true;
    const { pipeline, events, lines } = pipelineFor(target, {
      spoolMaxBytes: 700,
      retryInitialMs: 5000,
      retryMaxMs: 5000,
    });
    await pipeline.start();
    await stopAfter(pipeline, async () => {
      for (let n = 1; n <= 8; n++) await pipeline.record(row(n));
      const health = pipeline.health();
      assert.ok(health.auditBacklog >= 1 && health.auditBacklog < 8);
      assert.equal(health.auditDropped, 8 - health.auditBacklog);
      assert.equal(health.auditDegraded, true);
      const drops = events.filter((event) => event.kind === "audit_dropped");
      assert.equal(drops.length, health.auditDropped);
      assert.ok(drops.every((event) => event.kind === "audit_dropped" && event.reason === "spool_full"));
      assert.ok(lines.filter((line) => line.includes("audit_dropped")).length >= health.auditDropped);
      state.down = false;
    });
  });

  test("spooled rows older than the maximum age are dropped and counted at replay", async () => {
    const t0 = 1_000_000;
    let clock = t0;
    const dir = join(root, `age-${counter++}`);
    const outage = fakeTarget();
    outage.state.down = true;
    const first = pipelineFor(outage.target, {
      dir,
      spoolMaxAgeMs: 10_000,
      now: () => clock,
      retryInitialMs: 5000,
      retryMaxMs: 5000,
    });
    await first.pipeline.start();
    await first.pipeline.record(row(1, t0));
    await first.pipeline.record(row(2, t0 + 20_000));
    await first.pipeline.stop();
    clock = t0 + 25_000;
    const up = fakeTarget();
    const second = pipelineFor(up.target, { dir, spoolMaxAgeMs: 10_000, now: () => clock });
    await second.pipeline.start();
    await stopAfter(second.pipeline, async () => {
      assert.deepEqual(ids(up.state.stored), ["id-0002"]);
      assert.equal(second.pipeline.health().auditDropped, 1);
      assert.ok(second.events.some((event) => event.kind === "audit_dropped" && event.reason === "expired"));
    });
  });
});

describe("fail mode", () => {
  test("a failed audit write fails the call, is counted and raises the alarm", async () => {
    const { state, target } = fakeTarget();
    state.down = true;
    const { pipeline, events, dir } = pipelineFor(target, { onFailure: "fail" });
    await pipeline.start();
    await stopAfter(pipeline, async () => {
      await assert.rejects(pipeline.record(row(1)), (e) => e instanceof AuditUnavailableError);
      assert.equal(pipeline.health().auditFailures, 1);
      assert.equal(pipeline.health().auditDegraded, true);
      assert.ok(events.some((event) => event.kind === "audit_write_failed"));
      assert.deepEqual(readdirSync(dir).filter(Boolean), []);
      state.down = false;
      await pipeline.record(row(2));
      assert.equal(pipeline.health().auditDegraded, false);
      assert.deepEqual(ids(state.stored), ["id-0002"]);
    });
  });
});
