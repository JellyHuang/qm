import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { PatchPackageError } from "../src/zq/patch-package/settings.ts";
import type { XlsxDiffResult } from "../src/zq/patch-package/xlsx.ts";
import { git, put, scratchDir } from "./support/patch-package-fixture.ts";
import {
  buildFrom,
  makeApplier,
  makeClone,
  makeLfsRepo,
  placePackage,
  snapshot,
} from "./support/patch-package-apply.ts";

const ITEMS = "tables/items.xlsx";
const HERO = "资源/新 英雄[1].xlsx";
const NEW_ITEMS = Buffer.from("PK-new-items-workbook-bytes".repeat(60));
const NEW_HERO = Buffer.from("PK-hero-workbook".repeat(90));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function expectCode(result: { code: number | null; out: string; err: string }, code: number, pattern?: RegExp) {
  assert.equal(result.code, code, `${result.out}\n${result.err}`);
  if (pattern) assert.match(result.out + result.err, pattern);
}

async function expectRefusal(promise: Promise<unknown>, code: string, pattern?: RegExp) {
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof PatchPackageError, String(e));
    assert.equal(e.code, code, e.message);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

function resetWorktree(repo: string) {
  git(repo, "checkout", "-q", "--", ".");
  git(repo, "clean", "-fdq");
}

function mixedChange(repo: string) {
  put(repo, "readme.txt", "one\nTWO\nthree\n");
  put(repo, ITEMS, NEW_ITEMS);
  put(repo, HERO, NEW_HERO);
}

async function mixedPackage(t: TestContext) {
  const fixture = makeLfsRepo(t);
  mixedChange(fixture.repo);
  const pkg = await buildFrom(t, fixture);
  resetWorktree(fixture.repo);
  return { fixture, pkg };
}

function pointerOf(bytes: Buffer): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256(bytes)}\nsize ${bytes.length}\n`;
}

test("a mixed change builds one package with a text part and an LFS part, deterministically", async (t) => {
  const fixture = makeLfsRepo(t);
  mixedChange(fixture.repo);
  const pkg = await buildFrom(t, fixture);
  const manifest = JSON.parse(readFileSync(pkg.manifestPath, "utf8")) as {
    schema: number;
    kind: string;
    parts: { id: string; kind: string; files: string[] }[];
    changes: {
      path: string;
      kind: string;
      part: string;
      payload?: string;
      baseBlob?: string;
      lfs?: { oid: string; size: number };
    }[];
    selfCheck: { scriptGitBlob: string };
    author: { name: string; role: string };
    applyDefaults: { author: string; committer: string; flags: Record<string, string> };
    untested: string[];
  };
  assert.equal(manifest.schema, 2);
  assert.equal(manifest.kind, "patch-package");
  assert.deepEqual(
    manifest.parts.map((p) => [p.id, p.kind]),
    [
      ["A", "mbox"],
      ["B", "lfs-files"],
    ],
  );
  const byPath = new Map(manifest.changes.map((c) => [c.path, c]));
  assert.equal(byPath.get("readme.txt")?.part, "A");
  assert.equal(byPath.get(ITEMS)?.part, "B");
  assert.equal(byPath.get(ITEMS)?.kind, "lfs");
  assert.equal(byPath.get(ITEMS)?.lfs?.oid, sha256(NEW_ITEMS));
  assert.equal(byPath.get(ITEMS)?.lfs?.size, NEW_ITEMS.length);
  assert.equal(byPath.get(ITEMS)?.baseBlob, git(fixture.repo, "rev-parse", `${fixture.base}:${ITEMS}`));
  assert.equal(byPath.get(HERO)?.baseBlob, undefined);
  assert.deepEqual(manifest.untested, ["apply.ps1", "apply.cmd"]);
  assert.match(manifest.author.role, /package marker/);
  assert.equal(manifest.applyDefaults.committer, "the person who applies the package");
  assert.ok("--new-branch" in manifest.applyDefaults.flags && "--keep-bot-author" in manifest.applyDefaults.flags);
  const patch = readFileSync(join(pkg.dir, "patches", "0001.patch"), "utf8");
  assert.ok(!patch.includes(ITEMS) && !patch.includes("new-items") && patch.includes("readme.txt"));
  assert.deepEqual(readdirSync(join(pkg.dir, "files")).sort(), ["0001.dat", "0002.dat"]);
  assert.equal(
    sha256(readFileSync(join(pkg.dir, "files", "0001.dat"))),
    manifest.changes.find((c) => c.payload === "files/0001.dat")?.lfs?.oid,
  );
  const english = readFileSync(join(pkg.dir, "README_EN.txt"), "utf8");
  const chinese = readFileSync(join(pkg.dir, "README_CN.txt"), "utf8");
  assert.match(english, /UNTESTED/);
  assert.match(chinese, /未经测试/);
  for (const readme of [english, chinese]) assert.match(readme, /git reset --keep/);
  assert.ok(!/--hard/.test(english + chinese + readFileSync(join(pkg.dir, "apply.sh"), "utf8")));
  assert.ok(!/^\s*#(?!!)/m.test(readFileSync(join(pkg.dir, "apply.sh"), "utf8").replace(/^#!.*\n/, "")));
  assert.ok(!/^\s*#/m.test(readFileSync(join(pkg.dir, "apply.ps1"), "utf8")));
  assert.ok(!/^\s*(rem\b|::)/im.test(readFileSync(join(pkg.dir, "apply.cmd"), "utf8")));

  const again = await buildFrom(t, fixture);
  resetWorktree(fixture.repo);
  assert.equal(again.id, pkg.id);
  for (const file of pkg.files.filter((f) => f.name !== "manifest.json" && f.name !== "apply.sh"))
    assert.equal(again.files.find((f) => f.name === file.name)?.sha256, file.sha256, file.name);
  assert.equal(readFileSync(join(again.dir, "apply.sh"), "utf8"), readFileSync(join(pkg.dir, "apply.sh"), "utf8"));
  assert.equal(
    readFileSync(join(again.dir, "manifest.json"), "utf8"),
    readFileSync(join(pkg.dir, "manifest.json"), "utf8"),
  );
});

test("a mixed package becomes ONE commit with real pointers, authored and committed by the applier", async (t) => {
  const { fixture, pkg } = await mixedPackage(t);
  const clone = makeClone(t, fixture.repo, { lfs: true });
  const before = git(clone, "rev-parse", "HEAD");
  const app = makeApplier(t);
  const result = app.run(pkg.dir, ["--repo", clone]);
  expectCode(result, 0);
  assert.equal(git(clone, "rev-list", "--count", `${before}..HEAD`), "1");
  assert.equal(
    git(clone, "log", "-1", "--format=%an <%ae>|%cn <%ce>"),
    "Dana Local <dana@example.invalid>|Dana Local <dana@example.invalid>",
  );
  assert.equal(git(clone, "show", `HEAD:${ITEMS}`), pointerOf(NEW_ITEMS).trimEnd());
  assert.equal(git(clone, "show", `HEAD:${HERO}`), pointerOf(NEW_HERO).trimEnd());
  assert.equal(git(clone, "show", "HEAD:readme.txt"), "one\nTWO\nthree");
  assert.equal(
    git(clone, "log", "-1", "--format=%B"),
    "Tune the thing\n\nExplain why.\n\nTicket: WP-123\nAI-Generated: true",
  );
  assert.deepEqual(readFileSync(join(clone, ITEMS)), NEW_ITEMS);
  assert.equal(git(clone, "status", "--porcelain=v1"), "");
  assert.deepEqual(readdirSync(app.tmp), []);

  git(clone, "reset", "-q", "--keep", before);
  assert.equal(git(clone, "status", "--porcelain=v1", "-uall"), "");
  assert.equal(existsSync(join(clone, HERO)), false);
  assert.equal(git(clone, "rev-parse", "HEAD"), before);
});

test("a mixed package inside the repository root commits the change and never the package folder", async (t) => {
  const { fixture, pkg } = await mixedPackage(t);
  const clone = makeClone(t, fixture.repo, { lfs: true });
  const dir = placePackage(pkg.dir, clone);
  const name = basename(dir);
  const app = makeApplier(t);
  expectCode(app.run(dir, ["--dry-run"], { cwd: clone }), 0);
  assert.equal(git(clone, "status", "--porcelain=v1"), `?? ${name}/`);
  expectCode(app.run(dir, [], { cwd: clone }), 0);
  assert.deepEqual(
    git(clone, "-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD").split("\n").sort(),
    [ITEMS, HERO, "readme.txt"].sort(),
  );
  assert.equal(git(clone, "show", `HEAD:${ITEMS}`), pointerOf(NEW_ITEMS).trimEnd());
  assert.equal(git(clone, "status", "--porcelain=v1"), `?? ${name}/`);
  assert.deepEqual(readdirSync(app.tmp), []);
});

test("--keep-bot-author on a mixed package keeps the bot as author and the applier as committer", async (t) => {
  const { fixture, pkg } = await mixedPackage(t);
  const clone = makeClone(t, fixture.repo, { lfs: true });
  expectCode(makeApplier(t).run(pkg.dir, ["--repo", clone, "--keep-bot-author"]), 0);
  assert.equal(git(clone, "log", "-1", "--format=%an|%cn"), "QM Bot|Dana Local");
  assert.equal(git(clone, "show", `HEAD:${ITEMS}`), pointerOf(NEW_ITEMS).trimEnd());
});

test("an LFS-only package is committed directly with the recorded message", async (t) => {
  const fixture = makeLfsRepo(t);
  put(fixture.repo, ITEMS, NEW_ITEMS);
  const pkg = await buildFrom(t, fixture);
  resetWorktree(fixture.repo);
  assert.ok(!existsSync(join(pkg.dir, "patches")));
  const manifest = JSON.parse(readFileSync(pkg.manifestPath, "utf8")) as { parts: { id: string }[] };
  assert.deepEqual(
    manifest.parts.map((p) => p.id),
    ["B"],
  );

  const app = makeApplier(t);
  const clone = makeClone(t, fixture.repo, { lfs: true });
  const before = snapshot(clone, app.tmp);
  expectCode(app.run(pkg.dir, ["--repo", clone, "--dry-run"]), 0, /dry run finished/);
  assert.equal(snapshot(clone, app.tmp), before);

  expectCode(app.run(pkg.dir, ["--repo", clone]), 0);
  assert.equal(git(clone, "log", "-1", "--format=%an|%cn"), "Dana Local|Dana Local");
  assert.equal(
    git(clone, "log", "-1", "--format=%B"),
    "Tune the thing\n\nExplain why.\n\nTicket: WP-123\nAI-Generated: true",
  );
  assert.equal(git(clone, "show", `HEAD:${ITEMS}`), pointerOf(NEW_ITEMS).trimEnd());

  const bot = makeClone(t, fixture.repo, { lfs: true });
  expectCode(app.run(pkg.dir, ["--repo", bot, "--keep-bot-author"]), 0);
  assert.equal(
    git(bot, "log", "-1", "--format=%an <%ae>|%cn|%aI"),
    "QM Bot <qm-bot@invalid>|Dana Local|2026-01-02T03:04:05Z",
  );

  const branch = makeClone(t, fixture.repo, { lfs: true });
  expectCode(app.run(pkg.dir, ["--repo", branch, "--new-branch"]), 0);
  assert.equal(git(branch, "show", `qm/${pkg.id}:${ITEMS}`), pointerOf(NEW_ITEMS).trimEnd());
  assert.equal(git(branch, "show", `HEAD:${ITEMS}`), git(fixture.repo, "show", `${fixture.base}:${ITEMS}`));
});

test("the executable bit of an LFS file is kept", async (t) => {
  const fixture = makeLfsRepo(t);
  put(fixture.repo, "tools/run.xlsx", NEW_HERO);
  chmodSync(join(fixture.repo, "tools/run.xlsx"), 0o755);
  const pkg = await buildFrom(t, fixture);
  resetWorktree(fixture.repo);
  const clone = makeClone(t, fixture.repo, { lfs: true });
  expectCode(makeApplier(t).run(pkg.dir, ["--repo", clone]), 0);
  assert.equal(git(clone, "ls-tree", "HEAD", "tools/run.xlsx").slice(0, 6), "100755");
});

test("LFS refusals: no git-lfs, no filter, wrong pointer, rules that differ on the applier side, newer file, existing path", async (t) => {
  const { fixture, pkg } = await mixedPackage(t);
  const app = makeApplier(t);
  const refuse = (
    name: string,
    clone: string,
    args: string[],
    code: number,
    pattern: RegExp,
    env?: Record<string, string>,
  ) => {
    const before = snapshot(clone, app.tmp);
    const result = app.run(pkg.dir, ["--repo", clone, ...args], env ? { env } : {});
    expectCode(result, code, pattern);
    assert.equal(snapshot(clone, app.tmp), before, name);
    return result;
  };

  const noLfs = makeClone(t, fixture.repo, { lfs: true });
  refuse("git-lfs missing", noLfs, [], 4, /Git LFS is not installed/, { PATH: "/usr/bin:/bin" });

  const noFilter = makeClone(t, fixture.repo);
  refuse("filter missing", noFilter, [], 4, /Git LFS is not enabled/);

  const wrongFilter = makeClone(t, fixture.repo, { lfs: true });
  git(wrongFilter, "config", "filter.lfs.clean", "cat");
  refuse("pointer mismatch", wrongFilter, [], 5, /not as a Git LFS pointer/);
  assert.equal(existsSync(join(wrongFilter, "资源")), false);

  const otherRules = makeClone(t, fixture.repo, { lfs: true });
  writeFileSync(join(otherRules, ".gitattributes"), "*.txt text\n");
  git(otherRules, "commit", "-q", "-am", "drop the LFS rule");
  refuse("applier rules differ", otherRules, [], 5, /not as a Git LFS pointer|not turned into/);

  const newer = makeClone(t, fixture.repo, { lfs: true });
  put(newer, ITEMS, Buffer.from("someone else changed the workbook meanwhile".repeat(30)));
  git(newer, "commit", "-q", "-am", "newer workbook");
  refuse("blind overwrite guard", newer, [], 4, /changed after the base commit/);
  expectCode(app.run(pkg.dir, ["--repo", newer, "--new-branch", "--dry-run"]), 0);

  const exists = makeClone(t, fixture.repo, { lfs: true });
  put(exists, HERO, Buffer.from("already here".repeat(100)));
  git(exists, "add", "-A");
  git(exists, "commit", "-q", "-m", "hero exists");
  refuse("added path exists", exists, [], 4, /already exists/);

  const untracked = makeClone(t, fixture.repo, { lfs: true });
  put(untracked, HERO, Buffer.from("mine, not tracked"));
  refuse("untracked file in the way", untracked, [], 4, /already exists in your working copy/);
});

test("a hook refusing the commit after the LFS files were staged restores files, index and directories", async (t) => {
  const { fixture, pkg } = await mixedPackage(t);
  const clone = makeClone(t, fixture.repo, { lfs: true });
  const hook = join(clone, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const app = makeApplier(t);
  const before = snapshot(clone, app.tmp);
  const itemsBefore = readFileSync(join(clone, ITEMS));
  const result = app.run(pkg.dir, ["--repo", clone]);
  expectCode(result, 5, /rolled back/);
  assert.equal(snapshot(clone, app.tmp), before);
  assert.ok(readFileSync(join(clone, ITEMS)).equals(itemsBefore));
  assert.equal(existsSync(join(clone, "资源")), false);
  assert.equal(git(clone, "for-each-ref", "refs/qm"), "");

  const conflict = makeClone(t, fixture.repo, { lfs: true });
  put(conflict, "readme.txt", "one\nTWO-LOCAL\nthree\n");
  git(conflict, "commit", "-q", "-am", "same line");
  const conflictBefore = snapshot(conflict, app.tmp);
  expectCode(app.run(pkg.dir, ["--repo", conflict]), 5, /rolled back/);
  assert.equal(snapshot(conflict, app.tmp), conflictBefore);
});

test("LFS deletions and pure renames travel in the text patch and need no git-lfs on the applier", async (t) => {
  const fixture = makeLfsRepo(t, {
    "assets/old.xlsx": Buffer.from("old workbook".repeat(100)),
    "assets/r1.xlsx": Buffer.from("rename me".repeat(100)),
  });
  rmSync(join(fixture.repo, "assets/old.xlsx"));
  git(fixture.repo, "mv", "assets/r1.xlsx", "assets/r2.xlsx");
  const pkg = await buildFrom(t, fixture);
  const manifest = JSON.parse(readFileSync(pkg.manifestPath, "utf8")) as {
    parts: { id: string }[];
    changes: { path: string; part: string; kind: string; status: string }[];
  };
  assert.deepEqual(
    manifest.parts.map((p) => p.id),
    ["A"],
  );
  assert.ok(manifest.changes.every((c) => c.part === "A" && c.kind === "lfs"));
  assert.ok(!existsSync(join(pkg.dir, "files")));
  git(fixture.repo, "reset", "-q", "--hard");
  const clone = makeClone(t, fixture.repo);
  expectCode(makeApplier(t).run(pkg.dir, ["--repo", clone], { env: { PATH: "/usr/bin:/bin" } }), 0);
  assert.equal(git(clone, "ls-tree", "-r", "--name-only", "HEAD", "assets/"), "assets/r2.xlsx");
  assert.equal(
    git(clone, "rev-parse", "HEAD:assets/r2.xlsx"),
    git(fixture.repo, "rev-parse", `${fixture.base}:assets/r1.xlsx`),
  );
});

test("a rename with changed content is a deletion in the text part and an addition in the LFS part", async (t) => {
  const fixture = makeLfsRepo(t, { "assets/r1.xlsx": Buffer.from("rename me".repeat(100)) });
  rmSync(join(fixture.repo, "assets/r1.xlsx"));
  put(fixture.repo, "assets/r2.xlsx", Buffer.from("rename me, and changed".repeat(100)));
  const pkg = await buildFrom(t, fixture);
  const manifest = JSON.parse(readFileSync(pkg.manifestPath, "utf8")) as {
    parts: { id: string }[];
    changes: { path: string; part: string; status: string }[];
  };
  assert.deepEqual(
    manifest.parts.map((p) => p.id),
    ["A", "B"],
  );
  assert.deepEqual(manifest.changes.map((c) => [c.path, c.part, c.status]).sort(), [
    ["assets/r1.xlsx", "A", "D"],
    ["assets/r2.xlsx", "B", "A"],
  ]);
  resetWorktree(fixture.repo);
  const clone = makeClone(t, fixture.repo, { lfs: true });
  expectCode(makeApplier(t).run(pkg.dir, ["--repo", clone]), 0);
  assert.equal(git(clone, "ls-tree", "-r", "--name-only", "HEAD", "assets/"), "assets/r2.xlsx");
});

test("the builder refuses mismatches, other filters, case dependent rules, attribute changes and pointer content", async (t) => {
  const run = async (
    files: Record<string, string | Buffer>,
    mutate: (repo: string) => void,
    code: string,
    pattern?: RegExp,
  ) => {
    const fixture = makeLfsRepo(t, files);
    mutate(fixture.repo);
    const out = scratchDir(t, "pp-out-");
    await expectRefusal(buildFrom(t, fixture, {}, {}, out), code, pattern);
    assert.deepEqual(readdirSync(out), []);
  };
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 5\n`;
  await run(
    { "legacy.dat": pointer },
    (r) => put(r, "legacy.dat", "x".repeat(2000)),
    "lfs_attribute_mismatch",
    /legacy\.dat/,
  );
  await run(
    { ".gitattributes": "*.xlsx filter=crypt\n" },
    (r) => put(r, ITEMS, NEW_ITEMS),
    "unsupported_filter",
    /crypt/,
  );
  await run({ "Sub/UPPER.XLSX": "x" }, (r) => put(r, "Sub/UPPER.XLSX", "changed"), "attributes_case_dependent");
  await run({}, (r) => put(r, ".gitattributes", "*.xlsx filter=lfs\n*.bin filter=lfs\n"), "attributes_changed");
  await run({}, (r) => put(r, ITEMS, pointer), "lfs_pointer_content");
  await run({}, (r) => put(r, "new.xlsx", pointer), "lfs_pointer_content");
});

test("a package above ZQ_PATCH_MAX_PACKAGE_BYTES is refused and leaves nothing", async (t) => {
  const fixture = makeLfsRepo(t);
  put(fixture.repo, ITEMS, Buffer.alloc(200_000, 7));
  const out = scratchDir(t, "pp-out-");
  const tmp = scratchDir(t, "pp-tmp-");
  await expectRefusal(
    buildFrom(t, fixture, {}, { maxPackageBytes: 100_000 }, out),
    "too_large",
    /ZQ_PATCH_MAX_PACKAGE_BYTES/,
  );
  assert.deepEqual(readdirSync(out), []);
  assert.deepEqual(readdirSync(tmp), []);
  const ok = await buildFrom(t, fixture, {}, { maxPackageBytes: 300_000 });
  assert.ok(ok.zip.bytes > 200_000 && ok.zip.bytes < 300_000);
  assert.equal(ok.zip.data.length, ok.zip.bytes);
});

function xlsxResult(path: string, over: Partial<XlsxDiffResult> = {}): XlsxDiffResult {
  return {
    kind: "xlsx_diff",
    path,
    base: { ref: "main~1", commit: "a".repeat(40) },
    head: { ref: "main", commit: "b".repeat(40) },
    summary: { sheets: [] },
    total: 1,
    offset: 0,
    nextOffset: null,
    differences: [{ sheet: "Data", key: "7", column: "qty", old: "1", new: "2", kind: "cell_changed" }],
    ...over,
  };
}

test("workbooks: a comparison table only for the non-LFS one, the note for the LFS one", async (t) => {
  const fixture = makeLfsRepo(t, {
    ".gitattributes": "tables/*.xlsx filter=lfs diff=lfs merge=lfs -text\n",
    "plain/book.xlsx": Buffer.from("PK-plain-book".repeat(30)),
  });
  put(fixture.repo, ITEMS, NEW_ITEMS);
  put(fixture.repo, "plain/book.xlsx", Buffer.from("PK-plain-book-edited".repeat(30)));
  const pkg = await buildFrom(t, fixture, {
    workbooks: [
      { result: xlsxResult(ITEMS, { kind: "lfs_pointer_changed", oldLfs: { oid: "c".repeat(64), size: 9 } }) },
      { result: xlsxResult("plain/book.xlsx") },
    ],
  });
  const manifest = JSON.parse(readFileSync(pkg.manifestPath, "utf8")) as {
    changes: {
      path: string;
      kind: string;
      part: string;
      comparison?: { available: boolean; reason?: string; note?: string; file?: string };
    }[];
  };
  const byPath = new Map(manifest.changes.map((c) => [c.path, c]));
  assert.deepEqual(byPath.get(ITEMS)?.comparison, {
    available: false,
    reason: "lfs",
    note: "comparison not available for LFS files",
  });
  assert.equal(byPath.get(ITEMS)?.part, "B");
  assert.equal(byPath.get("plain/book.xlsx")?.kind, "xlsx");
  assert.equal(byPath.get("plain/book.xlsx")?.part, "A");
  assert.equal(byPath.get("plain/book.xlsx")?.comparison?.file, "comparison/book.diff.md");
  assert.deepEqual(readdirSync(join(pkg.dir, "comparison")), ["book.diff.md"]);
  assert.match(readFileSync(join(pkg.dir, "comparison", "book.diff.md"), "utf8"), /cell_changed/);
  assert.match(readFileSync(join(pkg.dir, "README_EN.txt"), "utf8"), /comparison not available for LFS files/);
  assert.match(readFileSync(join(pkg.dir, "README_CN.txt"), "utf8"), /LFS 文件无法生成对比表/);
  assert.ok(pkg.files.some((f) => f.name === "comparison/book.diff.md"));

  await expectRefusal(
    buildFrom(t, fixture, { workbooks: [{ result: xlsxResult("elsewhere/other.xlsx") }] }),
    "bad_input",
    /not among the changed files/,
  );
  await expectRefusal(
    buildFrom(t, fixture, { workbooks: [{ result: xlsxResult("plain/book.xlsx", { kind: "unchanged" }) }] }),
    "unchanged",
  );
  await expectRefusal(
    buildFrom(t, fixture, {
      workbooks: [{ result: xlsxResult("plain/book.xlsx") }, { result: xlsxResult("other/book.xlsx") }],
    }),
    "bad_input",
    /must be different/,
  );
});
