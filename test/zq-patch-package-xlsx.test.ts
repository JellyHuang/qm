import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { test } from "node:test";
import { PatchPackageError } from "../src/zq/patch-package/settings.ts";
import {
  buildXlsxPackage,
  renderXlsxDiff,
  xlsxPager,
  type XlsxDifference,
  type XlsxDiffResult,
  type XlsxSheetSummary,
} from "../src/zq/patch-package/xlsx.ts";
import { put, scratchDir, testSettings } from "./support/patch-package-fixture.ts";

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

function setup(t: Parameters<typeof scratchDir>[0], name = "items.xlsx") {
  const out = scratchDir(t, "pp-xout-");
  const src = scratchDir(t, "pp-xsrc-");
  put(src, name, Buffer.from("PK-pretend-workbook"));
  return { out, file: join(src, name), settings: testSettings(out) };
}

async function expectError(promise: Promise<unknown>, code: string, pattern?: RegExp) {
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof PatchPackageError, String(e));
    assert.equal(e.code, code, e.message);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

test("the package holds the workbook, a diff table and a manifest with hashes and refs", async (t) => {
  const s = setup(t);
  const pkg = await buildXlsxPackage([{ result: result(), file: s.file }], { settings: s.settings, ticket: "WP-9" });
  assert.deepEqual(readdirSync(pkg.dir).sort(), ["items.diff.md", "items.xlsx", "manifest.json"]);
  assert.equal(readFileSync(join(pkg.dir, "items.xlsx"), "utf8"), "PK-pretend-workbook");
  const md = readFileSync(join(pkg.dir, "items.diff.md"), "utf8");
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

  const text = readFileSync(pkg.manifestPath, "utf8");
  const manifest = JSON.parse(text) as {
    ticket: string;
    workbooks: {
      base: { commit: string };
      head: { ref: string };
      workbook: { name: string; sha256: string; bytes: number };
      diff: { sha256: string };
      differences: { complete: boolean; listed: number };
    }[];
  };
  const entry = manifest.workbooks[0];
  assert.equal(manifest.ticket, "WP-9");
  assert.equal(entry?.base.commit, "a".repeat(40));
  assert.equal(entry?.head.ref, "main");
  assert.equal(entry?.workbook.bytes, "PK-pretend-workbook".length);
  assert.equal(entry?.differences.complete, true);
  assert.equal(entry?.differences.listed, 5);
  assert.equal(entry?.workbook.sha256, pkg.files.find((f) => f.name === "items.xlsx")?.sha256);
  assert.ok(!text.includes(s.out) && !text.includes(s.file));
});

test("pipes, backslashes and newlines in values are escaped so the table stays one row per difference", async (t) => {
  const s = setup(t);
  const pkg = await buildXlsxPackage(
    [
      {
        result: result({ total: 1, differences: [diff("cell_changed", "a|b", "c", "x|y\nz", "back\\slash\r\nend")] }),
        file: s.file,
      },
    ],
    { settings: s.settings },
  );
  const md = readFileSync(join(pkg.dir, "items.diff.md"), "utf8");
  assert.match(md, /^\| Data \| a\\\|b \| c \| x\\\|y\\nz \| back\\\\slash\\nend \| cell_changed \|$/m);
});

test("ambiguous keys and the suggested key columns are called out above the summary", async (t) => {
  const s = setup(t);
  const ambiguous = result({
    summary: { sheets: [sheet({ ambiguous: 3, ambiguousKeys: 2, suggestedKeyColumns: ["A", "C"] })] },
    total: 1,
    differences: [diff("ambiguous", "(key)", "", "id", "id, name")],
  });
  const pkg = await buildXlsxPackage([{ result: ambiguous, file: s.file }], { settings: s.settings });
  const md = readFileSync(join(pkg.dir, "items.diff.md"), "utf8");
  assert.ok(md.indexOf("Ambiguous rows") < md.indexOf("## Summary"));
  assert.match(md, /sheet Data: 2 key problems, 3 ambiguous in all; suggested key columns: A, C/);
  assert.match(md, /\| ambiguous \|$/m);
});

test("an LFS pointer is rendered as not compared and an unchanged or unsupported result is refused", async (t) => {
  const s = setup(t);
  const lfs = result({
    kind: "lfs_pointer_changed",
    oldLfs: { oid: "1".repeat(64), size: 10 },
    newLfs: { oid: "2".repeat(64), size: 12 },
  });
  const pkg = await buildXlsxPackage([{ result: lfs, file: s.file }], { settings: s.settings });
  const md = readFileSync(join(pkg.dir, "items.diff.md"), "utf8");
  assert.match(md, /LFS file, content not compared/);
  assert.match(md, new RegExp(`oid ${"2".repeat(64)}, size 12`));
  assert.doesNotMatch(md, /^\| sheet \| key/m);

  const other = setup(t);
  await expectError(
    buildXlsxPackage([{ result: result({ kind: "unchanged" }), file: other.file }], { settings: other.settings }),
    "unchanged",
    /unchanged/,
  );
  await expectError(
    buildXlsxPackage([{ result: result({ kind: "unsupported", note: "macro workbook" }), file: other.file }], {
      settings: other.settings,
    }),
    "unsupported",
    /macro workbook/,
  );
  await expectError(
    buildXlsxPackage([{ result: result({ kind: "file_removed" }), file: other.file }], { settings: other.settings }),
    "unsupported",
    /removed/,
  );
  assert.deepEqual(readdirSync(other.out), []);
});

test("a missing modified file is refused without leaving anything behind", async (t) => {
  const s = setup(t);
  await expectError(
    buildXlsxPackage([{ result: result(), file: join(s.out, "nope.xlsx") }], { settings: s.settings }),
    "missing_file",
    /not on disk/,
  );
  assert.deepEqual(readdirSync(s.out), []);
});

test("all pages are fetched through nextOffset until it is exhausted", async (t) => {
  const s = setup(t);
  const all = Array.from({ length: 7 }, (_, i) => diff("cell_changed", String(i), "qty", "1", String(i)));
  const page = (offset: number, size: number): XlsxDiffResult =>
    result({
      total: 7,
      offset,
      differences: all.slice(offset, offset + size),
      nextOffset: offset + size < 7 ? offset + size : null,
    });
  const requested: number[] = [];
  const pkg = await buildXlsxPackage(
    [{ result: page(0, 3), file: s.file, fetchPage: async (offset) => (requested.push(offset), page(offset, 3)) }],
    { settings: s.settings },
  );
  assert.deepEqual(requested, [3, 6]);
  const md = readFileSync(join(pkg.dir, "items.diff.md"), "utf8");
  assert.equal(md.split("\n").filter((line) => line.endsWith("| cell_changed |")).length, 7);
  assert.equal(pkg.workbooks[0]?.complete, true);
});

test("a table that cannot be completed says so explicitly", async (t) => {
  const s = setup(t);
  const first = result({ total: 7, differences: [diff("cell_changed", "0", "q", "1", "2")], nextOffset: 1 });
  const noPager = await buildXlsxPackage([{ result: first, file: s.file }], { settings: s.settings, name: "a" });
  assert.equal(noPager.workbooks[0]?.complete, false);
  assert.match(
    readFileSync(join(noPager.dir, "items.diff.md"), "utf8"),
    /TABLE CUT: 1 of 7 differences are listed, no way to fetch/,
  );
  const manifest = JSON.parse(readFileSync(noPager.manifestPath, "utf8")) as {
    workbooks: { differences: { complete: boolean } }[];
  };
  assert.equal(manifest.workbooks[0]?.differences.complete, false);

  const failing = await buildXlsxPackage(
    [{ result: first, file: s.file, fetchPage: async () => Promise.reject(new Error("service down")) }],
    { settings: s.settings, name: "b" },
  );
  assert.match(readFileSync(join(failing.dir, "items.diff.md"), "utf8"), /TABLE CUT: 1 of 7.*service down/);

  const stuck = await buildXlsxPackage([{ result: first, file: s.file, fetchPage: async () => first }], {
    settings: s.settings,
    name: "c",
  });
  assert.match(readFileSync(join(stuck.dir, "items.diff.md"), "utf8"), /did not advance/);
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

test("a ticket that does not match the pattern is refused for a spreadsheet package too", async (t) => {
  const s = setup(t);
  await expectError(
    buildXlsxPackage([{ result: result(), file: s.file }], { settings: s.settings, ticket: "bad" }),
    "bad_ticket",
  );
  await expectError(
    buildXlsxPackage(
      [
        { result: result(), file: s.file },
        { result: result(), file: s.file },
      ],
      { settings: s.settings },
    ),
    "bad_input",
    /different/,
  );
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
