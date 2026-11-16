import { tenantTest as test } from "./support/tenant-test.ts";
import { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitAudit, type GitAuditRow } from "../src/zq/git/audit.ts";
import { DEFAULT_GIT_LIMITS, createGitLimits } from "../src/zq/git/limits.ts";
import { GIT_FETCH_TIMEOUT_MS, createGitRunner } from "../src/zq/git/runner.ts";
import { createGitReadonly } from "../src/zq/git/readonly.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { testMap } from "./support/test-database.ts";

const root = mkdtempSync(join(tmpdir(), "qm-git-runner-"));
const sleepers: number[] = [];
after(() => {
  for (const pid of sleepers)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
  rmSync(root, { recursive: true, force: true });
});

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
let counter = 0;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      GIT_AUTHOR_NAME: "A",
      GIT_AUTHOR_EMAIL: "a@example.test",
      GIT_COMMITTER_NAME: "A",
      GIT_COMMITTER_EMAIL: "a@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
}

function fakeGit(body: string): string {
  const file = join(root, `fake-${counter++}.sh`);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function stuckGit(tail: string, detach = ""): { bin: string; pidFile: string } {
  const pidFile = join(root, `pid-${counter++}`);
  const bin = fakeGit(`${detach} sleep 30 &\necho $! > ${pidFile}\n${tail}`);
  return { bin, pidFile };
}

function sleeperPid(pidFile: string): number {
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  sleepers.push(pid);
  return pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test("a timed out git is killed with every child it started and the call rejects promptly", async () => {
  const { bin, pidFile } = stuckGit("sleep 30");
  const started = Date.now();
  await assert.rejects(
    createGitRunner({ gitBinary: bin, timeoutMs: 500 }).run(root, ["status"]),
    /timed out after 500 ms/,
  );
  assert.ok(Date.now() - started < 5000);
  assert.equal(await gone(sleeperPid(pidFile)), true);
});

test("a git over its output cap is killed with every child it started", async () => {
  const { bin, pidFile } = stuckGit("head -c 100000 /dev/zero\nsleep 30");
  const started = Date.now();
  const out = await createGitRunner({ gitBinary: bin, maxBytes: 1000, timeoutMs: 20_000 }).run(root, ["status"]);
  assert.equal(out.truncated, true);
  assert.equal(out.stdout.length, 1000);
  assert.ok(Date.now() - started < 5000);
  assert.equal(await gone(sleeperPid(pidFile)), true);
});

test("a child that escaped the process group cannot keep the caller waiting", async () => {
  const { bin, pidFile } = stuckGit("sleep 30", "setsid");
  const started = Date.now();
  await assert.rejects(
    createGitRunner({ gitBinary: bin, timeoutMs: 300, killGraceMs: 300 }).run(root, ["status"]),
    /timed out/,
  );
  sleeperPid(pidFile);
  assert.ok(Date.now() - started < 5000);
});

test("a normal fast command still returns its output and failures keep their message", async () => {
  const runner = createGitRunner();
  const out = await runner.run(root, ["--version"]);
  assert.match(out.stdout.toString(), /git version/);
  await assert.rejects(runner.run(root, ["cat-file", "-p", "0".repeat(40)]), /exited with \d+/);
});

test("a per call timeout overrides the runner default", async () => {
  const { bin, pidFile } = stuckGit("sleep 30");
  const runner = createGitRunner({ gitBinary: bin, timeoutMs: 60_000 });
  await assert.rejects(runner.run(root, ["status"], { timeoutMs: 300 }), /timed out after 300 ms/);
  assert.equal(await gone(sleeperPid(pidFile)), true);
});

function sourceRepo(): string {
  const dir = join(root, `src-${counter++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "uploadpack.allowFilter", "true"]);
  git(dir, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  writeFileSync(join(dir, "a.txt"), "FILE-CONTENT\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "first"]);
  return dir;
}

function readonlyOver(
  remote: string,
  runner: ReturnType<typeof createGitRunner>,
  fetchTimeoutMs?: number,
  dir = join(root, `clones-${counter++}`),
) {
  const now = () => Date.now();
  const audit = createGitAudit({ map: testMap<GitAuditRow>(), now });
  const limits = createGitLimits({ config: DEFAULT_GIT_LIMITS, bytesSince: audit.bytesSince, now });
  return createGitReadonly({
    config: {
      dir,
      remotes: { server: remote },
      ...(fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs }),
    },
    runner,
    audit,
    limits,
    now,
  });
}

function slowFetchGit(delaySeconds: number): string {
  return fakeGit(`case "$2" in fetch) sleep ${delaySeconds};; esac\nexec ${REAL_GIT} "$@"`);
}

test("a fetch runs under the fetch timeout, not the read timeout", async () => {
  const remote = sourceRepo();
  const runner = createGitRunner({ gitBinary: slowFetchGit(2), timeoutMs: 1000 });
  const readonly = readonlyOver(remote, runner, 20_000);
  await readonly.fetchRepo("server");
  assert.equal((await readonly.recentCommits("p", "server")).commits[0]?.subject, "first");
});

test("a fetch past the fetch timeout is killed and reported", async () => {
  const remote = sourceRepo();
  const runner = createGitRunner({ gitBinary: slowFetchGit(30), timeoutMs: 20_000 });
  const readonly = readonlyOver(remote, runner, 400);
  const started = Date.now();
  await assert.rejects(readonly.fetchRepo("server"), /timed out after 400 ms/);
  assert.ok(Date.now() - started < 8000);
});

test("the fetch timeout defaults to 30 minutes, is configurable and is validated", () => {
  assert.equal(zqConfigFromEnv({}).git.fetchTimeoutMs, GIT_FETCH_TIMEOUT_MS);
  assert.equal(GIT_FETCH_TIMEOUT_MS, 30 * 60_000);
  assert.equal(zqConfigFromEnv({ ZQ_GIT_FETCH_TIMEOUT_MS: "90000" }).git.fetchTimeoutMs, 90_000);
  for (const bad of ["0", "999", "-1", "1.5", "soon", "86400001"])
    assert.throws(() => zqConfigFromEnv({ ZQ_GIT_FETCH_TIMEOUT_MS: bad }), /ZQ_GIT_FETCH_TIMEOUT_MS/);
});

test("a blob:none fetch keeps commits and trees but not file contents, and reads fail cleanly", async () => {
  const remote = sourceRepo();
  const dir = join(root, `clones-${counter++}`);
  const runner = createGitRunner({ timeoutMs: 10_000 });
  const readonly = readonlyOver(remote, runner, undefined, dir);
  await readonly.fetchRepo("server", { filter: "blob:none" });
  const bare = join(dir, "server.git");
  assert.equal((await runner.run(bare, ["rev-list", "--count", "main"])).stdout.toString().trim(), "1");
  assert.match((await runner.run(bare, ["ls-tree", "main"])).stdout.toString(), /a\.txt/);
  const started = Date.now();
  await assert.rejects(readonly.fileAt("p", "server", "main", "a.txt"), /exited with 128|not_found|missing/i);
  await assert.rejects(readonly.recentCommits("p", "server"), /exited with 128/);
  assert.ok(Date.now() - started < 8000);
});

test("only blob:none is accepted as a fetch filter", async () => {
  const readonly = readonlyOver(sourceRepo(), createGitRunner());
  for (const bad of ["tree:0", "blob:limit=1", "--upload-pack=x", ""])
    await assert.rejects(readonly.fetchRepo("server", { filter: bad }), /bad_filter/);
});
