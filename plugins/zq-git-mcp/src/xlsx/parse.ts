import { isDateFormat, parseRef, serialToIso, shiftFormula } from "./cells.ts";
import { scanZip, xmlSink, type PartSink } from "./zip.ts";

export interface SheetInfo {
  name: string;
  part: string;
  hidden: boolean;
}

export interface WorkbookInfo {
  sheets: SheetInfo[];
  date1904: boolean;
  dateStyles: Set<number>;
  macro: boolean;
  hasWorkbook: boolean;
}

interface SheetCell {
  col: number;
  display: string;
  formula: string | null;
  serial: number | null;
  noCache: boolean;
  isText: boolean;
}

export interface SheetRow {
  num: number;
  hidden: boolean;
  cells: SheetCell[];
}

export interface SheetEvents {
  row(row: SheetRow): void;
  hiddenColumns(columns: Set<number>): void;
  merges(refs: string[]): void;
  end(): void;
}

const MAX_COLUMN = 16384;

function sharedStringsSink(add: (text: string) => void): PartSink {
  let text = "";
  let phonetic = 0;
  let inT = false;
  return xmlSink({
    open(name) {
      if (name === "si") text = "";
      else if (name === "rPh") phonetic++;
      else if (name === "t") inT = true;
    },
    close(name) {
      if (name === "si") add(text);
      else if (name === "rPh") phonetic--;
      else if (name === "t") inT = false;
    },
    text(chunk) {
      if (inT && phonetic === 0) text += chunk;
    },
  });
}

export async function readWorkbookInfo(file: string, addShared: (text: string) => void): Promise<WorkbookInfo> {
  const info: WorkbookInfo = { sheets: [], date1904: false, dateStyles: new Set(), macro: false, hasWorkbook: false };
  const rawSheets: { name: string; rid: string; hidden: boolean }[] = [];
  const rels = new Map<string, string>();
  const formats = new Map<number, string>();
  const xfs: number[] = [];
  let inXfs = false;
  const names = await scanZip(file, (name) => {
    if (name === "xl/workbook.xml")
      return xmlSink({
        open(tag, attrs) {
          if (tag === "workbookPr") info.date1904 = attrs.date1904 === "1" || attrs.date1904 === "true";
          if (tag === "sheet")
            rawSheets.push({
              name: attrs.name ?? "",
              rid: attrs["r:id"] ?? "",
              hidden: attrs.state !== undefined && attrs.state !== "visible",
            });
        },
      });
    if (name === "xl/_rels/workbook.xml.rels")
      return xmlSink({
        open(tag, attrs) {
          if (tag === "Relationship" && attrs.Id && attrs.Target) rels.set(attrs.Id, attrs.Target);
        },
      });
    if (name === "xl/styles.xml")
      return xmlSink({
        open(tag, attrs) {
          if (tag === "numFmt") formats.set(Number(attrs.numFmtId), attrs.formatCode ?? "");
          if (tag === "cellXfs") inXfs = true;
          if (tag === "xf" && inXfs) xfs.push(Number(attrs.numFmtId ?? 0));
        },
        close(tag) {
          if (tag === "cellXfs") inXfs = false;
        },
      });
    if (name === "xl/sharedStrings.xml") return sharedStringsSink(addShared);
    return undefined;
  });
  info.hasWorkbook = names.includes("xl/workbook.xml");
  info.macro = names.some((name) => name === "xl/vbaProject.bin");
  xfs.forEach((numFmtId, index) => {
    if (isDateFormat(numFmtId, formats.get(numFmtId))) info.dateStyles.add(index);
  });
  for (const sheet of rawSheets) {
    const target = rels.get(sheet.rid);
    if (!target) continue;
    const part = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    info.sheets.push({ name: sheet.name, part, hidden: sheet.hidden });
  }
  return info;
}

function worksheetSink(info: WorkbookInfo, lookup: (id: number) => string, events: SheetEvents): PartSink {
  let rowNum = 0;
  let row: SheetRow | undefined;
  let colCursor = 0;
  let cell:
    | {
        col: number;
        type: string;
        style: number;
        v: string;
        hasV: boolean;
        f: string;
        hasF: boolean;
        fAttrs: Record<string, string>;
        inline: string;
      }
    | undefined;
  let target: "v" | "f" | "t" | undefined;
  let phonetic = 0;
  let inInline = false;
  const hiddenCols = new Set<number>();
  const merges: string[] = [];
  const shared = new Map<string, { formula: string; row: number; col: number }>();

  const finish = () => {
    if (!cell || !row) return;
    const current = cell;
    cell = undefined;
    const cached = current.hasV || current.type === "inlineStr";
    let display = "";
    let serial: number | null = null;
    let isText = false;
    if (current.type === "s") {
      display = current.hasV ? lookup(Number(current.v)) : "";
      isText = true;
    } else if (current.type === "inlineStr") {
      display = current.inline;
      isText = true;
    } else if (current.type === "str") {
      display = current.v;
      isText = true;
    } else if (current.type === "b") {
      display = current.v === "1" ? "TRUE" : "FALSE";
    } else if (current.type === "e" || current.type === "d") {
      display = current.v;
    } else if (current.hasV) {
      const number = Number(current.v);
      if (Number.isFinite(number)) {
        serial = number;
        display = String(number);
        if (info.dateStyles.has(current.style)) display = `${serialToIso(number, info.date1904)} (serial ${number})`;
      } else display = current.v;
    }
    let formula: string | null = null;
    if (current.hasF) {
      const si = current.fAttrs.si;
      if (current.fAttrs.t === "shared" && si !== undefined) {
        if (current.f !== "") shared.set(si, { formula: current.f, row: rowNum, col: current.col });
        const master = shared.get(si);
        formula = master ? shiftFormula(master.formula, rowNum - master.row, current.col - master.col) : current.f;
      } else formula = current.f;
    }
    const keepSerial = current.type === "" || current.type === "n" ? serial : null;
    row.cells.push({
      col: current.col,
      display,
      formula,
      serial: keepSerial !== null && info.dateStyles.has(current.style) ? keepSerial : null,
      noCache: current.hasF && !cached,
      isText,
    });
  };

  return xmlSink({
    open(name, attrs) {
      if (name === "row") {
        rowNum = attrs.r ? Number(attrs.r) : rowNum + 1;
        row = { num: rowNum, hidden: attrs.hidden === "1" || attrs.hidden === "true", cells: [] };
        colCursor = 0;
      } else if (name === "c" && row) {
        const ref = attrs.r ? parseRef(attrs.r) : undefined;
        colCursor = ref ? ref.col : colCursor + 1;
        cell = {
          col: colCursor,
          type: attrs.t ?? "",
          style: Number(attrs.s ?? 0),
          v: "",
          hasV: false,
          f: "",
          hasF: false,
          fAttrs: {},
          inline: "",
        };
      } else if (name === "v" && cell) {
        target = "v";
        cell.hasV = true;
      } else if (name === "f" && cell) {
        target = "f";
        cell.hasF = true;
        cell.fAttrs = attrs;
      } else if (name === "is") inInline = true;
      else if (name === "rPh") phonetic++;
      else if (name === "t" && inInline) target = "t";
      else if (name === "col") {
        if (attrs.hidden === "1" || attrs.hidden === "true") {
          const min = Math.max(1, Number(attrs.min));
          const max = Math.min(MAX_COLUMN, Number(attrs.max));
          for (let c = min; c <= max; c++) hiddenCols.add(c);
        }
      } else if (name === "mergeCell" && attrs.ref) merges.push(attrs.ref);
    },
    close(name) {
      if (name === "v" || name === "f" || name === "t") target = undefined;
      else if (name === "is") inInline = false;
      else if (name === "rPh") phonetic--;
      else if (name === "c") finish();
      else if (name === "row" && row) {
        events.row(row);
        row = undefined;
      } else if (name === "cols") events.hiddenColumns(hiddenCols);
      else if (name === "mergeCells") events.merges(merges);
      else if (name === "worksheet") events.end();
    },
    text(chunk) {
      if (!cell || !target) return;
      if (target === "v") cell.v += chunk;
      else if (target === "f") cell.f += chunk;
      else if (target === "t" && phonetic === 0) cell.inline += chunk;
    },
  });
}

export async function readWorksheets(
  file: string,
  info: WorkbookInfo,
  lookup: (id: number) => string,
  events: (sheet: SheetInfo) => SheetEvents | undefined,
): Promise<void> {
  const byPart = new Map(info.sheets.map((sheet) => [sheet.part, sheet]));
  await scanZip(file, (name) => {
    const sheet = byPart.get(name);
    const handler = sheet ? events(sheet) : undefined;
    return handler ? worksheetSink(info, lookup, handler) : undefined;
  });
}
