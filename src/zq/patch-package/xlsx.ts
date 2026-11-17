import { createWriteStream, type WriteStream } from "node:fs";
import { basename } from "node:path";
import { once } from "node:events";
import type { GitMcpClient } from "../git-mcp/client.ts";
import { PatchPackageError } from "./settings.ts";

export interface XlsxSheetSummary {
  sheet: string;
  status: string;
  baseHeaderRow: number | null;
  headHeaderRow: number | null;
  keyColumns: string[];
  suggestedKeyColumns?: string[];
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

export interface XlsxDifference {
  sheet: string;
  key: string;
  column: string;
  old: string;
  new: string;
  kind: string;
}

export interface XlsxDiffResult {
  kind: string;
  repo?: string;
  path: string;
  base: { ref: string; commit: string };
  head: { ref: string; commit: string };
  summary?: { sheets: XlsxSheetSummary[] };
  total?: number;
  offset?: number;
  nextOffset?: number | null;
  differences?: XlsxDifference[];
  note?: string;
  oldLfs?: { oid: string; size: number };
  newLfs?: { oid: string; size: number };
}

export type FetchPage = (offset: number) => Promise<XlsxDiffResult>;

export interface XlsxWorkbookInput {
  result: XlsxDiffResult;
  fetchPage?: FetchPage;
}

export const LFS_COMPARISON_NOTE = "comparison not available for LFS files";
const LFS_NOTE = "LFS file, content not compared";
const DEFAULT_MAX_PAGES = 10_000;

export function xlsxPager(
  client: Pick<GitMcpClient, "call">,
  args: {
    repo: string;
    path: string;
    base: string;
    head: string;
    sheets?: string[];
    overrides?: object;
    limit?: number;
  },
  caller: string,
): FetchPage {
  return async (offset) => (await client.call("diff_xlsx", { ...args, offset }, caller)) as unknown as XlsxDiffResult;
}

function escapeCell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n|\r/g, "\\n");
}

class Sink {
  readonly stream: WriteStream;
  constructor(path: string) {
    this.stream = createWriteStream(path);
  }
  async write(text: string): Promise<void> {
    if (!this.stream.write(text)) await once(this.stream, "drain");
  }
  async end(): Promise<void> {
    this.stream.end();
    await once(this.stream, "finish");
  }
  abort(): void {
    this.stream.destroy();
  }
}

function row(cells: readonly (string | number | null)[]): string {
  return `| ${cells.map((cell) => escapeCell(cell === null ? "" : String(cell))).join(" | ")} |\n`;
}

function lfsLine(side: string, lfs: { oid: string; size: number } | undefined): string {
  return lfs ? `- ${side}: oid ${lfs.oid}, size ${lfs.size}\n` : `- ${side}: not an LFS pointer\n`;
}

async function renderSummary(sink: Sink, result: XlsxDiffResult, ticket: string | undefined): Promise<void> {
  await sink.write(`# ${result.path}\n\n`);
  await sink.write(
    `- base: ${result.base.ref} (${result.base.commit})\n- head: ${result.head.ref} (${result.head.commit})\n`,
  );
  if (ticket) await sink.write(`- ticket: ${ticket}\n`);
  await sink.write("\n");
  const sheets = result.summary?.sheets ?? [];
  const ambiguous = sheets.filter((sheet) => sheet.ambiguous > 0 || sheet.ambiguousKeys > 0);
  if (ambiguous.length > 0) {
    await sink.write("## Ambiguous rows, check by hand\n\n");
    for (const sheet of ambiguous) {
      const suggested = sheet.suggestedKeyColumns?.length
        ? `suggested key columns: ${sheet.suggestedKeyColumns.join(", ")}`
        : "no unique key column was found";
      await sink.write(
        `- sheet ${sheet.sheet}: ${sheet.ambiguousKeys} key problems, ${sheet.ambiguous} ambiguous in all; ${suggested}\n`,
      );
    }
    await sink.write("\nRows marked `ambiguous` below could not be matched by key and were not guessed at.\n\n");
  }
  if (result.kind === "lfs_pointer" || result.kind === "lfs_pointer_changed") {
    await sink.write(`## ${LFS_NOTE}\n\n${lfsLine("base", result.oldLfs)}${lfsLine("head", result.newLfs)}\n`);
    return;
  }
  if (result.kind === "file_added") {
    await sink.write("## New workbook, content not compared\n\n");
    return;
  }
  await sink.write("## Summary\n\n");
  await sink.write(
    row([
      "sheet",
      "status",
      "header row (base/head)",
      "key columns",
      "rows (base/head)",
      "rows added",
      "rows removed",
      "cells changed",
      "formulas changed",
      "columns added",
      "columns removed",
      "ambiguous",
      "merges changed",
      "hidden changed",
    ]),
  );
  await sink.write(row(Array.from({ length: 14 }, () => "---")));
  for (const sheet of sheets)
    await sink.write(
      row([
        sheet.sheet,
        sheet.status,
        `${sheet.baseHeaderRow ?? "-"}/${sheet.headHeaderRow ?? "-"}`,
        sheet.keyColumns.join(", "),
        `${sheet.rows.base}/${sheet.rows.head}`,
        sheet.rowsAdded,
        sheet.rowsRemoved,
        sheet.changedCells,
        sheet.formulaChanged,
        sheet.columnsAdded,
        sheet.columnsRemoved,
        sheet.ambiguous,
        sheet.mergeChanged,
        sheet.hiddenChanged,
      ]),
    );
  await sink.write("\n## Differences\n\n");
}

export async function renderXlsxDiff(
  path: string,
  first: XlsxDiffResult,
  fetchPage: FetchPage | undefined,
  options: { ticket?: string; maxPages?: number } = {},
): Promise<{ rendered: number; total: number; complete: boolean }> {
  const sink = new Sink(path);
  try {
    await renderSummary(sink, first, options.ticket);
    if (first.kind !== "xlsx_diff") {
      await sink.end();
      return { rendered: 0, total: 0, complete: true };
    }
    const total = first.total ?? 0;
    await sink.write(row(["sheet", "key", "column", "old", "new", "kind"]));
    await sink.write(row(["---", "---", "---", "---", "---", "---"]));
    let rendered = 0;
    let page: XlsxDiffResult = first;
    let pages = 0;
    let stop: string | undefined;
    for (;;) {
      pages++;
      for (const difference of page.differences ?? []) {
        await sink.write(
          row([difference.sheet, difference.key, difference.column, difference.old, difference.new, difference.kind]),
        );
        rendered++;
      }
      const next = page.nextOffset ?? null;
      if (next === null) break;
      if (!fetchPage) {
        stop = "no way to fetch the remaining pages was given";
        break;
      }
      if (pages >= (options.maxPages ?? DEFAULT_MAX_PAGES)) {
        stop = "the page limit was reached";
        break;
      }
      try {
        page = await fetchPage(next);
      } catch (e) {
        stop = `fetching the next page failed: ${(e as Error).message}`;
        break;
      }
      if ((page.offset ?? next) !== next || (page.nextOffset ?? Infinity) <= next) {
        stop = "the service did not advance the offset";
        break;
      }
    }
    const complete = stop === undefined && rendered === total;
    if (!complete)
      await sink.write(
        `\nTABLE CUT: ${rendered} of ${total} differences are listed${stop ? `, ${stop}` : ""}. The rest must be read from the workbook.\n`,
      );
    await sink.end();
    return { rendered, total, complete };
  } catch (e) {
    sink.abort();
    throw e;
  }
}

export function stemOf(file: string): string {
  return basename(file).replace(/\.xlsx$/i, "");
}

export function refuseUnusableResult(result: XlsxDiffResult): void {
  const label = result.path;
  if (result.kind === "unchanged")
    throw new PatchPackageError(
      "unchanged",
      `${label} is unchanged between ${result.base.ref} and ${result.head.ref}, nothing to deliver`,
    );
  if (result.kind === "file_removed")
    throw new PatchPackageError(
      "unsupported",
      `${label} was removed at ${result.head.ref}, there is no modified file to deliver`,
    );
  if (!["xlsx_diff", "lfs_pointer", "lfs_pointer_changed", "file_added"].includes(result.kind))
    throw new PatchPackageError(
      "unsupported",
      `${label} could not be compared (${result.kind}${result.note ? `: ${result.note}` : ""})`,
    );
}
