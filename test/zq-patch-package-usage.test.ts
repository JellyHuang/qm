import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { git, makeRepo, put, scratchDir } from "./support/patch-package-fixture.ts";
import { buildFrom, makeApplier, makeClone, placePackage, snapshot } from "./support/patch-package-apply.ts";

async function packageOf(t: TestContext, edit: (repo: string) => void, fixture = makeRepo(t)) {
  edit(fixture.repo);
  const pkg = await buildFrom(t, fixture);
  git(fixture.repo, "checkout", "-q", "--", ".");
  git(fixture.repo, "clean", "-fdq");
  return { fixture, pkg };
}

const editReadme = (repo: string) => put(repo, "readme.txt", "one\nTWO\nthree\nfour\n");

function expectCode(result: { code: number | null; out: string; err: string }, code: number, pattern?: RegExp) {
  assert.equal(result.code, code, `${result.out}\n${result.err}`);
  if (pattern) assert.match(result.out + result.err, pattern);
}

function committed(repo: string, rev: string): string[] {
  return git(repo, "-c", "core.quotePath=false", "show", "--name-only", "--format=", rev).split("\n").filter(Boolean);
}

test("a package folder in the repository root applies with no folder argument and is never committed", async (t) => {
  const { fixture, pkg } = await packageOf(t, editReadme);
  const clone = makeClone(t, fixture.repo);
  const dir = placePackage(pkg.dir, clone);
  const name = basename(dir);
  const app = makeApplier(t);
  const untracked = `?? ${name}/`;
  const before = snapshot(clone, app.tmp);
  const head = git(clone, "rev-parse", "HEAD");

  expectCode(app.run(name, ["--dry-run"], { cwd: clone }), 0, /dry run finished/);
  assert.equal(snapshot(clone, app.tmp), before);
  assert.equal(git(clone, "status", "--porcelain"), untracked);

  const result = app.run(name, [], { cwd: clone });
  expectCode(result, 0, /can be deleted \(this script never deletes anything\)/);
  assert.match(result.out, new RegExp(`git reset --keep ${head}`));
  assert.deepEqual(committed(clone, "HEAD"), ["readme.txt"]);
  assert.equal(git(clone, "rev-list", "--count", `${head}..HEAD`), "1");
  assert.equal(git(clone, "status", "--porcelain"), untracked);
  assert.ok(existsSync(join(dir, "apply.sh")) && existsSync(join(dir, "manifest.json")));

  git(clone, "reset", "-q", "--keep", head);
  assert.equal(git(clone, "status", "--porcelain"), untracked);
  assert.equal(readFileSync(join(clone, "readme.txt"), "utf8"), "one\ntwo\nthree\n");

  expectCode(app.run(name, ["--new-branch", "--dry-run"], { cwd: clone }), 0);
  assert.equal(snapshot(clone, app.tmp), before);
  expectCode(app.run(name, ["--new-branch"], { cwd: clone }), 0, /can be deleted/);
  const branch = `qm/${pkg.id}`;
  assert.deepEqual(committed(clone, branch), ["readme.txt"]);
  assert.equal(git(clone, "status", "--porcelain"), untracked);
  assert.equal(git(clone, "rev-parse", "HEAD"), head);
  git(clone, "branch", "-D", branch);
  assert.equal(git(clone, "status", "--porcelain"), untracked);
  assert.equal(snapshot(clone, app.tmp), before);
});

test("an explicit --repo accepts a package outside the repository and any directory inside the repository", async (t) => {
  const { fixture, pkg } = await packageOf(t, editReadme);
  const clone = makeClone(t, fixture.repo);
  const app = makeApplier(t);
  expectCode(app.run(pkg.dir, ["--repo", join(clone, "日本"), "--dry-run"]), 0);
  expectCode(app.run(pkg.dir, ["--repo", clone]), 0);
  assert.equal(git(clone, "status", "--porcelain"), "");

  const second = makeClone(t, fixture.repo);
  mkdirSync(join(second, "sub"));
  const dir = placePackage(pkg.dir, join(second, "sub"));
  expectCode(app.run(dir, ["--repo", second]), 0);
  assert.deepEqual(committed(second, "HEAD"), ["readme.txt"]);
  assert.equal(git(second, "status", "--porcelain"), "?? sub/");
});

test("the default root rule refuses a parent that is not a repository root, and a tracked package folder", async (t) => {
  const { fixture, pkg } = await packageOf(t, editReadme);
  const app = makeApplier(t);
  const name = basename(pkg.dir);

  const plain = placePackage(pkg.dir, scratchDir(t, "pp-plain-"));
  expectCode(app.run(plain, []), 4, /is not a git repository: put the whole package folder into the root/);

  const nested = makeClone(t, fixture.repo);
  mkdirSync(join(nested, "tools"));
  const inSub = placePackage(pkg.dir, join(nested, "tools"));
  const nestedBefore = snapshot(nested, app.tmp);
  expectCode(app.run(inSub, []), 4, /is not its root/);
  expectCode(app.run(inSub, ["--new-branch"]), 4, /is not its root/);
  assert.equal(snapshot(nested, app.tmp), nestedBefore);

  const bareHome = scratchDir(t, "pp-bare-");
  git(bareHome, "clone", "-q", "--bare", fixture.repo, join(bareHome, "r.git"));
  const inBare = placePackage(pkg.dir, join(bareHome, "r.git"));
  expectCode(app.run(inBare, []), 4, /bare repository/);

  const tracked = makeClone(t, fixture.repo);
  const trackedDir = placePackage(pkg.dir, tracked);
  git(tracked, "add", name);
  git(tracked, "commit", "-q", "-m", "package committed by mistake");
  const trackedBefore = snapshot(tracked, app.tmp);
  expectCode(app.run(trackedDir, []), 4, /contains files that your repository tracks/);
  expectCode(app.run(trackedDir, ["--new-branch"]), 4, /contains files that your repository tracks/);
  assert.equal(snapshot(tracked, app.tmp), trackedBefore);
  assert.equal(git(tracked, "status", "--porcelain"), "");
});

test("a patch path inside the package folder is refused before anything is touched", async (t) => {
  const { fixture, pkg } = await packageOf(t, (repo) => {
    editReadme(repo);
    put(repo, "fresh/new.txt", "new\n");
    put(repo, "日本/文件.txt", "こんにちは世界\n");
  });
  const app = makeApplier(t);
  for (const folder of ["fresh", "Fresh", "日本"]) {
    const clone = makeClone(t, fixture.repo);
    const dir = placePackage(pkg.dir, clone, folder);
    const before = snapshot(clone, app.tmp);
    expectCode(app.run(dir, []), 4, /inside this package folder/);
    expectCode(app.run(dir, ["--new-branch"]), 4, /inside this package folder/);
    assert.equal(snapshot(clone, app.tmp), before, folder);
  }
  const outside = makeClone(t, fixture.repo);
  expectCode(app.run(pkg.dir, ["--repo", outside]), 0);
});

test("an extra file in the package folder is tolerated and stays untracked", async (t) => {
  const { fixture, pkg } = await packageOf(t, editReadme);
  const clone = makeClone(t, fixture.repo);
  const dir = placePackage(pkg.dir, clone);
  writeFileSync(join(dir, "notes.txt"), "my own notes\n");
  expectCode(makeApplier(t).run(dir, []), 0);
  assert.deepEqual(committed(clone, "HEAD"), ["readme.txt"]);
  assert.equal(git(clone, "status", "--porcelain"), `?? ${basename(dir)}/`);
});

test("a package folder that .gitignore ignores works and shows nothing in git status", async (t) => {
  const { fixture, pkg } = await packageOf(t, editReadme);
  const clone = makeClone(t, fixture.repo);
  put(clone, ".gitignore", `/${pkg.id}/\n`);
  git(clone, "add", ".gitignore");
  git(clone, "commit", "-q", "-m", "ignore the package folder");
  const dir = placePackage(pkg.dir, clone);
  expectCode(makeApplier(t).run(dir, []), 0);
  assert.deepEqual(committed(clone, "HEAD"), ["readme.txt"]);
  assert.equal(git(clone, "status", "--porcelain"), "");
});

test("two package folders side by side apply one after the other without committing either", async (t) => {
  const fixture = makeRepo(t);
  const first = await packageOf(t, editReadme, fixture);
  const second = await packageOf(t, (repo) => put(repo, "gone.txt", "edited by the second package\n"), fixture);
  assert.notEqual(first.pkg.id, second.pkg.id);
  const clone = makeClone(t, fixture.repo);
  const one = placePackage(first.pkg.dir, clone);
  const two = placePackage(second.pkg.dir, clone);
  const app = makeApplier(t);
  expectCode(app.run(one, []), 0);
  expectCode(app.run(two, []), 0);
  assert.deepEqual(committed(clone, "HEAD~1"), ["readme.txt"]);
  assert.deepEqual(committed(clone, "HEAD"), ["gone.txt"]);
  assert.equal(git(clone, "status", "--porcelain"), [`?? ${basename(one)}/`, `?? ${basename(two)}/`].sort().join("\n"));
});

test("each README is complete in one language and the manifest lists both", async (t) => {
  const { pkg } = await packageOf(t, (repo) => {
    editReadme(repo);
    put(repo, "日本/文件.txt", "こんにちは世界\n");
  });
  const english = readFileSync(join(pkg.dir, "README_EN.txt"), "utf8");
  const chinese = readFileSync(join(pkg.dir, "README_CN.txt"), "utf8");
  assert.ok(!existsSync(join(pkg.dir, "README.txt")));
  const changeLine = /^ {2}[AMDRC] /;
  for (const line of english.split("\n"))
    assert.ok(/^[\x00-\x7f]*$/.test(line) || changeLine.test(line), `non-ASCII outside the change list: ${line}`);
  const paragraphs = chinese.split("\n").filter((line) => line.trim() !== "" && !/^\s/.test(line));
  assert.ok(paragraphs.length > 5);
  for (const line of paragraphs) assert.match(line, /[㐀-鿿]/, `a line without Chinese: ${line}`);
  for (const readme of [english, chinese]) {
    assert.ok(readme.includes("日本/文件.txt"));
    assert.ok(readme.includes(`${pkg.id}/apply.sh --dry-run`));
    assert.match(readme, /--new-branch/);
    assert.match(readme, /apply\.cmd/);
  }
  assert.match(english, /UNTESTED/);
  assert.match(chinese, /未经测试/);

  const manifest = JSON.parse(readFileSync(pkg.manifestPath, "utf8")) as {
    files: { name: string; role: string; language?: string }[];
  };
  assert.deepEqual(
    manifest.files.filter((f) => f.role === "readme").map((f) => [f.name, f.language]),
    [
      ["README_CN.txt", "zh"],
      ["README_EN.txt", "en"],
    ],
  );
});

test("the Windows wrappers are generated with the line endings cmd.exe needs and labelled untested", async (t) => {
  const { pkg } = await packageOf(t, editReadme);
  const cmd = readFileSync(join(pkg.dir, "apply.cmd"), "utf8");
  assert.ok(cmd.endsWith("\r\n"));
  assert.ok(!/(?<!\r)\n/.test(cmd));
  const manifest = JSON.parse(readFileSync(pkg.manifestPath, "utf8")) as { untested: string[] };
  assert.deepEqual(manifest.untested, ["apply.ps1", "apply.cmd"]);
});
