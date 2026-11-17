import { z } from "zod";
import { GitDenied, checkCount, checkLine, checkOffset, checkPath, checkRepo, checkRevision } from "../validate.ts";
import type { Overrides } from "../xlsx/ingest.ts";
import { readLfsPointer } from "./lfs.ts";
import { lookupEntry, resolveCommit, type TreeEntry } from "./tree.ts";
import { defineTool } from "./types.ts";
import { runXlsxWorker } from "./xlsx-run.ts";

const RESERVE_CHARS = 6000;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 10_000;
const MAX_SHEETS = 100;
const MAX_NAME = 100;
const LFS_NOTE = "LFS file, content not compared, only oid/size changed";

function checkName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_NAME || /[\u0000-\u001f]/.test(value))
    throw new GitDenied("bad_arguments", `names are 1 through ${MAX_NAME} characters without control characters`);
  return value;
}

function checkOverrides(
  value: Record<string, { headerRow?: number | undefined; keyColumns?: string[] | undefined }> | undefined,
): Overrides {
  const out: Overrides = {};
  const entries = Object.entries(value ?? {});
  if (entries.length > MAX_SHEETS) throw new GitDenied("bad_arguments", `at most ${MAX_SHEETS} sheet overrides`);
  for (const [sheet, override] of entries) {
    const keyColumns = override.keyColumns?.map(checkName);
    if (keyColumns && keyColumns.length > 10) throw new GitDenied("bad_arguments", "at most 10 key columns");
    out[checkName(sheet)] = {
      ...(override.headerRow === undefined ? {} : { headerRow: checkLine(override.headerRow) }),
      ...(keyColumns ? { keyColumns } : {}),
    };
  }
  return out;
}

async function side(
  ctx: Parameters<typeof lookupEntry>[0],
  repo: Parameters<typeof lookupEntry>[1],
  commit: string,
  path: string,
) {
  try {
    const entry = await lookupEntry(ctx, repo, commit, path);
    if (entry.type !== "blob") throw new GitDenied("not_a_file", "that path is not a regular file");
    return entry;
  } catch (e) {
    if (e instanceof GitDenied && e.reason === "not_found") return undefined;
    throw e;
  }
}

export const diffXlsx = defineTool({
  name: "diff_xlsx",
  description:
    "Cell-level diff of one .xlsx file between two refs. Sheets are matched by name, the header row and key columns are detected (or overridden per sheet), rows are matched by key and changed rows are compared cell by cell by column header. Reports added, removed and changed rows and cells, added and removed columns and sheets, formula and merge changes, hidden rows and columns, and ambiguous keys. LFS pointers, other file types, macro and encrypted workbooks are reported as such. Use offset and limit to page through the differences.",
  input: z.strictObject({
    repo: z.string(),
    path: z.string(),
    base: z.string(),
    head: z.string(),
    sheets: z.array(z.string()).optional(),
    overrides: z
      .record(
        z.string(),
        z.strictObject({ headerRow: z.number().optional(), keyColumns: z.array(z.string()).optional() }),
      )
      .optional(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  async run(ctx, args) {
    const repo = checkRepo(args.repo);
    const path = checkPath(args.path);
    const baseRef = checkRevision(args.base);
    const headRef = checkRevision(args.head);
    const sheets = args.sheets?.map(checkName);
    if (sheets && sheets.length > MAX_SHEETS) throw new GitDenied("bad_arguments", `at most ${MAX_SHEETS} sheets`);
    const overrides = checkOverrides(args.overrides);
    const offset = args.offset === undefined ? 0 : checkOffset(args.offset);
    const limit = checkCount(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const extension = /\.(xlsx|xlsm|xls)$/i.exec(path)?.[1]?.toLowerCase();
    if (extension !== "xlsx")
      return {
        kind: "unsupported",
        repo,
        path,
        reason: extension ?? "not_xlsx",
        note: "only .xlsx workbooks can be compared",
        truncated: false,
      };
    await ctx.repos.ensure(repo);
    const baseCommit = await resolveCommit(ctx, repo, baseRef);
    const headCommit = await resolveCommit(ctx, repo, headRef);
    const before = await side(ctx, repo, baseCommit, path);
    const after = await side(ctx, repo, headCommit, path);
    const where = {
      repo,
      path,
      base: { ref: baseRef, commit: baseCommit },
      head: { ref: headRef, commit: headCommit },
    };
    if (!before && !after) throw new GitDenied("not_found", "the file exists at neither ref");
    if (!before || !after) {
      const present = (before ?? after) as TreeEntry;
      return {
        ...where,
        kind: before ? "file_removed" : "file_added",
        oid: present.oid,
        note: "the file exists at one ref only, content not compared",
        truncated: false,
      };
    }
    if (before.oid === after.oid) return { ...where, kind: "unchanged", oid: before.oid, truncated: false };
    return ctx.blobs.withBlobs(
      repo,
      [before.oid, after.oid],
      async (paths, stats) => {
        ctx.state.cacheHit = stats.hits > 0;
        const baseFile = paths.get(before.oid) ?? "";
        const headFile = paths.get(after.oid) ?? "";
        const [oldLfs, newLfs] = await Promise.all([readLfsPointer(baseFile), readLfsPointer(headFile)]);
        if (oldLfs || newLfs)
          return {
            ...where,
            kind: oldLfs && newLfs ? "lfs_pointer_changed" : "lfs_pointer",
            oldOid: before.oid,
            newOid: after.oid,
            ...(oldLfs ? { oldLfs, lfsOid: oldLfs.oid, lfsSize: oldLfs.size } : {}),
            ...(newLfs ? { newLfs, lfsOid: newLfs.oid, lfsSize: newLfs.size } : {}),
            note: LFS_NOTE,
            truncated: false,
          };
        const result = await runXlsxWorker(
          {
            baseFile,
            headFile,
            dir: stats.dir ?? "",
            overrides,
            sheets,
            offset,
            limit,
            budget: Math.max(1000, ctx.truncateChars - RESERVE_CHARS),
          },
          ctx.limits,
          stats.signal ?? ctx.signal,
        );
        if (result.type === "error") throw new GitDenied(result.code, result.message);
        if (result.type === "unsupported")
          return {
            ...where,
            kind: "unsupported",
            reason: result.reason,
            side: result.side,
            note: result.note,
            truncated: false,
          };
        return {
          ...where,
          kind: "xlsx_diff",
          summary: { sheets: result.sheets },
          total: result.total,
          offset: result.offset,
          returned: result.rows.length,
          nextOffset: result.next,
          table: result.table,
          differences: result.rows,
          cutDifferences: result.cut,
          truncated: result.truncated,
        };
      },
      { signal: ctx.signal, scratch: true },
    );
  },
});
