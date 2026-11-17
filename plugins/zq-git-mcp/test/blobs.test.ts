import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { join } from "node:path";
import { createBlobStore, type BlobStore } from "../src/blobs.ts";
import { createBlobCache, type BlobCache } from "../src/cache.ts";
import { dirSize } from "../src/fs-util.ts";
import { createLimiter } from "../src/limiter.ts";
import { createRepos, type Repos } from "../src/repos.ts";
import { createGitRunner } from "../src/runner.ts";
import { createScratch } from "../src/scratch.ts";
import { fakeGit, loggingGit } from "./support/fake-git.ts";
import { BIG_BYTES, buildFixture, commitAll, makeRoot, pushAll, git, type Fixture } from "./support/fixtures.ts";

const { root, cleanup } = makeRoot("zqgit-blobs-");
let fx: Fixture;
let counter = 0;
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

const manyOids: Record<string, string[]> = {};

before(() => {
  fx = buildFixture(root);
  for (const [repo, count] of [
    ["gameconfig", 100],
    ["zq-ui", 250],
  ] as const) {
    const dir = fx.work[repo];
    for (let i = 0; i < count; i++) writeFileSync(join(dir, `f${i}.txt`), `${repo} content ${i}\n`);
    commitAll(dir, "many files");
    pushAll(dir);
    manyOids[repo] = git(dir, ["ls-tree", "-r", "HEAD"])
      .split("\n")
      .filter((line) => /\tf\d+\.txt$/.test(line))
      .map((line) => line.split(/\s+/)[2] ?? "");
  }
});
after(cleanup);

interface Setup {
  blobs: BlobStore;
  repos: Repos;
  cache: BlobCache;
  clones: string;
  scratchDir: string;
  calls(): string[][];
  fetchCalls(): string[][];
}

async function setup(
  options: {
    cacheCap?: number;
    maxFetches?: number;
    maxJobs?: number;
    gitBinary?: string;
    repo?: "client" | "gameconfig" | "zq-ui";
  } = {},
): Promise<Setup> {
  const n = counter++;
  const logger = loggingGit(root);
  const runner = createGitRunner({ gitBinary: options.gitBinary ?? logger.bin, timeoutMs: 30_000 });
  const fetches = createLimiter(options.maxFetches ?? 4);
  const clones = join(root, `clones-${n}`);
  const scratchDir = join(root, `scratch-${n}`);
  const repos = createRepos({
    runner,
    fetches,
    clonesDir: clones,
    remoteBase: fx.remoteBase,
    refreshMs: 60_000,
    fetchTimeoutMs: 30_000,
  });
  const cache = createBlobCache({ dir: join(root, `cache-${n}`), capBytes: options.cacheCap ?? 64 * 1024 * 1024 });
  await cache.scan();
  const scratch = createScratch({
    dir: scratchDir,
    capBytes: 1024 ** 3,
    floorBytes: 0,
    maxJobs: options.maxJobs ?? 2,
    pollMs: 10,
  });
  await repos.ensure(options.repo ?? "client");
  const blobs = createBlobStore({ repos, runner, scratch, cache, fetches, fetchTimeoutMs: 30_000 });
  return {
    blobs,
    repos,
    cache,
    clones,
    scratchDir,
    calls: logger.calls,
    fetchCalls: () =>
      logger.calls().filter((call) => call.includes("fetch") && !call.includes("--prune") && call.includes("origin")),
  };
}

const read = (paths: ReadonlyMap<string, string>, oid: string) => readFileSync(paths.get(oid) ?? "", "utf8");

describe("on-demand blob fetch", () => {
  test("fetches a blob by object id, serves its content and then answers from the cache", async () => {
    const s = await setup();
    const first = await s.blobs.withBlobs("client", [fx.client.renamedOid], async (paths, stats) => ({
      text: read(paths, fx.client.renamedOid),
      stats,
    }));
    assert.match(first.text, new RegExp(`line one SECRET-FILE-CONTENT-MARKER`));
    assert.deepEqual(first.stats, { hits: 0, fetched: 1 });
    assert.equal(s.fetchCalls().length, 1);
    const second = await s.blobs.withBlobs("client", [fx.client.renamedOid], async (_paths, stats) => stats);
    assert.deepEqual(second, { hits: 1, fetched: 0 });
    assert.equal(s.fetchCalls().length, 1);
    assert.equal(s.cache.usage().entries, 1);
    assert.deepEqual(readdirSync(s.scratchDir), []);
  });

  test("the bare clone stays byte identical after 100 distinct blob fetches", async () => {
    const s = await setup({ repo: "gameconfig" });
    const distinct = [...new Set(manyOids.gameconfig ?? [])];
    assert.equal(distinct.length, 100);
    const bare = s.repos.dir("gameconfig");
    const listing = () =>
      execFileSync("find", [bare, "-type", "f", "-printf", "%P %s\n"], { encoding: "utf8" })
        .split("\n")
        .sort()
        .join("\n");
    const sizeBefore = await dirSize(bare);
    const filesBefore = listing();
    for (const oid of distinct) {
      const text = await s.blobs.withBlobs("gameconfig", [oid], async (paths) => read(paths, oid));
      assert.match(text, /^gameconfig content \d+\n$/);
    }
    assert.equal(s.fetchCalls().length, 100);
    assert.equal(await dirSize(bare), sizeBefore);
    assert.equal(listing(), filesBefore);
    assert.equal(s.cache.usage().entries, 100);
  });

  test("batches up to 100 object ids into one fetch", async () => {
    const s = await setup({ repo: "zq-ui" });
    const oids = [...new Set(manyOids["zq-ui"] ?? [])].slice(0, 250);
    assert.equal(oids.length, 250);
    const count = await s.blobs.withBlobs("zq-ui", oids, async (paths, stats) => {
      assert.equal(paths.size, 250);
      assert.equal(stats.fetched, 250);
      return paths.size;
    });
    assert.equal(count, 250);
    const sizes = s.fetchCalls().map((call) => call.length - call.indexOf("origin") - 1);
    assert.deepEqual(
      sizes.sort((a, b) => a - b),
      [50, 100, 100],
    );
  });

  test("identical in-flight fetches are coalesced into one", async () => {
    const s = await setup({ repo: "zq-ui" });
    const oids = [...new Set(manyOids["zq-ui"] ?? [])].slice(0, 5);
    const results = await Promise.all([
      s.blobs.withBlobs("zq-ui", oids, async (paths) => oids.map((oid) => read(paths, oid))),
      s.blobs.withBlobs("zq-ui", oids, async (paths) => oids.map((oid) => read(paths, oid))),
      s.blobs.withBlobs("zq-ui", [...oids].reverse(), async (paths) => oids.map((oid) => read(paths, oid))),
    ]);
    assert.equal(s.fetchCalls().length, 1);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0], results[2]);
    assert.equal(results[0]?.length, 5);
  });

  test("no more than the configured number of fetches run at the same time", async () => {
    const log = join(root, `overlap-${counter}.log`);
    const bin = fakeGit(
      root,
      `case " $* " in *" fetch "*) case " $* " in *" --prune "*) ;; *) echo "s" >> ${log}; sleep 0.3; echo "e" >> ${log};; esac;; esac\nexec ${REAL_GIT} "$@"`,
    );
    const s = await setup({ gitBinary: bin, maxFetches: 2, maxJobs: 6, repo: "zq-ui" });
    const oids = [...new Set(manyOids["zq-ui"] ?? [])].slice(0, 6);
    await Promise.all(oids.map((oid) => s.blobs.withBlobs("zq-ui", [oid], async (paths) => read(paths, oid))));
    let running = 0;
    let peak = 0;
    for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
      running += line === "s" ? 1 : -1;
      peak = Math.max(peak, running);
    }
    assert.equal(peak, 2);
  });

  test("a blob larger than half the cache is served from a transient file and not kept", async () => {
    const s = await setup({ cacheCap: 2 * 1024 * 1024 });
    let path = "";
    const size = await s.blobs.withBlobs("client", [fx.client.bigOid], async (paths) => {
      path = paths.get(fx.client.bigOid) ?? "";
      assert.ok(path.startsWith(s.scratchDir));
      return readFileSync(path).length;
    });
    assert.equal(size, BIG_BYTES);
    assert.equal(existsSync(path), false);
    assert.equal(s.cache.usage().entries, 0);
    assert.deepEqual(readdirSync(s.scratchDir), []);
  });

  test("an unknown object id fails cleanly, leaves no scratch behind and does not poison later calls", async () => {
    const s = await setup();
    await assert.rejects(s.blobs.withBlobs("client", ["0".repeat(39) + "1"], async () => "never"));
    assert.deepEqual(readdirSync(s.scratchDir), []);
    const text = await s.blobs.withBlobs("client", [fx.client.readmeOid], async (paths) =>
      read(paths, fx.client.readmeOid),
    );
    assert.equal(text, "# client\nchanged\n");
  });

  test("a commit or tree id is refused as not a blob", async () => {
    const s = await setup();
    const tree = git(fx.work.client, ["rev-parse", `${fx.client.first}^{tree}`]);
    await assert.rejects(
      s.blobs.withBlobs("client", [tree], async () => "never"),
      /not a blob/,
    );
    assert.equal(s.cache.usage().entries, 0);
  });

  test("hostile repository names and object ids are refused before any process starts", async () => {
    const s = await setup();
    const before = s.calls().length;
    for (const [repo, oid, reason] of [
      ["client", "HEAD", "bad_oid"],
      ["client", "--upload-pack=x", "bad_oid"],
      ["client", "abc", "bad_oid"],
      ["qm-test", fx.client.readmeOid, "repo_not_allowed"],
      ["../client", fx.client.readmeOid, "repo_not_allowed"],
    ] as const)
      await assert.rejects(
        s.blobs.withBlobs(repo, [oid], async () => "never"),
        (e) => (e as { reason?: string }).reason === reason,
      );
    assert.equal(s.calls().length, before);
  });
});

describe("the lazy fetch guard", () => {
  const forbidden: string[][] = [
    ["log", "--stat", "-n", "1", "main"],
    ["log", "-p", "-n", "1", "main"],
    ["diff", "--stat", "main~2", "main"],
    ["diff", "--numstat", "main~2", "main"],
    ["show", "main:README.md"],
    ["cat-file", "-p", "main:README.md"],
  ];

  test("commands that need blob contents fail loudly instead of downloading them", async () => {
    const s = await setup();
    const runner = createGitRunner({ timeoutMs: 20_000 });
    const bare = s.repos.dir("client");
    const size = await dirSize(bare);
    for (const args of forbidden) await assert.rejects(runner.run(bare, args), /exited with \d+/, args.join(" "));
    assert.equal(await dirSize(bare), size);
  });

  test("a size listing cannot see sizes of missing blobs and still downloads nothing", async () => {
    const s = await setup();
    const runner = createGitRunner({ timeoutMs: 20_000 });
    const bare = s.repos.dir("client");
    const size = await dirSize(bare);
    const out = await runner.run(bare, ["ls-tree", "-l", "main"]);
    assert.match(out.stdout.toString(), /BAD\s+README\.md/);
    assert.equal(await dirSize(bare), size);
  });

  test("the same command with the guard lifted does download, so the guard is what stops it", async () => {
    const s = await setup();
    const runner = createGitRunner({ timeoutMs: 20_000 });
    const bare = s.repos.dir("client");
    const size = await dirSize(bare);
    const out = await runner.run(bare, ["ls-tree", "-l", "main"], { remote: true });
    assert.match(out.stdout.toString(), /README\.md/);
    assert.ok((await dirSize(bare)) > size);
  });
});
