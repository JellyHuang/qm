import { GitDenied, checkRevision, type GitRepo } from "../validate.ts";
import { resolveRev } from "./commit-format.ts";
import type { ToolContext } from "./types.ts";

export interface TreeEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  oid: string;
  path: string;
}

const ENTRY = /^(\d+) (blob|tree|commit) ([0-9a-f]+)\t([^\0]*)\0?$/;

export function resolveCommit(ctx: ToolContext, repo: GitRepo, ref: string): Promise<string> {
  return resolveRev(ctx, repo, `${checkRevision(ref)}^{commit}`);
}

export async function lookupEntry(ctx: ToolContext, repo: GitRepo, commit: string, path: string): Promise<TreeEntry> {
  const out = await ctx.git(repo, ["ls-tree", "-z", "--end-of-options", commit, "--", path]);
  const match = ENTRY.exec(out.stdout.toString("utf8"));
  if (!match || match[4] !== path) throw new GitDenied("not_found", "no such path at that ref");
  return { mode: match[1] ?? "", type: match[2] as TreeEntry["type"], oid: match[3] ?? "", path };
}

export async function listTree(
  ctx: ToolContext,
  repo: GitRepo,
  commit: string,
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const out = await ctx.git(repo, ["ls-tree", "-r", "-z", "--end-of-options", commit]);
  const entries: TreeEntry[] = [];
  for (const record of out.stdout.toString("utf8").split("\0")) {
    const match = ENTRY.exec(record);
    if (match)
      entries.push({
        mode: match[1] ?? "",
        type: match[2] as TreeEntry["type"],
        oid: match[3] ?? "",
        path: match[4] ?? "",
      });
  }
  return { entries, truncated: out.truncated };
}
