import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { test } from "node:test";
import { PatchPackageError } from "../src/zq/patch-package/settings.ts";
import {
  refuseUnusableResult,
  renderXlsxDiff,
  xlsxPager,
  type XlsxDifference,
  type XlsxDiffResult,
  type XlsxSheetSummary,
} from "../src/zq/patch-package/xlsx.ts";
import { scratchDir } from "./support/patch-package-fixture.ts";

const sheet = (over: Partial<XlsxSheetSummary> = {}): XlsxSheetSummary => ({
  sheet: "Data",
  status: "both",
  baseHeaderRow: 1,
  headHeaderRow: 2,
  keyColumns: ["id"],
  rows: { base: 3, head: 3 },
  changedCells: 1,
  formulaChanged: 0,
  rowsAdded: 1,
  rowsRemoved: 1,
  columnsAdded: 1,
  columnsRemoved: 1,
  ambiguous: 0,
  ambiguousKeys: 0,
  mergeChanged: 0,
  hiddenChanged: 0,
  ...over,
});

const diff = (kind: string, key: string, column: string, o: string, n: string, name = "Data"): XlsxDifference => ({
  sheet: name,
  key,
  column,
  old: o,
  new: n,
  kind,
});

const result = (over: Partial<XlsxDiffResult> = {}): XlsxDiffResult => ({
  kind: "xlsx_diff",
  repo: "gameconfig",
  path: "tables/items.xlsx",
  base: { ref: "main~1", commit: "a".repeat(40) },
  head: { ref: "main", commit: "b".repeat(40) },
  summary: { sheets: [sheet()] },
  total: 5,
  offset: 0,
  nextOffset: null,
  differences: [
    diff("cell_changed", "2", "qty", "20", "25"),
    diff("row_removed", "3", "", "id=3; name=c", ""),
    diff("row_added", "4", "", "", "id=4; name=d"),
    diff("column_added", "(column)", "price", "", "new column"),
    diff("column_removed", "(column)", "note", "old column", ""),
  ],
  ...over,
});

async function expectError(fn: () => unknown, code: string, pattern?: RegExp) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof PatchPackageError, String(e));
    assert.equal(e.code, code, e.message);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

async function render(
  t: Parameters<typeof scratchDir>[0],
  first: XlsxDiffResult,
  fetchPage?: (offset: number) => Promise<XlsxDiffResult>,
  ticket?: string,
) {
  const file = join(scratchDir(t, "pp-xout-"), "table.diff.md");
  const outcome = await renderXlsxDiff(file, first, fetchPage, ticket ? { ticket } : {});
  return { md: readFileSync(file, "utf8"), outcome };
}

test("the table has refs, a summary and one row per difference", async (t) => {
  const { md, outcome } = await render(t, result(), undefined, "WP-9");
  const lines = md.split("\n");
  assert.ok(lines.indexOf("## Summary") < lines.indexOf("## Differences"));
  assert.match(md, /^\| Data \| both \| 1\/2 \| id \| 3\/3 \| 1 \| 1 \| 1 \| 0 \| 1 \| 1 \| 0 \| 0 \| 0 \|$/m);
  assert.match(md, /^\| sheet \| key \| column \| old \| new \| kind \|$/m);
  assert.match(md, /^\| Data \| 2 \| qty \| 20 \| 25 \| cell_changed \|$/m);
  assert.match(md, /^\| Data \| 3 \| {2}\| id=3; name=c \| {2}\| row_removed \|$/m);
  assert.match(md, /^\| Data \| 4 \| {2}\| {2}\| id=4; name=d \| row_added \|$/m);
  assert.match(md, /^\| Data \| \(column\) \| price \| {2}\| new column \| column_added \|$/m);
  assert.match(md, /^\| Data \| \(column\) \| note \| old column \| {2}\| column_removed \|$/m);
  assert.match(md, /ticket: WP-9/);
  assert.doesNotMatch(md, /TABLE CUT/);
  assert.deepEqual(outcome, { rendered: 5, total: 5, complete: true });
});

test("pipes, backslashes and newlines in values are escaped so the table stays one row per difference", async (t) => {
  const { md } = await render(
    t,
    result({ total: 1, differences: [diff("cell_changed", "a|b", "c", "x|y\nz", "back\\slash\r\nend")] }),
  );
  assert.match(md, /^\| Data \| a\\\|b \| c \| x\\\|y\\nz \| back\\\\slash\\nend \| cell_changed \|$/m);
});

test("ambiguous keys and the suggested key columns are called out above the summary", async (t) => {
  const { md } = await render(
    t,
    result({
      summary: { sheets: [sheet({ ambiguous: 3, ambiguousKeys: 2, suggestedKeyColumns: ["A", "C"] })] },
      total: 1,
      differences: [diff("ambiguous", "(key)", "", "id", "id, name")],
    }),
  );
  assert.ok(md.indexOf("Ambiguous rows") < md.indexOf("## Summary"));
  assert.match(md, /sheet Data: 2 key problems, 3 ambiguous in all; suggested key columns: A, C/);
  assert.match(md, /\| ambiguous \|$/m);
});

test("an LFS pointer is rendered as not compared and an unchanged or unsupported result is refused", async (t) => {
  const { md } = await render(
    t,
    result({
      kind: "lfs_pointer_changed",
      oldLfs: { oid: "1".repeat(64), size: 10 },
      newLfs: { oid: "2".repeat(64), size: 12 },
    }),
  );
  assert.match(md, /LFS file, content not compared/);
  assert.match(md, new RegExp(`oid ${"2".repeat(64)}, size 12`));
  assert.doesNotMatch(md, /^\| sheet \| key/m);

  await expectError(() => refuseUnusableResult(result({ kind: "unchanged" })), "unchanged", /unchanged/);
  await expectError(
    () => refuseUnusableResult(result({ kind: "unsupported", note: "macro workbook" })),
    "unsupported",
    /macro workbook/,
  );
  await expectError(() => refuseUnusableResult(result({ kind: "file_removed" })), "unsupported", /removed/);
  refuseUnusableResult(result());
});

test("all pages are fetched through nextOffset until it is exhausted", async (t) => {
  const all = Array.from({ length: 7 }, (_, i) => diff("cell_changed", String(i), "qty", "1", String(i)));
  const page = (offset: number, size: number): XlsxDiffResult =>
    result({
      total: 7,
      offset,
      differences: all.slice(offset, offset + size),
      nextOffset: offset + size < 7 ? offset + size : null,
    });
  const requested: number[] = [];
  const { md, outcome } = await render(t, page(0, 3), async (offset) => (requested.push(offset), page(offset, 3)));
  assert.deepEqual(requested, [3, 6]);
  assert.equal(md.split("\n").filter((line) => line.endsWith("| cell_changed |")).length, 7);
  assert.equal(outcome.complete, true);
});

test("a table that cannot be completed says so explicitly", async (t) => {
  const first = result({ total: 7, differences: [diff("cell_changed", "0", "q", "1", "2")], nextOffset: 1 });
  const noPager = await render(t, first);
  assert.equal(noPager.outcome.complete, false);
  assert.match(noPager.md, /TABLE CUT: 1 of 7 differences are listed, no way to fetch/);
  const failing = await render(t, first, async () => Promise.reject(new Error("service down")));
  assert.match(failing.md, /TABLE CUT: 1 of 7.*service down/);
  const stuck = await render(t, first, async () => first);
  assert.match(stuck.md, /did not advance/);
});

test("the pager asks diff_xlsx for the next offset with the same arguments", async () => {
  const calls: { tool: string; args: Record<string, unknown>; caller: string }[] = [];
  const fetchPage = xlsxPager(
    {
      call: async (tool, args, caller) => (
        calls.push({ tool, args, caller }),
        result() as unknown as Record<string, unknown>
      ),
    },
    { repo: "gameconfig", path: "tables/items.xlsx", base: "main~1", head: "main", limit: 100 },
    "qm-patch",
  );
  await fetchPage(300);
  assert.deepEqual(calls, [
    {
      tool: "diff_xlsx",
      args: { repo: "gameconfig", path: "tables/items.xlsx", base: "main~1", head: "main", limit: 100, offset: 300 },
      caller: "qm-patch",
    },
  ]);
});

test("thousands of differences stream to disk with bounded memory", async (t) => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const dir = scratchDir(t, "pp-big-");
  const PAGE = 5000;
  const TOTAL = 400_000;
  const filler = "x".repeat(60);
  const page = (offset: number): XlsxDiffResult => {
    const end = Math.min(TOTAL, offset + PAGE);
    const rows: XlsxDifference[] = [];
    for (let i = offset; i < end; i++)
      rows.push(diff("cell_changed", `key-${i}`, "col", `old ${filler}`, `new ${i} ${filler}`));
    return result({ total: TOTAL, offset, differences: rows, nextOffset: end < TOTAL ? end : null });
  };
  gc();
  const baseline = process.memoryUsage().heapUsed;
  let peak = 0;
  const outcome = await renderXlsxDiff(join(dir, "big.diff.md"), page(0), async (offset) => {
    gc();
    peak = Math.max(peak, process.memoryUsage().heapUsed - baseline);
    return page(offset);
  });
  assert.deepEqual(outcome, { rendered: TOTAL, total: TOTAL, complete: true });
  assert.ok(statSync(join(dir, "big.diff.md")).size > 60 * 1024 * 1024);
  assert.ok(peak < 30 * 1024 * 1024, `heap grew by ${peak} bytes`);
});
