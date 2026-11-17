import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { GIT_REPOS, type GitRepo } from "../../src/validate.ts";

export const ALICE = { name: "Alice A", email: "alice@example.test" };
export const BOB = { name: "Bob B", email: "bob@example.test" };
export const SECRET_MARKER = "SECRET-FILE-CONTENT-MARKER";
export const BIG_BYTES = 3 * 1024 * 1024;

export function makeRoot(prefix = "zqgit-test-"): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function git(cwd: string, args: string[], who = ALICE, date?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_AUTHOR_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email,
      GIT_COMMITTER_NAME: who.name,
      GIT_COMMITTER_EMAIL: who.email,
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  }).trim();
}

export interface Fixture {
  remoteBase: string;
  remotes: string;
  work: Record<GitRepo, string>;
  client: {
    first: string;
    second: string;
    third: string;
    featureTip: string;
    head: string;
    bigOid: string;
    readmeOid: string;
    renamedOid: string;
  };
}

export function commitAll(work: string, message: string, who = ALICE, date?: string): string {
  git(work, ["add", "-A"], who, date);
  git(work, ["commit", "-q", "-m", message], who, date);
  return git(work, ["rev-parse", "HEAD"]);
}

function seedRepo(root: string, name: GitRepo, remotes: string): string {
  const work = join(root, "work", name);
  mkdirSync(work, { recursive: true });
  git(work, ["init", "-q", "-b", GIT_REPOS[name]]);
  git(work, ["config", "uploadpack.allowFilter", "true"]);
  git(work, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  writeFileSync(join(work, "README.md"), `# ${name}\n`);
  commitAll(work, `init ${name}`, ALICE, "2024-01-01T10:00:00Z");
  const bare = join(remotes, `${name}.git`);
  git(root, ["clone", "-q", "--bare", work, bare]);
  git(bare, ["config", "uploadpack.allowFilter", "true"]);
  git(bare, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  git(work, ["remote", "add", "origin", bare]);
  return work;
}

export function pushAll(work: string): void {
  git(work, ["push", "-q", "origin", "--all", "--force"]);
}

export function buildFixture(root: string): Fixture {
  const remotes = join(root, "remotes");
  mkdirSync(remotes, { recursive: true });
  const work = Object.fromEntries(
    (Object.keys(GIT_REPOS) as GitRepo[]).map((name) => [name, seedRepo(root, name, remotes)]),
  ) as Record<GitRepo, string>;
  const dir = work.client;
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "数据"));
  mkdirSync(join(dir, "dir"));
  writeFileSync(join(dir, "src", "a.txt"), `line one ${SECRET_MARKER}\nline two\n`);
  writeFileSync(join(dir, "数据", "配置.txt"), "配置内容\n");
  writeFileSync(join(dir, "dir", "café.txt"), "café\n");
  writeFileSync(join(dir, "big.bin"), randomBytes(BIG_BYTES));
  const first = commitAll(dir, "add sources\n\nbody of the first commit", ALICE, "2024-02-01T10:00:00Z");
  git(dir, ["mv", "src/a.txt", "src/b.txt"], BOB);
  writeFileSync(join(dir, "README.md"), "# client\nchanged\n");
  writeFileSync(join(dir, "empty1"), "");
  writeFileSync(join(dir, "empty2"), "");
  const second = commitAll(dir, "rename a to b and add empties", BOB, "2024-03-01T10:00:00Z");
  git(dir, ["rm", "-q", "empty1"], BOB);
  writeFileSync(join(dir, "empty3"), "");
  writeFileSync(join(dir, "dir", "café.txt"), "café updated\n");
  const third = commitAll(dir, "touch empties and update cafe", BOB, "2024-04-01T10:00:00Z");
  git(dir, ["checkout", "-q", "-b", "feature/login"]);
  writeFileSync(join(dir, "login.txt"), "login\n");
  const featureTip = commitAll(dir, "add login", BOB, "2024-05-01T10:00:00Z");
  git(dir, ["checkout", "-q", "main"]);
  for (const name of Object.keys(GIT_REPOS) as GitRepo[]) pushAll(work[name]);
  return {
    remoteBase: `file://${remotes}/`,
    remotes,
    work,
    client: {
      first,
      second,
      third,
      featureTip,
      head: third,
      bigOid: git(dir, ["rev-parse", `${first}:big.bin`]),
      readmeOid: git(dir, ["rev-parse", `${second}:README.md`]),
      renamedOid: git(dir, ["rev-parse", `${first}:src/a.txt`]),
    },
  };
}
