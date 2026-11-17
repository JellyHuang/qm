import { z } from "zod";
import { errMessage } from "../../../chassis/src/errors.ts";
import { GIT_REPOS, GitDenied, checkBranch, checkRepo, type GitRepo } from "../validate.ts";
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

interface AckEntry {
  repo: string;
  branch: string;
  from: string | null;
  to: string | null;
}

const TIP = /^[0-9a-f]{40,64}$/;

function parseAck(value: unknown): AckEntry {
  const entry = value as { repo: string; branch: string; from: string | null; to: string | null };
  const tip = (tip: string | null) => {
    if (tip !== null && !TIP.test(tip)) throw new GitDenied("bad_sha", "expected a full object id or null");
    return tip;
  };
  return { repo: checkRepo(entry.repo), branch: checkBranch(entry.branch), from: tip(entry.from), to: tip(entry.to) };
}

async function applyAcks(ctx: ToolContext, repo: GitRepo, acks: AckEntry[]): Promise<number> {
  let applied = 0;
  const stored = await ctx.tips.list(repo);
  for (const ack of acks) {
    if ((stored.get(ack.branch)?.tip ?? null) !== ack.from) continue;
    if (ack.to === null) await ctx.tips.delete(repo, ack.branch);
    else await ctx.tips.put(repo, ack.branch, ack.to, Date.now());
    applied++;
  }
  return applied;
}

async function checkOne(ctx: ToolContext, repo: GitRepo, budget: number) {
  let remote: Map<string, string>;
  try {
    remote = await ctx.repos.heads(repo);
  } catch (e) {
    return { result: { repo, status: "error", error: errMessage(e) }, acks: [] as AckEntry[] };
  }
  const stored = await ctx.tips.list(repo);
  const seenAt = Date.now();
  const writes: (() => Promise<void>)[] = [];
  const acks: AckEntry[] = [];
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
        return { result: { repo, status: "error", error: errMessage(e) }, acks: [] as AckEntry[] };
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
        acks.push({ repo, branch, from: oldTip ?? null, to: advanceTo });
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
        acks.push({ repo, branch, from: entry.tip, to: null });
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
  return { result, acks };
}

export const checkUpdates = defineTool({
  name: "check_updates",
  description:
    "Poll the remote branch tips of one repository, or of all seven when repo is omitted, and return the commits (metadata only) that appeared since the last acknowledged state: new branches report their tip commit, updated branches the commits from the old tip, deleted branches are listed. Delivery is at-least-once: the stored tips only advance when a later call passes the acks of a response back in ack; an unacknowledged poll reports the same commits again. The first call for a repository only records its tips. An unreachable remote is reported per repository as an error, never as no updates.",
  input: z.strictObject({
    repo: z.string().optional(),
    ack: z
      .array(
        z.strictObject({
          repo: z.string(),
          branch: z.string(),
          from: z.string().nullable(),
          to: z.string().nullable(),
        }),
      )
      .optional(),
  }),
  async run(ctx, args) {
    const repos = args.repo === undefined ? (Object.keys(GIT_REPOS) as GitRepo[]) : [checkRepo(args.repo)];
    const acks = (args.ack ?? []).map(parseAck);
    const budget = Math.max(MIN_REPO_BUDGET, Math.floor((ctx.truncateChars - RESERVE_CHARS) / repos.length));
    const touched = new Set<GitRepo>([...repos, ...acks.map((ack) => ack.repo as GitRepo)]);
    let acknowledged = 0;
    const results = await Promise.all(
      [...touched].map((repo) =>
        withLock(ctx.tips, repo, async () => {
          acknowledged += await applyAcks(
            ctx,
            repo,
            acks.filter((ack) => ack.repo === repo),
          );
          return repos.includes(repo) ? checkOne(ctx, repo, budget) : undefined;
        }),
      ),
    );
    const polled = results.filter((result): result is NonNullable<typeof result> => result !== undefined);
    return {
      repos: polled.map((entry) => entry.result),
      ack: polled.flatMap((entry) => entry.acks),
      acknowledged,
      truncated: false,
    };
  },
});
