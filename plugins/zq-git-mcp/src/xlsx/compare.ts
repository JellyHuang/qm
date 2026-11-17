import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { HeaderDetection, SheetMeta } from "./ingest.ts";

const VALUE_CHARS = 200;

type CellTuple = [string, string | null, number | null, number];

export interface SheetSummary {
  sheet: string;
  status: "both" | "sheet_added" | "sheet_removed";
  baseHeaderRow: number | null;
  headHeaderRow: number | null;
  baseHeaderDetection: HeaderDetection;
  headHeaderDetection: HeaderDetection;
  suggestedKeyColumns?: string[];
  keyColumns: string[];
  rows: { base: number; head: number };
  changedCells: number;
  formulaChanged: number;
  rowsAdded: number;
  rowsRemoved: number;
  columnsAdded: number;
  columnsRemoved: number;
  ambiguous: number;
  ambiguousKeys: number;
  mergeChanged: number;
  hiddenChanged: number;
}

const GROUP = { sheet: 0, column: 1, ambiguity: 2, merge: 3, row: 4 } as const;
const LISTED_ROWS = 20;

function clip(text: string): { text: string; cut: boolean } {
  return text.length > VALUE_CHARS ? { text: `${text.slice(0, VALUE_CHARS)}...`, cut: true } : { text, cut: false };
}

function sheetStatus(b: SheetMeta | undefined, h: SheetMeta | undefined): SheetSummary["status"] {
  if (b && h) return "both";
  return h ? "sheet_added" : "sheet_removed";
}

function sameValue(a: CellTuple | undefined, b: CellTuple | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a[2] !== null && b[2] !== null) return a[2] === b[2];
  return a[0] === b[0];
}

export function compareSheets(
  db: DatabaseSync,
  base: Map<string, SheetMeta>,
  head: Map<string, SheetMeta>,
  filter: Set<string> | undefined,
  progress: () => void,
): { summaries: SheetSummary[]; names: string[] } {
  const names = [...head.keys(), ...[...base.keys()].filter((name) => !head.has(name))].filter(
    (name) => !filter || filter.has(name),
  );
  const insert = db.prepare("INSERT INTO diffs VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const summaries: SheetSummary[] = [];

  const add = (
    sheetIdx: number,
    grp: number,
    key: string,
    col: number,
    kind: string,
    oldValue: string,
    newValue: string,
    extra: Record<string, unknown> = {},
  ) => {
    const o = clip(oldValue);
    const n = clip(newValue);
    const flags = { ...extra, ...(o.cut ? { oldTruncated: true } : {}), ...(n.cut ? { newTruncated: true } : {}) };
    insert.run(sheetIdx, grp, key, col, kind, o.text, n.text, JSON.stringify(flags));
  };

  const describe = (cells: string): string => {
    const parsed = JSON.parse(cells) as Record<string, CellTuple>;
    return Object.entries(parsed)
      .map(([header, cell]) => `${header}=${cell[0]}`)
      .join("; ");
  };

  db.exec("BEGIN");
  names.forEach((name, sheetIdx) => {
    const b = base.get(name);
    const h = head.get(name);
    const summary: SheetSummary = {
      sheet: name,
      status: sheetStatus(b, h),
      baseHeaderRow: b?.headerRow ?? null,
      headHeaderRow: h?.headerRow ?? null,
      baseHeaderDetection: b?.detection ?? "none",
      headHeaderDetection: h?.detection ?? "none",
      keyColumns: (h ?? b)?.keyNames ?? [],
      rows: { base: b?.dataRows ?? 0, head: h?.dataRows ?? 0 },
      changedCells: 0,
      formulaChanged: 0,
      rowsAdded: 0,
      rowsRemoved: 0,
      columnsAdded: 0,
      columnsRemoved: 0,
      ambiguous: 0,
      ambiguousKeys: 0,
      mergeChanged: 0,
      hiddenChanged: 0,
    };
    summaries.push(summary);
    if (!b || !h) {
      const only = (b ?? h) as SheetMeta;
      const counts = `rows=${only.dataRows} columns=${only.headers.length}`;
      add(sheetIdx, GROUP.sheet, "(sheet)", 0, summary.status, b ? counts : "", h ? counts : "");
      return;
    }

    const baseSet = new Set(b.headers);
    const headSet = new Set(h.headers);
    h.headers.forEach((header, i) => {
      if (baseSet.has(header)) return;
      summary.columnsAdded++;
      add(sheetIdx, GROUP.column, "(column)", i, "column_added", "", header, { column: header });
    });
    b.headers.forEach((header, i) => {
      if (headSet.has(header)) return;
      summary.columnsRemoved++;
      add(sheetIdx, GROUP.column, "(column)", 100_000 + i, "column_removed", header, "", { column: header });
    });
    for (const [meta, side] of [
      [b, "base"],
      [h, "head"],
    ] as const)
      for (const header of meta.ambiguousHeaders) {
        summary.ambiguous++;
        add(
          sheetIdx,
          GROUP.column,
          "(column)",
          200_000,
          "ambiguous_header",
          side === "base" ? header : "",
          side === "head" ? header : "",
          { side, column: header },
        );
      }
    const hiddenBase = new Set(b.hiddenHeaders);
    const hiddenHead = new Set(h.hiddenHeaders);
    h.headers.forEach((header, i) => {
      if (!baseSet.has(header) || hiddenBase.has(header) === hiddenHead.has(header)) return;
      summary.hiddenChanged++;
      add(
        sheetIdx,
        GROUP.column,
        "(column)",
        300_000 + i,
        "hidden_changed",
        hiddenBase.has(header) ? "hidden" : "visible",
        hiddenHead.has(header) ? "hidden" : "visible",
        { column: header },
      );
    });
    const mergesBase = new Set(b.merges);
    const mergesHead = new Set(h.merges);
    for (const ref of h.merges)
      if (!mergesBase.has(ref)) {
        summary.mergeChanged++;
        add(sheetIdx, GROUP.merge, "(merge)", 0, "merge_changed", "", `merged ${ref}`, { ref });
      }
    for (const ref of b.merges)
      if (!mergesHead.has(ref)) {
        summary.mergeChanged++;
        add(sheetIdx, GROUP.merge, "(merge)", 1, "merge_changed", `merged ${ref}`, "", { ref });
      }

    if (b.keyId !== h.keyId) {
      summary.ambiguous++;
      summary.ambiguousKeys++;
      add(sheetIdx, GROUP.ambiguity, "(key)", 0, "ambiguous", b.keyNames.join(", "), h.keyNames.join(", "), {
        reason: "key_columns_differ",
      });
      return;
    }

    db.exec("DELETE FROM bad");
    const dupes = db
      .prepare(
        "SELECT side, key, count(*) AS n, group_concat(rownum) AS rows FROM rows WHERE sheet = ? AND key IS NOT NULL GROUP BY side, key HAVING n > 1",
      )
      .all(name) as { side: number; key: string; n: number; rows: string }[];
    const markBad = db.prepare("INSERT OR IGNORE INTO bad VALUES (?)");
    for (const dupe of dupes) {
      markBad.run(dupe.key);
      summary.ambiguous++;
      summary.ambiguousKeys++;
      const rowsText = dupe.rows.split(",").slice(0, LISTED_ROWS).join(",");
      add(
        sheetIdx,
        GROUP.ambiguity,
        dupe.key,
        0,
        "ambiguous",
        dupe.side === 0 ? `rows ${rowsText}` : "",
        dupe.side === 1 ? `rows ${rowsText}` : "",
        { reason: "duplicate_key", side: dupe.side === 0 ? "base" : "head", count: dupe.n },
      );
    }
    for (const side of [0, 1]) {
      const empty = db
        .prepare("SELECT rownum FROM rows WHERE sheet = ? AND side = ? AND key IS NULL ORDER BY rownum")
        .all(name, side) as { rownum: number }[];
      if (empty.length === 0) continue;
      summary.ambiguous++;
      summary.ambiguousKeys++;
      const rowsText = empty
        .slice(0, LISTED_ROWS)
        .map((r) => r.rownum)
        .join(",");
      add(
        sheetIdx,
        GROUP.ambiguity,
        "(empty key)",
        side,
        "ambiguous",
        side === 0 ? `rows ${rowsText}` : "",
        side === 1 ? `rows ${rowsText}` : "",
        { reason: "empty_key", side: side === 0 ? "base" : "head", count: empty.length },
      );
    }

    const onlyIn = (sideA: number, sideB: number): StatementSync =>
      db.prepare(
        `SELECT a.key AS key, a.cells AS cells, a.rownum AS rownum FROM rows a WHERE a.side = ${sideA} AND a.sheet = ? AND a.key IS NOT NULL AND a.key NOT IN (SELECT key FROM bad) AND NOT EXISTS (SELECT 1 FROM rows o WHERE o.side = ${sideB} AND o.sheet = a.sheet AND o.key = a.key)`,
      );
    for (const row of onlyIn(1, 0).iterate(name) as Iterable<{ key: string; cells: string; rownum: number }>) {
      summary.rowsAdded++;
      add(sheetIdx, GROUP.row, row.key, 0, "row_added", "", describe(row.cells), { row: row.rownum });
    }
    for (const row of onlyIn(0, 1).iterate(name) as Iterable<{ key: string; cells: string; rownum: number }>) {
      summary.rowsRemoved++;
      add(sheetIdx, GROUP.row, row.key, 0, "row_removed", describe(row.cells), "", { row: row.rownum });
    }

    const changed = db.prepare(
      "SELECT b.key AS key, b.cells AS bc, h.cells AS hc, b.hidden AS bh, h.hidden AS hh, b.rownum AS brow, h.rownum AS hrow FROM rows b JOIN rows h ON h.side = 1 AND h.sheet = b.sheet AND h.key = b.key WHERE b.side = 0 AND b.sheet = ? AND b.key IS NOT NULL AND b.key NOT IN (SELECT key FROM bad) AND (b.hash != h.hash OR b.hidden != h.hidden)",
    );
    let seen = 0;
    for (const row of changed.iterate(name) as Iterable<{
      key: string;
      bc: string;
      hc: string;
      bh: number;
      hh: number;
      brow: number;
      hrow: number;
    }>) {
      if (++seen % 5000 === 0) progress();
      if (row.bh !== row.hh) {
        summary.hiddenChanged++;
        add(
          sheetIdx,
          GROUP.row,
          row.key,
          0,
          "hidden_changed",
          row.bh ? "hidden" : "visible",
          row.hh ? "hidden" : "visible",
          { row: row.hrow },
        );
      }
      const before = JSON.parse(row.bc) as Record<string, CellTuple>;
      const after = JSON.parse(row.hc) as Record<string, CellTuple>;
      h.headers.forEach((header, col) => {
        if (!baseSet.has(header)) return;
        const a = before[header];
        const c = after[header];
        if (a === undefined && c === undefined) return;
        const hasFormula = (a?.[1] ?? null) !== null || (c?.[1] ?? null) !== null;
        const cachedBoth = (a === undefined || a[3] === 0) && (c === undefined || c[3] === 0);
        const valuesSame = sameValue(a, c);
        const formulasSame = (a?.[1] ?? null) === (c?.[1] ?? null);
        if (hasFormula && !cachedBoth) {
          if (formulasSame) return;
          summary.changedCells++;
          add(
            sheetIdx,
            GROUP.row,
            row.key,
            col,
            "cell_changed",
            a?.[1] ? `=${a[1]}` : (a?.[0] ?? ""),
            c?.[1] ? `=${c[1]}` : (c?.[0] ?? ""),
            { compared: "formula_text", row: row.hrow },
          );
          return;
        }
        if (!valuesSame) {
          summary.changedCells++;
          add(sheetIdx, GROUP.row, row.key, col, "cell_changed", a?.[0] ?? "", c?.[0] ?? "", {
            compared: hasFormula ? "cached_value" : "value",
            row: row.hrow,
            ...(a?.[1] ? { oldFormula: a[1] } : {}),
            ...(c?.[1] ? { newFormula: c[1] } : {}),
          });
        } else if (hasFormula && !formulasSame) {
          summary.formulaChanged++;
          add(
            sheetIdx,
            GROUP.row,
            row.key,
            col,
            "formula_changed",
            a?.[1] ? `=${a[1]}` : "",
            c?.[1] ? `=${c[1]}` : "",
            { compared: "cached_value", value: c?.[0] ?? "", row: row.hrow },
          );
        }
      });
    }
  });
  db.exec("COMMIT");
  return { summaries, names };
}

export interface DiffRow {
  sheet: string;
  key: string;
  column: string;
  old: string;
  new: string;
  kind: string;
  details: Record<string, unknown>;
}

function escapeCell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n|\r/g, "\\n");
}

export function readPage(
  db: DatabaseSync,
  names: string[],
  headersBySheet: Map<string, string[]>,
  offset: number,
  limit: number,
  budget: number,
): { total: number; rows: DiffRow[]; table: string; truncated: boolean; cut: number; next: number | null } {
  const total = (db.prepare("SELECT count(*) AS n FROM diffs").get() as { n: number }).n;
  const stmt = db.prepare(
    "SELECT sheet_idx, key, col, kind, old, new, extra FROM diffs ORDER BY sheet_idx, grp, key, col, rowid LIMIT ? OFFSET ?",
  );
  const rows: DiffRow[] = [];
  const lines = ["| sheet | key | column | old | new | kind |", "| --- | --- | --- | --- | --- | --- |"];
  let used = lines.join("\n").length;
  let truncated = false;
  for (const raw of stmt.iterate(limit, offset) as Iterable<{
    sheet_idx: number;
    key: string;
    col: number;
    kind: string;
    old: string;
    new: string;
    extra: string;
  }>) {
    const sheet = names[raw.sheet_idx] ?? "";
    const details = JSON.parse(raw.extra) as Record<string, unknown>;
    const headers = headersBySheet.get(sheet) ?? [];
    const cellLevel = raw.kind === "cell_changed" || raw.kind === "formula_changed";
    const fromHeader = cellLevel ? (headers[raw.col] ?? "") : "";
    const column = typeof details.column === "string" ? details.column : fromHeader;
    const row: DiffRow = {
      sheet,
      key: raw.key.replaceAll("\u001f", " | "),
      column,
      old: raw.old,
      new: raw.new,
      kind: raw.kind,
      details,
    };
    const line = `| ${[row.sheet, row.key, row.column, row.old, row.new, row.kind].map(escapeCell).join(" | ")} |`;
    const cost = JSON.stringify(row).length + line.length + 2;
    if (used + cost > budget && rows.length > 0) {
      truncated = true;
      break;
    }
    used += cost;
    rows.push(row);
    lines.push(line);
  }
  const end = offset + rows.length;
  return {
    total,
    rows,
    table: lines.join("\n"),
    truncated,
    cut: truncated ? total - end : 0,
    next: end < total ? end : null,
  };
}
