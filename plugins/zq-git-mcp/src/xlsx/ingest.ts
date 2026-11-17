import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { colIndex, colLetters } from "./cells.ts";
import { readWorkbookInfo, readWorksheets, type SheetEvents, type SheetRow, type WorkbookInfo } from "./parse.ts";

interface SheetOverride {
  headerRow?: number;
  keyColumns?: string[];
}

export type Overrides = Record<string, SheetOverride>;

export interface SheetMeta {
  name: string;
  headerRow: number | undefined;
  headers: string[];
  headerCols: number[];
  keyNames: string[];
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

function nonEmpty(row: SheetRow): number {
  return row.cells.filter((cell) => cell.display !== "" || cell.formula !== null).length;
}

function pickHeader(rows: SheetRow[]): number {
  const window = rows.slice(0, HEADER_WINDOW);
  const widest = Math.max(0, ...window.map(nonEmpty));
  const needed = Math.min(2, widest);
  for (let i = 0; i < window.length; i++) {
    const row = window[i];
    if (!row) continue;
    const cols = row.cells.filter((cell) => cell.display !== "" || cell.formula !== null).map((cell) => cell.col);
    if (cols.length === 0 || cols.length < needed) continue;
    const span = Math.max(...cols) - Math.min(...cols) + 1;
    const followed = rows.slice(i + 1).some((next) => nonEmpty(next) > 0);
    if (textual(row) / span >= 0.6 && followed) return i;
  }
  return rows.findIndex((row) => nonEmpty(row) > 0);
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
      headers: [],
      headerCols: [],
      keyNames: [],
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

    const decide = (header: SheetRow) => {
      const named = nameHeaders(header);
      meta.headerRow = header.num;
      meta.headers = named.headers;
      meta.headerCols = named.cols;
      meta.ambiguousHeaders = named.ambiguous;
      colHeader = new Map(named.cols.map((col, i) => [col, named.headers[i] ?? ""]));
      sortedHeaders = [...named.headers].sort();
      const keys = resolveKeys(sheet.name, override, named.headers, named.cols);
      meta.keyNames = keys.names;
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
      const at = pickHeader(rows);
      const header = rows[at];
      if (at < 0 || !header) return;
      decide(header);
      for (const row of rows.slice(at + 1)) emit(row);
    };

    return {
      row(row) {
        if (override?.headerRow !== undefined) {
          if (row.num < override.headerRow) return;
          if (row.num === override.headerRow && !meta.headerRow) return decide(row);
          return emit(row);
        }
        if (!buffer) return emit(row);
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
