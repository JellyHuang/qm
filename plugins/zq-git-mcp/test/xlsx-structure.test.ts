import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ALICE, BOB, buildFixture, commitAll, git, makeRoot, type Fixture } from "./support/fixtures.ts";
import { startHarness, testConfig, type Harness } from "./support/harness.ts";
import { buildXlsx, type Cell, type SheetSpec, type WorkbookSpec } from "./support/xlsx-builder.ts";

const { root, cleanup } = makeRoot("zqgit-xlsx-structure-");
let fx: Fixture;
let h: Harness;
let tick = 0;
const scenarios = new Map<string, { base: string; head: string; path: string; baseBlob: string; headBlob: string }>();

const stamp = () => new Date(Date.UTC(2025, 2, 1, 10, 0, 0) + ++tick * 60_000).toISOString().replace(".000Z", "Z");
const sheet = (name: string, rows: Cell[][], extra: Partial<SheetSpec> = {}): SheetSpec => ({ name, rows, ...extra });
const book = (spec: Partial<WorkbookSpec>, ...sheets: SheetSpec[]): WorkbookSpec => ({ ...spec, sheets });
const blanks = (n: number): Cell[][] => Array.from({ length: n }, () => []);

function scenario(name: string, one: WorkbookSpec, two: WorkbookSpec) {
  const dir = join(fx.work.gameconfig, "s");
  mkdirSync(dir, { recursive: true });
  const path = `s/${name}.xlsx`;
  writeFileSync(join(fx.work.gameconfig, path), buildXlsx(one));
  const base = commitAll(fx.work.gameconfig, `${name} one`, ALICE, stamp());
  writeFileSync(join(fx.work.gameconfig, path), buildXlsx(two));
  const head = commitAll(fx.work.gameconfig, `${name} two`, BOB, stamp());
  const blob = (commit: string) => git(fx.work.gameconfig, ["rev-parse", `${commit}:${path}`]);
  scenarios.set(name, { base, head, path, baseBlob: blob(base), headBlob: blob(head) });
}

const data = (second: string): Cell[][] => [
  ["id", "name", "qty"],
  ["a", "alpha", 1],
  ["b", second, 2],
];

before(async () => {
  fx = buildFixture(root);
  scenario("plain", book({}, sheet("Data", data("beta"))), book({}, sheet("Data", data("BETA"))));
  scenario(
    "prefixed",
    book({ prefix: "x" }, sheet("Data", data("beta"))),
    book({ prefix: "x" }, sheet("Data", data("BETA"))),
  );
  scenario(
    "backslash",
    book({ backslashNames: true }, sheet("Data", data("beta"))),
    book({ backslashNames: true }, sheet("Data", data("BETA"))),
  );
  scenario(
    "blank_lead",
    book({}, sheet("Data", [...blanks(12), ...data("beta")])),
    book({}, sheet("Data", [...blanks(12), ...data("BETA")])),
  );
  const titles = (n: number): Cell[][] => Array.from({ length: n }, (_, i) => [`ZQSECRET-title-${i}`]);
  scenario(
    "title_rows",
    book({}, sheet("Data", [...titles(12), ...data("beta")])),
    book({}, sheet("Data", [...titles(12), ...data("BETA")])),
  );
  scenario(
    "numeric_header",
    book(
      {},
      sheet("Data", [
        [2024, 2025, 2026],
        [1, 2, 3],
        [4, 5, 6],
      ]),
    ),
    book(
      {},
      sheet("Data", [
        [2024, 2025, 2026],
        [1, 2, 3],
        [4, 5, 7],
      ]),
    ),
  );
  scenario(
    "single_column",
    book({}, sheet("Data", [["id"], ["a"], ["b"]])),
    book({}, sheet("Data", [["id"], ["a"], ["c"]])),
  );
  scenario("empty_sheet", book({}, sheet("Empty", [])), book({}, sheet("Empty", []), sheet("Pad", data("beta"))));
  scenario(
    "hidden_sheet",
    book({}, sheet("Shown", data("beta")), sheet("Quiet", data("beta"), { state: "hidden" })),
    book({}, sheet("Shown", data("beta")), sheet("Quiet", data("BETA"), { state: "hidden" })),
  );
  scenario("renamed", book({}, sheet("Old", data("beta"))), book({}, sheet("New", data("beta"))));
  scenario(
    "weak_first_column",
    book(
      {},
      sheet("W", [
        ["group", "code", "val"],
        ["g1", "c1", "x"],
        ["g1", "c2", "y"],
        [null, "c3", "z"],
      ]),
    ),
    book(
      {},
      sheet("W", [
        ["group", "code", "val"],
        ["g1", "c1", "x"],
        ["g1", "c2", "Y"],
        [null, "c3", "z"],
      ]),
    ),
  );
  scenario(
    "renamed_key_header",
    book(
      {},
      sheet("K", [
        ["id", "code", "val"],
        [1, "c1", "x"],
        [2, "c2", "y"],
      ]),
    ),
    book(
      {},
      sheet("K", [
        ["identifier", "code", "val"],
        [1, "c1", "x"],
        [2, "c2", "Y"],
      ]),
    ),
  );
  scenario(
    "secrets",
    book(
      {},
      sheet("Data", [
        ["ZQSECRET-header", "ZQSECRET-second"],
        ["ZQSECRET-key-1", "ZQSECRET-value-1"],
        ["ZQSECRET-key-2", 7],
      ]),
    ),
    book(
      {},
      sheet("Data", [
        ["ZQSECRET-header", "ZQSECRET-second"],
        ["ZQSECRET-key-1", "ZQSECRET-value-2"],
        ["ZQSECRET-key-2", 8],
      ]),
    ),
  );
  git(fx.work.gameconfig, ["push", "-q", "origin", "--all", "--force"]);
  h = await startHarness(testConfig(root, fx.remoteBase));
});
after(async () => {
  await h.stop();
  cleanup();
});

interface SheetSummary {
  sheet: string;
  status: string;
  baseHeaderRow: number | null;
  headHeaderRow: number | null;
  baseHeaderDetection: string;
  headHeaderDetection: string;
  suggestedKeyColumns?: string[];
  changedCells: number;
  ambiguous: number;
}

async function diff(name: string, extra: Record<string, unknown> = {}) {
  const s = scenarios.get(name);
  assert.ok(s, name);
  const out = await h.call("diff_xlsx", { repo: "gameconfig", path: s.path, base: s.base, head: s.head, ...extra });
  assert.equal(out.isError, false, JSON.stringify(out.body));
  const sheets = ((out.body.summary as { sheets?: SheetSummary[] } | undefined)?.sheets ?? []) as SheetSummary[];
  return { body: out.body, sheets, kinds: ((out.body.differences ?? []) as { kind: string }[]).map((d) => d.kind) };
}

async function diagnose(name: string) {
  const s = scenarios.get(name);
  assert.ok(s, name);
  return h.service.diagnoseXlsx({ repo: "gameconfig", path: s.path, baseRef: s.base, headRef: s.head });
}

describe("which workbooks give a null header row, a removed sheet or all ambiguous differences", () => {
  test("a plain workbook is the baseline: the header is found by rule and the change is reported", async () => {
    const { sheets, kinds } = await diff("plain");
    assert.deepEqual(
      sheets.map((s) => [s.baseHeaderRow, s.baseHeaderDetection, s.changedCells]),
      [[1, "rule", 1]],
    );
    assert.deepEqual(kinds, ["cell_changed"]);
  });

  test("element names with a namespace prefix are read like plain ones", async () => {
    const { sheets, kinds } = await diff("prefixed");
    assert.deepEqual(
      sheets.map((s) => [s.sheet, s.status, s.headHeaderRow]),
      [["Data", "both", 1]],
    );
    assert.deepEqual(kinds, ["cell_changed"]);
  });

  test("package entries written with backslashes are read", async () => {
    const { sheets, kinds } = await diff("backslash");
    assert.deepEqual(
      sheets.map((s) => [s.status, s.headHeaderRow]),
      [["both", 1]],
    );
    assert.deepEqual(kinds, ["cell_changed"]);
  });

  test("more than ten leading rows without content no longer hide the header", async () => {
    const { sheets, kinds } = await diff("blank_lead");
    assert.deepEqual(
      sheets.map((s) => [s.baseHeaderRow, s.baseHeaderDetection]),
      [[13, "rule"]],
    );
    assert.deepEqual(kinds, ["cell_changed"]);
  });

  test("more than ten title rows fool the rule, which the summary shows, and a header row override fixes it", async () => {
    const auto = await diff("title_rows");
    assert.equal(auto.sheets[0]?.headHeaderRow, 1);
    assert.equal(auto.sheets[0]?.headHeaderDetection, "rule");
    assert.deepEqual(auto.kinds, []);
    const forced = await diff("title_rows", { overrides: { Data: { headerRow: 13 } } });
    assert.equal(forced.sheets[0]?.headHeaderDetection, "override");
    assert.deepEqual(forced.kinds, ["cell_changed"]);
  });

  test("a header row of numbers is not text, so the first row is used and the summary says it was a fallback", async () => {
    const { sheets, kinds } = await diff("numeric_header");
    assert.deepEqual(
      sheets.map((s) => [s.baseHeaderRow, s.baseHeaderDetection]),
      [[1, "fallback_first_row"]],
    );
    assert.deepEqual(kinds, ["cell_changed"]);
  });

  test("a single column sheet, an empty sheet and a hidden sheet are all compared normally or reported as empty", async () => {
    const single = await diff("single_column");
    assert.deepEqual(single.sheets[0]?.baseHeaderDetection, "rule");
    assert.deepEqual(single.kinds.sort(), ["row_added", "row_removed"]);
    const empty = await diff("empty_sheet");
    assert.deepEqual(
      empty.sheets
        .filter((entry) => entry.sheet === "Empty")
        .map((entry) => [entry.baseHeaderRow, entry.headHeaderRow, entry.baseHeaderDetection]),
      [[null, null, "none"]],
    );
    const hidden = await diff("hidden_sheet");
    assert.deepEqual(
      hidden.sheets.map((s) => [s.sheet, s.status, s.changedCells]),
      [
        ["Shown", "both", 0],
        ["Quiet", "both", 1],
      ],
    );
  });

  test("a renamed sheet is a removed sheet plus an added one", async () => {
    const { sheets, kinds } = await diff("renamed");
    assert.deepEqual(
      sheets.map((s) => [s.sheet, s.status]),
      [
        ["New", "sheet_added"],
        ["Old", "sheet_removed"],
      ],
    );
    assert.deepEqual(
      sheets.map((s) => s.headHeaderDetection),
      ["rule", "none"],
    );
    assert.deepEqual(kinds, ["sheet_added", "sheet_removed"]);
  });

  test("a weak first column is reported as ambiguous and the summary suggests a key that is unique", async () => {
    const { sheets, kinds } = await diff("weak_first_column");
    assert.ok(kinds.every((kind) => kind === "ambiguous"));
    assert.ok((sheets[0]?.ambiguous ?? 0) >= 2);
    assert.deepEqual(sheets[0]?.suggestedKeyColumns, ["B"]);
    const retried = await diff("weak_first_column", {
      overrides: { W: { keyColumns: sheets[0]?.suggestedKeyColumns } },
    });
    assert.deepEqual(retried.kinds, ["cell_changed"]);
  });

  test("a renamed first column header makes the default keys differ and a suggestion is given", async () => {
    const { sheets, kinds } = await diff("renamed_key_header");
    assert.ok(kinds.includes("ambiguous"));
    assert.deepEqual(sheets[0]?.suggestedKeyColumns, ["B"]);
    for (const keyColumns of [["B"], ["A"]]) {
      const retried = await diff("renamed_key_header", { overrides: { K: { keyColumns } } });
      assert.ok(retried.kinds.includes("cell_changed"), keyColumns.join());
      assert.ok(!retried.kinds.includes("ambiguous"), keyColumns.join());
    }
  });
});

describe("structure only diagnostics", () => {
  test("they explain the header decision, the first column keys and why a sheet was added or removed", async () => {
    const lines = await diagnose("renamed");
    const compare = lines.filter((line) => line.type === "compare");
    assert.deepEqual(
      compare.map((line) => [line.sheet, line.status, line.reportedAs]),
      [
        ["New", "only_head", "sheet_added"],
        ["Old", "only_base", "sheet_removed"],
      ],
    );
    const weak = (await diagnose("weak_first_column")).find((line) => line.type === "sheet" && line.side === "head");
    assert.equal(weak?.headerDetection, "rule");
    assert.deepEqual(weak?.firstColumn, {
      dataRows: 3,
      emptyKeys: 1,
      distinctKeys: 1,
      duplicateKeys: 1,
      duplicateKeyRows: 2,
    });
    assert.deepEqual(weak?.keyColumns, ["A"]);
    const titles = (await diagnose("title_rows")).find((line) => line.type === "sheet" && line.side === "head");
    assert.equal(((titles?.headerRowsConsidered ?? []) as unknown[]).length, 1);
    assert.equal(((titles?.firstRows ?? []) as unknown[]).length, 15);
    const numeric = (await diagnose("numeric_header")).find((line) => line.type === "sheet" && line.side === "head");
    assert.equal(numeric?.headerDetection, "fallback_first_row");
    assert.deepEqual(
      ((numeric?.headerRowsConsidered ?? []) as { reason: string }[]).map((row) => row.reason),
      ["not_mostly_text", "not_mostly_text", "not_mostly_text"],
    );
    const workbook = (await diagnose("backslash")).find((line) => line.type === "workbook");
    assert.equal(workbook?.sheetsParsed, 1);
  });

  test("a blob mode resolves a short object id with the path and refuses one without it", async () => {
    const s = scenarios.get("plain");
    assert.ok(s);
    const viaBlobs = await h.service.diagnoseXlsx({
      repo: "gameconfig",
      path: s.path,
      baseBlob: s.baseBlob.slice(0, 8),
      headBlob: s.headBlob,
    });
    assert.equal(viaBlobs[0]?.baseOid, s.baseBlob);
    assert.ok(viaBlobs.some((line) => line.type === "sheet"));
    await assert.rejects(
      h.service.diagnoseXlsx({ repo: "gameconfig", baseBlob: s.baseBlob.slice(0, 8), headBlob: s.headBlob }),
      /full 40 hex object id/,
    );
    await assert.rejects(
      h.service.diagnoseXlsx({ repo: "gameconfig", path: s.path, baseBlob: "zzzzzzz", headBlob: s.headBlob }),
      /hex digits/,
    );
  });

  test("the output never contains a cell value or a title, only counts, letters and sheet names", async () => {
    const lines = await diagnose("secrets");
    const text = JSON.stringify(lines);
    assert.doesNotMatch(text, /ZQSECRET/);
    assert.match(text, /"sheet":"Data"/);
    assert.ok(lines.some((line) => line.type === "sheet" && line.side === "base"));
    const titles = JSON.stringify(await diagnose("title_rows"));
    assert.doesNotMatch(titles, /ZQSECRET/);
  });
});
