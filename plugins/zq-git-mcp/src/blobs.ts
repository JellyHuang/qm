import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BlobCache, CacheLease } from "./cache.ts";
import type { Limiter } from "./limiter.ts";
import type { Repos } from "./repos.ts";
import type { GitRunner } from "./runner.ts";
import type { Scratch, ScratchJob } from "./scratch.ts";
import { checkOid, checkRepo, type GitRepo } from "./validate.ts";

interface BlobStats {
  hits: number;
  fetched: number;
}

export interface BlobStore {
  withBlobs<T>(
    repo: string,
    oids: readonly string[],
    fn: (paths: ReadonlyMap<string, string>, stats: BlobStats) => Promise<T>,
  ): Promise<T>;
}

export interface BlobStoreOptions {
  repos: Repos;
  runner: GitRunner;
  scratch: Scratch;
  cache: BlobCache;
  fetches: Limiter;
  fetchTimeoutMs: number;
  batchSize?: number;
}

const FETCH_BATCH = 100;

interface Acquired {
  leases: Map<string, CacheLease>;
  paths: Map<string, string>;
}

export function createBlobStore(options: BlobStoreOptions): BlobStore {
  const { repos, runner, scratch, cache, fetches, fetchTimeoutMs } = options;
  const batchSize = options.batchSize ?? FETCH_BATCH;
  const pending = new Map<string, Promise<void>>();

  async function fetchBatch(repo: GitRepo, oids: string[], dir: string, job: ScratchJob, got: Acquired) {
    const gitDir = join(dir, "git");
    await runner.run(undefined, ["init", "--bare", "--quiet", gitDir], { signal: job.signal });
    for (const [key, value] of [
      ["remote.origin.url", repos.url(repo)],
      ["remote.origin.promisor", "true"],
      ["fetch.unpackLimit", "1"],
      ["transfer.unpackLimit", "1"],
    ] as const)
      await runner.run(gitDir, ["config", key, value], { signal: job.signal });
    await mkdir(join(gitDir, "objects", "info"), { recursive: true });
    await writeFile(join(gitDir, "objects", "info", "alternates"), `${join(repos.dir(repo), "objects")}\n`);
    await runner.run(gitDir, ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", "origin", ...oids], {
      remote: true,
      timeoutMs: fetchTimeoutMs,
      signal: job.signal,
    });
    const checked = await runner.run(gitDir, ["cat-file", "--batch-check"], {
      input: `${oids.join("\n")}\n`,
      signal: job.signal,
    });
    const sizes = new Map<string, number>();
    for (const line of checked.stdout.toString("utf8").split("\n").filter(Boolean)) {
      const [oid = "", type = "", size = ""] = line.split(" ");
      if (type !== "blob") throw new Error(`object ${oid} is not a blob in ${repo}`);
      sizes.set(oid, Number(size));
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
          await fetchBatch(repo, batch, dir, job, got);
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
    const keyOf = (oid: string) => `${repo}:${oid}`;
    const waits = missing.flatMap((oid) => pending.get(keyOf(oid)) ?? []);
    const owned = missing.filter((oid) => !pending.has(keyOf(oid)));
    const settlers: (() => void)[] = [];
    for (const oid of owned) {
      pending.set(
        keyOf(oid),
        new Promise<void>((resolve) =>
          settlers.push(() => {
            pending.delete(keyOf(oid));
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
        return await scratch.job(async (job) => {
          await acquire(repo, missing, job, got);
          return fn(got.paths, { hits, fetched: missing.length });
        });
      } finally {
        for (const lease of got.leases.values()) lease.release();
      }
    },
  };
}
