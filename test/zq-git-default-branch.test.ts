import { tenantTest as test } from "./support/tenant-test.ts";
import { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitAudit, type GitAuditRow } from "../src/zq/git/audit.ts";
import { DEFAULT_GIT_LIMITS, createGitLimits } from "../src/zq/git/limits.ts";
import { createGitRunner } from "../src/zq/git/runner.ts";
import { createGitReadonly } from "../src/zq/git/readonly.ts";
import { testMap } from "./support/test-database.ts";

const root = mkdtempSync(join(tmpdir(), "qm-git-default-"));
after(() => rmSync(root, { recursive: true, force: true }));

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

function sourceRepo(branch: string): string {
  const dir = join(root, `src-${branch}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", branch]);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  git(dir, ["checkout", "-q", "-b", "other"]);
  writeFileSync(join(dir, "b.txt"), "b\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "other"]);
  git(dir, ["checkout", "-q", branch]);
  return dir;
}

for (const branch of ["master", "main"]) {
  test(`first fetch into an empty directory points HEAD at the remote default branch ${branch}`, async () => {
    const remote = sourceRepo(branch);
    const now = () => Date.now();
    const audit = createGitAudit({ map: testMap<GitAuditRow>(), now });
    const limits = createGitLimits({ config: DEFAULT_GIT_LIMITS, bytesSince: audit.bytesSince, now });
    const dir = join(root, `clones-${branch}`);
    const readonly = createGitReadonly({
      config: { dir, remotes: { server: remote } },
      runner: createGitRunner(),
      audit,
      limits,
      now,
    });
    await readonly.fetchRepo("server");
    assert.equal(git(root, [`--git-dir=${dir}/server.git`, "symbolic-ref", "HEAD"]), `refs/heads/${branch}`);
    const recent = await readonly.recentCommits("p", "server");
    assert.equal(recent.commits.length, 1);
    assert.equal(recent.commits[0]?.subject, "init");
    const branches = await readonly.branches("p", "server");
    assert.deepEqual(branches.branches.map((b) => b.name).sort(), [branch, "other"].sort());
    await readonly.fetchRepo("server");
    assert.equal(git(root, [`--git-dir=${dir}/server.git`, "symbolic-ref", "HEAD"]), `refs/heads/${branch}`);
  });
}
