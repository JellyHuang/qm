import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { loggingGit } from "./support/fake-git.ts";
import { buildFixture, commitAll, makeRoot, pushAll, ALICE, type Fixture } from "./support/fixtures.ts";
import { LFS_OID_ONE, buildFilesFixture, pngBytes, type FilesFixture } from "./support/files-fixture.ts";
import { startHarness, testConfig, type Harness } from "./support/harness.ts";

const { root, cleanup } = makeRoot("zqgit-read-");
const logger = loggingGit(root);
let fx: Fixture;
let ff: FilesFixture;
let h: Harness;

before(async () => {
  fx = buildFixture(root);
  ff = buildFilesFixture(fx);
  const long = fx.work.server;
  writeFileSync(
    join(long, "long.txt"),
    Array.from({ length: 5000 }, (_, i) => `line ${i + 1} ${"x".repeat(90)}`).join("\n") + "\n",
  );
  commitAll(long, "long file", ALICE, "2024-09-01T10:00:00Z");
  pushAll(long);
  h = await startHarness(testConfig(root, fx.remoteBase), { gitBinary: logger.bin });
});
after(async () => {
  await h.stop();
  cleanup();
});

const blobFetches = () =>
  logger.calls().filter((call) => call.includes("fetch") && call.includes("origin") && !call.includes("--prune"))
    .length;

async function read(args: Record<string, unknown>, harness = h) {
  const out = await harness.call("read_file", { repo: "gameconfig", ...args });
  return out;
}

describe("text files", () => {
  test("returns the whole file with line and byte totals", async () => {
    const out = await read({ ref: ff.c3, path: "app.txt" });
    assert.equal(out.isError, false, JSON.stringify(out.body));
    assert.equal(out.body.kind, "text");
    assert.equal(out.body.content, "alpha\nBETA\ngamma\ndelta");
    assert.equal(out.body.totalLines, 4);
    assert.equal(out.body.totalBytes, 23);
    assert.equal(out.body.size, 23);
    assert.equal(out.body.startLine, 1);
    assert.equal(out.body.endLine, 4);
    assert.equal(out.body.truncated, false);
    assert.equal(out.body.commit, ff.c3);
  });

  test("returns a line range and clamps ranges that run past the end", async () => {
    assert.equal((await read({ ref: ff.c3, path: "app.txt", startLine: 2, endLine: 3 })).body.content, "BETA\ngamma");
    const tail = await read({ ref: ff.c3, path: "app.txt", startLine: 3, endLine: 99 });
    assert.equal(tail.body.content, "gamma\ndelta");
    assert.equal(tail.body.endLine, 4);
    const beyond = await read({ ref: ff.c3, path: "app.txt", startLine: 10, endLine: 12 });
    assert.equal(beyond.body.content, "");
    assert.equal(beyond.body.totalLines, 4);
    assert.equal(beyond.body.endLine, 0);
  });

  test("serves non-ASCII paths and keeps carriage returns", async () => {
    const zh = await read({ ref: "main", path: "配置/说明.txt" });
    assert.equal(zh.body.content, "中文说明\n第二行");
    assert.equal(zh.body.totalLines, 2);
    assert.equal(zh.body.totalBytes, Buffer.byteLength("中文说明\n第二行\n"));
    const crlf = await read({ ref: ff.c5, path: "crlf.txt" });
    assert.equal(crlf.body.content, "a\r\nb\r");
  });

  test("resolves branches, shas and short shas, and follows history", async () => {
    assert.equal((await read({ ref: ff.c1, path: "app.txt" })).body.content, "alpha\nbeta\ngamma");
    assert.equal((await read({ ref: ff.c1.slice(0, 9), path: "app.txt" })).body.content, "alpha\nbeta\ngamma");
    assert.equal((await read({ ref: "main", path: "app-renamed.txt" })).body.content, "alpha\nBETA\ngamma\ndelta");
    const gone = await read({ ref: "main", path: "app.txt" });
    assert.equal(gone.isError, true);
    assert.equal((gone.body.error as { code: string }).code, "not_found");
    assert.equal((await read({ ref: ff.c5, path: "crlf.txt" })).isError, false);
    assert.equal((await read({ ref: "main", path: "crlf.txt" })).isError, true);
  });

  test("a byte range returns that slice of a text file", async () => {
    const out = await read({ ref: ff.c3, path: "app.txt", offset: 6, length: 4 });
    assert.equal(out.body.content, "BETA");
    assert.equal(out.body.length, 4);
    assert.equal(out.body.truncated, false);
  });
});

describe("binary files", () => {
  test("returns size, oid, sha256 and the detected type, and a base64 byte range on request", async () => {
    const out = await read({ ref: ff.c1, path: "pic.png" });
    assert.equal(out.body.kind, "binary");
    assert.equal(out.body.size, pngBytes().length);
    assert.equal(out.body.oid, ff.pngOid);
    assert.equal(out.body.detectedType, "png");
    assert.equal(out.body.sha256, createHash("sha256").update(pngBytes()).digest("hex"));
    assert.equal("base64" in out.body, false);
    const slice = await read({ ref: ff.c1, path: "pic.png", offset: 0, length: 8 });
    assert.equal(slice.body.base64, pngBytes().subarray(0, 8).toString("base64"));
    assert.equal(slice.body.length, 8);
    const tail = await read({ ref: ff.c1, path: "pic.png", offset: pngBytes().length - 3, length: 100 });
    assert.equal(tail.body.base64, pngBytes().subarray(-3).toString("base64"));
    assert.equal(tail.body.truncated, false);
  });

  test("a line range on a binary file is refused", async () => {
    const out = await read({ ref: ff.c1, path: "pic.png", startLine: 1, endLine: 2 });
    assert.equal(out.isError, true);
    assert.equal((out.body.error as { code: string }).code, "binary_file");
  });

  test("a byte range longer than the response limit is cut and reported", async () => {
    const small = await startHarness(
      testConfig(root, fx.remoteBase, { truncateChars: 3000, clonesDir: join(root, "small-clones") }),
    );
    try {
      const out = await read({ ref: ff.c1, path: "pic.png", offset: 0, length: pngBytes().length }, small);
      assert.equal(out.body.truncated, true);
      assert.equal(out.body.length, 750);
      assert.equal(out.body.cutBytes, pngBytes().length - 750);
      assert.ok(JSON.stringify(out.body).length <= 3000);
    } finally {
      await small.stop();
    }
  });
});

describe("special entries", () => {
  test("an LFS pointer is reported as a pointer and never as content", async () => {
    const out = await read({ ref: ff.c1, path: "pointer.bin" });
    assert.equal(out.body.kind, "lfs_pointer");
    assert.equal(out.body.lfsOid, LFS_OID_ONE);
    assert.equal(out.body.lfsSize, 123456);
    assert.equal(out.body.path, "pointer.bin");
    assert.equal(out.body.oid, ff.pointerOneOid);
    assert.equal("content" in out.body, false);
  });

  test("a file with real content under an LFS attributed path is served normally", async () => {
    const out = await read({ ref: ff.c1, path: "real.bin" });
    assert.equal(out.body.kind, "text");
    assert.equal(out.body.content, "real content under an lfs attributed path");
  });

  test("a large file that merely starts like a pointer is content and the decision never uses the path", async () => {
    const out = await read({ ref: ff.c1, path: "fake-pointer.dat", startLine: 1, endLine: 1 });
    assert.equal(out.body.kind, "text");
    assert.equal(out.body.content, "version https://git-lfs.github.com/spec/v1");
    const plain = await read({ ref: ff.c1, path: "app.txt" });
    assert.equal(plain.body.kind, "text");
  });

  test("a submodule entry is reported as a submodule and never fetched", async () => {
    const before = blobFetches();
    const out = await read({ ref: ff.c5, path: "vendor/lib" });
    assert.equal(out.isError, false, JSON.stringify(out.body));
    assert.equal(out.body.kind, "submodule");
    assert.equal(out.body.commit, ff.submoduleCommit);
    assert.equal(blobFetches(), before);
  });

  test("a directory and a missing path are refused", async () => {
    const dir = await read({ ref: ff.c5, path: "配置" });
    assert.equal((dir.body.error as { code: string }).code, "not_a_file");
    const missing = await read({ ref: ff.c5, path: "nope.txt" });
    assert.equal((missing.body.error as { code: string }).code, "not_found");
  });
});

describe("blob cache", () => {
  test("a cold read fetches once, a warm read is a cache hit and a lost cache refetches", async () => {
    const path = "notes2.txt";
    const before = blobFetches();
    const mark = h.audit.rows().length;
    await read({ ref: ff.c4, path });
    await read({ ref: ff.c4, path });
    assert.equal(blobFetches(), before + 1);
    rmSync(join(root, "data", "cache"), { recursive: true, force: true });
    const again = await read({ ref: ff.c4, path });
    assert.equal(
      again.body.content,
      "note number 1\nnote number 2\nnote number 3\nnote number 4\nnote number 5\nnote number 6\nnote number 7\nnote number 8\nnote number 9\nnote number ten changed",
    );
    assert.equal(blobFetches(), before + 2);
    assert.deepEqual(
      h.audit
        .rows()
        .slice(mark)
        .map((row) => row.cacheHit),
      [false, true, false],
    );
  });
});

describe("limits and refusals", () => {
  test("a long file is cut at the response limit with exact totals", async () => {
    const small = await startHarness(
      testConfig(root, fx.remoteBase, { truncateChars: 6000, clonesDir: join(root, "small-clones-2") }),
    );
    try {
      const out = await small.call("read_file", { repo: "server", ref: "main", path: "long.txt" });
      assert.equal(out.body.truncated, true);
      assert.equal(out.body.totalLines, 5000);
      assert.ok((out.body.endLine as number) < 5000 && (out.body.endLine as number) > 10);
      assert.ok((out.body.content as string).split("\n").length === out.body.endLine);
      assert.ok((out.body.cutChars as number) > 400_000);
      assert.ok(JSON.stringify(out.body).length <= 6000);
    } finally {
      await small.stop();
    }
  });

  test("hostile arguments are refused before any git process starts and nothing is stored in the audit", async () => {
    const started = logger.calls().length;
    const cases: [Record<string, unknown>, string][] = [
      [{ ref: "--output=x", path: "a" }, "bad_ref"],
      [{ ref: "main", path: "../x" }, "bad_path"],
      [{ ref: "main", path: "/etc/passwd" }, "bad_path"],
      [{ ref: "main", path: "a", startLine: 0 }, "bad_number"],
      [{ ref: "main", path: "a", offset: -1 }, "bad_number"],
      [{ ref: "main", path: "a", startLine: 3, endLine: 2 }, "bad_number"],
      [{ ref: "main", path: "a", startLine: 1, offset: 0 }, "bad_arguments"],
      [{ ref: "main", path: "a", url: "x" }, "bad_arguments"],
    ];
    for (const [args, reason] of cases) {
      const out = await read(args);
      assert.equal((out.body.error as { code: string }).code, reason, JSON.stringify(args));
    }
    assert.equal(logger.calls().length, started);
    const dump = JSON.stringify(h.audit.rows());
    for (const content of ["alpha", "中文说明", "real content", "note number"])
      assert.equal(dump.includes(content), false);
  });
});
