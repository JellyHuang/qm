import assert from "node:assert/strict";
import { createWriteStream, readFileSync } from "node:fs";
import { after, test } from "node:test";
import { join } from "node:path";
import { createGitRunner } from "../src/runner.ts";
import { fakeGit } from "./support/fake-git.ts";
import { BIG_BYTES, buildFixture, makeRoot } from "./support/fixtures.ts";

const { root, cleanup } = makeRoot("zqgit-runner-");
const sleepers: number[] = [];
let counter = 0;
after(() => {
  for (const pid of sleepers)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
  cleanup();
});

function stuckGit(tail: string, detach = ""): { bin: string; pidFile: string } {
  const pidFile = join(root, `pid-${counter++}`);
  return { bin: fakeGit(root, `${detach} sleep 30 &\necho $! > ${pidFile}\n${tail}`), pidFile };
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

test("a git over its output cap is killed with every child it started and reports the cut", async () => {
  const { bin, pidFile } = stuckGit("head -c 100000 /dev/zero\nsleep 30");
  const out = await createGitRunner({ gitBinary: bin, maxBytes: 1000, timeoutMs: 20_000 }).run(root, ["status"]);
  assert.equal(out.truncated, true);
  assert.equal(out.stdout.length, 1000);
  assert.ok(out.cutBytes > 0);
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

test("an aborted run kills the process group and rejects with the abort reason", async () => {
  const { bin, pidFile } = stuckGit("sleep 30");
  const controller = new AbortController();
  const run = createGitRunner({ gitBinary: bin, timeoutMs: 20_000 }).run(root, ["status"], {
    signal: controller.signal,
  });
  await new Promise((r) => setTimeout(r, 200));
  controller.abort(new Error("disk space low"));
  await assert.rejects(run, /disk space low/);
  assert.equal(await gone(sleeperPid(pidFile)), true);
  await assert.rejects(
    createGitRunner().run(root, ["--version"], { signal: AbortSignal.abort(new Error("already aborted")) }),
    /already aborted/,
  );
});

test("the environment is clean and the lazy fetch guard is on except for remote runs", async () => {
  const dump = join(root, "env-dump");
  const bin = fakeGit(root, `env > ${dump}`);
  process.env.SECRET_TOKEN = "leak-me";
  process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
  process.env.GIT_DIR = "/tmp/other";
  process.env.HOME = "/tmp/home-leak";
  try {
    const runner = createGitRunner({ gitBinary: bin, sshCommand: "ssh -i /k" });
    await runner.run(root, ["status"]);
    const local = Object.fromEntries(
      readFileSync(dump, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    for (const leaked of ["SECRET_TOKEN", "SSH_AUTH_SOCK", "GIT_DIR", "HOME", "GIT_SSH_COMMAND"])
      assert.equal(leaked in local, false, leaked);
    assert.equal(local.GIT_NO_LAZY_FETCH, "1");
    assert.equal(local.GIT_TERMINAL_PROMPT, "0");
    assert.equal(local.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(local.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(local.GIT_LITERAL_PATHSPECS, "1");
    await runner.run(root, ["fetch"], { remote: true });
    const remote = readFileSync(dump, "utf8");
    assert.match(remote, /^GIT_SSH_COMMAND=ssh -i \/k$/m);
    assert.doesNotMatch(remote, /GIT_NO_LAZY_FETCH/);
  } finally {
    delete process.env.SECRET_TOKEN;
    delete process.env.SSH_AUTH_SOCK;
    delete process.env.GIT_DIR;
  }
});

test("git runs with quoted paths off and no shell", async () => {
  const runner = createGitRunner();
  const fx = buildFixture(join(root, "fx"));
  const bare = join(fx.remotes, "client.git");
  const out = await runner.run(bare, ["ls-tree", "-z", "--name-only", "-r", "main"]);
  assert.ok(out.stdout.toString("utf8").split("\0").includes("数据/配置.txt"));
  const quote = await runner.run(bare, ["config", "--get", "core.quotepath"]);
  assert.equal(quote.stdout.toString().trim(), "false");
  await assert.rejects(runner.run(bare, ["rev-parse", "HEAD; touch /tmp/zqgit-shell"]), /exited with/);
});

test("output can be streamed to a sink without being held in memory", async () => {
  const fx = buildFixture(join(root, "fx-sink"));
  const bare = join(fx.remotes, "client.git");
  const target = join(root, "streamed.bin");
  const runner = createGitRunner({ maxBytes: 10 });
  const out = await runner.run(bare, ["cat-file", "blob", fx.client.bigOid], { sink: createWriteStream(target) });
  assert.equal(out.bytes, BIG_BYTES);
  assert.equal(out.stdout.length, 0);
  assert.equal(out.truncated, false);
  assert.equal(readFileSync(target).length, BIG_BYTES);
});

test("a failing command keeps its stderr message and stdin input is delivered", async () => {
  const runner = createGitRunner();
  await assert.rejects(runner.run(root, ["cat-file", "-p", "0".repeat(40)]), /exited with \d+/);
  const fx = buildFixture(join(root, "fx-input"));
  const out = await runner.run(join(fx.remotes, "client.git"), ["cat-file", "--batch-check"], {
    input: `${fx.client.readmeOid}\n`,
  });
  assert.match(out.stdout.toString(), new RegExp(`${fx.client.readmeOid} blob \\d+`));
});

test("the child PATH is the configured one", async () => {
  const dump = join(root, "path-dump");
  const bin = fakeGit(root, `printf '%s' "$PATH" > ${dump}`);
  await createGitRunner({ gitBinary: bin, path: "/opt/git247/bin:/usr/bin" }).run(root, ["status"]);
  assert.equal(readFileSync(dump, "utf8"), "/opt/git247/bin:/usr/bin");
  await createGitRunner({ gitBinary: bin }).run(root, ["status"]);
  assert.equal(readFileSync(dump, "utf8"), "/usr/local/bin:/usr/bin:/bin");
});
