import { z } from "zod";
import { checkRepo, checkSha } from "../validate.ts";
import { changedFiles } from "./changes.ts";
import { COMMIT_FORMAT, parseCommitRecord, resolveRev } from "./commit-format.ts";
import { defineTool } from "./types.ts";

export const getCommit = defineTool({
  name: "get_commit",
  description:
    "Get one commit by sha: message, author, committer, parents and the per-file status list against the first parent (exact renames paired by identical content, submodule entries reported as kind submodule). Line counts are on demand and not included.",
  input: z.strictObject({ repo: z.string(), sha: z.string() }),
  async run(ctx, args) {
    const repo = checkRepo(args.repo);
    const sha = checkSha(args.sha);
    await ctx.repos.ensure(repo);
    const full = await resolveRev(ctx, repo, `${sha}^{commit}`);
    const logged = await ctx.git(repo, ["log", "-1", "-z", `--format=${COMMIT_FORMAT}`, "--end-of-options", full]);
    const commit = parseCommitRecord(logged.stdout.toString("utf8").replace(/\0$/, ""));
    const changes = await changedFiles(ctx, repo, commit.parents[0], full);
    return {
      repo,
      ...commit,
      files: changes.files,
      lineCounts: "on_demand",
      truncated: changes.truncated,
    };
  },
});
