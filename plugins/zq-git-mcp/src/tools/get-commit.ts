import { z } from "zod";
import { checkRepo, checkSha } from "../validate.ts";
import { COMMIT_FORMAT, parseCommitRecord, resolveRev } from "./commit-format.ts";
import { pairExactRenames, parseRawDiff } from "./raw-diff.ts";
import { defineTool } from "./types.ts";

export const getCommit = defineTool({
  name: "get_commit",
  description:
    "Get one commit by sha: message, author, committer, parents and the per-file status list against the first parent (exact renames paired by identical content). Line counts are on demand and not included.",
  input: z.strictObject({ repo: z.string(), sha: z.string() }),
  async run(ctx, args) {
    const repo = checkRepo(args.repo);
    const sha = checkSha(args.sha);
    await ctx.repos.ensure(repo);
    const full = await resolveRev(ctx, repo, `${sha}^{commit}`);
    const logged = await ctx.git(repo, ["log", "-1", "-z", `--format=${COMMIT_FORMAT}`, "--end-of-options", full]);
    const commit = parseCommitRecord(logged.stdout.toString("utf8").replace(/\0$/, ""));
    const parent = commit.parents[0];
    const diff = await ctx.git(repo, [
      "diff-tree",
      "-r",
      "-z",
      "--raw",
      "--no-renames",
      "--no-abbrev",
      ...(parent === undefined ? ["--root"] : []),
      "--end-of-options",
      ...(parent === undefined ? [full] : [parent, full]),
    ]);
    return {
      repo,
      ...commit,
      files: pairExactRenames(parseRawDiff(diff.stdout.toString("utf8"))),
      lineCounts: "on_demand",
      truncated: diff.truncated,
    };
  },
});
