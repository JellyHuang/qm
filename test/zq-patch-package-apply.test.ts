import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { git, makeRepo, put, scratchDir } from "./support/patch-package-fixture.ts";
import { buildFrom, makeApplier, makeClone, snapshot } from "./support/patch-package-apply.ts";

async function textPackage(t: TestContext, mutate?: (repo: string) => void) {
  const fixture = makeRepo(t);
  (mutate ?? ((repo) => put(repo, "readme.txt", "one\nTWO\nthree\nfour\n")))(fixture.repo);
  const pkg = await buildFrom(t, fixture);
  git(fixture.repo, "checkout", "-q", "--", ".");
  git(fixture.repo, "clean", "-fdq");
  return { fixture, pkg };
}

function expectCode(result: { code: number | null; out: string; err: string }, code: number, pattern?: RegExp) {
  assert.equal(result.code, code, `${result.out}\n${result.err}`);
  if (pattern) assert.match(result.out + result.err, pattern);
}

test("the default applies one commit on the current branch, authored and committed by the applier", async (t) => {
  const { fixture, pkg } = await textPackage(t);
  const clone = makeClone(t, fixture.repo);
  put(clone, "mine.txt", "untracked and unrelated\n");
  const app = makeApplier(t);
  const before = git(clone, "rev-parse", "HEAD");
  const result = app.run(pkg.dir, ["--repo", clone]);
  expectCode(result, 0);
  assert.equal(git(clone, "rev-list", "--count", `${before}..HEAD`), "1");
  assert.equal(git(clone, "rev-parse", "HEAD~1"), before);
  assert.equal(git(clone, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(git(clone, "log", "-1", "--format=%an <%ae>"), "Dana Local <dana@example.invalid>");
  assert.equal(git(clone, "log", "-1", "--format=%cn <%ce>"), "Dana Local <dana@example.invalid>");
  assert.equal(
    git(clone, "log", "-1", "--format=%B"),
    "Tune the thing\n\nExplain why.\n\nTicket: WP-123\nAI-Generated: true",
  );
  assert.equal(readFileSync(join(clone, "readme.txt"), "utf8"), "one\nTWO\nthree\nfour\n");
  assert.match(result.out, new RegExp(`original HEAD: ${before}`));
  assert.match(result.out, new RegExp(`git reset --keep ${before}`));
  assert.ok(!/--hard/.test(result.out + result.err));
  assert.deepEqual(readdirSync(app.tmp), []);
  assert.equal(git(clone, "for-each-ref", "refs/qm"), "");
  assert.equal(git(clone, "worktree", "list").split("\n").length, 1);

  git(clone, "reset", "-q", "--keep", before);
  assert.equal(git(clone, "rev-parse", "HEAD"), before);
  assert.equal(git(clone, "status", "--porcelain=v1", "-uall"), "?? mine.txt");
  assert.equal(readFileSync(join(clone, "mine.txt"), "utf8"), "untracked and unrelated\n");
  assert.equal(readFileSync(join(clone, "readme.txt"), "utf8"), "one\ntwo\nthree\n");
});

test("--keep-bot-author keeps the package author and the applier stays the committer", async (t) => {
  const { fixture, pkg } = await textPackage(t);
  const clone = makeClone(t, fixture.repo);
  expectCode(makeApplier(t).run(pkg.dir, ["--repo", clone, "--keep-bot-author"]), 0);
  assert.equal(git(clone, "log", "-1", "--format=%an <%ae>"), "QM Bot <qm-bot@invalid>");
  assert.equal(git(clone, "log", "-1", "--format=%cn <%ce>"), "Dana Local <dana@example.invalid>");
});

test("--dry-run applies, shows the result and leaves nothing behind in either mode", async (t) => {
  const { fixture, pkg } = await textPackage(t);
  const clone = makeClone(t, fixture.repo);
  const app = makeApplier(t);
  const before = snapshot(clone, app.tmp);
  for (const extra of [[], ["--new-branch"]]) {
    const result = app.run(pkg.dir, ["--repo", clone, "--dry-run", ...extra]);
    expectCode(result, 0, /dry run finished/);
    assert.match(result.out, /Tune the thing/);
    assert.equal(snapshot(clone, app.tmp), before);
  }
});

test("--new-branch builds qm/<id> from the base commit and does not touch the current branch", async (t) => {
  const { fixture, pkg } = await textPackage(t);
  const clone = makeClone(t, fixture.repo);
  git(clone, "switch", "-q", "-c", "feature/mine");
  put(clone, "mine.txt", "work\n");
  git(clone, "add", "mine.txt");
  git(clone, "commit", "-q", "-m", "my work");
  put(clone, "untracked.txt", "keep me\n");
  const head = git(clone, "rev-parse", "HEAD");
  const app = makeApplier(t);
  const result = app.run(pkg.dir, ["--repo", clone, "--new-branch"]);
  expectCode(result, 0);
  const branch = `qm/${pkg.id}`;
  assert.equal(git(clone, "rev-parse", "HEAD"), head);
  assert.equal(git(clone, "symbolic-ref", "--short", "HEAD"), "feature/mine");
  assert.equal(git(clone, "rev-parse", `${branch}~1`), fixture.base);
  assert.equal(git(clone, "rev-list", "--count", `${fixture.base}..${branch}`), "1");
  assert.equal(git(clone, "log", "-1", "--format=%an <%ae>", branch), "Dana Local <dana@example.invalid>");
  assert.equal(readFileSync(join(clone, "untracked.txt"), "utf8"), "keep me\n");
  assert.equal(readFileSync(join(clone, "readme.txt"), "utf8"), "one\ntwo\nthree\n");
  assert.equal(git(clone, "worktree", "list").split("\n").length, 1);
  assert.deepEqual(readdirSync(app.tmp), []);
  expectCode(app.run(pkg.dir, ["--repo", clone, "--new-branch"]), 4, /already exists/);
});

test("refusals leave the repository exactly as it was", async (t) => {
  const { fixture, pkg } = await textPackage(t);
  const app = makeApplier(t);
  const refuse = (name: string, clone: string, args: string[], code: number, pattern: RegExp, pkgDir = pkg.dir) => {
    const before = snapshot(clone, app.tmp);
    const result = app.run(pkgDir, ["--repo", clone, ...args]);
    expectCode(result, code, pattern);
    assert.equal(snapshot(clone, app.tmp), before, name);
  };

  const dirty = makeClone(t, fixture.repo);
  put(dirty, "readme.txt", "edited locally\n");
  refuse("dirty tree", dirty, [], 4, /uncommitted changes/);

  const staged = makeClone(t, fixture.repo);
  put(staged, "gone.txt", "edited\n");
  git(staged, "add", "gone.txt");
  refuse("staged", staged, [], 4, /uncommitted changes/);

  const anonymous = makeClone(t, fixture.repo, { identity: false });
  refuse("no identity", anonymous, [], 4, /does not know who you are/);
  git(anonymous, "config", "user.name", "Only Name");
  refuse("no email", anonymous, [], 4, /does not know who you are/);

  const detached = makeClone(t, fixture.repo);
  git(detached, "checkout", "-q", "--detach");
  refuse("detached", detached, [], 4, /detached HEAD.*--new-branch/);
  expectCode(app.run(pkg.dir, ["--repo", detached, "--dry-run", "--new-branch"]), 0);

  const unrelated = scratchDir(t, "pp-unrel-");
  git(unrelated, "init", "-q", "-b", "main");
  git(unrelated, "config", "user.name", "Dana Local");
  git(unrelated, "config", "user.email", "dana@example.invalid");
  put(unrelated, "a", "a");
  git(unrelated, "add", "a");
  git(unrelated, "commit", "-q", "-m", "a");
  refuse("missing base", unrelated, [], 4, /base commit .* is not in this repository/);

  const merging = makeClone(t, fixture.repo);
  mkdirSync(join(merging, ".git", "rebase-apply"));
  refuse("operation in progress", merging, [], 4, /operation is in progress/);

  expectCode(app.run(pkg.dir, ["--repo", scratchDir(t, "pp-notrepo-")]), 4, /not a git repository/);
  expectCode(app.run(pkg.dir, ["--bogus"]), 2);
  expectCode(app.run(pkg.dir, ["--repo"]), 2);
  expectCode(app.run(pkg.dir, ["--help"]), 0, /--new-branch/);
  assert.ok(!/--reset-author/.test(app.run(pkg.dir, ["--help"]).out));
});

test("a conflict and a refusing hook roll everything back to the original HEAD", async (t) => {
  const { fixture, pkg } = await textPackage(t);
  const app = makeApplier(t);

  const conflict = makeClone(t, fixture.repo);
  put(conflict, "readme.txt", "one\nTWO-LOCAL\nthree\n");
  git(conflict, "commit", "-q", "-am", "local edit of the same line");
  let before = snapshot(conflict, app.tmp);
  let result = app.run(pkg.dir, ["--repo", conflict]);
  expectCode(result, 5, /does not apply/);
  assert.match(result.out, /rolled back/);
  assert.equal(snapshot(conflict, app.tmp), before);

  const hooked = makeClone(t, fixture.repo);
  const hook = join(hooked, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho refused-by-hook >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  before = snapshot(hooked, app.tmp);
  result = app.run(pkg.dir, ["--repo", hooked]);
  expectCode(result, 5, /refused/);
  assert.match(result.err, /refused-by-hook/);
  assert.equal(snapshot(hooked, app.tmp), before);
  assert.equal(readFileSync(join(hooked, "readme.txt"), "utf8"), "one\ntwo\nthree\n");
  assert.equal(git(hooked, "for-each-ref", "refs/qm"), "");

  const branchHooked = makeClone(t, fixture.repo);
  const branchHook = join(branchHooked, ".git", "hooks", "pre-commit");
  writeFileSync(branchHook, "#!/bin/sh\nexit 1\n");
  chmodSync(branchHook, 0o755);
  before = snapshot(branchHooked, app.tmp);
  expectCode(app.run(pkg.dir, ["--repo", branchHooked, "--new-branch"]), 5);
  assert.equal(snapshot(branchHooked, app.tmp), before);
});

test("an interrupt while the commit hook runs rolls everything back and exits 130", async (t) => {
  const { fixture, pkg } = await textPackage(t);
  const clone = makeClone(t, fixture.repo);
  const marker = join(scratchDir(t, "pp-mark-"), "started");
  const hook = join(clone, ".git", "hooks", "pre-commit");
  writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\nsleep 2\n`);
  chmodSync(hook, 0o755);
  const app = makeApplier(t);
  const before = snapshot(clone, app.tmp);
  const child = app.start(pkg.dir, ["--repo", clone]);
  let out = "";
  child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  const done = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(marker), "the hook never started");
  child.kill("SIGTERM");
  assert.equal(await done, 130);
  assert.match(out, /rolled back/);
  assert.equal(snapshot(clone, app.tmp), before);
});

test("upstream rules: behind is refused, equal or ahead proceeds, no upstream proceeds with a note", async (t) => {
  const { fixture, pkg } = await textPackage(t);
  const remote = join(scratchDir(t, "pp-remote-"), "remote.git");
  git(dirname(remote), "clone", "-q", "--bare", fixture.repo, remote);
  const app = makeApplier(t);
  const track = () => {
    const clone = makeClone(t, remote);
    return clone;
  };

  const equal = track();
  let result = app.run(pkg.dir, ["--repo", equal, "--dry-run"]);
  expectCode(result, 0, /nothing to pull from origin\/main/);

  const ahead = track();
  put(ahead, "extra.txt", "x\n");
  git(ahead, "add", "extra.txt");
  git(ahead, "commit", "-q", "-m", "ahead");
  expectCode(app.run(pkg.dir, ["--repo", ahead, "--dry-run"]), 0, /nothing to pull/);

  const other = track();
  put(other, "newer.txt", "y\n");
  git(other, "add", "newer.txt");
  git(other, "commit", "-q", "-m", "newer upstream commit");
  git(other, "push", "-q", "origin", "main");
  const behind = track();
  git(behind, "reset", "-q", "--keep", "HEAD~1");
  const before = snapshot(behind, app.tmp);
  result = app.run(pkg.dir, ["--repo", behind]);
  expectCode(result, 4, /1 commit\(s\) behind origin\/main.*last fetch.*pull first/);
  assert.equal(snapshot(behind, app.tmp), before);

  const lonely = makeClone(t, fixture.repo);
  git(lonely, "remote", "remove", "origin");
  result = app.run(pkg.dir, ["--repo", lonely, "--dry-run"]);
  expectCode(result, 0, /no upstream/);
});

test("a HEAD that does not contain the base commit still applies through the three-way merge, with a note", async (t) => {
  const { fixture, pkg } = await textPackage(t);
  const clone = makeClone(t, fixture.repo);
  git(clone, "switch", "-q", "--orphan", "side");
  git(clone, "rm", "-rfq", "--ignore-unmatch", ".");
  put(clone, "readme.txt", "one\ntwo\nthree\n");
  git(clone, "add", "readme.txt");
  git(clone, "commit", "-q", "-m", "unrelated root with the same readme");
  const result = makeApplier(t).run(pkg.dir, ["--repo", clone, "--dry-run"]);
  expectCode(result, 0, /does not contain the base commit/);
});

test("package damage is refused with exit 3 and nothing is touched: files, manifest and the script itself", async (t) => {
  const { fixture, pkg } = await textPackage(t);
  const clone = makeClone(t, fixture.repo);
  const app = makeApplier(t);
  const before = snapshot(clone, app.tmp);
  const copy = (name: string) => {
    const dest = join(scratchDir(t, `pp-${name}-`), "pkg");
    mkdirSync(dest);
    for (const file of ["COMMIT_MESSAGE.txt", "README.txt", "apply.sh", "manifest.json"])
      writeFileSync(join(dest, file), readFileSync(join(pkg.dir, file)));
    mkdirSync(join(dest, "patches"));
    writeFileSync(join(dest, "patches", "0001.patch"), readFileSync(join(pkg.dir, "patches", "0001.patch")));
    return dest;
  };
  const append = (dir: string, file: string) =>
    writeFileSync(join(dir, file), `${readFileSync(join(dir, file), "utf8")}x`);

  for (const file of ["patches/0001.patch", "COMMIT_MESSAGE.txt"]) {
    const dir = copy("tamper");
    append(dir, file);
    expectCode(app.run(dir, ["--repo", clone]), 3, new RegExp(`${file.replace("/", "\\/")} does not match`));
  }
  const manifest = copy("manifest");
  append(manifest, "manifest.json");
  expectCode(app.run(manifest, ["--repo", clone]), 3, /manifest\.json does not match this script/);

  const script = copy("script");
  writeFileSync(
    join(script, "apply.sh"),
    readFileSync(join(script, "apply.sh"), "utf8").replace('say "package', 'say "tampered package'),
  );
  expectCode(app.run(script, ["--repo", clone]), 3, /this script was changed/);

  const both = copy("both");
  writeFileSync(join(both, "apply.sh"), `${readFileSync(join(both, "apply.sh"), "utf8")}\n`);
  expectCode(app.run(both, ["--repo", clone]), 3, /this script was changed/);

  const missing = copy("missing");
  rmSync(join(missing, "patches", "0001.patch"));
  expectCode(app.run(missing, ["--repo", clone]), 3, /incomplete: patches\/0001\.patch is missing/);
  const noManifest = copy("nomanifest");
  rmSync(join(noManifest, "manifest.json"));
  expectCode(app.run(noManifest, ["--repo", clone]), 3, /manifest\.json is missing/);
  assert.equal(snapshot(clone, app.tmp), before);
});

test("text, binary, rename, exec bit, deletion, CRLF and CJK paths with brackets apply to the intended tree, also with autocrlf", async (t) => {
  const { fixture, pkg } = await textPackage(t, (repo) => {
    put(repo, "readme.txt", "one\nTWO\nthree\n");
    put(repo, "crlf.txt", "alpha\r\nBETA\r\ngamma\r\n");
    put(repo, "blob.bin", Buffer.concat([Buffer.alloc(5000, 7), Buffer.from([0, 255])]));
    chmodSync(join(repo, "tool.sh"), 0o755);
    rmSync(join(repo, "gone.txt"));
    rmSync(join(repo, "old-name.txt"));
    put(
      repo,
      "renamed/new-name.txt",
      "a stable body that is long enough to be a rename\nsecond line\nthird line\nfourth line\nand an edit\n",
    );
    put(repo, "日本/[配置] 表(1).txt", "新しい\r\nファイル\r\n");
    put(repo, "日本/文件.txt", "こんにちは世界\n");
  });
  assert.equal(pkg.resultTree?.length, 40);
  for (const config of [[], ["-c", "core.autocrlf=true"]]) {
    const clone = join(scratchDir(t, "pp-crlf-"), "clone");
    git(dirname(clone), "clone", "-q", ...config, fixture.repo, clone);
    git(clone, "config", "user.name", "Dana Local");
    git(clone, "config", "user.email", "dana@example.invalid");
    const result = makeApplier(t).run(pkg.dir, ["--repo", clone]);
    expectCode(result, 0);
    assert.equal(git(clone, "rev-parse", "HEAD^{tree}"), pkg.resultTree, config.join(" "));
    assert.equal(git(clone, "status", "--porcelain=v1"), "");
    assert.equal(git(clone, "ls-tree", "HEAD", "tool.sh").slice(0, 6), "100755");
  }
});

test("the commit message keeps a bracketed subject exactly", async (t) => {
  const fixture = makeRepo(t);
  put(fixture.repo, "readme.txt", "changed\n");
  const pkg = await buildFrom(t, fixture, { subject: "[WP-9] Fix [the] thing" });
  git(fixture.repo, "checkout", "-q", "--", ".");
  const clone = makeClone(t, fixture.repo);
  expectCode(makeApplier(t).run(pkg.dir, ["--repo", clone]), 0);
  assert.equal(git(clone, "log", "-1", "--format=%s"), "[WP-9] Fix [the] thing");
});

test("the script also runs under bash outside POSIX mode", async (t) => {
  const { fixture, pkg } = await textPackage(t);
  const clone = makeClone(t, fixture.repo);
  const app = makeApplier(t, "bash");
  expectCode(app.run(pkg.dir, ["--repo", clone]), 0);
  assert.equal(git(clone, "log", "-1", "--format=%s"), "Tune the thing");
});
