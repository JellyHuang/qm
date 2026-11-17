import { closeSync, openSync, writeSync } from "node:fs";
import { Zip, ZipDeflate, strToU8, zipSync } from "fflate";

export interface CellSpec {
  v?: string | number | boolean | null;
  f?: string;
  si?: number;
  ref?: string;
  noCache?: boolean;
  date?: boolean;
  rich?: string[];
  inline?: string;
  error?: string;
}

export type Cell = CellSpec | string | number | boolean | null;

export interface SheetSpec {
  name: string;
  rows: Cell[][];
  startRow?: number;
  hiddenRows?: number[];
  hiddenCols?: number[];
  merges?: string[];
  state?: "hidden";
}

export interface WorkbookSpec {
  sheets: SheetSpec[];
  date1904?: boolean;
  macro?: boolean;
  prefix?: string;
  backslashNames?: boolean;
}

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const letters = (n: number) => {
  let out = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) out = String.fromCharCode(65 + ((x - 1) % 26)) + out;
  return out;
};

export function sharedStringsOf(spec: WorkbookSpec): { table: Map<string, number>; xml: () => string } {
  const table = new Map<string, number>();
  const items: string[] = [];
  const add = (key: string, xml: string) => {
    if (!table.has(key)) {
      table.set(key, items.length);
      items.push(xml);
    }
  };
  for (const sheet of spec.sheets)
    for (const row of sheet.rows)
      for (const cell of row) {
        if (typeof cell === "string") add(cell, `<si><t xml:space="preserve">${escapeXml(cell)}</t></si>`);
        else if (cell && typeof cell === "object" && cell.rich)
          add(
            `rich:${cell.rich.join("\u0000")}`,
            `<si>${cell.rich.map((run) => `<r><t xml:space="preserve">${escapeXml(run)}</t></r>`).join("")}<rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si>`,
          );
        else if (
          cell &&
          typeof cell === "object" &&
          typeof cell.v === "string" &&
          !cell.f &&
          !cell.inline &&
          !cell.error
        )
          add(cell.v, `<si><t xml:space="preserve">${escapeXml(cell.v)}</t></si>`);
      }
  return {
    table,
    xml: () =>
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${items.length}" uniqueCount="${items.length}">${items.join("")}</sst>`,
  };
}

function cellXml(ref: string, cell: Cell, strings: Map<string, number>): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return `<c r="${ref}" t="s"><v>${strings.get(cell)}</v></c>`;
  if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
  if (typeof cell === "boolean") return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
  if (cell.rich) return `<c r="${ref}" t="s"><v>${strings.get(`rich:${cell.rich.join("\u0000")}`)}</v></c>`;
  if (cell.inline !== undefined)
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.inline)}</t></is></c>`;
  if (cell.error) return `<c r="${ref}" t="e"><v>${cell.error}</v></c>`;
  const style = cell.date ? ' s="1"' : "";
  const formula =
    cell.f !== undefined || cell.si !== undefined
      ? `<f${cell.si !== undefined ? ` t="shared" si="${cell.si}"` : ""}${cell.ref ? ` ref="${cell.ref}"` : ""}>${escapeXml(cell.f ?? "")}</f>`
      : "";
  if (cell.noCache) return `<c r="${ref}"${style}>${formula}</c>`;
  if (typeof cell.v === "string")
    return formula
      ? `<c r="${ref}"${style} t="str">${formula}<v>${escapeXml(cell.v)}</v></c>`
      : `<c r="${ref}"${style} t="s"><v>${strings.get(cell.v)}</v></c>`;
  return `<c r="${ref}"${style}>${formula}<v>${cell.v ?? ""}</v></c>`;
}

export function sheetXml(sheet: SheetSpec, strings: Map<string, number>): string {
  const start = sheet.startRow ?? 1;
  const cols = (sheet.hiddenCols ?? [])
    .map((c) => `<col min="${c}" max="${c}" width="9" hidden="1" customWidth="1"/>`)
    .join("");
  const rows = sheet.rows
    .map((row, i) => {
      const n = start + i;
      const hidden = sheet.hiddenRows?.includes(n) ? ' hidden="1"' : "";
      return `<row r="${n}"${hidden}>${row.map((cell, c) => cellXml(`${letters(c + 1)}${n}`, cell, strings)).join("")}</row>`;
    })
    .join("");
  const merges = sheet.merges?.length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${rows}</sheetData>${merges}</worksheet>`;
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';

function packageParts(spec: WorkbookSpec): Record<string, string> {
  const sheets = spec.sheets
    .map(
      (sheet, i) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}"${sheet.state ? ` state="${sheet.state}"` : ""} r:id="rId${i + 1}"/>`,
    )
    .join("");
  const rels = spec.sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join("");
  return {
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr${spec.date1904 ? ' date1904="1"' : ""}/><sheets>${sheets}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    "xl/styles.xml": STYLES,
  };
}

function prefixed(xml: string, prefix: string | undefined): string {
  if (!prefix) return xml;
  return xml.replace(/<(\/?)([A-Za-z][\w]*)/g, `<$1${prefix}:$2`).replace(/ xmlns="/, ` xmlns:${prefix}="`);
}

export function buildXlsx(spec: WorkbookSpec): Uint8Array {
  const strings = sharedStringsOf(spec);
  const files: Record<string, Uint8Array> = {};
  const parts = packageParts(spec);
  const put = (name: string, text: string, wrap: boolean) => {
    const stored = spec.backslashNames && name.startsWith("xl/") ? name.replaceAll("/", "\\") : name;
    files[stored] = strToU8(wrap ? prefixed(text, spec.prefix) : text);
  };
  for (const [name, text] of Object.entries(parts)) put(name, text, name === "xl/workbook.xml");
  spec.sheets.forEach((sheet, i) => put(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet, strings.table), true));
  put("xl/sharedStrings.xml", strings.xml(), true);
  if (spec.macro) put("xl/vbaProject.bin", "macro", false);
  return zipSync(files, { level: 6 });
}

export interface LargeSpec {
  rows: number;
  pool: number;
  changeEvery: number;
  dropEvery: number;
  extraRows: number;
}

export function writeLargeXlsx(file: string, spec: LargeSpec, variant: "base" | "head"): void {
  const fd = openSync(file, "w");
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    writeSync(fd, chunk);
  });
  const add = (name: string, parts: Iterable<string>) => {
    const entry = new ZipDeflate(name, { level: 1 });
    zip.add(entry);
    let buffer = "";
    for (const part of parts) {
      buffer += part;
      if (buffer.length > 1 << 20) {
        entry.push(strToU8(buffer));
        buffer = "";
      }
    }
    entry.push(strToU8(buffer), true);
  };
  const workbook: WorkbookSpec = { sheets: [{ name: "Big", rows: [] }] };
  for (const [name, text] of Object.entries(packageParts(workbook))) add(name, [text]);
  const label = (i: number) =>
    `item ${i % spec.pool} ${"x".repeat(40 + (i % 17))} ${variant === "head" && i % spec.changeEvery === 0 ? "changed" : ""}`.trim();
  const total = spec.rows + (variant === "head" ? spec.extraRows : 0);
  function* rows(): Generator<string> {
    yield '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
    yield '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>';
    let n = 1;
    for (let i = 1; i <= total; i++) {
      if (variant === "head" && i <= spec.rows && i % spec.dropEvery === 0) continue;
      n++;
      const poolId = 4 + (i % spec.pool);
      const amount = variant === "head" && i % spec.changeEvery === 0 ? i * 2 + 1 : i * 2;
      yield `<row r="${n}"><c r="A${n}"><v>${i}</v></c><c r="B${n}" t="s"><v>${poolId}</v></c><c r="C${n}"><v>${amount}</v></c><c r="D${n}" s="1"><v>${45000 + (i % 400)}</v></c></row>`;
    }
    yield "</sheetData></worksheet>";
  }
  add("xl/worksheets/sheet1.xml", rows());
  function* strings(): Generator<string> {
    const count = 4 + spec.pool;
    yield `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${count}" uniqueCount="${count}">`;
    for (const header of ["id", "name", "amount", "when"]) yield `<si><t>${header}</t></si>`;
    for (let i = 0; i < spec.pool; i++) yield `<si><t>${label(i)}</t></si>`;
    yield "</sst>";
  }
  add("xl/sharedStrings.xml", strings());
  zip.end();
  closeSync(fd);
}
