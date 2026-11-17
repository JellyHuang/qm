import { z } from "zod";
import { MAX_COMMITS, checkAuthor, checkBranch, checkCount, checkPath, checkRepo, checkSince } from "../validate.ts";
import { COMMIT_FORMAT, parseCommitRecord, resolveRev } from "./commit-format.ts";
import { defineTool } from "./types.ts";

const DEFAULT_LIMIT = 50;

export const listCommits = defineTool({
  name: "list_commits",
  description:
    "List commit metadata (sha, parents, author, committer, subject, message) newest first. Never reads file contents. Optional branch, path, author, since, until (ISO dates) and limit.",
  input: z.strictObject({
    repo: z.string(),
    branch: z.string().optional(),
    path: z.string().optional(),
    author: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    limit: z.number().optional(),
  }),
  async run(ctx, args) {
    const repo = checkRepo(args.repo);
    const branch = args.branch === undefined ? undefined : checkBranch(args.branch);
    const path = args.path === undefined ? undefined : checkPath(args.path);
    const author = args.author === undefined ? undefined : checkAuthor(args.author);
    const since = args.since === undefined ? undefined : checkSince(args.since);
    const until = args.until === undefined ? undefined : checkSince(args.until);
    const limit = checkCount(args.limit, DEFAULT_LIMIT, MAX_COMMITS);
    await ctx.repos.ensure(repo);
    const start = branch === undefined ? "HEAD" : `refs/heads/${branch}`;
    await resolveRev(ctx, repo, start);
    const out = await ctx.git(repo, [
      "log",
      "-z",
      `--format=${COMMIT_FORMAT}`,
      "-n",
      String(limit + 1),
      "--fixed-strings",
      "--regexp-ignore-case",
      ...(author === undefined ? [] : [`--author=${author}`]),
      ...(since === undefined ? [] : [`--since=${since}`]),
      ...(until === undefined ? [] : [`--until=${until}`]),
      "--end-of-options",
      start,
      "--",
      ...(path === undefined ? [] : [path]),
    ]);
    const records = out.stdout.toString("utf8").split("\0").filter(Boolean);
    return {
      repo,
      branch: branch ?? (await ctx.git(repo, ["symbolic-ref", "--short", "HEAD"])).stdout.toString("utf8").trim(),
      commits: records.slice(0, limit).map(parseCommitRecord),
      more: records.length > limit || out.truncated,
      truncated: out.truncated,
    };
  },
});
