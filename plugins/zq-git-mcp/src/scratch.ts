import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { swallow } from "../../chassis/src/errors.ts";
import { sleep } from "./async.ts";
import { dirSize, pidAlive } from "./fs-util.ts";
import { createLimiter } from "./limiter.ts";

export class DiskSpaceLowError extends Error {
  constructor() {
    super("disk space low");
    this.name = "DiskSpaceLowError";
  }
}

export interface ScratchJob {
  dir: string;
  signal: AbortSignal;
}

export interface ScratchOptions {
  dir: string;
  capBytes: number;
  floorBytes: number;
  maxJobs: number;
  pollMs?: number;
  monitorMs?: number;
  pid?: number;
  freeBytes?: () => Promise<number>;
}

export interface Scratch {
  job<T>(fn: (job: ScratchJob) => Promise<T>): Promise<T>;
  sweep(): Promise<number>;
  enforceFloor(): Promise<void>;
  usedBytes(): Promise<number>;
  start(): void;
  stop(): void;
}

const OWNER = /^(\d+)-/;

export function createScratch(options: ScratchOptions): Scratch {
  const { dir, capBytes, floorBytes } = options;
  const pid = options.pid ?? process.pid;
  const pollMs = options.pollMs ?? 500;
  const monitorMs = options.monitorMs ?? 2000;
  const heavy = createLimiter(options.maxJobs);
  const active: { dir: string; controller: AbortController }[] = [];
  let monitor: NodeJS.Timeout | undefined;

  const freeBytes =
    options.freeBytes ??
    (async () => {
      await mkdir(dir, { recursive: true });
      const stats = await statfs(dir);
      return stats.bavail * stats.bsize;
    });

  const usedBytes = () => dirSize(dir);

  async function admit(): Promise<void> {
    while ((await usedBytes()) >= capBytes) await sleep(pollMs);
    if ((await freeBytes()) < floorBytes) throw new DiskSpaceLowError();
  }

  async function enforceFloor(): Promise<void> {
    const newest = active.at(-1);
    if (newest && (await freeBytes()) < floorBytes) newest.controller.abort(new DiskSpaceLowError());
  }

  return {
    job(fn) {
      return heavy.run(async () => {
        await mkdir(dir, { recursive: true });
        await admit();
        const jobDir = join(dir, `${pid}-${randomUUID()}`);
        await mkdir(jobDir);
        const entry = { dir: jobDir, controller: new AbortController() };
        active.push(entry);
        try {
          return await fn({ dir: jobDir, signal: entry.controller.signal });
        } finally {
          active.splice(active.indexOf(entry), 1);
          await rm(jobDir, { recursive: true, force: true });
        }
      });
    },
    async sweep() {
      await mkdir(dir, { recursive: true });
      let removed = 0;
      for (const name of await readdir(dir)) {
        const owner = Number(OWNER.exec(name)?.[1]);
        if (owner === pid || (owner > 0 && pidAlive(owner))) continue;
        await rm(join(dir, name), { recursive: true, force: true });
        removed++;
      }
      return removed;
    },
    enforceFloor,
    usedBytes,
    start() {
      monitor ??= setInterval(
        () => void enforceFloor().catch((e) => swallow("scratch floor check", e)),
        monitorMs,
      ).unref();
    },
    stop() {
      clearInterval(monitor);
      monitor = undefined;
    },
  };
}
