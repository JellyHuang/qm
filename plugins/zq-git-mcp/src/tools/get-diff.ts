import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { checkPathPatterns, checkRange, checkRepo, globToRegExp, type GitRepo } from "../validate.ts";
import { EMPTY_TREE, changedFiles } from "./changes.ts";
import { resolveRev } from "./commit-format.ts";
import { LFS_POINTER_MAX_BYTES, parseLfsPointer } from "./lfs.ts";
import { readRange } from "./text-scan.ts";
import { resolveCommit } from "./tree.ts";
import { defineTool, type ToolContext } from "./types.ts";

const RESERVE_CHARS = 2000;
const PATHS_PER_RUN = 500;

interface DiffFile {
  kind: "file" | "submodule" | "lfs_pointer";
  path: string;
  status: string;
  oldPath?: string;
  oldOid?: string;
  newOid?: string;
  oldCommit?: string;
  newCommit?: string;
  oldSize?: number;
  newSize?: number;
  lfsOid?: string;
  lfsSize?: number;
  oldLfs?: { oid: string; size: number };
  newLfs?: { oid: string; size: number };
  binary?: boolean;
  additions?: number;
  deletions?: number;
  unavailable?: string;
}

function matcher(patterns: string[]): (path: string) => boolean {
  const tests = patterns.map((pattern) =>
    /[*?]/.test(pattern) ? (path: string) => globToRegExp(pattern).test(path) : (path: string) => path === pattern,
  );
  return (path) => tests.some((test) => test(path));
}

async function resolveRange(ctx: ToolContext, repo: GitRepo, range: string) {
  const parts = checkRange(range);
  if (parts)
    return { base: await resolveCommit(ctx, repo, parts.base), head: await resolveCommit(ctx, repo, parts.head) };
  const head = await resolveCommit(ctx, repo, range);
  const parent = await resolveRev(ctx, repo, `${head}^1`).catch(() => undefined);
  return { base: parent, head };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const getDiff = defineTool({
  name: "get_diff",
  description:
    "Diff of a commit (against its first parent) or of base..head. Without paths only the changed file list is returned: status, old and new object ids, modes, exact renames, submodules as kind submodule. With paths (literal or globs matched against that list) it fetches the old and new blobs, returns a unified diff and per-file line counts; LFS pointers are reported as kind lfs_pointer and binary files by size only.",
  input: z.strictObject({ repo: z.string(), range: z.string(), paths: z.array(z.string()).optional() }),
  async run(ctx, args) {
    const repo = checkRepo(args.repo);
    const patterns = args.paths === undefined ? undefined : checkPathPatterns(args.paths);
    await ctx.repos.ensure(repo);
    const { base, head } = await resolveRange(ctx, repo, args.range);
    const changes = await changedFiles(ctx, repo, base, head);
    const where = { repo, base: base ?? null, head };
    if (!patterns) return { ...where, files: changes.files, truncated: changes.truncated };
    const wanted = matcher(patterns);
    const matched = changes.files.filter(
      (file) => wanted(file.path) || (file.oldPath !== undefined && wanted(file.oldPath)),
    );
    const submodules = matched.filter((file) => file.kind === "submodule");
    const regular = matched.filter((file) => file.kind === "file");
    const common = { ...where, requested: patterns.length, matched: matched.length };
    const submoduleEntries: DiffFile[] = submodules.map((file) => ({
      kind: "submodule",
      path: file.path,
      status: file.status,
      ...(file.oldCommit ? { oldCommit: file.oldCommit } : {}),
      ...(file.newCommit ? { newCommit: file.newCommit } : {}),
    }));
    if (regular.length === 0)
      return { ...common, files: submoduleEntries, diff: "", diffBytes: 0, cutBytes: 0, truncated: changes.truncated };
    const oids = [
      ...new Set(regular.flatMap((file) => [file.oldOid, file.newOid].filter((oid): oid is string => !!oid))),
    ];
    const budget = Math.max(500, ctx.truncateChars - RESERVE_CHARS);
    return ctx.blobs.withTempRepo(
      repo,
      async (temp) => {
        const problems = await temp.fetch(oids);
        const available = oids.filter((oid) => !problems.has(oid));
        const sizes = await temp.sizes(available);
        const pointers = new Map<string, { oid: string; size: number }>();
        for (const oid of available) {
          const size = sizes.get(oid) ?? Infinity;
          if (size > LFS_POINTER_MAX_BYTES) continue;
          const pointer = parseLfsPointer((await temp.local(["cat-file", "blob", oid])).stdout);
          if (pointer) pointers.set(oid, pointer);
        }
        const entries: DiffFile[] = regular.map((file) => {
          const lost = [file.oldOid, file.newOid].find((oid) => oid !== undefined && problems.has(oid));
          const oldLfs = file.oldOid ? pointers.get(file.oldOid) : undefined;
          const newLfs = file.newOid ? pointers.get(file.newOid) : undefined;
          return {
            kind: oldLfs || newLfs ? "lfs_pointer" : "file",
            path: file.path,
            status: file.status,
            ...(file.oldPath ? { oldPath: file.oldPath } : {}),
            ...(file.oldOid ? { oldOid: file.oldOid } : {}),
            ...(file.newOid ? { newOid: file.newOid } : {}),
            ...(file.oldOid && sizes.has(file.oldOid) ? { oldSize: sizes.get(file.oldOid) } : {}),
            ...(file.newOid && sizes.has(file.newOid) ? { newSize: sizes.get(file.newOid) } : {}),
            ...(oldLfs || newLfs ? { lfsOid: (newLfs ?? oldLfs)?.oid, lfsSize: (newLfs ?? oldLfs)?.size } : {}),
            ...(oldLfs ? { oldLfs } : {}),
            ...(newLfs ? { newLfs } : {}),
            ...(lost ? { unavailable: problems.get(lost) ?? "unavailable" } : {}),
          };
        });
        const plain = regular.filter(
          (file, i) => file.status !== "R" && entries[i]?.kind === "file" && entries[i]?.unavailable === undefined,
        );
        const diffPaths = [...new Set(plain.flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])]))];
        const baseArg = base ?? EMPTY_TREE;
        const numstat = new Map<string, { additions?: number; deletions?: number; binary: boolean }>();
        for (const part of chunks(diffPaths, PATHS_PER_RUN)) {
          const out = await temp.local([
            "diff",
            "--numstat",
            "-z",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--end-of-options",
            baseArg,
            head,
            "--",
            ...part,
          ]);
          for (const record of out.stdout.toString("utf8").split("\0").filter(Boolean)) {
            const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(record);
            if (!match) continue;
            numstat.set(
              match[3] ?? "",
              match[1] === "-"
                ? { binary: true }
                : { additions: Number(match[1]), deletions: Number(match[2]), binary: false },
            );
          }
        }
        for (const entry of entries) {
          if (entry.status === "R") {
            entry.additions = 0;
            entry.deletions = 0;
            continue;
          }
          const stats = numstat.get(entry.path);
          if (!stats) continue;
          entry.binary = stats.binary;
          if (!stats.binary) {
            entry.additions = stats.additions;
            entry.deletions = stats.deletions;
          }
        }
        const diffFile = join(temp.dir, "diff.out");
        for (const [i, part] of chunks(diffPaths, PATHS_PER_RUN).entries())
          await temp.local(
            [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--no-color",
              "--no-renames",
              "--end-of-options",
              baseArg,
              head,
              "--",
              ...part,
            ],
            { sink: createWriteStream(diffFile, { flags: i === 0 ? "w" : "a" }) },
          );
        const files = [...entries, ...submoduleEntries];
        const diffBytes = diffPaths.length === 0 ? 0 : (await stat(diffFile)).size;
        const diffBudget = Math.max(500, budget - JSON.stringify(files).length);
        const head8 =
          diffBytes === 0 ? Buffer.alloc(0) : await readRange(diffFile, 0, Math.min(diffBytes, diffBudget * 4));
        const text = head8.toString("utf8").slice(0, diffBudget).replace(/�$/, "");
        const cutBytes = diffBytes - Buffer.byteLength(text);
        return { ...common, files, diff: text, diffBytes, cutBytes, truncated: cutBytes > 0 || changes.truncated };
      },
      { signal: ctx.signal },
    );
  },
});
