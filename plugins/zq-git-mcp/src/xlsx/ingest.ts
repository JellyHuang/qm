import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { colIndex, colLetters } from "./cells.ts";
import { readWorkbookInfo, readWorksheets, type SheetEvents, type SheetRow, type WorkbookInfo } from "./parse.ts";

interface SheetOverride {
  headerRow?: number;
  keyColumns?: string[];
}

export type Overrides = Record<string, SheetOverride>;

export type HeaderDetection = "rule" | "fallback_first_row" | "override" | "none";

interface RowShape {
  row: number;
  nonEmpty: number;
  text: number;
  numeric: number;
  formula: number;
}

interface HeaderRuleRow extends RowShape {
  reason: "too_few_cells" | "not_mostly_text" | "no_data_row_after" | "qualified";
}

export interface SheetMeta {
  name: string;
  headerRow: number | undefined;
  detection: HeaderDetection;
  considered: HeaderRuleRow[];
  firstRows: RowShape[];
  rowElements: number;
  columns: number;
  headers: string[];
  headerCols: number[];
  keyNames: string[];
  keyId: string;
  ambiguousHeaders: string[];
  hiddenHeaders: string[];
  merges: string[];
  dataRows: number;
}

export class OverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverrideError";
  }
}

const HEADER_WINDOW = 10;
const FIRST_ROWS = 15;
const BATCH_ROWS = 5000;
const CACHE_STRINGS = 20_000;
const PROGRESS_EVERY = 20_000;

export function createSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = FILE;
    CREATE TABLE ss (side INTEGER, id INTEGER, text TEXT, PRIMARY KEY (side, id)) WITHOUT ROWID;
    CREATE TABLE rows (side INTEGER, sheet TEXT, key TEXT, rownum INTEGER, hash TEXT, hidden INTEGER, cells TEXT);
    CREATE TABLE diffs (sheet_idx INTEGER, grp INTEGER, key TEXT, col INTEGER, kind TEXT, old TEXT, new TEXT, extra TEXT);
    CREATE TABLE bad (key TEXT PRIMARY KEY) WITHOUT ROWID;
  `);
}

function textual(row: SheetRow): number {
  return row.cells.filter((cell) => cell.isText && cell.display.trim() !== "").length;
}

function filled(row: SheetRow) {
  return row.cells.filter((cell) => cell.display !== "" || cell.formula !== null);
}

const nonEmpty = (row: SheetRow): number => filled(row).length;

function shapeOf(row: SheetRow): RowShape {
  const cells = filled(row);
  const formula = cells.filter((cell) => cell.formula !== null).length;
  const text = cells.filter((cell) => cell.formula === null && cell.isText && cell.display.trim() !== "").length;
  return { row: row.num, nonEmpty: cells.length, text, numeric: cells.length - formula - text, formula };
}

function chooseHeader(rows: SheetRow[]): {
  index: number;
  detection: "rule" | "fallback_first_row" | "none";
  considered: HeaderRuleRow[];
} {
  const window = rows.slice(0, HEADER_WINDOW);
  const widest = Math.max(0, ...window.map(nonEmpty));
  const needed = Math.min(2, widest);
  const considered: HeaderRuleRow[] = [];
  for (let i = 0; i < window.length; i++) {
    const row = window[i];
    if (!row) continue;
    const cols = filled(row).map((cell) => cell.col);
    const span = cols.length === 0 ? 1 : Math.max(...cols) - Math.min(...cols) + 1;
    const followed = rows.slice(i + 1).some((next) => nonEmpty(next) > 0);
    let reason: HeaderRuleRow["reason"] = "qualified";
    if (cols.length < needed) reason = "too_few_cells";
    else if (textual(row) / span < 0.6) reason = "not_mostly_text";
    else if (!followed) reason = "no_data_row_after";
    considered.push({ ...shapeOf(row), reason });
    if (reason === "qualified") return { index: i, detection: "rule", considered };
  }
  const first = rows.findIndex((row) => nonEmpty(row) > 0);
  return { index: first, detection: first < 0 ? "none" : "fallback_first_row", considered };
}

function resolveKeys(
  sheet: string,
  override: SheetOverride | undefined,
  headers: string[],
  headerCols: number[],
): { names: string[]; cols: number[] } {
  if (!override?.keyColumns || override.keyColumns.length === 0) {
    const first = headers[0];
    return first === undefined ? { names: [], cols: [] } : { names: [first], cols: [headerCols[0] ?? 1] };
  }
  const names: string[] = [];
  const cols: number[] = [];
  for (const token of override.keyColumns) {
    let at = headers.indexOf(token);
    if (at < 0 && /^[A-Za-z]{1,3}$/.test(token)) at = headerCols.indexOf(colIndex(token));
    if (at < 0) throw new OverrideError(`key column "${token}" is not a column of sheet "${sheet}"`);
    names.push(headers[at] ?? token);
    cols.push(headerCols[at] ?? 1);
  }
  return { names, cols };
}

function nameHeaders(row: SheetRow): { headers: string[]; cols: number[]; ambiguous: string[] } {
  const seen = new Map<string, number>();
  const ambiguous = new Set<string>();
  const headers: string[] = [];
  const cols: number[] = [];
  for (const cell of [...row.cells].sort((a, b) => a.col - b.col)) {
    const base = cell.display.trim() === "" ? colLetters(cell.col) : cell.display.trim();
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    if (count > 1) ambiguous.add(base);
    headers.push(count > 1 ? `${base} (${count})` : base);
    cols.push(cell.col);
  }
  return { headers, cols, ambiguous: [...ambiguous] };
}

export interface IngestContext {
  db: DatabaseSync;
  side: number;
  file: string;
  overrides: Overrides;
  sheets: Set<string> | undefined;
  diagnostics?: boolean;
  progress(rows: number): void;
}

export async function ingestSide(ctx: IngestContext): Promise<{ info: WorkbookInfo; metas: Map<string, SheetMeta> }> {
  const { db, side } = ctx;
  const addString = db.prepare("INSERT INTO ss VALUES (?, ?, ?)");
  const readString: StatementSync = db.prepare("SELECT text FROM ss WHERE side = ? AND id = ?");
  const cache = new Map<number, string>();
  let nextId = 0;
  db.exec("BEGIN");
  const info = await readWorkbookInfo(ctx.file, (text) => {
    addString.run(side, nextId++, text);
    if (nextId % BATCH_ROWS === 0) db.exec("COMMIT; BEGIN");
  });
  db.exec("COMMIT");
  const metas = new Map<string, SheetMeta>();
  if (info.macro || !info.hasWorkbook) return { info, metas };

  const lookup = (id: number): string => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const text = (readString.get(side, id) as { text: string } | undefined)?.text ?? "";
    if (cache.size >= CACHE_STRINGS) cache.clear();
    cache.set(id, text);
    return text;
  };

  const insert = db.prepare("INSERT INTO rows VALUES (?, ?, ?, ?, ?, ?, ?)");
  let inBatch = 0;
  let total = 0;
  db.exec("BEGIN");
  const write = (values: (string | number | null)[]) => {
    insert.run(...values);
    total++;
    if (++inBatch >= BATCH_ROWS) {
      db.exec("COMMIT; BEGIN");
      inBatch = 0;
    }
    if (total % PROGRESS_EVERY === 0) ctx.progress(total);
  };

  await readWorksheets(ctx.file, info, lookup, (sheet): SheetEvents | undefined => {
    if (ctx.sheets && !ctx.sheets.has(sheet.name)) return undefined;
    const override = ctx.overrides[sheet.name];
    const meta: SheetMeta = {
      name: sheet.name,
      headerRow: undefined,
      detection: "none",
      considered: [],
      firstRows: [],
      rowElements: 0,
      columns: 0,
      headers: [],
      headerCols: [],
      keyNames: [],
      keyId: "",
      ambiguousHeaders: [],
      hiddenHeaders: [],
      merges: [],
      dataRows: 0,
    };
    metas.set(sheet.name, meta);
    let hiddenCols = new Set<number>();
    let buffer: SheetRow[] | undefined = [];
    let keyCols: number[] = [];
    let colHeader = new Map<number, string>();
    let sortedHeaders: string[] = [];

    const decide = (header: SheetRow, detection: HeaderDetection) => {
      const named = nameHeaders(header);
      meta.headerRow = header.num;
      meta.detection = detection;
      meta.headers = named.headers;
      meta.headerCols = named.cols;
      meta.ambiguousHeaders = named.ambiguous;
      colHeader = new Map(named.cols.map((col, i) => [col, named.headers[i] ?? ""]));
      sortedHeaders = [...named.headers].sort();
      const keys = resolveKeys(sheet.name, override, named.headers, named.cols);
      meta.keyNames = keys.names;
      meta.keyId = override?.keyColumns?.length
        ? `columns:${keys.cols.join(",")}`
        : `names:${keys.names.join("\u001f")}`;
      keyCols = keys.cols;
    };

    const emit = (row: SheetRow) => {
      const cells: Record<string, (string | number | null)[]> = {};
      const byCol = new Map<number, string>();
      let any = false;
      for (const cell of row.cells) {
        byCol.set(cell.col, cell.display);
        const header = colHeader.get(cell.col);
        if (header === undefined || (cell.display === "" && cell.formula === null)) continue;
        cells[header] = [cell.display, cell.formula, cell.serial, cell.noCache ? 1 : 0];
        any = true;
      }
      if (!any) return;
      const parts = keyCols.map((col) => byCol.get(col) ?? "");
      const key = parts.every((part) => part === "") ? null : parts.join("\u001f");
      const hash = createHash("sha1")
        .update(JSON.stringify(sortedHeaders.map((header) => cells[header] ?? null)))
        .digest("hex");
      meta.dataRows++;
      write([side, sheet.name, key, row.num, hash, row.hidden ? 1 : 0, JSON.stringify(cells)]);
    };

    const flush = () => {
      if (!buffer) return;
      const rows = buffer;
      buffer = undefined;
      const chosen = chooseHeader(rows);
      meta.considered = chosen.considered;
      const header = rows[chosen.index];
      if (chosen.index < 0 || !header) return;
      decide(header, chosen.detection === "none" ? "fallback_first_row" : chosen.detection);
      for (const row of rows.slice(chosen.index + 1)) emit(row);
    };

    return {
      row(row) {
        meta.rowElements++;
        for (const cell of row.cells) if (cell.col > meta.columns) meta.columns = cell.col;
        if (ctx.diagnostics && meta.firstRows.length < FIRST_ROWS) meta.firstRows.push(shapeOf(row));
        if (override?.headerRow !== undefined) {
          if (row.num < override.headerRow) return;
          if (row.num === override.headerRow && !meta.headerRow) return decide(row, "override");
          return emit(row);
        }
        if (!buffer) return emit(row);
        if (nonEmpty(row) === 0) return;
        buffer.push(row);
        if (buffer.length > HEADER_WINDOW) flush();
      },
      hiddenColumns(columns) {
        hiddenCols = columns;
      },
      merges(refs) {
        meta.merges = [...refs].sort();
      },
      end() {
        if (buffer) flush();
        meta.hiddenHeaders = meta.headers.filter((_, i) => hiddenCols.has(meta.headerCols[i] ?? -1));
      },
    };
  });
  db.exec("COMMIT");
  return { info, metas };
}
