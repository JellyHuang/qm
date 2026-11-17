import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { TestContext } from "node:test";
import { git, makeRepo, put, scratchDir, testSettings, type Fixture } from "./patch-package-fixture.ts";
import { buildPatchPackage, type PatchPackage, type PatchPackageInput } from "../../src/zq/patch-package/package.ts";

export const LFS_ATTRIBUTES = "*.xlsx filter=lfs diff=lfs merge=lfs -text\n";

const STUB = `#!/bin/sh
case $1 in
  version) echo "git-lfs/0.0-simulated"; exit 0 ;;
  clean)
    tmp=$(mktemp)
    cat > "$tmp"
    if head -c 40 "$tmp" | grep -q '^version https://git-lfs'; then
      cat "$tmp"
    else
      oid=$(sha256sum "$tmp" | cut -d' ' -f1)
      size=$(wc -c < "$tmp" | tr -d ' ')
      printf 'version https://git-lfs.github.com/spec/v1\\noid sha256:%s\\nsize %s\\n' "$oid" "$size"
    fi
    rm -f "$tmp"
    ;;
  smudge) cat ;;
  *) exit 0 ;;
esac
`;

export function installLfsStub(t: TestContext): string {
  const bin = scratchDir(t, "pp-bin-");
  writeFileSync(join(bin, "git-lfs"), STUB);
  chmodSync(join(bin, "git-lfs"), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  t.after(() => {
    process.env.PATH = before;
  });
  return bin;
}

export function enableLfsFilter(repo: string): void {
  git(repo, "config", "filter.lfs.clean", "git-lfs clean -- %f");
  git(repo, "config", "filter.lfs.smudge", "git-lfs smudge -- %f");
  git(repo, "config", "filter.lfs.required", "true");
}

export function makeLfsRepo(t: TestContext, files: Record<string, string | Buffer> = {}): Fixture {
  installLfsStub(t);
  const repo = scratchDir(t, "pp-lfsrepo-");
  git(repo, "init", "-q", "-b", "main");
  enableLfsFilter(repo);
  const all: Record<string, string | Buffer> = {
    ".gitattributes": LFS_ATTRIBUTES,
    "readme.txt": "one\ntwo\nthree\n",
    "tables/items.xlsx": Buffer.from("PK-base-items-workbook-bytes".repeat(40)),
    ...files,
  };
  for (const [path, content] of Object.entries(all)) put(repo, path, content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  for (const path of Object.keys(all)) rmSync(join(repo, path));
  git(repo, "checkout", "-q", "--", ".");
  return { repo, base: git(repo, "rev-parse", "HEAD") };
}

export interface ApplyResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  out: string;
  err: string;
}

export interface Applier {
  tmp: string;
  run(pkgDir: string, args: string[], over?: { env?: Record<string, string>; cwd?: string }): ApplyResult;
  start(pkgDir: string, args: string[]): ReturnType<typeof spawn>;
}

export function makeApplier(t: TestContext, shell = "sh"): Applier {
  const tmp = scratchDir(t, "pp-apptmp-");
  const env = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? "",
    HOME: "/nonexistent",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    TMPDIR: tmp,
    ...extra,
  });
  return {
    tmp,
    run(pkgDir, args, over = {}) {
      const r = spawnSync(shell, [join(pkgDir, "apply.sh"), ...args], {
        cwd: over.cwd ?? tmp,
        env: env(over.env),
        encoding: "utf8",
      });
      return { code: r.status, signal: r.signal, out: r.stdout, err: r.stderr };
    },
    start(pkgDir, args) {
      return spawn(shell, [join(pkgDir, "apply.sh"), ...args], {
        cwd: tmp,
        env: env(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
  };
}

export function makeClone(t: TestContext, source: string, options: { identity?: boolean; lfs?: boolean } = {}): string {
  const dest = join(scratchDir(t, "pp-clone-"), "clone");
  git(source, "rev-parse", "HEAD");
  const parent = join(dest, "..");
  mkdirSync(parent, { recursive: true });
  git(parent, "clone", "-q", source, dest);
  if (options.identity !== false) {
    git(dest, "config", "user.name", "Dana Local");
    git(dest, "config", "user.email", "dana@example.invalid");
  }
  if (options.lfs) enableLfsFilter(dest);
  return dest;
}

export function placePackage(pkgDir: string, into: string, name: string = basename(pkgDir)): string {
  const dest = join(into, name);
  cpSync(pkgDir, dest, { recursive: true });
  return dest;
}

export function snapshot(repo: string, tmp: string): string {
  return [
    git(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
    git(repo, "rev-parse", "HEAD"),
    git(repo, "status", "--porcelain=v1", "-uall"),
    git(repo, "worktree", "list"),
    git(repo, "ls-files", "-s"),
    git(repo, "stash", "list"),
    readdirSync(join(repo, ".git"))
      .filter((n) => /^(rebase|MERGE|CHERRY|REVERT|AUTO_MERGE)/.test(n))
      .join(","),
    readdirSync(tmp).join(","),
  ].join("\n---\n");
}

export async function buildFrom(
  t: TestContext,
  fixture: Fixture,
  over: Partial<PatchPackageInput> = {},
  settingsOver: Parameters<typeof testSettings>[1] = {},
  out: string = scratchDir(t, "pp-out-"),
): Promise<PatchPackage> {
  return buildPatchPackage(
    {
      repoDir: fixture.repo,
      baseCommit: fixture.base,
      ticket: "WP-123",
      subject: "Tune the thing",
      body: "Explain why.",
      change: { kind: "workingDir", dir: fixture.repo },
      ...over,
    },
    {
      settings: testSettings(out, settingsOver),
      commitDate: new Date("2026-01-02T03:04:05Z"),
      tmpRoot: scratchDir(t, "pp-tmp-"),
    },
  );
}

export function plainFixture(t: TestContext): Fixture {
  return makeRepo(t);
}
