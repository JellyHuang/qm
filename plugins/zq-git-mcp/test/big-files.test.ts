import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ALICE, buildFixture, commitAll, makeRoot, pushAll, type Fixture } from "./support/fixtures.ts";
import { startHarness, testConfig, type Harness } from "./support/harness.ts";
import { withIndexPackPeak } from "./support/rss.ts";

const { root, cleanup } = makeRoot("zqgit-big-");
const FILLER = "abcdefghij".repeat(9);
const TEXT_LINES = 2_400_000;
const BINARY_CHUNKS = 20;
const CHUNK = 8 * 1024 * 1024;
const line = (i: number) => `${i} ${FILLER}`;
let fx: Fixture;
let textBytes = 0;
let binarySha = "";
let binaryBytes = 0;

before(() => {
  fx = buildFixture(root);
  const dir = fx.work.server;
  const text = openSync(join(dir, "big.txt"), "w");
  for (let start = 1; start <= TEXT_LINES; start += 100_000) {
    const rows: string[] = [];
    for (let i = start; i < start + 100_000 && i <= TEXT_LINES; i++) rows.push(line(i));
    writeSync(text, `${rows.join("\n")}\n`);
  }
  closeSync(text);
  textBytes = statSync(join(dir, "big.txt")).size;
  const binary = openSync(join(dir, "big.bin"), "w");
  const hash = createHash("sha256");
  for (let i = 0; i < BINARY_CHUNKS; i++) {
    const chunk = randomBytes(CHUNK);
    chunk[0] = 0;
    hash.update(chunk);
    writeSync(binary, chunk);
  }
  closeSync(binary);
  binarySha = hash.digest("hex");
  binaryBytes = BINARY_CHUNKS * CHUNK;
  commitAll(dir, "big files", ALICE, "2024-10-01T10:00:00Z");
  pushAll(dir);
});
after(cleanup);

async function peakRss<T>(run: () => Promise<T>): Promise<{ value: T; growth: number }> {
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 10);
  try {
    return { value: await run(), growth: peak - baseline };
  } finally {
    clearInterval(timer);
  }
}

function sliceOf(file: string, offset: number, length: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

async function harnessWith(cacheCapBytes: number, name: string): Promise<Harness> {
  return startHarness(
    testConfig(root, fx.remoteBase, {
      cacheCapBytes,
      clonesDir: join(root, name, "clones"),
      scratchDir: join(root, name, "scratch"),
      cacheDir: join(root, name, "cache"),
    }),
  );
}

describe("a blob larger than half the cache is streamed through scratch and never kept", () => {
  let h: Harness;
  before(async () => {
    h = await harnessWith(64 * 1024 * 1024, "transient");
  });
  after(async () => {
    await h.stop();
  });

  test("a line range of a multi-hundred-MB text file comes back with exact totals and bounded memory", async () => {
    const { value, growth } = await withIndexPackPeak(() =>
      peakRss(() =>
        h.call("read_file", { repo: "server", ref: "main", path: "big.txt", startLine: 1_200_000, endLine: 1_200_002 }),
      ),
    ).then((outer) => ({ value: outer.value.value, growth: outer.value.growth, indexPack: outer.peakBytes }));
    assert.equal(value.isError, false, JSON.stringify(value.body).slice(0, 300));
    assert.equal(value.body.content, [1_200_000, 1_200_001, 1_200_002].map(line).join("\n"));
    assert.equal(value.body.totalLines, TEXT_LINES);
    assert.equal(value.body.totalBytes, textBytes);
    assert.equal(value.body.truncated, false);
    assert.ok(textBytes > 200 * 1024 * 1024);
    assert.ok(growth < 160 * 1024 * 1024, `rss grew by ${Math.round(growth / 1048576)} MiB`);
    const repos = await h.call("list_repos", {});
    assert.equal((repos.body.cache as { entries: number }).entries, 0);
    assert.deepEqual(readdirSync(join(root, "transient", "scratch")), []);
  });

  test("a content search streams a multi-hundred-MB file and finds the one matching line", async () => {
    const { value, growth } = await withIndexPackPeak(() =>
      peakRss(() =>
        h.call("search", {
          repo: "server",
          ref: "main",
          kind: "content",
          query: "^1200000 ",
          regex: true,
          pathGlob: "big.txt",
        }),
      ),
    ).then((outer) => ({ value: outer.value.value, growth: outer.value.growth }));
    assert.equal(value.isError, false, JSON.stringify(value.body).slice(0, 300));
    assert.deepEqual(
      (value.body.matches as { line: number; text: string }[]).map((m) => [m.line, m.text]),
      [[1_200_000, line(1_200_000).slice(0, 500)]],
    );
    assert.equal(value.body.searched, 1);
    assert.ok(growth < 160 * 1024 * 1024, `rss grew by ${Math.round(growth / 1048576)} MiB`);
    assert.deepEqual(readdirSync(join(root, "transient", "scratch")), []);
  });

  test("a large binary is hashed by streaming and a byte range from the middle is exact", async () => {
    const offset = 100 * 1024 * 1024 + 7;
    const { value, peakBytes } = await withIndexPackPeak(() =>
      h.call("read_file", { repo: "server", ref: "main", path: "big.bin", offset, length: 1000 }),
    );
    assert.equal(value.isError, false, JSON.stringify(value.body).slice(0, 300));
    assert.equal(value.body.kind, "binary");
    assert.equal(value.body.size, binaryBytes);
    assert.equal(value.body.sha256, binarySha);
    assert.equal(value.body.base64, sliceOf(join(fx.work.server, "big.bin"), offset, 1000).toString("base64"));
    assert.ok(peakBytes < binaryBytes / 8, `index-pack peaked at ${Math.round(peakBytes / 1048576)} MiB`);
    assert.deepEqual(readdirSync(join(root, "transient", "scratch")), []);
  });
});

describe("a large blob below half the cache is cached and then served as a hit", () => {
  let h: Harness;
  before(async () => {
    h = await harnessWith(1024 * 1024 * 1024, "cached");
  });
  after(async () => {
    await h.stop();
  });

  test("the second read of a 160 MiB binary is a cache hit and the cache holds it", async () => {
    const first = await h.call("read_file", { repo: "server", ref: "main", path: "big.bin" });
    const second = await h.call("read_file", { repo: "server", ref: "main", path: "big.bin" });
    assert.equal(first.body.sha256, binarySha);
    assert.equal(second.body.sha256, binarySha);
    assert.deepEqual(
      h.audit.rows().map((row) => row.cacheHit),
      [false, true],
    );
    const cache = (await h.call("list_repos", {})).body.cache as { usedBytes: number; entries: number };
    assert.equal(cache.entries, 1);
    assert.equal(cache.usedBytes, binaryBytes);
  });
});
