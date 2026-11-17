import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errMessage } from "../../chassis/src/errors.ts";
import type { BlobCache, CacheLease } from "./cache.ts";
import { dirSize } from "./fs-util.ts";
import type { SizeLedger } from "./ledger.ts";
import type { Limiter } from "./limiter.ts";
import type { Repos } from "./repos.ts";
import type { GitOutput, GitRunOptions, GitRunner } from "./runner.ts";
import { DiskSpaceLowError, type Scratch, type ScratchJob } from "./scratch.ts";
import { checkOid, checkRepo, type GitRepo } from "./validate.ts";

interface BlobStats {
  hits: number;
  fetched: number;
}

interface TempRepo {
  gitDir: string;
  fetch(oids: readonly string[]): Promise<void>;
  git(args: readonly string[], opts?: GitRunOptions): Promise<GitOutput>;
  lazyFetches(): Promise<number>;
}

export interface BlobStore {
  withBlobs<T>(
    repo: string,
    oids: readonly string[],
    fn: (paths: ReadonlyMap<string, string>, stats: BlobStats) => Promise<T>,
  ): Promise<T>;
  withTempRepo<T>(repo: string, fn: (temp: TempRepo) => Promise<T>): Promise<T>;
}

export interface BlobStoreOptions {
  repos: Repos;
  runner: GitRunner;
  scratch: Scratch;
  cache: BlobCache;
  fetches: Limiter;
  bigFetches: Limiter;
  ledger: SizeLedger;
  fetchTimeoutMs: number;
  noProgressMs: number;
  failureTtlMs: number;
  batchSize?: number;
  smallBytes?: number;
  progressPollMs?: number;
  now?: () => number;
}

export class BlobFetchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BlobFetchError";
  }
}

const FETCH_BATCH = 100;
const SMALL_BLOB_BYTES = 1024 * 1024;
const BIG_FILE_THRESHOLD = "1m";
const LAZY_FETCH_TRACE = /run_command:.*\bfetch\b.*--stdin/;

interface Acquired {
  leases: Map<string, CacheLease>;
  paths: Map<string, string>;
}

export function createBlobStore(options: BlobStoreOptions): BlobStore {
  const { repos, runner, scratch, cache, fetches, bigFetches, ledger, fetchTimeoutMs } = options;
  const batchSize = options.batchSize ?? FETCH_BATCH;
  const smallBytes = options.smallBytes ?? SMALL_BLOB_BYTES;
  const progressPollMs = options.progressPollMs ?? Math.max(10, Math.min(5000, options.noProgressMs / 4));
  const now = options.now ?? Date.now;
  const pending = new Map<string, Promise<void>>();
  const failed = new Map<string, { until: number; message: string }>();

  const keyOf = (repo: string, oid: string) => `${repo}:${oid}`;

  function describe(repo: string, oids: readonly string[], message: string): string {
    const more = oids.length > 1 ? ` (+${oids.length - 1} more)` : "";
    return `fetch failed for ${repo} ${(oids[0] ?? "").slice(0, 10)}${more}: ${message}`;
  }

  function refuseRecentFailures(repo: string, oids: readonly string[]): void {
    for (const oid of oids) {
      const entry = failed.get(keyOf(repo, oid));
      if (!entry) continue;
      if (entry.until <= now()) failed.delete(keyOf(repo, oid));
      else throw new BlobFetchError(describe(repo, [oid], `failed recently, not retried yet: ${entry.message}`));
    }
  }

  async function prepareTempRepo(repo: GitRepo, gitDir: string, signal: AbortSignal) {
    await runner.run(undefined, ["init", "--bare", "--quiet", gitDir], { signal });
    for (const [key, value] of [
      ["remote.origin.url", repos.url(repo)],
      ["remote.origin.promisor", "true"],
      ["fetch.unpackLimit", "1"],
      ["transfer.unpackLimit", "1"],
      ["core.bigFileThreshold", BIG_FILE_THRESHOLD],
      ["fetch.negotiationAlgorithm", "noop"],
    ] as const)
      await runner.run(gitDir, ["config", key, value], { signal });
    await mkdir(join(gitDir, "objects", "info"), { recursive: true });
    await writeFile(join(gitDir, "objects", "info", "alternates"), `${join(repos.dir(repo), "objects")}\n`);
  }

  async function watched<T>(dir: string, signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const stalled = new AbortController();
    let last = await dirSize(dir);
    let grewAt = now();
    const timer = setInterval(() => {
      void dirSize(dir).then((size) => {
        if (size !== last) {
          last = size;
          grewAt = now();
        } else if (now() - grewAt >= options.noProgressMs)
          stalled.abort(new Error(`no progress for ${Math.round(options.noProgressMs / 1000)} s`));
      });
    }, progressPollMs);
    try {
      return await run(AbortSignal.any([signal, stalled.signal]));
    } finally {
      clearInterval(timer);
    }
  }

  async function guardedFetch(repo: GitRepo, gitDir: string, dir: string, oids: readonly string[], job: ScratchJob) {
    refuseRecentFailures(repo, oids);
    try {
      await watched(dir, job.signal, (signal) =>
        runner.run(
          gitDir,
          [
            "-c",
            "fetch.negotiationAlgorithm=noop",
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            "--quiet",
            "origin",
            ...oids,
          ],
          {
            remote: true,
            timeoutMs: fetchTimeoutMs,
            signal,
          },
        ),
      );
    } catch (e) {
      if (e instanceof DiskSpaceLowError) throw e;
      const message = errMessage(e);
      for (const oid of oids) failed.set(keyOf(repo, oid), { until: now() + options.failureTtlMs, message });
      throw new BlobFetchError(describe(repo, oids, message), { cause: e });
    }
  }

  async function fetchBatch(repo: GitRepo, oids: string[], dir: string, job: ScratchJob, got: Acquired) {
    const gitDir = join(dir, "git");
    await prepareTempRepo(repo, gitDir, job.signal);
    await guardedFetch(repo, gitDir, dir, oids, job);
    const checked = await runner.run(gitDir, ["cat-file", "--batch-check"], {
      input: `${oids.join("\n")}\n`,
      signal: job.signal,
    });
    const sizes = new Map<string, number>();
    for (const line of checked.stdout.toString("utf8").split("\n").filter(Boolean)) {
      const [oid = "", type = "", size = ""] = line.split(" ");
      if (type !== "blob") throw new Error(`object ${oid} is not a blob in ${repo}`);
      sizes.set(oid, Number(size));
      ledger.record(repo, oid, Number(size));
    }
    for (const oid of oids) {
      const size = sizes.get(oid);
      if (size === undefined) throw new Error(`object ${oid} was not fetched for ${repo}`);
      const keep = cache.keepable(size);
      const target = keep ? await cache.tmpPath() : join(dir, oid);
      try {
        const out = await runner.run(gitDir, ["cat-file", "blob", oid], {
          sink: createWriteStream(target),
          signal: job.signal,
        });
        if (out.bytes !== size) throw new Error(`object ${oid} read ${out.bytes} of ${size} bytes`);
      } catch (e) {
        await rm(target, { force: true });
        throw e;
      }
      if (!keep) got.paths.set(oid, target);
      else {
        const lease = await cache.commit(oid, target, size);
        got.leases.set(oid, lease);
        got.paths.set(oid, lease.path);
      }
    }
  }

  async function fetchAll(repo: GitRepo, oids: string[], job: ScratchJob, got: Acquired) {
    const batches: string[][] = [];
    for (let i = 0; i < oids.length; i += batchSize) batches.push(oids.slice(i, i + batchSize));
    await Promise.all(
      batches.map((batch, i) =>
        fetches.run(async () => {
          const dir = join(job.dir, `batch-${i}`);
          await mkdir(dir, { recursive: true });
          const known = batch.map((oid) => ledger.size(repo, oid));
          const small = known.every((size) => size !== undefined && size <= smallBytes);
          const run = () => fetchBatch(repo, batch, dir, job, got);
          await (small ? run() : bigFetches.run(run));
          await rm(join(dir, "git"), { recursive: true, force: true });
        }),
      ),
    );
  }

  async function leaseAll(oids: string[], got: Acquired): Promise<string[]> {
    const missing: string[] = [];
    for (const oid of oids) {
      const lease = await cache.lease(oid);
      if (!lease) missing.push(oid);
      else {
        got.leases.set(oid, lease);
        got.paths.set(oid, lease.path);
      }
    }
    return missing;
  }

  async function acquire(repo: GitRepo, wanted: string[], job: ScratchJob, got: Acquired) {
    const missing = await leaseAll(wanted, got);
    const waits = missing.flatMap((oid) => pending.get(keyOf(repo, oid)) ?? []);
    const owned = missing.filter((oid) => !pending.has(keyOf(repo, oid)));
    const settlers: (() => void)[] = [];
    for (const oid of owned) {
      pending.set(
        keyOf(repo, oid),
        new Promise<void>((resolve) =>
          settlers.push(() => {
            pending.delete(keyOf(repo, oid));
            resolve();
          }),
        ),
      );
    }
    try {
      await fetchAll(repo, owned, job, got);
    } finally {
      for (const settle of settlers) settle();
    }
    await Promise.allSettled(waits);
    const waited = missing.filter((oid) => !owned.includes(oid));
    await fetchAll(repo, await leaseAll(waited, got), job, got);
  }

  return {
    async withBlobs(repoName, oids, fn) {
      const repo = checkRepo(repoName);
      const unique = [...new Set(oids.map(checkOid))];
      const got: Acquired = { leases: new Map(), paths: new Map() };
      try {
        const missing = await leaseAll(unique, got);
        const hits = unique.length - missing.length;
        if (missing.length === 0) return await fn(got.paths, { hits, fetched: 0 });
        refuseRecentFailures(repo, missing);
        return await scratch.job(async (job) => {
          await acquire(repo, missing, job, got);
          return fn(got.paths, { hits, fetched: missing.length });
        });
      } finally {
        for (const lease of got.leases.values()) lease.release();
      }
    },
    async withTempRepo(repoName, fn) {
      const repo = checkRepo(repoName);
      return scratch.job(async (job) => {
        const dir = join(job.dir, "temp");
        const gitDir = join(dir, "git");
        const trace = join(dir, "trace.log");
        await mkdir(dir, { recursive: true });
        await prepareTempRepo(repo, gitDir, job.signal);
        return fn({
          gitDir,
          fetch: (oids) => guardedFetch(repo, gitDir, dir, oids.map(checkOid), job),
          git: (args, opts = {}) =>
            runner.run(gitDir, args, { remote: true, timeoutMs: fetchTimeoutMs, signal: job.signal, trace, ...opts }),
          async lazyFetches() {
            const log = await readFile(trace, "utf8").catch(() => "");
            return log.split("\n").filter((line) => LAZY_FETCH_TRACE.test(line)).length;
          },
        });
      });
    },
  };
}
