import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import type { PatchPackageSettings } from "../../src/zq/patch-package/settings.ts";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: "/nonexistent",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Dev",
      GIT_AUTHOR_EMAIL: "dev@example.test",
      GIT_COMMITTER_NAME: "Dev",
      GIT_COMMITTER_EMAIL: "dev@example.test",
    },
  }).trim();
}

export function scratchDir(t: TestContext, prefix = "pp-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function put(root: string, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export const BASE_FILES: Record<string, string | Buffer> = {
  "readme.txt": "one\ntwo\nthree\n",
  "crlf.txt": "alpha\r\nbeta\r\ngamma\r\n",
  "blob.bin": Buffer.from([0, 1, 2, 3, 255, 254, 0, 9, 8, 7]),
  "tool.sh": "#!/bin/sh\necho hi\n",
  "old-name.txt": "a stable body that is long enough to be a rename\nsecond line\nthird line\nfourth line\n",
  "gone.txt": "to be deleted\n",
  "日本/文件.txt": "こんにちは\n",
};

export interface Fixture {
  repo: string;
  base: string;
}

export function makeRepo(t: TestContext, files: Record<string, string | Buffer> = BASE_FILES): Fixture {
  const repo = scratchDir(t, "pp-repo-");
  git(repo, "init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) put(repo, path, content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return { repo, base: git(repo, "rev-parse", "HEAD") };
}

export function testSettings(outputDir: string, overrides: Partial<PatchPackageSettings> = {}): PatchPackageSettings {
  return {
    ticketPattern: "^(WP-)?[0-9]{1,9}$",
    authorName: "QM Bot",
    authorEmail: "qm-bot@invalid",
    outputDir,
    subjectMax: 72,
    bodyMax: 5000,
    ...overrides,
  };
}
