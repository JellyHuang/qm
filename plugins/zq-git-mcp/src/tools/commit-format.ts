import { GitDenied, type GitRepo } from "../validate.ts";
import type { ToolContext } from "./types.ts";

const FIELD = "\u001f";

export const COMMIT_FORMAT = ["%H", "%P", "%an", "%ae", "%aI", "%cn", "%ce", "%cI", "%B"].join("%x1f");

export interface CommitRecord {
  sha: string;
  parents: string[];
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  subject: string;
  message: string;
}

export function parseCommitRecord(record: string): CommitRecord {
  const [sha = "", parents = "", an = "", ae = "", ad = "", cn = "", ce = "", cd = "", ...body] = record.split(FIELD);
  const message = body.join(FIELD).trim();
  return {
    sha,
    parents: parents.split(" ").filter(Boolean),
    author: { name: an, email: ae, date: ad },
    committer: { name: cn, email: ce, date: cd },
    subject: message.split("\n", 1)[0] ?? "",
    message,
  };
}

export async function resolveRev(ctx: Pick<ToolContext, "git">, repo: GitRepo, rev: string): Promise<string> {
  try {
    const out = await ctx.git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", rev]);
    return out.stdout.toString("utf8").trim();
  } catch {
    throw new GitDenied("not_found", "no such revision");
  }
}
