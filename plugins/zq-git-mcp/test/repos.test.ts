import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { join } from "node:path";
import { createLimiter } from "../src/limiter.ts";
import { createRepos } from "../src/repos.ts";
import { createGitRunner } from "../src/runner.ts";
import { loggingGit } from "./support/fake-git.ts";
import { buildFixture, commitAll, git, makeRoot, pushAll, type Fixture } from "./support/fixtures.ts";

const { root, cleanup } = makeRoot("zqgit-repos-");
let fx: Fixture;
let counter = 0;
before(() => {
  fx = buildFixture(root);
});
after(cleanup);

function reposAt(refreshMs = 60_000) {
  const logger = loggingGit(root);
  const runner = createGitRunner({ gitBinary: logger.bin });
  const clonesDir = join(root, `clones-${counter++}`);
  const repos = createRepos({
    runner,
    fetches: createLimiter(4),
    clonesDir,
    remoteBase: fx.remoteBase,
    refreshMs,
    fetchTimeoutMs: 30_000,
  });
  const clones = () => logger.calls().filter((call) => call.includes("clone"));
  return { repos, runner, clonesDir, clones, calls: logger.calls };
}

const headOf = (repos: ReturnType<typeof reposAt>["repos"], name: "client" | "jenkinstasks") =>
  git(root, [`--git-dir=${repos.dir(name)}`, "symbolic-ref", "HEAD"]);

test("the first use creates a blobless bare clone that follows the remote default branch", async () => {
  const { repos } = reposAt();
  await repos.ensure("client");
  await repos.ensure("jenkinstasks");
  assert.equal(headOf(repos, "client"), "refs/heads/main");
  assert.equal(headOf(repos, "jenkinstasks"), "refs/heads/master");
  const bare = repos.dir("client");
  assert.equal(git(root, [`--git-dir=${bare}`, "config", "--get", "remote.origin.promisor"]), "true");
  assert.equal(git(root, [`--git-dir=${bare}`, "config", "--get", "remote.origin.partialclonefilter"]), "blob:none");
  assert.equal(git(root, [`--git-dir=${bare}`, "rev-parse", "--is-bare-repository"]), "true");
  const listed = await repos.list();
  assert.equal(listed.find((r) => r.name === "client")?.cloned, true);
  assert.equal(listed.find((r) => r.name === "client")?.head, "main");
});

test("concurrent first uses share one clone", async () => {
  const { repos, clones } = reposAt();
  await Promise.all([repos.ensure("client"), repos.ensure("client"), repos.ensure("client")]);
  assert.equal(clones().length, 1);
});

test("a fresh clone is not refetched but a stale one picks up new commits, deleted branches and a new default branch", async () => {
  const { repos, runner, calls } = reposAt(0);
  await repos.ensure("server");
  const bare = repos.dir("server");
  const work = fx.work.server;
  git(work, ["checkout", "-q", "-b", "temp"]);
  writeFileSync(join(work, "t.txt"), "t\n");
  const tip = commitAll(work, "temp commit");
  git(work, ["push", "-q", "origin", "temp"]);
  await repos.ensure("server");
  assert.equal(git(root, [`--git-dir=${bare}`, "rev-parse", "refs/heads/temp"]), tip);
  git(work, ["checkout", "-q", "main"]);
  git(work, ["push", "-q", "origin", "--delete", "temp"]);
  git(work, ["branch", "-q", "-D", "temp"]);
  git(work, ["checkout", "-q", "-b", "trunk"]);
  pushAll(work);
  git(fx.remotes + "/server.git", ["symbolic-ref", "HEAD", "refs/heads/trunk"]);
  await repos.ensure("server");
  assert.equal(git(root, [`--git-dir=${bare}`, "symbolic-ref", "HEAD"]), "refs/heads/trunk");
  await assert.rejects(runner.run(bare, ["rev-parse", "--verify", "--quiet", "refs/heads/temp"]));
  assert.ok(calls().some((call) => call.includes("fetch")));
});

test("within the refresh age no further network call is made", async () => {
  const { repos, calls } = reposAt(60_000);
  await repos.ensure("clientcode");
  const before = calls().length;
  await repos.ensure("clientcode");
  await repos.ensure("clientcode");
  assert.equal(calls().length, before);
});

test("list reports repositories that were never fetched as not cloned", async () => {
  const { repos, clonesDir } = reposAt();
  const listed = await repos.list();
  assert.equal(listed.length, 7);
  assert.ok(listed.every((r) => !r.cloned && r.lastFetchAt === null && r.cloneSizeBytes === null && r.head === null));
  assert.equal(existsSync(clonesDir), false);
});

test("a failed clone leaves no partial directory behind", async () => {
  const logger = loggingGit(root);
  const clonesDir = join(root, `clones-${counter++}`);
  const repos = createRepos({
    runner: createGitRunner({ gitBinary: logger.bin }),
    fetches: createLimiter(1),
    clonesDir,
    remoteBase: `file://${root}/nowhere/`,
    refreshMs: 0,
    fetchTimeoutMs: 30_000,
  });
  await assert.rejects(repos.ensure("client"), /exited with/);
  assert.equal((await repos.list()).find((r) => r.name === "client")?.cloned, false);
  await assert.rejects(repos.ensure("client"), /exited with/);
});
