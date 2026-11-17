import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { dirSize } from "../src/fs-util.ts";
import { loggingGit } from "./support/fake-git.ts";
import { ALICE, BOB, buildFixture, commitAll, git, makeRoot, pushAll, type Fixture } from "./support/fixtures.ts";
import { LFS_OID_ONE, buildFilesFixture, type FilesFixture } from "./support/files-fixture.ts";
import { startHarness, testConfig, type Harness } from "./support/harness.ts";

const { root, cleanup } = makeRoot("zqgit-search-");
const logger = loggingGit(root);
let fx: Fixture;
let ff: FilesFixture;
let h: Harness;

before(async () => {
  fx = buildFixture(root);
  ff = buildFilesFixture(fx);
  git(join(fx.remotes, "gameconfig.git"), ["config", "pack.writeBitmaps", "true"]);
  git(join(fx.remotes, "gameconfig.git"), ["repack", "-a", "-d", "-b"]);
  const long = fx.work.server;
  writeFileSync(
    join(long, "long.txt"),
    Array.from({ length: 4000 }, (_, i) => `row ${i + 1} needle ${"z".repeat(60)}`).join("\n") + "\n",
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

async function search(args: Record<string, unknown>, harness = h, repo = "gameconfig") {
  return harness.call("search", { repo, ref: "main", ...args });
}

interface Hit {
  path: string;
  line: number;
  text: string;
  before: string[];
  after: string[];
}

describe("message search", () => {
  test("matches commit messages as fixed strings, case-insensitively, without touching blobs", async () => {
    const size = await dirSize(join(root, "data", "clones"));
    const out = await search({ kind: "message", query: "BOB EDITS" });
    assert.equal(out.isError, false, JSON.stringify(out.body));
    assert.deepEqual(
      (out.body.commits as { sha: string }[]).map((c) => c.sha),
      [ff.c2],
    );
    assert.equal((await search({ kind: "message", query: ".*" })).body.commits instanceof Array, true);
    assert.deepEqual((await search({ kind: "message", query: ".*" })).body.commits, []);
    assert.ok((await dirSize(join(root, "data", "clones"))) >= size);
    assert.equal(blobFetches(), 0);
  });

  test("filters by author and honours the limit", async () => {
    const empty = await search({ kind: "message", query: "" });
    assert.equal((empty.body.error as { code: string }).code, "bad_query");
    const edits = await search({ kind: "message", query: "e", author: "BOB" });
    assert.ok((edits.body.commits as { author: { email: string } }[]).every((c) => c.author.email === BOB.email));
    const limited = await search({ kind: "message", query: "a", limit: 1 });
    assert.equal((limited.body.commits as unknown[]).length, 1);
    assert.equal(limited.body.more, true);
  });
});

describe("path search", () => {
  test("finds files by case-insensitive substring or glob, reports submodules as skipped", async () => {
    const sub = await search({ kind: "path", query: "APP", ref: ff.c3 });
    assert.deepEqual(
      (sub.body.paths as { path: string }[]).map((p) => p.path),
      ["app.txt"],
    );
    const renamed = await search({ kind: "path", query: "app" });
    assert.deepEqual(
      (renamed.body.paths as { path: string }[]).map((p) => p.path),
      ["app-renamed.txt"],
    );
    const zh = await search({ kind: "path", query: "配置" });
    assert.deepEqual(
      (zh.body.paths as { path: string }[]).map((p) => p.path),
      ["配置/说明.txt"],
    );
    const glob = await search({ kind: "path", query: "*.PNG" });
    assert.deepEqual(
      (glob.body.paths as { path: string }[]).map((p) => p.path),
      ["pic.png"],
    );
    const vendor = await search({ kind: "path", query: "vendor", ref: ff.c5 });
    assert.deepEqual(vendor.body.paths, []);
    assert.equal(vendor.body.submodulesSkipped, 1);
    const filtered = await search({ kind: "path", query: "t", pathGlob: "*.txt", ref: ff.c4 });
    assert.ok((filtered.body.paths as { path: string }[]).every((p) => p.path.endsWith(".txt")));
    assert.equal(blobFetches(), 0);
  });
});

describe("content search", () => {
  test("requires pathGlob and says why", async () => {
    const started = logger.calls().length;
    for (const args of [{ query: "gamma" }, { query: "gamma", pathGlob: "" }]) {
      const out = await search({ kind: "content", ...args });
      assert.equal((out.body.error as { code: string }).code, "path_glob_required");
      assert.match((out.body.error as { message: string }).message, /pathGlob/);
    }
    assert.equal(logger.calls().length, started);
  });

  test("reports the matched file count, fetches the matches in one batch and greps them", async () => {
    const before = blobFetches();
    const out = await search({ kind: "content", query: "gamma", pathGlob: "*.txt", ref: ff.c3 });
    assert.equal(out.isError, false, JSON.stringify(out.body));
    assert.equal(out.body.matchedCount, 3);
    assert.equal(out.body.searched, 3);
    const matches = out.body.matches as Hit[];
    assert.deepEqual(
      matches.map((m) => [m.path, m.line, m.text]),
      [["app.txt", 3, "gamma"]],
    );
    assert.equal(blobFetches(), before + 1);
    assert.equal(out.body.truncated, false);
    await search({ kind: "content", query: "gamma", pathGlob: "*.txt", ref: ff.c3 });
    assert.equal(blobFetches(), before + 1);
    assert.equal(h.audit.rows().at(-1)?.cacheHit, true);
  });

  test("supports regular expressions, ignore case, context lines and non-ASCII content", async () => {
    const regex = await search({
      kind: "content",
      query: "^(alpha|delta)$",
      regex: true,
      pathGlob: "app.txt",
      ref: ff.c3,
    });
    assert.deepEqual(
      (regex.body.matches as Hit[]).map((m) => m.text),
      ["alpha", "delta"],
    );
    const caseless = await search({
      kind: "content",
      query: "BETA",
      ignoreCase: true,
      pathGlob: "app.txt",
      ref: ff.c1,
    });
    assert.deepEqual(
      (caseless.body.matches as Hit[]).map((m) => m.text),
      ["beta"],
    );
    const context = await search({ kind: "content", query: "BETA", pathGlob: "app.txt", ref: ff.c3, context: 1 });
    const hit = (context.body.matches as Hit[])[0];
    assert.equal(hit?.line, 2);
    assert.deepEqual(hit?.before, ["alpha"]);
    assert.deepEqual(hit?.after, ["gamma"]);
    const zh = await search({ kind: "content", query: "第二行", pathGlob: "配置/*", ref: ff.c1 });
    assert.deepEqual(
      (zh.body.matches as Hit[]).map((m) => [m.path, m.line]),
      [["配置/说明.txt", 2]],
    );
  });

  test("binary files are skipped and counted, LFS pointers and submodules reported as skipped", async () => {
    const out = await search({ kind: "content", query: "version", pathGlob: "**", ref: ff.c5 });
    assert.equal(out.isError, false, JSON.stringify(out.body));
    const skipped = out.body.skipped as {
      binary: number;
      lfsPointers: { count: number; items: { path: string; lfsOid: string }[] };
      submodules: { count: number; items: { path: string; commit: string }[] };
    };
    assert.equal(skipped.binary, 1);
    assert.equal(skipped.lfsPointers.count, 1);
    assert.equal(skipped.lfsPointers.items[0]?.path, "pointer.bin");
    assert.equal(skipped.lfsPointers.items[0]?.lfsOid, "b".repeat(64));
    assert.equal(skipped.submodules.count, 1);
    assert.equal(skipped.submodules.items[0]?.commit, ff.submoduleCommit);
    const paths = (out.body.matches as Hit[]).map((m) => m.path);
    assert.ok(!paths.includes("pointer.bin") && !paths.includes("pic.png"));
    assert.ok(paths.includes("fake-pointer.dat"));
    const c1 = await search({ kind: "content", query: "x", pathGlob: "pointer.bin", ref: ff.c1 });
    assert.equal(
      (c1.body.skipped as { lfsPointers: { items: { lfsOid: string }[] } }).lfsPointers.items[0]?.lfsOid,
      LFS_OID_ONE,
    );
  });

  test("hostile arguments are refused before any process starts", async () => {
    const started = logger.calls().length;
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: "content", query: "x", pathGlob: "../x" }, "bad_path"],
      [{ kind: "content", query: "(", regex: true, pathGlob: "a" }, "bad_regex"],
      [{ kind: "content", query: "x\u0000", pathGlob: "a" }, "bad_query"],
      [{ kind: "content", query: "x", pathGlob: "a", context: 99 }, "bad_number"],
      [{ kind: "message", query: "x", ref: "--all" }, "bad_ref"],
      [{ kind: "files", query: "x" }, "bad_arguments"],
      [{ kind: "path", query: "x", url: "y" }, "bad_arguments"],
    ];
    for (const [args, reason] of cases) {
      const out = await search(args);
      assert.equal((out.body.error as { code: string }).code, reason, JSON.stringify(args));
    }
    assert.equal(logger.calls().length, started);
  });

  test("results are cut only by the response limit and the counts say what was not searched", async () => {
    const small = await startHarness(
      testConfig(root, fx.remoteBase, { truncateChars: 9000, clonesDir: join(root, "small-search") }),
    );
    try {
      const out = await search({ kind: "content", query: "needle", pathGlob: "long.txt" }, small, "server");
      assert.equal(out.body.truncated, true);
      const matchCount = out.body.matchCount as number;
      assert.ok(matchCount > 5 && matchCount < 4000);
      assert.equal((out.body.matches as unknown[]).length, matchCount);
      assert.equal(out.body.notSearched, 1);
      assert.ok(JSON.stringify(out.body).length <= 9000);
      const limited = await search({ kind: "content", query: "needle", pathGlob: "long.txt", limit: 3 }, h, "server");
      assert.equal((limited.body.matches as unknown[]).length, 3);
    } finally {
      await small.stop();
    }
  });

  test("the audit stores the query as an argument but no matched content", async () => {
    const dump = JSON.stringify(h.audit.rows());
    for (const content of ["zzzzzzzzzz", "中文说明", "padding line"]) assert.equal(dump.includes(content), false);
    assert.ok(h.audit.rows().some((row) => row.tool === "search" && row.result === "ok"));
  });
});
