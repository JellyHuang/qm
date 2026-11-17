import { open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { compareSheets, readPage } from "./compare.ts";
import { describeWorkbooks } from "./diagnose.ts";
import { suggestKeyColumns } from "./keys.ts";
import type { WorkbookInfo } from "./parse.ts";
import { OverrideError, createSchema, ingestSide, type Overrides, type SheetMeta } from "./ingest.ts";

export interface XlsxWorkerInput {
  baseFile: string;
  headFile: string;
  dir: string;
  overrides: Overrides;
  sheets: string[] | undefined;
  offset: number;
  limit: number;
  budget: number;
  mode?: "diagnose";
}

const input = workerData as XlsxWorkerInput;

interface Ingested {
  info: WorkbookInfo;
  metas: Map<string, SheetMeta>;
}
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

async function isZip(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(4);
    await handle.read(buffer, 0, 4, 0);
    return ZIP_MAGIC.every((byte, i) => buffer[i] === byte);
  } finally {
    await handle.close();
  }
}

function unsupported(reason: string, side: string, note: string) {
  return { type: "unsupported", reason, side, note };
}

async function run() {
  for (const [side, file] of [
    ["base", input.baseFile],
    ["head", input.headFile],
  ] as const)
    if (!(await isZip(file)))
      return unsupported("not_a_zip_package", side, "not an OOXML package: an encrypted workbook or a legacy xls file");
  const db = new DatabaseSync(join(input.dir, "work.sqlite"));
  createSchema(db);
  const filter = input.sheets ? new Set(input.sheets) : undefined;
  const sides: Ingested[] = [];
  let rowsSeen = 0;
  for (const [side, file, label] of [
    [0, input.baseFile, "base"],
    [1, input.headFile, "head"],
  ] as const) {
    const ingested = await ingestSide({
      db,
      side,
      file,
      overrides: input.overrides,
      sheets: filter,
      diagnostics: input.mode === "diagnose",
      progress: (rows) => {
        rowsSeen = rows;
        parentPort?.postMessage({ type: "progress", rows: rowsSeen });
      },
    });
    if (ingested.info.macro && input.mode !== "diagnose")
      return unsupported("xlsm", label, "macro enabled workbooks are not supported");
    if (!ingested.info.hasWorkbook && input.mode !== "diagnose")
      return unsupported("not_a_workbook", label, "the package has no xl/workbook.xml");
    sides.push(ingested);
    parentPort?.postMessage({ type: "progress", rows: rowsSeen });
  }
  db.exec("CREATE INDEX rows_idx ON rows (sheet, side, key)");
  const [base, head] = sides;
  if (input.mode === "diagnose" && base && head) {
    const lines = describeWorkbooks(db, [base, head]);
    db.close();
    return { type: "diagnostics", lines };
  }
  const { summaries, names } = compareSheets(db, base?.metas ?? new Map(), head?.metas ?? new Map(), filter, () =>
    parentPort?.postMessage({ type: "progress", rows: rowsSeen }),
  );
  for (const [index, summary] of summaries.entries()) {
    const headMeta = head?.metas.get(summary.sheet);
    if (summary.status !== "both" || !headMeta) continue;
    const ambiguous = db
      .prepare("SELECT count(*) AS n FROM diffs WHERE sheet_idx = ? AND kind = 'ambiguous'")
      .get(index) as { n: number };
    if (ambiguous.n > 0)
      summary.suggestedKeyColumns = suggestKeyColumns(db, summary.sheet, base?.metas.get(summary.sheet), headMeta);
  }
  const headers = new Map([...(head?.metas ?? [])].map(([name, meta]) => [name, meta.headers]));
  const page = readPage(db, names, headers, input.offset, input.limit, input.budget);
  db.close();
  return { type: "result", sheets: summaries, offset: input.offset, ...page };
}

run().then(
  (result) => parentPort?.postMessage(result),
  (e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    parentPort?.postMessage(
      e instanceof OverrideError
        ? { type: "error", code: "bad_override", message }
        : unsupported("corrupt_package", "both", `the workbook could not be read: ${message.slice(0, 200)}`),
    );
  },
);
