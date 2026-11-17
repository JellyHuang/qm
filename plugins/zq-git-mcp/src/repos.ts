import { randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirSize } from "./fs-util.ts";
import type { Limiter } from "./limiter.ts";
import type { GitRunner } from "./runner.ts";
import { GIT_REPOS, type GitRepo } from "./validate.ts";

interface RepoInfo {
  name: GitRepo;
  defaultBranch: string;
  head: string | null;
  cloned: boolean;
  lastFetchAt: string | null;
  cloneSizeBytes: number | null;
}

export interface Repos {
  url(repo: GitRepo): string;
  dir(repo: GitRepo): string;
  ensure(repo: GitRepo, options?: { force?: boolean }): Promise<void>;
  heads(repo: GitRepo): Promise<Map<string, string>>;
  list(): Promise<RepoInfo[]>;
}

export interface ReposOptions {
  runner: GitRunner;
  fetches: Limiter;
  clonesDir: string;
  remoteBase: string;
  refreshMs: number;
  fetchTimeoutMs: number;
  now?: () => number;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

export function createRepos(options: ReposOptions): Repos {
  const { runner, fetches, clonesDir, remoteBase, refreshMs, fetchTimeoutMs } = options;
  const now = options.now ?? Date.now;
  const inflight = new Map<GitRepo, Promise<void>>();

  const url = (repo: GitRepo) => `${remoteBase}${repo}.git`;
  const dir = (repo: GitRepo) => join(clonesDir, `${repo}.git`);
  const marker = (repo: GitRepo) => join(clonesDir, `${repo}.fetched`);
  const remote = { remote: true, timeoutMs: fetchTimeoutMs };

  async function markFetched(repo: GitRepo): Promise<void> {
    await writeFile(marker(repo), "");
    const at = now() / 1000;
    await utimes(marker(repo), at, at);
  }

  async function lastFetch(repo: GitRepo): Promise<number | undefined> {
    return (await stat(marker(repo)).catch(() => undefined))?.mtimeMs;
  }

  async function clone(repo: GitRepo): Promise<void> {
    const partial = `${dir(repo)}.partial-${randomUUID()}`;
    try {
      await runner.run(
        undefined,
        ["clone", "--bare", "--filter=blob:none", "--no-tags", "--quiet", url(repo), partial],
        remote,
      );
      await rename(partial, dir(repo));
    } finally {
      await rm(partial, { recursive: true, force: true });
    }
  }

  async function update(repo: GitRepo): Promise<void> {
    const git = dir(repo);
    await runner.run(
      git,
      [
        "fetch",
        "--prune",
        "--update-head-ok",
        "--no-write-fetch-head",
        "--no-tags",
        "--quiet",
        "origin",
        "+refs/heads/*:refs/heads/*",
      ],
      remote,
    );
    const listed = await runner.run(git, ["ls-remote", "--symref", "origin", "HEAD"], remote);
    const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(listed.stdout.toString("utf8"))?.[1];
    if (branch) await runner.run(git, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  }

  async function refresh(repo: GitRepo, force: boolean): Promise<void> {
    await mkdir(clonesDir, { recursive: true });
    if (!(await exists(dir(repo)))) await clone(repo);
    else {
      const last = await lastFetch(repo);
      if (!force && last !== undefined && now() - last < refreshMs) return;
      await update(repo);
    }
    await markFetched(repo);
  }

  return {
    url,
    dir,
    ensure(repo, options = {}) {
      const force = options.force === true;
      const pending =
        (force ? undefined : inflight.get(repo)) ??
        fetches.run(() => refresh(repo, force)).finally(() => inflight.delete(repo));
      inflight.set(repo, pending);
      return pending;
    },
    async heads(repo) {
      const out = await fetches.run(() =>
        runner.run(undefined, ["ls-remote", "--heads", url(repo)], {
          remote: true,
          timeoutMs: Math.min(fetchTimeoutMs, 120_000),
        }),
      );
      const tips = new Map<string, string>();
      for (const line of out.stdout.toString("utf8").split("\n")) {
        const match = /^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/.exec(line);
        if (match) tips.set(match[2] ?? "", match[1] ?? "");
      }
      return tips;
    },
    async list() {
      return Promise.all(
        (Object.keys(GIT_REPOS) as GitRepo[]).map(async (name) => {
          const cloned = await exists(dir(name));
          const last = await lastFetch(name);
          const head = cloned
            ? await runner
                .run(dir(name), ["symbolic-ref", "--short", "HEAD"])
                .then((out) => out.stdout.toString("utf8").trim())
                .catch(() => null)
            : null;
          return {
            name,
            defaultBranch: GIT_REPOS[name],
            head,
            cloned,
            lastFetchAt: last === undefined ? null : new Date(last).toISOString(),
            cloneSizeBytes: cloned ? await dirSize(dir(name)) : null,
          };
        }),
      );
    },
  };
}
