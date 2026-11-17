import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { sleep } from "../src/async.ts";
import type { AuditRow, AuditTarget } from "../src/audit.ts";
import type { AuditAlarmEvent } from "../src/audit-pipeline.ts";
import { buildFixture, makeRoot, type Fixture } from "./support/fixtures.ts";
import { startHarness, testConfig, type Harness } from "./support/harness.ts";

const { root, cleanup } = makeRoot("zqgit-audit-service-");
let fx: Fixture;
let counter = 0;
before(() => {
  fx = buildFixture(root);
});
after(cleanup);

function target() {
  const state = { down: false, stored: [] as AuditRow[] };
  const sink: AuditTarget = {
    async record(row) {
      if (state.down) throw new Error("connection refused postgres://svc:hunter2@db.internal:5432/qm");
      state.stored.push(row);
    },
  };
  return { state, sink };
}

async function start(mode: "serve" | "fail", sink: AuditTarget) {
  const n = counter++;
  const events: AuditAlarmEvent[] = [];
  const lines: string[] = [];
  const h: Harness = await startHarness(
    testConfig(root, fx.remoteBase, {
      auditOnFailure: mode,
      clonesDir: join(root, `c-${n}`),
      auditSpoolDir: join(root, `spool-${n}`),
    }),
    {
      auditTarget: sink,
      alarm: (event) => events.push(event),
      log: (line) => lines.push(line),
      auditRetry: { initialMs: 20, maxMs: 40 },
    },
  );
  return { h, events, lines, spool: join(root, `spool-${n}`) };
}

async function until(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await sleep(20);
  return check();
}

const INTERNALS = /spool|backlog|audit|postgres|hunter2|connection refused|dropped|degraded/i;

describe("on failure serve", () => {
  test("calls keep working during a database outage, health shows the backlog and nothing else leaks into results", async () => {
    const { state, sink } = target();
    const { h, events, spool } = await start("serve", sink);
    try {
      state.down = true;
      const commits = await h.call("list_commits", { repo: "client", limit: 2 });
      assert.equal(commits.isError, false);
      assert.doesNotMatch(JSON.stringify(commits.body), INTERNALS);
      const refused = await h.call("read_file", { repo: "client", ref: "main", path: "../x" });
      assert.equal(refused.isError, true);
      assert.doesNotMatch(JSON.stringify(refused.body), INTERNALS);
      const repos = await h.call("list_repos", {});
      assert.equal(repos.body.auditDegraded, true);
      assert.ok((repos.body.auditBacklog as number) >= 2);
      assert.match(repos.body.auditLastError as string, /connection refused/);
      assert.doesNotMatch(repos.body.auditLastError as string, /hunter2|postgres:\/\//);
      assert.ok(events.some((event) => event.kind === "audit_write_failed"));
      assert.ok(readdirSync(spool).length >= 1);
      state.down = false;
      assert.equal(await until(() => state.stored.length >= 3), true);
      const after = await h.call("list_repos", {});
      assert.equal(after.body.auditDegraded, false);
      assert.equal(after.body.auditBacklog, 0);
      assert.deepEqual(
        state.stored.slice(0, 2).map((row) => [row.tool, row.result]),
        [
          ["list_commits", "ok"],
          ["read_file", "denied:bad_path"],
        ],
      );
      assert.ok(
        state.stored.every(
          (row) =>
            typeof row.principal === "string" && typeof row.ms === "number" && typeof row.cache_hit === "boolean",
        ),
      );
      assert.equal(new Set(state.stored.map((row) => row.id)).size, state.stored.length);
    } finally {
      await h.stop();
    }
  });
});

describe("on failure fail", () => {
  test("a failed audit write fails the call with a generic error and no audit internals", async () => {
    const { state, sink } = target();
    const { h, spool } = await start("fail", sink);
    try {
      state.down = true;
      const out = await h.call("list_commits", { repo: "client", limit: 1 });
      assert.equal(out.isError, true);
      assert.equal((out.body.error as { code: string }).code, "audit_unavailable");
      assert.doesNotMatch(JSON.stringify(out.body), /hunter2|postgres|connection refused|spool/i);
      assert.deepEqual(readdirSync(spool).length, 0);
      state.down = false;
      const ok = await h.call("list_commits", { repo: "client", limit: 1 });
      assert.equal(ok.isError, false);
      assert.equal(state.stored.length, 1);
    } finally {
      await h.stop();
    }
  });
});
