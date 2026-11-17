import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { sleep } from "../src/async.ts";
import { ALICE, BOB, buildFixture, commitAll, makeRoot, pushAll, type Fixture } from "./support/fixtures.ts";
import { SECRET, startHarness, testConfig, type Harness } from "./support/harness.ts";
import { writeLargeXlsx, type LargeSpec } from "./support/xlsx-builder.ts";

const { root, cleanup } = makeRoot("zqgit-xlsx-large-");
const SPEC: LargeSpec = { rows: 400_000, pool: 100_000, changeEvery: 800, dropEvery: 4000, extraRows: 100 };
let fx: Fixture;
let base = "";
let head = "";
let sharedBytes = 0;

before(() => {
  fx = buildFixture(root);
  const work = fx.work.server;
  writeLargeXlsx(join(work, "big.xlsx"), SPEC, "base");
  base = commitAll(work, "big one", ALICE, "2025-04-01T10:00:00Z");
  writeLargeXlsx(join(work, "big.xlsx"), SPEC, "head");
  head = commitAll(work, "big two", BOB, "2025-04-02T10:00:00Z");
  pushAll(work);
  sharedBytes = SPEC.pool * 60;
});
after(cleanup);

const threads = () => readdirSync("/proc/self/task").length;

async function until(check: () => boolean, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

function expected() {
  let changedRows = 0;
  let removed = 0;
  for (let i = 1; i <= SPEC.rows; i++) {
    if (i % SPEC.dropEvery === 0) removed++;
    else if (i % SPEC.changeEvery === 0) changedRows++;
  }
  return { changedRows, removed };
}

async function harnessFor(overrides: Parameters<typeof testConfig>[2], name: string): Promise<Harness> {
  return startHarness(
    testConfig(root, fx.remoteBase, {
      clonesDir: join(root, name, "clones"),
      scratchDir: join(root, name, "scratch"),
      cacheDir: join(root, name, "cache"),
      cacheCapBytes: 1024 * 1024 * 1024,
      ...overrides,
    }),
  );
}

const args = () => ({ repo: "server", path: "big.xlsx", base, head });

describe("a 400k row workbook with a multi-megabyte shared string table", () => {
  let h: Harness;
  before(async () => {
    h = await harnessFor({ xlsxTimeoutMs: 600_000 }, "run");
  });
  after(async () => {
    await h.stop();
  });

  test("is compared with bounded memory, exact counts and no scratch left behind", async (t) => {
    const file = join(fx.work.server, "big.xlsx");
    assert.ok(statSync(file).size > 5 * 1024 * 1024);
    assert.ok(sharedBytes >= 5 * 1024 * 1024);
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 25);
    const started = Date.now();
    const out = await h.call("diff_xlsx", { ...args(), limit: 50 });
    const seconds = (Date.now() - started) / 1000;
    clearInterval(timer);
    assert.equal(out.isError, false, JSON.stringify(out.body).slice(0, 400));
    const sheet = (
      out.body.summary as {
        sheets: {
          rowsAdded: number;
          rowsRemoved: number;
          changedCells: number;
          rows: { base: number; head: number };
        }[];
      }
    ).sheets[0];
    const { changedRows, removed } = expected();
    assert.equal(sheet?.rows.base, SPEC.rows);
    assert.equal(sheet?.rowsAdded, SPEC.extraRows);
    assert.equal(sheet?.rowsRemoved, removed);
    assert.equal(sheet?.changedCells, changedRows * 2);
    assert.equal(out.body.total, SPEC.extraRows + removed + changedRows * 2);
    assert.equal(out.body.returned, 50);
    const growth = peak - baseline;
    t.diagnostic(
      `400k rows, workbook ${Math.round(statSync(file).size / 1048576)} MiB, shared strings about ${Math.round(sharedBytes / 1048576)} MiB: ${seconds.toFixed(1)} s, process RSS growth ${Math.round(growth / 1048576)} MiB`,
    );
    assert.ok(growth < 350 * 1024 * 1024, `rss grew by ${Math.round(growth / 1048576)} MiB`);
    assert.ok(seconds < 240);
    assert.deepEqual(readdirSync(join(root, "run", "scratch")), []);
  });
});

describe("limits and cleanup", () => {
  test("a cancelled request stops the worker thread and removes the scratch directory", async () => {
    const h = await harnessFor({ xlsxTimeoutMs: 600_000 }, "cancel");
    try {
      await h.call("list_repos", {});
      const baseline = threads();
      const abort = new AbortController();
      const request = fetch(h.url, {
        method: "POST",
        signal: abort.signal,
        headers: {
          authorization: `Bearer ${SECRET}`,
          "x-qm-caller": "canceller",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "diff_xlsx", arguments: args() },
        }),
      }).catch(() => undefined);
      const scratch = join(root, "cancel", "scratch");
      const running = await until(
        () => readdirSync(scratch).some((entry) => existsSync(join(scratch, entry, "work.sqlite"))),
        120_000,
      );
      assert.equal(running, true);
      abort.abort();
      await request;
      assert.equal(await until(() => readdirSync(scratch).length === 0), true);
      assert.equal(await until(() => threads() <= baseline), true);
      assert.equal(await until(() => h.audit.rows().some((row) => row.caller === "canceller")), true);
      assert.equal(h.audit.rows().find((row) => row.caller === "canceller")?.result, "error");
      assert.equal((await h.call("list_repos", {})).isError, false);
    } finally {
      await h.stop();
    }
  });

  test("the total time limit stops the worker, removes scratch and leaves the service serving", async () => {
    const h = await harnessFor({ xlsxTimeoutMs: 1500 }, "timeout");
    try {
      await h.call("list_repos", {});
      const baseline = threads();
      const out = await h.call("diff_xlsx", args());
      assert.equal(out.isError, true);
      assert.equal((out.body.error as { code: string }).code, "xlsx_timeout");
      assert.deepEqual(readdirSync(join(root, "timeout", "scratch")), []);
      assert.equal(await until(() => threads() <= baseline), true);
      assert.equal((await h.call("list_commits", { repo: "server", limit: 1 })).isError, false);
    } finally {
      await h.stop();
    }
  });

  test("a comparison that reports no progress is stopped by the watchdog", async () => {
    const h = await harnessFor({ xlsxTimeoutMs: 600_000, xlsxNoProgressMs: 100 }, "watchdog");
    try {
      const out = await h.call("diff_xlsx", args());
      assert.equal(out.isError, true);
      assert.equal((out.body.error as { code: string }).code, "xlsx_no_progress");
      assert.deepEqual(readdirSync(join(root, "watchdog", "scratch")), []);
    } finally {
      await h.stop();
    }
  });

  test("a worker that exceeds its memory bound is killed alone and the service keeps serving", async () => {
    const h = await harnessFor({ xlsxMaxHeapMb: 4 }, "heap");
    try {
      const out = await h.call("diff_xlsx", args());
      assert.equal(out.isError, true);
      assert.equal((out.body.error as { code: string }).code, "xlsx_out_of_memory");
      assert.deepEqual(readdirSync(join(root, "heap", "scratch")), []);
      assert.equal((await h.call("list_repos", {})).isError, false);
    } finally {
      await h.stop();
    }
  });
});
