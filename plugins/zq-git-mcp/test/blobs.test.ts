import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { BlobFetchError, createBlobStore, type BlobStore } from "../src/blobs.ts";
import { createBlobCache, type BlobCache } from "../src/cache.ts";
import { dirSize } from "../src/fs-util.ts";
import { createMemoryBlobMetaLedger } from "../src/ledger.ts";
import { createLimiter } from "../src/limiter.ts";
import { createRepos, type Repos } from "../src/repos.ts";
import { createGitRunner } from "../src/runner.ts";
import { createScratch } from "../src/scratch.ts";
import { fakeGit, loggingGit } from "./support/fake-git.ts";
import { withIndexPackPeak } from "./support/rss.ts";
import { BIG_BYTES, buildFixture, commitAll, makeRoot, pushAll, git, type Fixture } from "./support/fixtures.ts";

const { root, cleanup } = makeRoot("zqgit-blobs-");
let fx: Fixture;
let counter = 0;
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

const manyOids: Record<string, string[]> = {};
const HUGE_MB = 128;
let hugeOid = "";

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
  const huge = fx.work.jenkinstasks;
  const piece = randomBytes(1024 * 1024);
  const parts = Array.from({ length: HUGE_MB }, (_, i) => Buffer.concat([piece.subarray(i + 1), randomBytes(i + 1)]));
  writeFileSync(join(huge, "huge.bin"), Buffer.concat(parts));
  commitAll(huge, "huge blob");
  pushAll(huge);
  hugeOid = git(huge, ["rev-parse", "HEAD:huge.bin"]);
});
after(cleanup);

interface Setup {
  ledger: ReturnType<typeof createMemoryBlobMetaLedger>;
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
    repo?: "client" | "gameconfig" | "zq-ui" | "jenkinstasks" | "clientcode";
    maxBigFetches?: number;
    noProgressMs?: number;
    failureTtlMs?: number;
    now?: () => number;
  } = {},
): Promise<Setup> {
  const n = counter++;
  const logger = loggingGit(root);
  const runner = createGitRunner({ gitBinary: options.gitBinary ?? logger.bin, timeoutMs: 120_000 });
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
  const ledger = createMemoryBlobMetaLedger();
  const blobs = createBlobStore({
    repos,
    runner,
    scratch,
    cache,
    fetches,
    bigFetches: createLimiter(options.maxBigFetches ?? 2),
    ledger,
    fetchTimeoutMs: 120_000,
    noProgressMs: options.noProgressMs ?? 120_000,
    failureTtlMs: options.failureTtlMs ?? 60_000,
    progressPollMs: 20,
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    ledger,
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
    assert.deepEqual({ hits: first.stats.hits, fetched: first.stats.fetched }, { hits: 0, fetched: 1 });
    assert.equal(s.fetchCalls().length, 1);
    const second = await s.blobs.withBlobs("client", [fx.client.renamedOid], async (_paths, stats) => stats);
    assert.deepEqual({ hits: second.hits, fetched: second.fetched }, { hits: 1, fetched: 0 });
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

describe("fetch failures", () => {
  const MISSING = `${"0".repeat(39)}1`;

  test("a failed fetch names the repository and object, is remembered briefly and is not retried in a storm", async () => {
    let clock = 1_000_000;
    const s = await setup({ failureTtlMs: 60_000, now: () => clock });
    const fail = (oid: string) =>
      assert.rejects(
        s.blobs.withBlobs("client", [oid], async () => "never"),
        (e) => {
          assert.ok(e instanceof BlobFetchError);
          assert.match(e.message, new RegExp(`fetch failed for client ${oid.slice(0, 10)}: .*exited with`));
          return true;
        },
      );
    await fail(MISSING);
    assert.equal(s.fetchCalls().length, 1);
    for (let i = 0; i < 5; i++)
      await assert.rejects(
        s.blobs.withBlobs("client", [MISSING], async () => "never"),
        /failed recently, not retried yet/,
      );
    assert.equal(s.fetchCalls().length, 1);
    assert.equal(
      await s.blobs.withBlobs("client", [fx.client.readmeOid], async (paths) => read(paths, fx.client.readmeOid)),
      "# client\nchanged\n",
    );
    clock += 61_000;
    await fail(MISSING);
    assert.equal(s.fetchCalls().length, 3);
    assert.deepEqual(readdirSync(s.scratchDir), []);
  });

  test("every explicit fetch is a plain object id fetch and never asks for an unfiltered or refetch mode", async () => {
    const s = await setup();
    await s.blobs.withBlobs("client", [fx.client.readmeOid], async () => 1);
    assert.equal(s.fetchCalls().length, 1);
    for (const call of s.fetchCalls()) {
      assert.deepEqual(call.slice(call.indexOf("fetch") - 2, call.indexOf("origin") + 1), [
        "-c",
        "fetch.negotiationAlgorithm=noop",
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--quiet",
        "origin",
      ]);
      assert.equal(
        call.some((arg) => /filter|refetch|unshallow|depth/.test(arg)),
        false,
      );
    }
  });

  test("a bitmap packed server still sends a blob the client already has a commit for, thanks to noop negotiation", async () => {
    const bare = join(fx.remotes, "clientcode.git");
    git(bare, ["config", "pack.writeBitmaps", "true"]);
    git(bare, ["repack", "-a", "-d", "-b"]);
    const oid = git(fx.work.clientcode, ["rev-parse", "HEAD:README.md"]);
    const s = await setup({ repo: "clientcode" });
    const plain = join(root, `bitmap-${counter++}.git`);
    const runner = createGitRunner({ timeoutMs: 60_000 });
    await runner.run(undefined, ["init", "--bare", "--quiet", plain]);
    for (const [key, value] of [
      ["remote.origin.url", s.repos.url("clientcode")],
      ["remote.origin.promisor", "true"],
    ] as const)
      await runner.run(plain, ["config", key, value]);
    await mkdir(join(plain, "objects", "info"), { recursive: true });
    await writeFile(join(plain, "objects", "info", "alternates"), `${join(s.repos.dir("clientcode"), "objects")}\n`);
    const fetchPlain = ["fetch", "--no-tags", "--no-write-fetch-head", "origin", oid];
    await assert.rejects(runner.run(plain, fetchPlain, { remote: true }), /did not send all necessary objects/);
    const text = await s.blobs.withBlobs("clientcode", [oid], async (paths) => read(paths, oid));
    assert.equal(text, "# clientcode\n");
    await runner.run(plain, ["-c", "fetch.negotiationAlgorithm=noop", ...fetchPlain], { remote: true });
  });

  test("a fetch that stops making progress is killed by the watchdog and reported", async () => {
    const hang = fakeGit(root, `case " $* " in *" fetch "*) sleep 30;; esac\nexec ${REAL_GIT} "$@"`);
    const s = await setup({ gitBinary: hang, noProgressMs: 400 });
    const started = Date.now();
    await assert.rejects(
      s.blobs.withBlobs("client", [fx.client.readmeOid], async () => "never"),
      /fetch failed for client .*no progress/,
    );
    assert.ok(Date.now() - started < 8000);
    assert.deepEqual(readdirSync(s.scratchDir), []);
  });

  test("a fetch that keeps writing is not stopped by the watchdog", async () => {
    const slow = fakeGit(
      root,
      `case " $* " in *" fetch "*) d=\${3#--git-dir=}; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do echo x >> $d/progress; sleep 0.1; done;; esac\nexec ${REAL_GIT} "$@"`,
    );
    const s = await setup({ gitBinary: slow, noProgressMs: 500 });
    const text = await s.blobs.withBlobs("client", [fx.client.readmeOid], async (paths) =>
      read(paths, fx.client.readmeOid),
    );
    assert.equal(text, "# client\nchanged\n");
  });
});

describe("memory aware fetch limits", () => {
  const overlapGit = (log: string) =>
    fakeGit(
      root,
      `case " $* " in *" fetch "*) case " $* " in *" --prune "*) ;; *) echo "s" >> ${log}; sleep 0.3; echo "e" >> ${log};; esac;; esac\nexec ${REAL_GIT} "$@"`,
    );
  const peakOf = (log: string) => {
    let running = 0;
    let peak = 0;
    for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
      running += line === "s" ? 1 : -1;
      peak = Math.max(peak, running);
    }
    return peak;
  };

  test("fetches of blobs not known to be small run one at a time when the big fetch limit is one", async () => {
    const log = join(root, `big-${counter}.log`);
    const s = await setup({ gitBinary: overlapGit(log), maxBigFetches: 1, maxFetches: 4, maxJobs: 6, repo: "zq-ui" });
    const oids = [...new Set(manyOids["zq-ui"] ?? [])].slice(0, 4);
    await Promise.all(oids.map((oid) => s.blobs.withBlobs("zq-ui", [oid], async (paths) => read(paths, oid))));
    assert.equal(peakOf(log), 1);
  });

  test("fetches of blobs already learned to be small are not held back by the big fetch limit", async () => {
    const log = join(root, `small-${counter}.log`);
    const s = await setup({ gitBinary: overlapGit(log), maxBigFetches: 1, maxFetches: 4, maxJobs: 6, repo: "zq-ui" });
    const oids = [...new Set(manyOids["zq-ui"] ?? [])].slice(0, 4);
    for (const oid of oids) s.ledger.record("zq-ui", oid, { size_bytes: 20 });
    await Promise.all(oids.map((oid) => s.blobs.withBlobs("zq-ui", [oid], async (paths) => read(paths, oid))));
    assert.ok(peakOf(log) > 1);
  });

  test("sizes learned after a download are remembered", async () => {
    const s = await setup();
    assert.equal(s.ledger.get("client", fx.client.readmeOid)?.size_bytes, undefined);
    await s.blobs.withBlobs("client", [fx.client.readmeOid], async () => 1);
    assert.equal(s.ledger.get("client", fx.client.readmeOid)?.size_bytes, "# client\nchanged\n".length);
  });

  test("the temporary repository streams large packs instead of holding them in memory", async (t) => {
    const s = await setup({ repo: "jenkinstasks", cacheCap: 1024 * 1024 * 1024 });
    const size = HUGE_MB * 1024 * 1024;
    const withSetting = await withIndexPackPeak(() =>
      s.blobs.withBlobs("jenkinstasks", [hugeOid], async (paths) => readFileSync(paths.get(hugeOid) ?? "").length),
    );
    assert.equal(withSetting.value, size);
    const plain = join(root, `plain-${counter++}.git`);
    const runner = createGitRunner({ timeoutMs: 120_000 });
    await runner.run(undefined, ["init", "--bare", "--quiet", plain]);
    for (const [key, value] of [
      ["remote.origin.url", s.repos.url("jenkinstasks")],
      ["remote.origin.promisor", "true"],
      ["fetch.unpackLimit", "1"],
      ["transfer.unpackLimit", "1"],
    ] as const)
      await runner.run(plain, ["config", key, value]);
    const without = await withIndexPackPeak(() =>
      runner.run(plain, ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", "origin", hugeOid], {
        remote: true,
        timeoutMs: 120_000,
      }),
    );
    t.diagnostic(
      `index-pack peak RSS for a ${HUGE_MB} MiB blob: ${Math.round(withSetting.peakBytes / 1048576)} MiB with core.bigFileThreshold=1m, ${Math.round(without.peakBytes / 1048576)} MiB without`,
    );
    assert.ok(withSetting.peakBytes < size / 4);
    assert.ok(without.peakBytes > withSetting.peakBytes * 2);
  });
});

describe("temporary repository helper", () => {
  test("runs a command with lazy fetch allowed and counts the lazy fetches it caused", async () => {
    const s = await setup();
    const bare = s.repos.dir("client");
    const size = await dirSize(bare);
    const rootCommit = git(fx.work.client, ["rev-list", "--max-parents=0", fx.client.second]);
    const rootReadme = git(fx.work.client, ["rev-parse", `${rootCommit}:README.md`]);
    const blame = ["blame", "--porcelain", fx.client.second, "--", "README.md"];
    const partial = await s.blobs.withTempRepo("client", async (temp) => {
      const threshold = await temp.git(["config", "--get", "core.bigFileThreshold"]);
      assert.equal(threshold.stdout.toString().trim(), "1m");
      const negotiation = await temp.git(["config", "--get", "fetch.negotiationAlgorithm"]);
      assert.equal(negotiation.stdout.toString().trim(), "noop");
      await temp.fetch([fx.client.readmeOid]);
      const out = await temp.git(blame);
      return { text: out.stdout.toString(), lazy: await temp.lazyFetches() };
    });
    assert.match(partial.text, new RegExp(`^${fx.client.second} `, "m"));
    assert.equal(partial.lazy, 1);
    const prefetched = await s.blobs.withTempRepo("client", async (temp) => {
      await temp.fetch([fx.client.readmeOid, rootReadme]);
      const out = await temp.git(blame);
      return { text: out.stdout.toString(), lazy: await temp.lazyFetches() };
    });
    assert.equal(prefetched.text, partial.text);
    assert.equal(prefetched.lazy, 0);
    assert.equal(await dirSize(bare), size);
    assert.deepEqual(readdirSync(s.scratchDir), []);
  });

  test("the same command in the bare clone fails instead of fetching lazily", async () => {
    const s = await setup();
    const runner = createGitRunner({ timeoutMs: 20_000 });
    await assert.rejects(
      runner.run(s.repos.dir("client"), ["blame", "--porcelain", fx.client.second, "--", "README.md"]),
      /exited with \d+/,
    );
  });
});

describe("batches with an unfetchable object", () => {
  const BAD = "f".repeat(40);
  const reals = () => [...new Set(manyOids["zq-ui"] ?? [])].slice(0, 3);

  test("the batch is split, the fetchable objects are returned and only the failing one is remembered", async () => {
    const s = await setup({ repo: "zq-ui" });
    const [a = "", b = "", c = ""] = reals();
    const order = [a, BAD, b, c];
    const result = await s.blobs.withBlobs(
      "zq-ui",
      order,
      async (paths, stats) => ({
        texts: [a, b, c].map((oid) => read(paths, oid)),
        failed: [...stats.failed.keys()],
        fetched: stats.fetched,
        hasBad: paths.has(BAD),
      }),
      { partial: true },
    );
    assert.match(result.texts[0] ?? "", /^zq-ui content \d+\n$/);
    assert.deepEqual(result.failed, [BAD]);
    assert.equal(result.fetched, 3);
    assert.equal(result.hasBad, false);
    const calls = s.fetchCalls();
    assert.equal(calls.length, 5);
    const occurrences = (oid: string) => calls.filter((call) => call.includes(oid)).length;
    for (const oid of order) assert.ok(occurrences(oid) <= 3, `${oid} fetched ${occurrences(oid)} times`);
    const again = await s.blobs.withBlobs("zq-ui", order, async (_paths, stats) => [...stats.failed.values()], {
      partial: true,
    });
    assert.equal(s.fetchCalls().length, 5);
    assert.match(again[0] ?? "", /failed recently, not retried yet/);
    assert.deepEqual(readdirSync(s.scratchDir), []);
  });

  test("without partial results the failure is raised after the good objects have been cached", async () => {
    const s = await setup({ repo: "zq-ui" });
    const [a = "", b = ""] = reals();
    await assert.rejects(
      s.blobs.withBlobs("zq-ui", [a, BAD, b], async () => "never"),
      (e) => e instanceof BlobFetchError && e.message.includes(`zq-ui ${BAD.slice(0, 10)}`),
    );
    const before = s.fetchCalls().length;
    await s.blobs.withBlobs("zq-ui", [a, b], async (_paths, stats) => assert.equal(stats.hits, 2));
    assert.equal(s.fetchCalls().length, before);
  });
});
