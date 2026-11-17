import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { join } from "node:path";
import { createBlobCache, type BlobCache } from "../src/cache.ts";
import { makeRoot } from "./support/fixtures.ts";

const { root, cleanup } = makeRoot("zqgit-cache-");
after(cleanup);
let counter = 0;

const oid = (n: number) => String(n).padStart(40, "0");

function cacheAt(capBytes: number, dir = join(root, `cache-${counter++}`)) {
  const cache = createBlobCache({ dir, capBytes });
  return { dir, cache };
}

async function put(cache: BlobCache, id: string, size: number, hold = false) {
  const tmp = await cache.tmpPath();
  writeFileSync(tmp, Buffer.alloc(size, 1));
  const lease = await cache.commit(id, tmp, size);
  if (!hold) lease.release();
  return lease;
}

test("a stored blob is served from the directory and a hit returns the same bytes", async () => {
  const { cache } = cacheAt(1000);
  await cache.scan();
  await put(cache, oid(1), 100);
  const lease = await cache.lease(oid(1));
  assert.equal(lease?.size, 100);
  assert.ok(lease && existsSync(lease.path));
  lease?.release();
  assert.equal(await cache.lease(oid(2)), undefined);
  assert.deepEqual(cache.usage(), { usedBytes: 100, capBytes: 1000, entries: 1 });
});

test("the least recently used blob is evicted first and a hit makes a blob recent", async () => {
  const { cache, dir } = cacheAt(100);
  await cache.scan();
  await put(cache, oid(1), 40);
  await put(cache, oid(2), 40);
  (await cache.lease(oid(1)))?.release();
  await put(cache, oid(3), 40);
  assert.deepEqual(readdirSync(dir).sort(), [oid(1), oid(3)]);
  assert.equal(cache.usage().usedBytes, 80);
});

test("a blob that is being read is pinned and survives eviction until released", async () => {
  const { cache, dir } = cacheAt(100);
  await cache.scan();
  const pinned = await put(cache, oid(1), 40, true);
  await put(cache, oid(2), 40);
  await put(cache, oid(3), 40);
  assert.ok(existsSync(join(dir, oid(1))));
  assert.equal(existsSync(join(dir, oid(2))), false);
  pinned.release();
  await put(cache, oid(4), 40);
  assert.equal(existsSync(join(dir, oid(1))), false);
  assert.deepEqual(readdirSync(dir).sort(), [oid(3), oid(4)]);
});

test("only blobs up to half the cap are kept", () => {
  const { cache } = cacheAt(1000);
  assert.equal(cache.keepable(500), true);
  assert.equal(cache.keepable(501), false);
});

test("deleting the directory loses the cache harmlessly and it rebuilds on the next store", async () => {
  const { cache, dir } = cacheAt(1000);
  await cache.scan();
  await put(cache, oid(1), 100);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(await cache.lease(oid(1)), undefined);
  assert.equal(cache.usage().usedBytes, 0);
  await put(cache, oid(2), 100);
  assert.equal((await cache.lease(oid(2)))?.size, 100);
});

test("a restart rebuilds the index from the directory in file mtime order and drops half-written files", async () => {
  const { cache, dir } = cacheAt(1000);
  await cache.scan();
  await put(cache, oid(1), 300);
  await put(cache, oid(2), 300);
  await put(cache, oid(3), 300);
  utimesSync(join(dir, oid(3)), 1000, 1000);
  utimesSync(join(dir, oid(1)), 2000, 2000);
  utimesSync(join(dir, oid(2)), 3000, 3000);
  writeFileSync(join(dir, ".tmp-leftover"), "partial");
  const restarted = createBlobCache({ dir, capBytes: 1000 });
  await restarted.scan();
  assert.equal(existsSync(join(dir, ".tmp-leftover")), false);
  assert.deepEqual(restarted.usage(), { usedBytes: 900, capBytes: 1000, entries: 3 });
  await put(restarted, oid(4), 300);
  assert.deepEqual(readdirSync(dir).sort(), [oid(1), oid(2), oid(4)]);
});

test("a restart with a smaller cap evicts down to the cap", async () => {
  const { cache, dir } = cacheAt(1000);
  await cache.scan();
  await put(cache, oid(1), 400);
  await put(cache, oid(2), 400);
  const smaller = createBlobCache({ dir, capBytes: 500 });
  await smaller.scan();
  assert.deepEqual(readdirSync(dir), [oid(2)]);
});
