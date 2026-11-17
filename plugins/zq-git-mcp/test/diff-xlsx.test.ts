import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { loggingGit } from "./support/fake-git.ts";
import { ALICE, BOB, buildFixture, commitAll, git, makeRoot, pushAll, type Fixture } from "./support/fixtures.ts";
import { pointerFor } from "./support/files-fixture.ts";
import { startHarness, testConfig, type Harness } from "./support/harness.ts";
import { buildXlsx, type Cell, type SheetSpec, type WorkbookSpec } from "./support/xlsx-builder.ts";

const { root, cleanup } = makeRoot("zqgit-xlsx-");
const logger = loggingGit(root);
let fx: Fixture;
let h: Harness;
const scenarios = new Map<string, { base: string; head: string; path: string }>();
let tick = 0;
const stamp = () => new Date(Date.UTC(2025, 1, 1, 10, 0, 0) + ++tick * 60_000).toISOString().replace(".000Z", "Z");

function dir() {
  return join(fx.work.gameconfig, "x");
}

function scenario(name: string, one: Uint8Array | string, two: Uint8Array | string, extension = "xlsx") {
  const path = `x/${name}.${extension}`;
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(fx.work.gameconfig, path), one);
  const base = commitAll(fx.work.gameconfig, `${name} one`, ALICE, stamp());
  writeFileSync(join(fx.work.gameconfig, path), two);
  const head = commitAll(fx.work.gameconfig, `${name} two`, BOB, stamp());
  scenarios.set(name, { base, head, path });
}

const sheet = (name: string, rows: Cell[][], extra: Partial<SheetSpec> = {}): SheetSpec => ({ name, rows, ...extra });
const book = (...sheets: SheetSpec[]): WorkbookSpec => ({ sheets });

before(async () => {
  fx = buildFixture(root);
  scenario(
    "basic",
    buildXlsx(
      book(
        sheet("Data", [
          ["id", "name", "qty"],
          [1, "a", 10],
          [2, "b", 20],
          [3, "c", 30],
        ]),
      ),
    ),
    buildXlsx(
      book(
        sheet("Data", [
          ["id", "name", "qty"],
          [1, "a", 10],
          [2, "b", 25],
          [4, "d", 40],
        ]),
      ),
    ),
  );
  scenario(
    "titles",
    buildXlsx(
      book(sheet("T", [["Quarterly report"], [null], ["code", "label", "value"], ["k1", "one", 1], ["k2", "two", 2]])),
    ),
    buildXlsx(
      book(sheet("T", [["Quarterly report"], [null], ["code", "label", "value"], ["k1", "one", 1], ["k2", "two", 3]])),
    ),
  );
  scenario(
    "composite",
    buildXlsx(
      book(
        sheet("C", [
          ["region", "id", "val"],
          ["east", 1, "x"],
          ["east", 2, "y"],
          ["west", 1, "z"],
        ]),
      ),
    ),
    buildXlsx(
      book(
        sheet("C", [
          ["region", "id", "val"],
          ["east", 1, "x"],
          ["east", 2, "Y"],
          ["west", 1, "zz"],
        ]),
      ),
    ),
  );
  scenario(
    "ambiguity",
    buildXlsx(
      book(
        sheet("A", [
          ["id", "v"],
          ["dup", "one"],
          ["dup", "two"],
          [null, "orphan"],
          ["ok", "same"],
          ["ok2", "before"],
        ]),
      ),
    ),
    buildXlsx(
      book(
        sheet("A", [
          ["id", "v"],
          ["dup", "ONE"],
          ["dup", "TWO"],
          [null, "ORPHAN"],
          ["ok", "same"],
          ["ok2", "after"],
        ]),
      ),
    ),
  );
  scenario(
    "columns",
    buildXlsx(
      book(
        sheet("K", [
          ["id", "a", "b"],
          [1, "x", "old"],
          [2, "y", "old2"],
        ]),
      ),
    ),
    buildXlsx(
      book(
        sheet("K", [
          ["id", "a", "c"],
          [1, "x2", "new"],
          [2, "y", "new2"],
        ]),
      ),
    ),
  );
  scenario(
    "dupheaders",
    buildXlsx(
      book(
        sheet("H", [
          ["id", "v", "v"],
          [1, "a", "b"],
        ]),
      ),
    ),
    buildXlsx(
      book(
        sheet("H", [
          ["id", "v", "v"],
          [1, "a", "B"],
        ]),
      ),
    ),
  );
  scenario(
    "formulas",
    buildXlsx(
      book(
        sheet("F", [
          ["id", "a", "b", "sum"],
          [1, 1, 2, { f: "B2+C2", v: 3 }],
          [2, 5, 5, { f: "B3+C3", v: 10 }],
          [3, 1, 1, { f: "B4+C4", noCache: true }],
          [4, 2, { f: "B5*2", si: 0, ref: "C5:C6", v: 4 }, 0],
          [5, 3, { si: 0, v: 6 }, 0],
        ]),
      ),
    ),
    buildXlsx(
      book(
        sheet("F", [
          ["id", "a", "b", "sum"],
          [1, 1, 2, { f: "B2*C2-1", v: 3 }],
          [2, 5, 5, { f: "B3+C3", v: 11 }],
          [3, 1, 1, { f: "B4*C4", noCache: true }],
          [4, 2, { f: "B5*3", si: 0, ref: "C5:C6", v: 4 }, 0],
          [5, 3, { si: 0, v: 6 }, 0],
        ]),
      ),
    ),
  );
  scenario(
    "rich",
    buildXlsx(
      book(
        sheet("R", [
          ["id", "t"],
          [1, { rich: ["foo", "bar"] }],
          [2, { rich: ["a", "b"] }],
          [3, { inline: "inline one" }],
        ]),
      ),
    ),
    buildXlsx(
      book(
        sheet("R", [
          ["id", "t"],
          [1, "foobar"],
          [2, "abc"],
          [3, { inline: "inline two" }],
        ]),
      ),
    ),
  );
  scenario(
    "merges",
    buildXlsx(
      book(
        sheet(
          "M",
          [
            ["id", "t"],
            [1, "a"],
          ],
          { merges: ["A2:B2"] },
        ),
      ),
    ),
    buildXlsx(
      book(
        sheet(
          "M",
          [
            ["id", "t"],
            [1, "a"],
          ],
          { merges: ["A2:C2"] },
        ),
      ),
    ),
  );
  scenario(
    "hidden",
    buildXlsx(
      book(
        sheet("V", [
          ["id", "p", "q"],
          [1, "a", "b"],
          [2, "c", "d"],
        ]),
      ),
    ),
    buildXlsx(
      book(
        sheet(
          "V",
          [
            ["id", "p", "q"],
            [1, "a", "b"],
            [2, "c", "d"],
          ],
          { hiddenRows: [3], hiddenCols: [3] },
        ),
      ),
    ),
  );
  scenario(
    "dates",
    buildXlsx(
      book(
        sheet("D", [
          ["id", "when"],
          [1, { v: 45000, date: true }],
          [2, { v: 45010, date: true }],
        ]),
      ),
    ),
    buildXlsx(
      book(
        sheet("D", [
          ["id", "when"],
          [1, { v: 45000, date: true }],
          [2, { v: 45011.5, date: true }],
        ]),
      ),
    ),
  );
  scenario(
    "sheets",
    buildXlsx(
      book(
        sheet("Keep", [
          ["id", "v"],
          [1, "a"],
        ]),
        sheet("Gone", [
          ["id", "v", "w"],
          [1, 2, 3],
          [2, 3, 4],
        ]),
      ),
    ),
    buildXlsx(
      book(
        sheet("Keep", [
          ["id", "v"],
          [1, "a"],
        ]),
        sheet("Fresh", [
          ["id", "n"],
          [1, 2],
          [2, 3],
          [3, 4],
        ]),
      ),
    ),
  );
  scenario(
    "long",
    buildXlsx(
      book(
        sheet("L", [
          ["id", "v"],
          [1, "a".repeat(300)],
        ]),
      ),
    ),
    buildXlsx(
      book(
        sheet("L", [
          ["id", "v"],
          [1, "b".repeat(300)],
        ]),
      ),
    ),
  );
  scenario(
    "paging",
    buildXlsx(book(sheet("P", [["id", "v"], ...Array.from({ length: 30 }, (_, i): Cell[] => [i + 1, `v${i}`])]))),
    buildXlsx(book(sheet("P", [["id", "v"], ...Array.from({ length: 30 }, (_, i): Cell[] => [i + 1, `w${i}`])]))),
  );
  const pointerOne = pointerFor("c".repeat(64), 111);
  const pointerTwo = pointerFor("d".repeat(64), 222);
  const real = buildXlsx(book(sheet("S", [["id"], [1]])));
  scenario("lfs_one_side", real, pointerOne);
  scenario("lfs_both", pointerOne, pointerTwo);
  scenario("not_a_zip", "this is plain text", "so is this");
  scenario("encrypted", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 4, 5, 6]));
  scenario(
    "macro",
    buildXlsx({ ...book(sheet("S", [["id"], [1]])), macro: true }),
    buildXlsx({ ...book(sheet("S", [["id"], [2]])), macro: true }),
  );
  scenario("legacy", "x", "y", "xls");
  scenario("macro_ext", "x", "y", "xlsm");
  const addedPath = "x/added.xlsx";
  writeFileSync(join(fx.work.gameconfig, addedPath), real);
  const added = commitAll(fx.work.gameconfig, "added", ALICE, "2025-03-20T10:00:00Z");
  scenarios.set("added", { base: scenarios.get("basic")?.head ?? "", head: added, path: addedPath });
  pushAll(fx.work.gameconfig);
  git(join(fx.remotes, "gameconfig.git"), ["config", "pack.writeBitmaps", "true"]);
  git(join(fx.remotes, "gameconfig.git"), ["repack", "-a", "-d", "-b"]);
  h = await startHarness(testConfig(root, fx.remoteBase), { gitBinary: logger.bin });
});
after(async () => {
  await h.stop();
  cleanup();
});

interface Diff {
  sheet: string;
  key: string;
  column: string;
  old: string;
  new: string;
  kind: string;
  details: Record<string, unknown>;
}
interface Summary {
  sheet: string;
  status: string;
  baseHeaderRow: number | null;
  headHeaderRow: number | null;
  keyColumns: string[];
  rows: { base: number; head: number };
  changedCells: number;
  formulaChanged: number;
  rowsAdded: number;
  rowsRemoved: number;
  columnsAdded: number;
  columnsRemoved: number;
  ambiguous: number;
  mergeChanged: number;
  hiddenChanged: number;
}

async function diff(name: string, extra: Record<string, unknown> = {}, harness = h) {
  const s = scenarios.get(name);
  assert.ok(s, name);
  const out = await harness.call("diff_xlsx", {
    repo: "gameconfig",
    path: s.path,
    base: s.base,
    head: s.head,
    ...extra,
  });
  return {
    out,
    body: out.body,
    differences: (out.body.differences ?? []) as Diff[],
    sheets: ((out.body.summary as { sheets: Summary[] } | undefined)?.sheets ?? []) as Summary[],
  };
}

const find = (diffs: Diff[], kind: string, key?: string) =>
  diffs.filter((d) => d.kind === kind && (key === undefined || d.key === key));

describe("rows and cells", () => {
  test("reports changed cells, added and removed rows, a summary first and a markdown table", async () => {
    const { out, body, differences, sheets } = await diff("basic");
    assert.equal(out.isError, false, JSON.stringify(body));
    assert.equal(body.kind, "xlsx_diff");
    assert.equal(Object.keys(body).indexOf("summary") < Object.keys(body).indexOf("table"), true);
    const data = sheets[0];
    assert.equal(data?.sheet, "Data");
    assert.equal(data?.baseHeaderRow, 1);
    assert.deepEqual(data?.keyColumns, ["id"]);
    assert.equal(data?.changedCells, 1);
    assert.equal(data?.rowsAdded, 1);
    assert.equal(data?.rowsRemoved, 1);
    assert.deepEqual(
      differences.map((d) => [d.kind, d.key, d.column, d.old, d.new]),
      [
        ["cell_changed", "2", "qty", "20", "25"],
        ["row_removed", "3", "", "id=3; name=c; qty=30", ""],
        ["row_added", "4", "", "", "id=4; name=d; qty=40"],
      ],
    );
    assert.match(body.table as string, /^\| sheet \| key \| column \| old \| new \| kind \|$/m);
    assert.match(body.table as string, /^\| Data \| 2 \| qty \| 20 \| 25 \| cell_changed \|$/m);
    assert.equal(body.total, 3);
    assert.equal(body.truncated, false);
    assert.equal(body.nextOffset, null);
  });

  test("finds the header below title rows and honours a header row override", async () => {
    const auto = await diff("titles");
    assert.equal(auto.sheets[0]?.baseHeaderRow, 3);
    assert.deepEqual(auto.sheets[0]?.keyColumns, ["code"]);
    assert.deepEqual(
      auto.differences.map((d) => [d.key, d.column, d.old, d.new]),
      [["k2", "value", "2", "3"]],
    );
    const forced = await diff("titles", { overrides: { T: { headerRow: 4 } } });
    assert.equal(forced.sheets[0]?.baseHeaderRow, 4);
    assert.deepEqual(forced.sheets[0]?.keyColumns, ["k1"]);
  });

  test("supports composite keys by name or by letter and refuses an unknown key column", async () => {
    const single = await diff("composite");
    assert.ok(single.sheets[0] && single.sheets[0].ambiguous > 0);
    assert.ok(find(single.differences, "ambiguous").some((d) => (d.details.reason as string) === "duplicate_key"));
    for (const keyColumns of [
      ["region", "id"],
      ["A", "B"],
    ]) {
      const keyed = await diff("composite", { overrides: { C: { keyColumns } } });
      assert.deepEqual(keyed.sheets[0]?.keyColumns, ["region", "id"]);
      assert.deepEqual(
        keyed.differences.map((d) => [d.key, d.column, d.old, d.new]),
        [
          ["east | 2", "val", "y", "Y"],
          ["west | 1", "val", "z", "zz"],
        ],
      );
    }
    const bad = await diff("composite", { overrides: { C: { keyColumns: ["nope"] } } });
    assert.equal((bad.body.error as { code: string }).code, "bad_override");
  });

  test("duplicate and empty keys are reported as ambiguous with row numbers and are not compared", async () => {
    const { differences, sheets } = await diff("ambiguity");
    const ambiguous = find(differences, "ambiguous");
    assert.ok(ambiguous.some((d) => d.key === "dup" && d.old === "rows 2,3" && d.details.reason === "duplicate_key"));
    assert.ok(ambiguous.some((d) => d.key === "(empty key)" && d.old === "rows 4" && d.details.reason === "empty_key"));
    assert.equal(find(differences, "cell_changed", "dup").length, 0);
    assert.deepEqual(
      find(differences, "cell_changed").map((d) => [d.key, d.old, d.new]),
      [["ok2", "before", "after"]],
    );
    assert.ok((sheets[0]?.ambiguous ?? 0) >= 3);
  });

  test("added and removed columns are listed by header and common columns are still compared", async () => {
    const { differences, sheets } = await diff("columns");
    assert.deepEqual(
      find(differences, "column_removed").map((d) => d.column),
      ["b"],
    );
    assert.deepEqual(
      find(differences, "column_added").map((d) => d.column),
      ["c"],
    );
    assert.deepEqual(
      find(differences, "cell_changed").map((d) => [d.key, d.column, d.old, d.new]),
      [["1", "a", "x", "x2"]],
    );
    assert.equal(sheets[0]?.columnsAdded, 1);
    assert.equal(sheets[0]?.columnsRemoved, 1);
  });

  test("duplicate headers get an occurrence suffix and are flagged", async () => {
    const { differences } = await diff("dupheaders");
    assert.ok(find(differences, "ambiguous_header").some((d) => d.column === "v"));
    assert.deepEqual(
      find(differences, "cell_changed").map((d) => [d.column, d.old, d.new]),
      [["v (2)", "b", "B"]],
    );
  });

  test("long cell values are cut to 200 characters and flagged", async () => {
    const { differences } = await diff("long");
    const change = find(differences, "cell_changed")[0];
    assert.equal(change?.old.length, 203);
    assert.equal(change?.new.length, 203);
    assert.equal(change?.details.oldTruncated, true);
    assert.equal(change?.details.newTruncated, true);
  });
});

describe("formulas, text, dates, merges, hidden and sheets", () => {
  test("compares cached values by default, reports formula changes with equal values and falls back to formula text", async () => {
    const { differences, sheets } = await diff("formulas");
    const byKey = (key: string) => differences.filter((d) => d.key === key);
    const sum = (key: string) => byKey(key).find((d) => d.column === "sum");
    assert.equal(sum("1")?.kind, "formula_changed");
    assert.equal(sum("1")?.old, "=B2+C2");
    assert.equal(sum("1")?.new, "=B2*C2-1");
    assert.equal(sum("1")?.details.value, "3");
    assert.equal(sum("2")?.kind, "cell_changed");
    assert.equal(sum("2")?.details.compared, "cached_value");
    assert.equal(sum("2")?.old, "10");
    assert.equal(sum("2")?.new, "11");
    assert.equal(sum("3")?.kind, "cell_changed");
    assert.equal(sum("3")?.details.compared, "formula_text");
    assert.equal(sum("3")?.old, "=B4+C4");
    assert.equal(sum("3")?.new, "=B4*C4");
    assert.equal(sheets[0]?.formulaChanged, 3);
  });

  test("shared formulas are expanded as text before comparing", async () => {
    const { differences } = await diff("formulas");
    const shared = differences.filter((d) => d.column === "b" && (d.key === "4" || d.key === "5"));
    assert.deepEqual(
      shared.map((d) => [d.key, d.kind, d.old, d.new]),
      [
        ["4", "formula_changed", "=B5*2", "=B5*3"],
        ["5", "formula_changed", "=B6*2", "=B6*3"],
      ],
    );
  });

  test("rich text is concatenated, phonetic runs are ignored and inline strings are read", async () => {
    const { differences } = await diff("rich");
    assert.deepEqual(
      differences.map((d) => [d.key, d.kind, d.old, d.new]),
      [
        ["2", "cell_changed", "ab", "abc"],
        ["3", "cell_changed", "inline one", "inline two"],
      ],
    );
  });

  test("dates are compared by serial and shown with both the serial and the ISO date", async () => {
    const { differences } = await diff("dates");
    assert.deepEqual(
      differences.map((d) => [d.key, d.old, d.new]),
      [["2", "2023-03-25 (serial 45010)", "2023-03-26T12:00:00 (serial 45011.5)"]],
    );
  });

  test("changed merges and hidden rows and columns are reported", async () => {
    const merged = await diff("merges");
    assert.deepEqual(
      merged.differences.map((d) => [d.kind, d.old, d.new]),
      [
        ["merge_changed", "", "merged A2:C2"],
        ["merge_changed", "merged A2:B2", ""],
      ],
    );
    const hidden = await diff("hidden");
    const kinds = hidden.differences.map((d) => [d.kind, d.key, d.column, d.old, d.new]);
    assert.deepEqual(kinds, [
      ["hidden_changed", "(column)", "q", "visible", "hidden"],
      ["hidden_changed", "2", "", "visible", "hidden"],
    ]);
  });

  test("added and removed sheets report row and column counts only", async () => {
    const { differences, sheets } = await diff("sheets");
    assert.deepEqual(
      differences.map((d) => [d.sheet, d.kind, d.old, d.new]),
      [
        ["Fresh", "sheet_added", "", "rows=3 columns=2"],
        ["Gone", "sheet_removed", "rows=2 columns=3", ""],
      ],
    );
    assert.deepEqual(
      sheets.map((s) => [s.sheet, s.status]),
      [
        ["Keep", "both"],
        ["Fresh", "sheet_added"],
        ["Gone", "sheet_removed"],
      ],
    );
    const only = await diff("sheets", { sheets: ["Keep"] });
    assert.deepEqual(only.differences, []);
  });
});

describe("files that are not compared", () => {
  test("an LFS pointer on one or both sides is reported, never a parse error", async () => {
    const one = await diff("lfs_one_side");
    assert.equal(one.body.kind, "lfs_pointer");
    assert.equal((one.body.newLfs as { oid: string }).oid, "c".repeat(64));
    assert.equal(one.body.oldLfs, undefined);
    assert.equal(one.body.note, "LFS file, content not compared, only oid/size changed");
    const both = await diff("lfs_both");
    assert.equal(both.body.kind, "lfs_pointer_changed");
    assert.deepEqual(both.body.oldLfs, { oid: "c".repeat(64), size: 111 });
    assert.deepEqual(both.body.newLfs, { oid: "d".repeat(64), size: 222 });
  });

  test("other file types, encrypted, macro and broken packages are reported as unsupported", async () => {
    const before = logger.calls().length;
    const xls = await diff("legacy");
    assert.equal(xls.body.kind, "unsupported");
    assert.equal(xls.body.reason, "xls");
    const xlsm = await diff("macro_ext");
    assert.equal(xlsm.body.reason, "xlsm");
    assert.equal(logger.calls().length, before);
    for (const [name, reason] of [
      ["not_a_zip", "not_a_zip_package"],
      ["encrypted", "not_a_zip_package"],
      ["macro", "xlsm"],
    ] as const) {
      const out = await diff(name);
      assert.equal(out.out.isError, false, JSON.stringify(out.body));
      assert.equal(out.body.kind, "unsupported", name);
      assert.equal(out.body.reason, reason, name);
    }
  });

  test("a file present at one ref only is reported as added or removed and an identical blob as unchanged", async () => {
    const s = scenarios.get("added");
    const added = await h.call("diff_xlsx", { repo: "gameconfig", path: s?.path, base: s?.base, head: s?.head });
    assert.equal(added.body.kind, "file_added");
    const removed = await h.call("diff_xlsx", { repo: "gameconfig", path: s?.path, base: s?.head, head: s?.base });
    assert.equal(removed.body.kind, "file_removed");
    const same = await h.call("diff_xlsx", { repo: "gameconfig", path: s?.path, base: s?.head, head: s?.head });
    assert.equal(same.body.kind, "unchanged");
    const none = await h.call("diff_xlsx", { repo: "gameconfig", path: "x/none.xlsx", base: s?.head, head: s?.head });
    assert.equal((none.body.error as { code: string }).code, "not_found");
  });
});

describe("paging, limits and refusals", () => {
  test("offset and limit page through a stable ordering and the pages add up to the full result", async () => {
    const full = await diff("paging", { limit: 100 });
    assert.equal(full.body.total, 30);
    assert.equal(full.differences.length, 30);
    const seen: string[] = [];
    let offset = 0;
    for (let pages = 0; pages < 10; pages++) {
      const page = await diff("paging", { offset, limit: 12 });
      seen.push(...page.differences.map((d) => d.key));
      if (page.body.nextOffset === null) break;
      offset = page.body.nextOffset as number;
    }
    assert.deepEqual(
      seen,
      full.differences.map((d) => d.key),
    );
    assert.deepEqual(seen, [...seen].sort());
  });

  test("the response is cut by size, says how many differences were cut and continues from nextOffset", async () => {
    const small = await startHarness(
      testConfig(root, fx.remoteBase, { truncateChars: 9000, clonesDir: join(root, "small-xlsx") }),
    );
    try {
      const first = await diff("paging", {}, small);
      assert.equal(first.body.truncated, true);
      assert.ok((first.body.cutDifferences as number) > 0);
      assert.ok(JSON.stringify(first.body).length <= 9000);
      const rest = await diff("paging", { offset: first.body.nextOffset as number }, small);
      assert.equal(
        (first.body.returned as number) + (rest.body.returned as number) + ((rest.body.cutDifferences as number) ?? 0),
        30,
      );
    } finally {
      await small.stop();
    }
  });

  test("hostile arguments are refused before any process starts and the audit holds no cell content", async () => {
    const started = logger.calls().length;
    const s = scenarios.get("basic");
    const base = { repo: "gameconfig", path: s?.path, base: s?.base, head: s?.head };
    const cases: [Record<string, unknown>, string][] = [
      [{ path: "../x.xlsx" }, "bad_path"],
      [{ base: "--output=x" }, "bad_ref"],
      [{ head: "a..b" }, "bad_ref"],
      [{ repo: "qm-test" }, "repo_not_allowed"],
      [{ offset: -1 }, "bad_number"],
      [{ limit: 0 }, "bad_number"],
      [{ overrides: { S: { headerRow: 0 } } }, "bad_number"],
      [{ overrides: { S: { keyColumns: [""] } } }, "bad_arguments"],
      [{ sheets: ["a\u0000b"] }, "bad_arguments"],
      [{ url: "x" }, "bad_arguments"],
    ];
    for (const [extra, reason] of cases) {
      const out = await h.call("diff_xlsx", { ...base, ...extra });
      assert.equal((out.body.error as { code: string }).code, reason, JSON.stringify(extra));
    }
    assert.equal(logger.calls().length, started);
    const dump = JSON.stringify(h.audit.rows());
    for (const content of ["Quarterly report", "orphan", "inline one", "item "])
      assert.equal(dump.includes(content), false);
    assert.ok(h.audit.rows().some((row) => row.tool === "diff_xlsx" && row.result === "ok"));
  });
});
