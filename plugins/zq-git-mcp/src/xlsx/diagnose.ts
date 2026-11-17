import type { DatabaseSync } from "node:sqlite";
import { colLetters } from "./cells.ts";
import type { SheetMeta } from "./ingest.ts";
import { suggestKeyColumns } from "./keys.ts";
import type { WorkbookInfo } from "./parse.ts";

interface Ingested {
  info: WorkbookInfo;
  metas: Map<string, SheetMeta>;
}

const SIDES = ["base", "head"] as const;

const REPORTED = { both: "compared", only_base: "sheet_removed", only_head: "sheet_added", neither: "none" } as const;

function sheetStatus(b: SheetMeta | undefined, h: SheetMeta | undefined): keyof typeof REPORTED {
  if (b && h) return "both";
  if (b) return "only_base";
  return h ? "only_head" : "neither";
}

function keyLetters(meta: SheetMeta): string[] {
  return meta.keyNames.map((name) => colLetters(meta.headerCols[meta.headers.indexOf(name)] ?? 1));
}

function firstColumn(db: DatabaseSync, side: number, sheet: string) {
  const counts = db
    .prepare(
      "SELECT count(*) AS rows, sum(key IS NULL) AS empty, count(DISTINCT key) AS distinctKeys FROM rows WHERE side = ? AND sheet = ?",
    )
    .get(side, sheet) as { rows: number; empty: number | null; distinctKeys: number };
  const duplicates = db
    .prepare(
      "SELECT count(*) AS keys, coalesce(sum(n), 0) AS rows FROM (SELECT count(*) AS n FROM rows WHERE side = ? AND sheet = ? AND key IS NOT NULL GROUP BY key HAVING n > 1)",
    )
    .get(side, sheet) as { keys: number; rows: number };
  return {
    dataRows: counts.rows,
    emptyKeys: counts.empty ?? 0,
    distinctKeys: counts.distinctKeys,
    duplicateKeys: duplicates.keys,
    duplicateKeyRows: duplicates.rows,
  };
}

function reasonFor(meta: SheetMeta | undefined, info: WorkbookInfo | undefined): string {
  if (!meta)
    return `not parsed: the workbook declares ${info?.declared.length ?? 0} sheets, ${info?.unresolved.length ?? 0} without a readable part`;
  if (meta.headerRow === undefined)
    return meta.rowElements === 0 ? "no rows at all" : `no non-empty row among ${meta.rowElements} rows`;
  if (meta.detection === "rule") return `row ${meta.headerRow} qualified`;
  if (meta.detection === "override") return `row ${meta.headerRow} by override`;
  return `no row in the window qualified, the first non-empty row ${meta.headerRow} was used`;
}

export function describeWorkbooks(db: DatabaseSync, sides: [Ingested, Ingested]): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  sides.forEach((ingested, side) => {
    lines.push({
      type: "workbook",
      side: SIDES[side],
      sheetsDeclared: ingested.info.declared.length,
      sheetNames: ingested.info.declared,
      sheetsParsed: ingested.metas.size,
      sheetsWithoutPart: ingested.info.unresolved,
      dateStyles: ingested.info.dateStyles.size,
    });
    for (const meta of ingested.metas.values()) {
      const key = firstColumn(db, side, meta.name);
      lines.push({
        type: "sheet",
        side: SIDES[side],
        sheet: meta.name,
        rowElements: meta.rowElements,
        columns: meta.columns,
        headerColumns: meta.headers.length,
        duplicateHeaders: meta.ambiguousHeaders.length,
        headerRow: meta.headerRow ?? null,
        headerDetection: meta.detection,
        headerReason: reasonFor(meta, undefined),
        headerRowsConsidered: meta.considered,
        firstRows: meta.firstRows,
        keyColumns: keyLetters(meta),
        firstColumn: key,
      });
    }
  });
  const [base, head] = sides;
  const names = [
    ...new Set([...head.info.declared, ...base.info.declared, ...base.metas.keys(), ...head.metas.keys()]),
  ];
  for (const name of names) {
    const b = base.metas.get(name);
    const h = head.metas.get(name);
    const status = sheetStatus(b, h);
    const differ = b && h ? b.keyId !== h.keyId : false;
    const key = [0, 1]
      .map((side) => (side === 0 ? b : h))
      .map((meta, side) => (meta ? firstColumn(db, side, name) : undefined));
    const ambiguous = key.some((entry) => entry && (entry.emptyKeys > 0 || entry.duplicateKeys > 0));
    lines.push({
      type: "compare",
      sheet: name,
      status,
      reportedAs: REPORTED[status],
      baseHeaderRow: b?.headerRow ?? null,
      headHeaderRow: h?.headerRow ?? null,
      baseReason: reasonFor(b, base.info),
      headReason: reasonFor(h, head.info),
      keyColumnsDiffer: differ,
      ambiguousDefaultKey: ambiguous,
      suggestedKeyColumns: h && (ambiguous || differ) ? suggestKeyColumns(db, name, b, h) : [],
    });
  }
  return lines;
}
