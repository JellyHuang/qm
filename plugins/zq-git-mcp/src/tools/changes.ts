import type { GitRepo } from "../validate.ts";
import { pairExactRenames, parseRawDiff, type FileChange } from "./raw-diff.ts";
import type { ToolContext } from "./types.ts";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export async function changedFiles(
  ctx: ToolContext,
  repo: GitRepo,
  base: string | undefined,
  head: string,
): Promise<{ files: FileChange[]; truncated: boolean }> {
  const out = await ctx.git(repo, [
    "diff-tree",
    "-r",
    "-z",
    "--raw",
    "--no-renames",
    "--no-abbrev",
    ...(base === undefined ? ["--root"] : []),
    "--end-of-options",
    ...(base === undefined ? [head] : [base, head]),
  ]);
  return { files: pairExactRenames(parseRawDiff(out.stdout.toString("utf8"))), truncated: out.truncated };
}
