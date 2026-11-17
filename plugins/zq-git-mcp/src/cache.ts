import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";

export interface CacheLease {
  path: string;
  size: number;
  release(): void;
}

export interface BlobCache {
  scan(): Promise<void>;
  lease(oid: string): Promise<CacheLease | undefined>;
  tmpPath(): Promise<string>;
  commit(oid: string, tmp: string, size: number): Promise<CacheLease>;
  keepable(size: number): boolean;
  usage(): { usedBytes: number; capBytes: number; entries: number };
}

interface Entry {
  size: number;
  usedAt: number;
}

const TMP_PREFIX = ".tmp-";

export function createBlobCache(options: { dir: string; capBytes: number; now?: () => number }): BlobCache {
  const { dir, capBytes } = options;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const pins = new Map<string, number>();
  let total = 0;
  let lastStamp = 0;

  const stamp = () => {
    lastStamp = Math.max(now(), lastStamp + 1);
    return lastStamp;
  };

  const forget = (oid: string) => {
    const entry = entries.get(oid);
    if (entry) total -= entry.size;
    entries.delete(oid);
  };

  const pin = (oid: string, path: string, size: number): CacheLease => {
    pins.set(oid, (pins.get(oid) ?? 0) + 1);
    let released = false;
    return {
      path,
      size,
      release() {
        if (released) return;
        released = true;
        const left = (pins.get(oid) ?? 1) - 1;
        if (left <= 0) pins.delete(oid);
        else pins.set(oid, left);
      },
    };
  };

  async function evict(): Promise<void> {
    const oldest = [...entries].sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [oid] of oldest) {
      if (total <= capBytes) return;
      if (pins.has(oid)) continue;
      forget(oid);
      await rm(join(dir, oid), { force: true });
    }
  }

  async function touch(oid: string, path: string, at: number): Promise<void> {
    await utimes(path, at / 1000, at / 1000);
    const entry = entries.get(oid);
    if (entry) entry.usedAt = at;
  }

  return {
    async scan() {
      entries.clear();
      total = 0;
      await mkdir(dir, { recursive: true });
      for (const name of await readdir(dir)) {
        const path = join(dir, name);
        if (name.startsWith(TMP_PREFIX)) {
          await rm(path, { force: true });
          continue;
        }
        const info = await stat(path);
        entries.set(name, { size: info.size, usedAt: info.mtimeMs });
        total += info.size;
        lastStamp = Math.max(lastStamp, info.mtimeMs);
      }
      await evict();
    },
    async lease(oid) {
      const entry = entries.get(oid);
      if (!entry) return undefined;
      const path = join(dir, oid);
      const lease = pin(oid, path, entry.size);
      try {
        await touch(oid, path, stamp());
      } catch (e) {
        lease.release();
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        forget(oid);
        return undefined;
      }
      return lease;
    },
    async tmpPath() {
      await mkdir(dir, { recursive: true });
      return join(dir, `${TMP_PREFIX}${randomUUID()}`);
    },
    async commit(oid, tmp, size) {
      const path = join(dir, oid);
      forget(oid);
      await rename(tmp, path);
      const at = stamp();
      entries.set(oid, { size, usedAt: at });
      total += size;
      await utimes(path, at / 1000, at / 1000);
      const lease = pin(oid, path, size);
      await evict();
      return lease;
    },
    keepable: (size) => size <= capBytes / 2,
    usage: () => ({ usedBytes: total, capBytes, entries: entries.size }),
  };
}
