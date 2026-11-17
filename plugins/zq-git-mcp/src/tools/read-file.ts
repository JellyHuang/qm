import { stat } from "node:fs/promises";
import { z } from "zod";
import { GitDenied, checkLine, checkOffset, checkPath, checkRepo } from "../validate.ts";
import { detectType } from "./file-type.ts";
import { LFS_POINTER_MAX_BYTES, parseLfsPointer } from "./lfs.ts";
import { readRange, scanText, sha256Of, sniff } from "./text-scan.ts";
import { lookupEntry, resolveCommit } from "./tree.ts";
import { defineTool } from "./types.ts";

const RESERVE_CHARS = 2000;

export const readFile = defineTool({
  name: "read_file",
  description:
    "Read one file at a ref. Text files return the requested line range (startLine, endLine) with total line and byte counts. Binary files return size, oid, sha256 and detected type, and a base64 byte range when offset and length are given. LFS pointers and submodule entries are reported as such, never as content. Output is cut at the configured size with a truncated flag.",
  input: z.strictObject({
    repo: z.string(),
    ref: z.string(),
    path: z.string(),
    startLine: z.number().optional(),
    endLine: z.number().optional(),
    offset: z.number().optional(),
    length: z.number().optional(),
  }),
  async run(ctx, args) {
    const repo = checkRepo(args.repo);
    const path = checkPath(args.path);
    const startLine = args.startLine === undefined ? undefined : checkLine(args.startLine);
    const endLine = args.endLine === undefined ? undefined : checkLine(args.endLine);
    const offset = args.offset === undefined ? undefined : checkOffset(args.offset);
    const length = args.length === undefined ? undefined : checkOffset(args.length);
    const lineMode = startLine !== undefined || endLine !== undefined;
    const byteMode = offset !== undefined || length !== undefined;
    if (lineMode && byteMode) throw new GitDenied("bad_arguments", "use line numbers or a byte range, not both");
    if (startLine !== undefined && endLine !== undefined && endLine < startLine)
      throw new GitDenied("bad_number", "endLine is before startLine");
    await ctx.repos.ensure(repo);
    const commit = await resolveCommit(ctx, repo, args.ref);
    const entry = await lookupEntry(ctx, repo, commit, path);
    const where = { repo, ref: args.ref, commit, path };
    if (entry.type === "commit") return { ...where, kind: "submodule", commit: entry.oid, truncated: false };
    if (entry.type !== "blob") throw new GitDenied("not_a_file", "that path is a directory");
    const budget = Math.max(500, ctx.truncateChars - RESERVE_CHARS);
    return ctx.blobs.withBlobs(
      repo,
      [entry.oid],
      async (paths, stats) => {
        ctx.state.cacheHit = stats.hits > 0;
        const file = paths.get(entry.oid) ?? "";
        const size = (await stat(file)).size;
        const head = await sniff(file);
        const binary = head.includes(0);
        ctx.ledger.record(repo, entry.oid, { size, binary });
        const common = { ...where, oid: entry.oid, size };
        if (!binary && size <= LFS_POINTER_MAX_BYTES) {
          const pointer = parseLfsPointer(head);
          if (pointer)
            return { ...common, kind: "lfs_pointer", lfsOid: pointer.oid, lfsSize: pointer.size, truncated: false };
        }
        if (binary) {
          if (lineMode) throw new GitDenied("binary_file", "line ranges need a text file; use offset and length");
          const base = {
            ...common,
            kind: "binary",
            detectedType: detectType(head, path),
            sha256: await sha256Of(file),
          };
          if (!byteMode) return { ...base, truncated: false };
          const from = Math.min(offset ?? 0, size);
          const wanted = Math.min(length ?? size - from, size - from);
          const take = Math.min(wanted, Math.floor((budget * 3) / 4));
          const bytes = await readRange(file, from, take);
          return {
            ...base,
            offset: from,
            length: bytes.length,
            base64: bytes.toString("base64"),
            cutBytes: wanted - bytes.length,
            truncated: bytes.length < wanted,
          };
        }
        if (byteMode) {
          const from = Math.min(offset ?? 0, size);
          const wanted = Math.min(length ?? size - from, size - from);
          const bytes = await readRange(file, from, Math.min(wanted, budget));
          return {
            ...common,
            kind: "text",
            offset: from,
            length: bytes.length,
            content: bytes.toString("utf8"),
            cutBytes: wanted - bytes.length,
            truncated: bytes.length < wanted,
          };
        }
        const scan = await scanText(file, { start: startLine ?? 1, end: endLine ?? Infinity }, budget);
        return {
          ...common,
          kind: "text",
          startLine: scan.firstLine,
          endLine: scan.lastLine,
          totalLines: scan.totalLines,
          totalBytes: scan.totalBytes,
          content: scan.content,
          cutChars: scan.cutChars,
          truncated: scan.cutChars > 0,
        };
      },
      { signal: ctx.signal },
    );
  },
});
