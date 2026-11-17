import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALLOWED_GIT_SUBCOMMANDS, createGitRunner } from "../src/zq/patch-package/git.ts";
import { PatchPackageError } from "../src/zq/patch-package/settings.ts";
import { buildTextPatchPackage, type GitMcpDiffResult, type TextPatchInput } from "../src/zq/patch-package/text.ts";
import { git, makeRepo, put, scratchDir, testSettings } from "./support/patch-package-fixture.ts";

const DATE = new Date("2026-01-02T03:04:05Z");

async function expectError(promise: Promise<unknown>, code: string, pattern?: RegExp) {
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof PatchPackageError, String(e));
    assert.equal(e.code, code, e.message);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

function setup(t: Parameters<typeof makeRepo>[0]) {
  const fixture = makeRepo(t);
  const out = scratchDir(t, "pp-out-");
  const tmp = scratchDir(t, "pp-tmp-");
  const input = (over: Partial<TextPatchInput> = {}): TextPatchInput => ({
    repoDir: fixture.repo,
    baseCommit: fixture.base,
    ticket: "ZQ-123",
    subject: "Tune the thing",
    body: "Explain why.",
    change: { kind: "workingDir", dir: fixture.repo },
    ...over,
  });
  const options = (over: Record<string, unknown> = {}) => ({
    settings: testSettings(out),
    commitDate: DATE,
    tmpRoot: tmp,
    ...over,
  });
  return { ...fixture, out, tmp, input, options };
}

test("a working copy with text, binary, rename, delete, mode, CRLF and non-ASCII changes round-trips through git am", async (t) => {
  const s = setup(t);
  put(s.repo, "readme.txt", "one\nTWO\nthree\nfour\n");
  put(s.repo, "crlf.txt", "alpha\r\nBETA\r\ngamma\r\n");
  put(s.repo, "blob.bin", Buffer.concat([Buffer.alloc(300_000, 7), Buffer.from([0, 255])]));
  chmodSync(join(s.repo, "tool.sh"), 0o755);
  rmSync(join(s.repo, "gone.txt"));
  rmSync(join(s.repo, "old-name.txt"));
  put(
    s.repo,
    "renamed/new-name.txt",
    readFileSync(join(s.repo, "readme.txt"), "utf8") &&
      "a stable body that is long enough to be a rename\nsecond line\nthird line\nfourth line\n",
  );
  put(s.repo, "日本/新しい.txt", "新しい\r\nファイル\r\n");
  put(s.repo, "日本/文件.txt", "こんにちは世界\n");
  put(s.repo, "fresh.txt", "brand new\n");

  const pkg = await buildTextPatchPackage(s.input(), s.options());
  assert.equal(pkg.baseCommit, s.base);
  assert.equal(pkg.files.length, 1);
  assert.match(pkg.files[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);

  const byPath = new Map(pkg.changes.map((c) => [c.path, c]));
  assert.equal(byPath.get("gone.txt")?.status, "D");
  assert.equal(byPath.get("fresh.txt")?.status, "A");
  assert.equal(byPath.get("renamed/new-name.txt")?.status, "R");
  assert.equal(byPath.get("renamed/new-name.txt")?.oldPath, "old-name.txt");
  assert.equal(byPath.get("tool.sh")?.newMode, "100755");
  assert.equal(byPath.get("blob.bin")?.binary, true);
  assert.equal(byPath.get("日本/新しい.txt")?.status, "A");

  const fresh = scratchDir(t, "pp-fresh-");
  git(fresh, "init", "-q");
  git(fresh, "fetch", "-q", s.repo, s.base);
  git(fresh, "checkout", "-q", "--detach", s.base);
  git(fresh, "-c", "user.name=R", "-c", "user.email=r@x", "am", "--3way", "--keep-cr", ...pkg.files.map((f) => f.path));
  assert.equal(git(fresh, "rev-parse", "HEAD^{tree}"), pkg.resultTree);
  assert.equal(git(fresh, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(fresh, "crlf.txt"), "utf8"), "alpha\r\nBETA\r\ngamma\r\n");
  assert.equal(readFileSync(join(fresh, "日本/新しい.txt"), "utf8"), "新しい\r\nファイル\r\n");
  assert.equal(readFileSync(join(fresh, "blob.bin")).length, 300_002);
});

test("the commit message carries the ticket and the AI marker exactly once and the author is the QM identity", async (t) => {
  const s = setup(t);
  put(s.repo, "readme.txt", "changed\n");
  const pkg = await buildTextPatchPackage(s.input(), s.options());
  const patch = readFileSync(pkg.files[0]?.path ?? "", "utf8");
  assert.equal(patch.match(/^Ticket: ZQ-123$/gm)?.length, 1);
  assert.equal(patch.match(/^AI-Generated: QM$/gm)?.length, 1);
  assert.match(patch, /^From: QM Bot <qm-bot@invalid>$/m);
  assert.match(patch, /^Date: Fri, 2 Jan 2026 03:04:05 \+0000$/m);
  assert.match(patch, /Subject: \[PATCH\] Tune the thing\n\nExplain why\.\n\nTicket: ZQ-123\nAI-Generated: QM\n---\n/);
});

test("the same inputs and date give byte-identical patch files", async (t) => {
  const s = setup(t);
  put(s.repo, "readme.txt", "changed\n");
  const first = await buildTextPatchPackage(s.input(), s.options());
  const second = await buildTextPatchPackage(
    s.input(),
    s.options({ settings: testSettings(scratchDir(t, "pp-out2-")) }),
  );
  assert.equal(first.files[0]?.sha256, second.files[0]?.sha256);
  assert.equal(first.resultCommit, second.resultCommit);
});

test("the manifest has hashes and refs, no secrets and no absolute temp paths", async (t) => {
  const s = setup(t);
  put(s.repo, "readme.txt", "changed\n");
  const pkg = await buildTextPatchPackage(s.input(), s.options());
  const text = readFileSync(pkg.manifestPath, "utf8");
  const manifest = JSON.parse(text) as {
    files: { name: string; sha256: string }[];
    base: { commit: string };
    ticket: string;
  };
  assert.equal(manifest.base.commit, s.base);
  assert.equal(manifest.ticket, "ZQ-123");
  assert.equal(manifest.files[0]?.sha256, pkg.files[0]?.sha256);
  assert.ok(!text.includes(s.out) && !text.includes(s.tmp) && !text.includes(s.repo));
  assert.ok(!/\/tmp\//.test(text));
  assert.deepEqual(readdirSync(pkg.dir).sort(), [manifest.files[0]?.name, "manifest.json"]);
});

test("a diff obtained from get_diff builds the same tree as the working copy", async (t) => {
  const s = setup(t);
  put(s.repo, "readme.txt", "one\nTWO\nthree\n");
  put(s.repo, "日本/文件.txt", "こんにちは世界\n");
  const diff =
    git(s.repo, "diff", "--no-ext-diff", "--no-color", "--no-renames", s.base, "--", "readme.txt", "日本/文件.txt") +
    "\n";
  const result: GitMcpDiffResult = {
    base: s.base,
    head: s.base,
    files: [
      { kind: "file", path: "readme.txt", status: "M" },
      { kind: "file", path: "日本/文件.txt", status: "M" },
    ],
    diff,
    truncated: false,
  };
  const fromDiff = await buildTextPatchPackage(s.input({ change: { kind: "diff", result } }), s.options());
  const fromCopy = await buildTextPatchPackage(
    s.input(),
    s.options({ settings: testSettings(scratchDir(t, "pp-out2-")) }),
  );
  assert.equal(fromDiff.resultTree, fromCopy.resultTree);
  assert.equal(fromDiff.manifest.source, "git-mcp-diff");
});

test("a truncated diff, a wrong base and unsupported entries are refused with a clear reason", async (t) => {
  const s = setup(t);
  const ok: GitMcpDiffResult = {
    base: s.base,
    head: s.base,
    files: [{ kind: "file", path: "readme.txt", status: "M" }],
    diff: "diff --git a/readme.txt b/readme.txt\n",
    truncated: false,
  };
  const run = (result: GitMcpDiffResult) =>
    buildTextPatchPackage(s.input({ change: { kind: "diff", result } }), s.options());
  await expectError(run({ ...ok, truncated: true }), "truncated_diff", /truncated/);
  await expectError(run({ ...ok, base: "b".repeat(40) }), "bad_input", /base commit/);
  await expectError(run({ ...ok, diff: "" }), "empty");
  await expectError(
    run({ ...ok, files: [{ kind: "lfs_pointer", path: "x", status: "M" }] }),
    "unsupported",
    /lfs_pointer/,
  );
  await expectError(run({ ...ok, files: [{ kind: "submodule", path: "x", status: "M" }] }), "unsupported", /submodule/);
  await expectError(
    run({ ...ok, files: [{ kind: "file", path: "x", status: "M", binary: true }] }),
    "unsupported",
    /binary/,
  );
  await expectError(run({ ...ok, files: [{ kind: "file", path: "x", status: "R" }] }), "unsupported", /rename/);
  assert.deepEqual(readdirSync(s.out), []);
});

test("the ticket, subject and body are validated", async (t) => {
  const s = setup(t);
  put(s.repo, "readme.txt", "changed\n");
  const build = (over: Partial<TextPatchInput>) => buildTextPatchPackage(s.input(over), s.options());
  await expectError(build({ ticket: "" }), "bad_ticket");
  await expectError(build({ ticket: "zq-1" }), "bad_ticket", /does not match/);
  await expectError(build({ ticket: "ZQ-1\nAI-Generated: x" }), "bad_ticket");
  await expectError(build({ subject: "" }), "bad_message");
  await expectError(build({ subject: "x".repeat(73) }), "bad_message", /longer/);
  await expectError(build({ subject: "bad\u0007bell" }), "bad_message", /control/);
  await expectError(build({ body: "line\rwith cr" }), "bad_message", /control/);
  await expectError(build({ body: "x".repeat(5001) }), "bad_message", /longer/);
  await expectError(build({ body: "fine\nTicket: OTHER-1" }), "bad_message", /Ticket:/);
  await expectError(build({ body: "AI-Generated: nope" }), "bad_message");
  const custom = await buildTextPatchPackage(
    s.input({ ticket: "work-package-77" }),
    s.options({ settings: testSettings(s.out, { ticketPattern: "^work-package-[0-9]+$" }) }),
  );
  assert.equal(custom.manifest.ticket, "work-package-77");
  assert.deepEqual(readdirSync(s.tmp), []);
});

test("an author identity that is not clearly QM is refused", async (t) => {
  const s = setup(t);
  put(s.repo, "readme.txt", "changed\n");
  await expectError(
    buildTextPatchPackage(
      s.input(),
      s.options({ settings: testSettings(s.out, { authorName: "Alice", authorEmail: "a@x.test" }) }),
    ),
    "bad_input",
    /QM/,
  );
});

test("an empty change, LFS pointers, submodules and an unknown base are refused", async (t) => {
  const s = setup(t);
  await expectError(buildTextPatchPackage(s.input(), s.options()), "empty");
  await expectError(
    buildTextPatchPackage(s.input({ baseCommit: "c".repeat(40) }), s.options()),
    "bad_input",
    /not in the given repository/,
  );
  await expectError(buildTextPatchPackage(s.input({ baseCommit: "main" }), s.options()), "bad_input", /full/);

  put(s.repo, "asset.bin", "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 12\n");
  await expectError(buildTextPatchPackage(s.input(), s.options()), "unsupported", /LFS/);
  rmSync(join(s.repo, "asset.bin"));

  const sub = scratchDir(t, "pp-sub-");
  git(sub, "init", "-q");
  put(sub, "f", "x");
  git(sub, "add", "-A");
  git(sub, "commit", "-q", "-m", "s");
  git(s.repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/sub");
  await expectError(buildTextPatchPackage(s.input(), s.options()), "unsupported", /submodule/);
  assert.deepEqual(readdirSync(s.out), []);
});

test("temp dirs and the package directory are cleaned up on success and on failure", async (t) => {
  const s = setup(t);
  put(s.repo, "readme.txt", "changed\n");
  const pkg = await buildTextPatchPackage(s.input(), s.options());
  assert.deepEqual(readdirSync(s.tmp), []);
  assert.ok(existsSync(pkg.dir));
  await expectError(buildTextPatchPackage(s.input(), s.options()), "exists");
  assert.deepEqual(readdirSync(s.tmp), []);
  assert.deepEqual(readdirSync(s.out), [`ZQ-123-${pkg.resultCommit.slice(0, 12)}`]);

  const failing = await buildTextPatchPackage(
    s.input(),
    s.options({
      settings: testSettings(scratchDir(t, "pp-out3-")),
      observeGit: (sub: string) => {
        if (sub === "am") throw new PatchPackageError("verify_failed", "forced");
      },
    }),
  ).catch((e: unknown) => e);
  assert.ok(failing instanceof PatchPackageError);
  assert.deepEqual(readdirSync(s.tmp), []);
});

test("no remote exists in any scratch repository and only allowlisted git subcommands are spawned", async (t) => {
  const s = setup(t);
  put(s.repo, "readme.txt", "changed\n");
  const seen: string[] = [];
  const remotes: string[] = [];
  await buildTextPatchPackage(
    s.input(),
    s.options({
      observeGit: (sub: string, args: readonly string[]) => {
        seen.push(sub);
        if (sub === "commit") remotes.push(git(s.tmp + "/" + readdirSync(s.tmp)[0] + "/build", "remote", "-v"));
        assert.ok(!args.some((a) => /^(origin|https?:|ssh:|git@)/.test(a)), args.join(" "));
      },
    }),
  );
  assert.ok(seen.length > 5);
  for (const sub of seen) assert.ok(ALLOWED_GIT_SUBCOMMANDS.includes(sub), sub);
  for (const forbidden of ["push", "fetch", "pull", "clone", "remote", "send-pack", "ls-remote", "archive", "bundle"])
    assert.ok(!ALLOWED_GIT_SUBCOMMANDS.includes(forbidden), forbidden);
  assert.deepEqual(remotes, [""]);
  const runner = createGitRunner({ name: "QM Bot", email: "qm-bot@invalid" });
  for (const forbidden of ["push", "fetch", "clone", "remote"])
    assert.throws(() => runner.run(forbidden, [], { cwd: s.repo }), /not allowed/);
});

test("a large binary file is carried without a size limit", async (t) => {
  const s = setup(t);
  const big = randomBytes(24 * 1024 * 1024);
  big[0] = 0;
  put(s.repo, "big.bin", big);
  const pkg = await buildTextPatchPackage(s.input(), s.options());
  assert.ok((pkg.files[0]?.bytes ?? 0) > 20 * 1024 * 1024);
  assert.equal(pkg.changes.find((c) => c.path === "big.bin")?.binary, true);
});
