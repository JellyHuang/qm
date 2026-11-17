import { z } from "zod";
import { errMessage } from "../../../chassis/src/errors.ts";
import { GIT_REPOS, checkRepo, type GitRepo } from "../validate.ts";
import { COMMIT_FORMAT, parseCommitRecord } from "./commit-format.ts";
import { defineTool, type ToolContext } from "./types.ts";

const RESERVE_CHARS = 2000;
const MIN_REPO_BUDGET = 1000;

interface UpdatedCommit {
  sha: string;
  authorName: string;
  authorEmail: string;
  date: string;
  subject: string;
  branch: string;
}

interface BranchUpdate {
  branch: string;
  status: "new" | "updated" | "rewritten" | "deleted";
  oldTip?: string;
  newTip?: string;
  commits: UpdatedCommit[];
  partial?: boolean;
}

const locks = new WeakMap<object, Map<string, Promise<unknown>>>();

function withLock<T>(owner: object, key: string, fn: () => Promise<T>): Promise<T> {
  const chain = locks.get(owner) ?? new Map<string, Promise<unknown>>();
  locks.set(owner, chain);
  const run = (chain.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  chain.set(key, tail);
  void tail.then(() => {
    if (chain.get(key) === tail) chain.delete(key);
  });
  return run;
}

async function succeeds(ctx: ToolContext, repo: GitRepo, args: string[]): Promise<boolean> {
  return ctx.git(repo, args).then(
    () => true,
    () => false,
  );
}

async function commitsBetween(
  ctx: ToolContext,
  repo: GitRepo,
  branch: string,
  range: string[],
  limitOne: boolean,
): Promise<UpdatedCommit[]> {
  const out = await ctx.git(repo, [
    "log",
    "-z",
    `--format=${COMMIT_FORMAT}`,
    "--topo-order",
    ...(limitOne ? ["-n", "1"] : ["--reverse"]),
    "--end-of-options",
    ...range,
  ]);
  return out.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const commit = parseCommitRecord(record);
      return {
        sha: commit.sha,
        authorName: commit.author.name,
        authorEmail: commit.author.email,
        date: commit.author.date,
        subject: commit.subject,
        branch,
      };
    });
}

async function describeBranch(
  ctx: ToolContext,
  repo: GitRepo,
  branch: string,
  oldTip: string | undefined,
  newTip: string,
): Promise<Pick<BranchUpdate, "status" | "commits">> {
  const tipOnly = () => commitsBetween(ctx, repo, branch, [newTip], true);
  if (oldTip === undefined) return { status: "new", commits: await tipOnly() };
  if (!(await succeeds(ctx, repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${oldTip}^{commit}`])))
    return { status: "rewritten", commits: await tipOnly() };
  const forward = await succeeds(ctx, repo, ["merge-base", "--is-ancestor", oldTip, newTip]);
  const commits = await commitsBetween(ctx, repo, branch, [`${oldTip}..${newTip}`], false);
  return { status: forward ? "updated" : "rewritten", commits: commits.length > 0 ? commits : await tipOnly() };
}

async function checkOne(ctx: ToolContext, repo: GitRepo, budget: number) {
  let remote: Map<string, string>;
  try {
    remote = await ctx.repos.heads(repo);
  } catch (e) {
    return { repo, status: "error", error: errMessage(e) };
  }
  const stored = await ctx.tips.list(repo);
  const seenAt = Date.now();
  const writes: (() => Promise<void>)[] = [];
  const record = (branch: string, tip: string) => writes.push(() => ctx.tips.put(repo, branch, tip, seenAt));
  let result: Record<string, unknown>;

  if (stored.size === 0) {
    for (const [branch, tip] of remote) record(branch, tip);
    result = { repo, status: "first_run", branches: remote.size, updates: [] };
  } else {
    const changed = [...remote].filter(([branch, tip]) => stored.get(branch)?.tip !== tip);
    const deleted = [...stored].filter(([branch]) => !remote.has(branch));
    if (changed.length === 0 && deleted.length === 0) {
      result = { repo, status: "unchanged", branches: remote.size, updates: [] };
    } else {
      try {
        if (changed.length > 0) await ctx.repos.ensure(repo, { force: true });
      } catch (e) {
        return { repo, status: "error", error: errMessage(e) };
      }
      const updates: BranchUpdate[] = [];
      let used = 0;
      for (const [branch, newTip] of changed) {
        const oldTip = stored.get(branch)?.tip;
        const described = await describeBranch(ctx, repo, branch, oldTip, newTip);
        const kept: UpdatedCommit[] = [];
        for (const commit of described.commits) {
          used += JSON.stringify(commit).length + 1;
          if (used > budget && kept.length > 0) break;
          kept.push(commit);
        }
        const partial = kept.length < described.commits.length;
        const advanceTo = partial ? (kept.at(-1)?.sha ?? newTip) : newTip;
        record(branch, advanceTo);
        updates.push({
          branch,
          status: described.status,
          ...(oldTip ? { oldTip } : {}),
          newTip,
          commits: kept,
          ...(partial ? { partial: true } : {}),
        });
      }
      for (const [branch, entry] of deleted) {
        writes.push(() => ctx.tips.delete(repo, branch));
        updates.push({ branch, status: "deleted", oldTip: entry.tip, commits: [] });
      }
      result = {
        repo,
        status: "changed",
        branches: remote.size,
        updates,
        ...(updates.some((update) => update.partial) ? { partial: true } : {}),
      };
    }
  }
  for (const write of writes) await write();
  return result;
}

export const checkUpdates = defineTool({
  name: "check_updates",
  description:
    "Poll the remote branch tips of one repository, or of all seven when repo is omitted, and return the commits (metadata only) that appeared since the previous call: new branches report their tip commit, updated branches the commits from the old tip, deleted branches are listed. The first call for a repository only records its tips. An unreachable remote is reported per repository as an error, never as no updates.",
  input: z.strictObject({ repo: z.string().optional() }),
  async run(ctx, args) {
    const repos = args.repo === undefined ? (Object.keys(GIT_REPOS) as GitRepo[]) : [checkRepo(args.repo)];
    const budget = Math.max(MIN_REPO_BUDGET, Math.floor((ctx.truncateChars - RESERVE_CHARS) / repos.length));
    const results = await Promise.all(repos.map((repo) => withLock(ctx.tips, repo, () => checkOne(ctx, repo, budget))));
    return { repos: results, truncated: false };
  },
});
