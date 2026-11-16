import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitAuditRow } from "../src/zq/git/audit.ts";
import { createGitRunner } from "../src/zq/git/runner.ts";
import { GIT_REPOS } from "../src/zq/git/validate.ts";
import {
  parseVerifyEnv,
  runVerify,
  summarizeAudit,
  ZQ_DEFAULT_BRANCHES,
  ZQ_REMOTES,
} from "../scripts/zq-git-verify.ts";

const root = mkdtempSync(join(tmpdir(), "qm-git-verify-"));
after(() => rmSync(root, { recursive: true, force: true }));
const BODY = "FILE-BODY-MARKER";
const EMAIL = "a@example.test";

function fixture(name: string, branch: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        GIT_AUTHOR_NAME: "A",
        GIT_AUTHOR_EMAIL: EMAIL,
        GIT_COMMITTER_NAME: "A",
        GIT_COMMITTER_EMAIL: EMAIL,
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  run(["init", "-q", "-b", branch]);
  writeFileSync(join(dir, "notes.txt"), `${BODY}\nsecond\n`);
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "first"]);
  writeFileSync(join(dir, "notes.txt"), `${BODY}\nsecond\nthird\n`);
  run(["commit", "-q", "-a", "-m", "subject-marker"]);
  return dir;
}

test("parseVerifyEnv applies defaults and rejects a missing key and unknown repositories", () => {
  assert.deepEqual(parseVerifyEnv({ ZQ_GIT_KEY_FILE: "/k" }), {
    keyFile: "/k",
    dir: "/tmp/zq-git-verify",
    repos: ["gameconfig", "CommonMessage", "jenkinstasks"],
  });
  assert.deepEqual(parseVerifyEnv({ ZQ_GIT_KEY_FILE: "/k", ZQ_GIT_DIR: "/d", ZQ_GIT_VERIFY_REPOS: "server, client" }), {
    keyFile: "/k",
    dir: "/d",
    repos: ["server", "client"],
  });
  assert.throws(() => parseVerifyEnv({}), /ZQ_GIT_KEY_FILE/);
  assert.throws(() => parseVerifyEnv({ ZQ_GIT_KEY_FILE: "/k", ZQ_GIT_VERIFY_REPOS: "qm-test" }), /qm-test/);
});

test("the real remotes cover exactly the seven repositories and jenkinstasks defaults to master", () => {
  assert.deepEqual(Object.keys(ZQ_REMOTES).sort(), [...GIT_REPOS].sort());
  assert.equal(ZQ_REMOTES.server, "git@lab.skyunion.net:ca-programmer-zq/server.git");
  assert.equal(ZQ_DEFAULT_BRANCHES.jenkinstasks, "master");
  assert.equal(ZQ_DEFAULT_BRANCHES.client, "main");
});

test("summarizeAudit counts by result and tool and flags rows carrying extra fields", () => {
  const row = (tool: string, result: GitAuditRow["result"]): GitAuditRow => ({
    at: 1,
    principal: "verify",
    tool,
    bytes: 1,
    truncated: false,
    result,
    ms: 1,
  });
  const rows = [row("git_diff", "ok"), row("git_diff", "ok"), row("git_blame", "denied:bad_path")];
  assert.deepEqual(summarizeAudit(rows), {
    total: 3,
    byResult: { ok: 2, "denied:bad_path": 1 },
    byTool: { git_diff: 2, git_blame: 1 },
    contentFree: true,
  });
  assert.equal(summarizeAudit([{ ...row("git_diff", "ok"), content: "x" } as GitAuditRow]).contentFree, false);
});

test("runVerify against local fixtures passes, prints no content and refuses the outsider without git", async () => {
  const main = fixture("main-src", "main");
  const master = fixture("master-src", "master");
  const remotes = Object.fromEntries(GIT_REPOS.map((r) => [r, r === "jenkinstasks" ? master : main]));
  const lines: string[] = [];
  const report = await runVerify({
    remotes,
    defaults: ZQ_DEFAULT_BRANCHES,
    dir: join(root, "clones"),
    repos: ["gameconfig", "CommonMessage", "jenkinstasks"],
    runner: createGitRunner(),
    log: (line) => lines.push(line),
  });
  const out = lines.join("\n");
  assert.deepEqual(report.failures, [], out);
  assert.match(out, /jenkinstasks: branches=1 default=master/);
  assert.match(out, /gameconfig fileAt: ok bytes=\d+ truncated=false/);
  assert.match(out, /CommonMessage blame: ok/);
  assert.match(out, /qm-test: denied:repo_not_allowed audit=denied:repo_not_allowed git processes=0/);
  assert.equal(report.summary.contentFree, true);
  assert.equal(report.summary.byResult["denied:repo_not_allowed"], 1);
  for (const leaked of [BODY, EMAIL, "subject-marker", "third"]) assert.ok(!out.includes(leaked), leaked);
});

test("runVerify fails when the remote default branch is not the expected one", async () => {
  const wrong = fixture("wrong-src", "trunk");
  const lines: string[] = [];
  const report = await runVerify({
    remotes: Object.fromEntries(GIT_REPOS.map((r) => [r, wrong])),
    defaults: ZQ_DEFAULT_BRANCHES,
    dir: join(root, "clones-wrong"),
    repos: [],
    runner: createGitRunner(),
    log: (line) => lines.push(line),
  });
  assert.ok(report.failures.includes("default branch of server"));
  assert.match(lines.join("\n"), /gameconfig: skipped, not fetched/);
});
