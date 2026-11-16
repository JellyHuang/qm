import { tenantTest as test } from "./support/tenant-test.ts";
import { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitAudit, type GitAuditRow } from "../src/zq/git/audit.ts";
import { DEFAULT_GIT_LIMITS, createGitLimits } from "../src/zq/git/limits.ts";
import { createGitRunner, sshCommand } from "../src/zq/git/runner.ts";
import {
  createGitReadonly,
  MAX_BLAME_LINES,
  MAX_COMMIT_MESSAGE_EXCERPT_BYTES,
  MAX_DIFF_BYTES,
  MAX_DIFF_FILES,
  MAX_FILE_BYTES,
  MAX_FILES_IN_COMMIT,
  MAX_FILES_PER_COMMIT_LISTING,
} from "../src/zq/git/readonly.ts";
import { GitDenied } from "../src/zq/git/validate.ts";
import { testMap } from "./support/test-database.ts";

const root = mkdtempSync(join(tmpdir(), "qm-git-"));
after(() => rmSync(root, { recursive: true, force: true }));

const ALICE = { name: "Alice A", email: "alice@example.test" };
const BOB = { name: "Bob B", email: "bob@example.test" };
const SECRET = "SECRET-FILE-CONTENT-MARKER";
const BULK_FILES = 210;
const BIG_BYTES = 100 * 1024;

const work = join(root, "work");
const clones = join(root, "clones");
const marker = join(root, "marker");

function git(cwd: string, args: string[], who = ALICE): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      GIT_AUTHOR_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email,
      GIT_COMMITTER_NAME: who.name,
      GIT_COMMITTER_EMAIL: who.email,
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
}

function commitAll(message: string, who = ALICE): string {
  git(work, ["add", "-A"], who);
  git(work, ["commit", "-q", "-m", message], who);
  return git(work, ["rev-parse", "HEAD"]);
}

function buildFixture() {
  mkdirSync(work, { recursive: true });
  mkdirSync(clones, { recursive: true });
  git(work, ["init", "-q", "-b", "main"]);
  mkdirSync(join(work, "src"));
  writeFileSync(join(work, "README.md"), "# fixture\n");
  writeFileSync(
    join(work, "src", "a.txt"),
    Array.from({ length: 300 }, (_, i) => `line ${i + 1} ${SECRET}`).join("\n") + "\n",
  );
  writeFileSync(join(work, "long.txt"), "x".repeat(5000) + "\n");
  writeFileSync(join(work, "big.txt"), "0123456789abcdef\n".repeat(BIG_BYTES / 17));
  writeFileSync(join(work, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
  writeFileSync(
    join(work, "sheet.xlsx"),
    Buffer.concat([Buffer.from("PK"), Buffer.from([3, 4, 0, 0]), Buffer.from("cells")]),
  );
  const first = commitAll("first commit\n\nbody of the first commit");
  git(work, ["mv", "src/a.txt", "src/b.txt"], BOB);
  writeFileSync(
    join(work, "src", "b.txt"),
    Array.from({ length: 300 }, (_, i) => `line ${i + 1} ${SECRET}`).join("\n") + "\nextra\n",
  );
  writeFileSync(join(work, "bin.dat"), Buffer.from([0, 9, 9, 9, 9, 0, 255, 1]));
  writeFileSync(
    join(work, "sheet.xlsx"),
    Buffer.concat([Buffer.from("PK"), Buffer.from([3, 4, 0, 0]), Buffer.from("cells2")]),
  );
  const second = commitAll("rename a to b", BOB);
  git(work, ["checkout", "-q", "-b", "feature/login"]);
  writeFileSync(join(work, "login.txt"), "login\n");
  const featureSha = commitAll("add login", BOB);
  git(work, ["checkout", "-q", "main"]);
  mkdirSync(join(work, "bulk"));
  for (let i = 0; i < BULK_FILES; i++)
    writeFileSync(join(work, "bulk", `f${String(i).padStart(3, "0")}.txt`), `${i}\n`);
  const bulk = commitAll(`bulk ${"m".repeat(3000)}`);
  for (let i = 0; i < 55; i++) {
    writeFileSync(join(work, "many.txt"), `${i}\n`);
    commitAll(`many ${i}`);
  }
  return { first, second, featureSha, bulk, head: git(work, ["rev-parse", "HEAD"]) };
}

const fx = buildFixture();

async function harness(opts: { remotes?: Record<string, string> } = {}) {
  const map = testMap<GitAuditRow>();
  let clock = 1_000;
  const now = () => (clock += 5);
  const audit = createGitAudit({ map, now });
  const runner = createGitRunner();
  const dir = mkdtempSync(join(clones, "d-"));
  const config = { dir, remotes: opts.remotes ?? { server: work } };
  const limits = createGitLimits({ config: DEFAULT_GIT_LIMITS, bytesSince: audit.bytesSince, now });
  const readonly = createGitReadonly({ config, runner, audit, limits, now });
  git(dir, ["init", "-q", "--bare", "-b", "main", "server.git"]);
  await readonly.fetchRepo("server");
  return { readonly, audit, runner, dir };
}

async function denied(promise: Promise<unknown>, reason: string) {
  await assert.rejects(promise, (e) => e instanceof GitDenied && e.reason === reason);
}

test("fetchRepo mirrors branches and picks up a new commit and a deleted branch", async () => {
  const { readonly } = await harness();
  const before = await readonly.branches("p", "server");
  assert.deepEqual(before.branches.map((b) => b.name).sort(), ["feature/login", "main"]);
  git(work, ["checkout", "-q", "-b", "temp"]);
  writeFileSync(join(work, "t.txt"), "t\n");
  commitAll("temp commit");
  await readonly.fetchRepo("server");
  const withTemp = await readonly.branches("p", "server", "temp");
  assert.equal(withTemp.branches.length, 1);
  git(work, ["checkout", "-q", "main"]);
  git(work, ["branch", "-D", "temp"]);
  await readonly.fetchRepo("server");
  assert.equal((await readonly.branches("p", "server", "temp")).branches.length, 0);
});

test("recentCommits lists authors, files, caps and branches", async () => {
  const { readonly } = await harness();
  const recent = await readonly.recentCommits("p", "server");
  assert.equal(recent.commits.length, MAX_FILES_PER_COMMIT_LISTING);
  assert.equal(recent.truncated, true);
  assert.equal(recent.commits[0]?.subject, "many 54");
  assert.deepEqual(recent.commits[0]?.files, [{ path: "many.txt", status: "M" }]);
  assert.equal(recent.commits[0]?.authorEmail, ALICE.email);
  assert.equal(recent.commits[0]?.branch, "HEAD");

  const few = await readonly.recentCommits("p", "server", { limit: 3 });
  assert.equal(few.commits.length, 3);
  assert.equal(few.truncated, true);

  const feature = await readonly.recentCommits("p", "server", { branch: "feature/login", limit: 1 });
  assert.equal(feature.commits[0]?.sha, fx.featureSha);
  assert.equal(feature.commits[0]?.authorName, BOB.name);
  assert.equal(feature.commits[0]?.authorEmail, BOB.email);
  assert.equal(feature.commits[0]?.branch, "feature/login");

  const future = await readonly.recentCommits("p", "server", {
    since: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
  });
  assert.deepEqual(future.commits, []);
});

test("a commit with many files and a long message is cut in the listing", async () => {
  const { readonly, dir } = await harness();
  git(join(dir, "server.git"), ["update-ref", "refs/heads/bulkonly", fx.bulk]);
  const recent = await readonly.recentCommits("p", "server", { branch: "bulkonly", limit: 1 });
  const c = recent.commits[0];
  assert.equal(c?.files.length, MAX_FILES_PER_COMMIT_LISTING);
  assert.equal(c?.filesTruncated, true);
  assert.equal(c?.messageTruncated, true);
  assert.ok(Buffer.byteLength(c?.message ?? "") <= MAX_COMMIT_MESSAGE_EXCERPT_BYTES);
});

test("commit returns message, people, parents and per-file stats with a 200 file cap", async () => {
  const { readonly } = await harness();
  const first = await readonly.commit("p", "server", fx.first);
  assert.equal(first.message, "first commit\n\nbody of the first commit");
  assert.deepEqual(first.parents, []);
  assert.equal(first.author.email, ALICE.email);
  assert.equal(first.committer.name, ALICE.name);
  assert.equal(first.truncated, false);
  const readme = first.files.find((f) => f.path === "README.md");
  assert.deepEqual(readme, { path: "README.md", status: "A", added: 1, removed: 0, binary: false });
  assert.equal(first.files.find((f) => f.path === "bin.dat")?.binary, true);
  assert.equal(first.files.find((f) => f.path === "sheet.xlsx")?.binary, true);

  const second = await readonly.commit("p", "server", fx.second.slice(0, 10));
  assert.deepEqual(second.parents, [fx.first]);
  assert.equal(second.author.email, BOB.email);
  const renamed = second.files.find((f) => f.path === "src/b.txt");
  assert.equal(renamed?.status, "R");
  assert.equal(renamed?.added, 1);

  const bulk = await readonly.commit("p", "server", fx.bulk);
  assert.equal(bulk.files.length, MAX_FILES_IN_COMMIT);
  assert.equal(bulk.truncated, true);
  assert.equal(bulk.cutItems, BULK_FILES - MAX_FILES_IN_COMMIT);
});

test("diff of one commit is a unified diff and binaries are reported without content", async () => {
  const { readonly } = await harness();
  const d = await readonly.diff("p", "server", fx.second);
  assert.equal(d.truncated, false);
  assert.match(d.patch, /^diff --git a\/src\/a.txt b\/src\/b.txt/m);
  assert.match(d.patch, /\+extra/);
  assert.deepEqual(d.binaryFiles.map((b) => b.path).sort(), ["bin.dat", "sheet.xlsx"]);
  const bin = d.binaryFiles.find((b) => b.path === "bin.dat");
  assert.equal(bin?.oldSize, 6);
  assert.equal(bin?.newSize, 8);
  assert.match(bin?.newOid ?? "", /^[0-9a-f]{40}$/);
  assert.equal(d.patch.includes("PK"), false);
  assert.equal(d.patch.includes("cells"), false);

  const onlyBin = await readonly.diff("p", "server", fx.second, "sheet.xlsx");
  assert.equal(onlyBin.patch, "");
  assert.equal(onlyBin.binaryFiles.length, 1);

  const range = await readonly.diff("p", "server", `${fx.first}..${fx.second}`, "src/b.txt");
  assert.match(range.patch, /\+extra/);
  assert.deepEqual(
    range.files.map((f) => f.path),
    ["src/b.txt"],
  );
});

test("diff of the root commit works and big diffs are cut by bytes and by files", async () => {
  const { readonly } = await harness();
  const root = await readonly.diff("p", "server", fx.first);
  assert.equal(root.truncated, true);
  assert.ok(root.cutBytes && root.cutBytes > 0);
  assert.ok(Buffer.byteLength(root.patch) <= MAX_DIFF_BYTES);
  const bulk = await readonly.diff("p", "server", fx.bulk);
  assert.equal(bulk.files.length, MAX_DIFF_FILES);
  assert.equal(bulk.truncated, true);
  assert.equal(bulk.cutItems, BULK_FILES - MAX_DIFF_FILES);
});

test("fileAt reads text from the object database, caps big files and reports binaries as size only", async () => {
  const { readonly } = await harness();
  const readme = await readonly.fileAt("p", "server", "main", "README.md");
  assert.equal(readme.binary, false);
  assert.equal(readme.binary === false && readme.content, "# fixture\n");
  assert.equal(readme.truncated, false);

  const big = await readonly.fileAt("p", "server", "main", "big.txt");
  assert.equal(big.binary === false && Buffer.byteLength(big.content), MAX_FILE_BYTES);
  assert.equal(big.truncated, true);
  assert.equal(big.cutBytes, big.size - MAX_FILE_BYTES);

  const long = await readonly.fileAt("p", "server", "main", "long.txt");
  assert.equal(long.binary === false && long.content.length, 5001);

  const bin = await readonly.fileAt("p", "server", "main", "bin.dat");
  assert.equal(bin.binary, true);
  assert.equal(bin.size, 8);
  assert.equal("content" in bin, false);
  const xlsx = await readonly.fileAt("p", "server", fx.first, "sheet.xlsx");
  assert.equal(xlsx.binary, true);
  assert.match(xlsx.oid, /^[0-9a-f]{40}$/);

  const old = await readonly.fileAt("p", "server", fx.first, "src/a.txt");
  assert.equal(old.binary === false && old.content.startsWith("line 1 "), true);
  await denied(readonly.fileAt("p", "server", "main", "src/a.txt"), "not_found");
  await denied(readonly.fileAt("p", "server", "main", "src"), "not_found");
  await denied(readonly.fileAt("p", "server", "nosuchbranch", "README.md"), "not_found");
});

test("blame returns the requested range with authors and caps at 200 lines", async () => {
  const { readonly } = await harness();
  const b = await readonly.blame("p", "server", "main", "src/b.txt", 3, 5);
  assert.deepEqual(
    b.lines.map((l) => l.line),
    [3, 4, 5],
  );
  assert.equal(b.lines[0]?.author, ALICE.name);
  assert.equal(b.lines[0]?.sha, fx.first);
  assert.match(b.lines[0]?.text ?? "", /^line 3 /);
  assert.match(b.lines[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(b.truncated, false);

  const extra = await readonly.blame("p", "server", "main", "src/b.txt", 301, 301);
  assert.equal(extra.lines[0]?.author, BOB.name);
  assert.equal(extra.lines[0]?.text, "extra");

  const wide = await readonly.blame("p", "server", "main", "src/b.txt", 1, 300);
  assert.equal(wide.lines.length, MAX_BLAME_LINES);
  assert.equal(wide.truncated, true);
  assert.equal(wide.cutItems, 300 - MAX_BLAME_LINES);

  const long = await readonly.blame("p", "server", "main", "long.txt", 1, 1);
  assert.equal(long.truncated, true);
  assert.equal(long.cutBytes, 5000 - 1024);

  await denied(readonly.blame("p", "server", "main", "src/b.txt", 5, 3), "bad_number");
  await denied(readonly.blame("p", "server", "main", "src/b.txt", 0, 3), "bad_number");
});

test("branches filters by glob, sorts by recency and reports tips", async () => {
  const { readonly } = await harness();
  const all = await readonly.branches("p", "server");
  assert.deepEqual(all.branches.map((b) => b.name).sort(), ["feature/login", "main"]);
  assert.equal(all.branches.find((b) => b.name === "main")?.sha, fx.head);
  const dates = all.branches.map((b) => Date.parse(b.date));
  assert.deepEqual(
    dates,
    [...dates].sort((a, b) => b - a),
  );
  assert.equal(all.truncated, false);
  assert.deepEqual(
    (await readonly.branches("p", "server", "feature/*")).branches.map((b) => b.name),
    ["feature/login"],
  );
  assert.deepEqual((await readonly.branches("p", "server", "fea?ure/login")).branches.length, 1);
  assert.deepEqual((await readonly.branches("p", "server", "ma")).branches, []);
  await denied(readonly.branches("p", "server", "a;b"), "bad_pattern");
});

test("a repository outside the allowlist or without a clone is refused", async () => {
  const { readonly } = await harness();
  await denied(readonly.commit("p", "other", fx.first), "repo_not_allowed");
  await denied(readonly.branches("p", "../server"), "repo_not_allowed");
  await denied(readonly.fetchRepo("client"), "no_remote");
  await assert.rejects(readonly.branches("p", "client"));
});

test("refs, paths, shas and ranges that could act as options or escape are refused", async () => {
  const { readonly } = await harness();
  await denied(readonly.fileAt("p", "server", "--upload-pack=touch x", "README.md"), "bad_ref");
  await denied(readonly.fileAt("p", "server", "main", "../README.md"), "bad_path");
  await denied(readonly.fileAt("p", "server", "main", "src/../README.md"), "bad_path");
  await denied(readonly.fileAt("p", "server", "main", "/etc/passwd"), "bad_path");
  await denied(readonly.fileAt("p", "server", "main", "README.md\0.txt"), "bad_path");
  await denied(readonly.fileAt("p", "server", "main", "-n"), "bad_path");
  await denied(readonly.fileAt("p", "server", "main", `${"a/".repeat(600)}x`), "bad_path");
  await denied(readonly.fileAt("p", "server", "ma in", "README.md"), "bad_ref");
  await denied(readonly.fileAt("p", "server", "a..b..c", "README.md"), "bad_ref");
  await denied(readonly.fileAt("p", "server", "x".repeat(300), "README.md"), "bad_ref");
  await denied(readonly.recentCommits("p", "server", { branch: "-all" }), "bad_branch");
  await denied(readonly.recentCommits("p", "server", { branch: "a\nb" }), "bad_branch");
  await denied(readonly.recentCommits("p", "server", { since: "--output=x" }), "bad_since");
  await denied(readonly.recentCommits("p", "server", { limit: 0 }), "bad_number");
  await denied(readonly.commit("p", "server", "--all"), "bad_sha");
  await denied(readonly.commit("p", "server", "abc"), "bad_sha");
  await denied(readonly.commit("p", "server", "g".repeat(10)), "bad_sha");
  await denied(readonly.diff("p", "server", "main...feature/login"), "bad_ref");
  await denied(readonly.diff("p", "server", "a..b..c"), "bad_range");
  await denied(readonly.diff("p", "server", "--stat..main"), "bad_ref");
  await denied(readonly.diff("p", "server", `${fx.first}..${fx.second}`, "../x"), "bad_path");
});

test("no shell is involved: metacharacters in a ref are refused and never executed", async () => {
  const { readonly, runner, dir } = await harness();
  await denied(readonly.fileAt("p", "server", `main;touch ${marker}`, "README.md"), "bad_ref");
  await denied(readonly.fileAt("p", "server", `$(touch ${marker})`, "README.md"), "bad_ref");
  await denied(readonly.fileAt("p", "server", "main", `README.md;touch ${marker}`), "not_found");
  await denied(readonly.recentCommits("p", "server", { branch: `x$(touch ${marker})` }), "bad_branch");
  await assert.rejects(runner.run(join(dir, "server.git"), ["log", "--end-of-options", `main;touch ${marker}`]));
  await assert.rejects(runner.run(join(dir, "server.git"), ["log", "--end-of-options", `$(touch ${marker})`]));
  assert.equal(existsSync(marker), false);
});

test("the runner runs git with a clean environment and kills output over its cap", async () => {
  const { dir } = await harness();
  const bare = join(dir, "server.git");
  const small = createGitRunner({ maxBytes: 1000 });
  const blob = git(work, ["rev-parse", "HEAD:big.txt"]);
  const started = Date.now();
  const out = await small.run(bare, ["cat-file", "blob", blob]);
  assert.equal(out.truncated, true);
  assert.equal(out.stdout.length, 1000);
  assert.ok(out.cutBytes > 0);
  assert.ok(Date.now() - started < 10_000);
  const roomy = await createGitRunner().run(bare, ["cat-file", "blob", blob], { maxBytes: 10 * BIG_BYTES });
  assert.equal(roomy.truncated, false);
  assert.equal(roomy.stdout.length, Number(git(work, ["cat-file", "-s", blob])));
  await assert.rejects(
    createGitRunner({ gitBinary: "sh", timeoutMs: 100 }).run(bare, ["-c", "sleep 5"]),
    /exited|timed out/,
  );
});

test("remote runs use the injected key file with a pinned identity and known_hosts", () => {
  const command = sshCommand("/tmp/k ey", "/etc/known");
  assert.match(command, /-i '\/tmp\/k ey'/);
  assert.match(command, /IdentitiesOnly=yes/);
  assert.match(command, /StrictHostKeyChecking=yes/);
  assert.match(command, /UserKnownHostsFile='\/etc\/known'/);
});

test("remote runs take the key from withKeyFile and need a known_hosts file", async () => {
  const keys: string[] = [];
  const withKeyFile = async <T>(fn: (file: string) => Promise<T>) => {
    keys.push("dummy");
    return fn("/dev/null");
  };
  const { dir } = await harness();
  const bare = join(dir, "server.git");
  await assert.rejects(createGitRunner({ withKeyFile }).run(bare, ["fetch", work], { remote: true }), /known_hosts/);
  assert.deepEqual(keys, []);
  const runner = createGitRunner({ withKeyFile, knownHosts: "/dev/null" });
  const out = await runner.run(bare, ["rev-parse", "--git-dir"], { remote: true });
  assert.equal(out.stdout.toString().trim(), bare);
  assert.deepEqual(keys, ["dummy"]);
});

test("every call is audited, refused ones too, and no content is stored", async () => {
  const { readonly, audit } = await harness();
  await readonly.fileAt("alice-mm", "server", "main", "src/b.txt");
  await readonly.diff("alice-mm", "server", fx.second);
  await readonly.fileAt("alice-mm", "server", "main", "big.txt");
  await denied(readonly.commit("bob-mm", "other", fx.first), "repo_not_allowed");
  await denied(readonly.fileAt("bob-mm", "server", "--upload-pack=x\0", "../p\u0001"), "bad_ref");
  await assert.rejects(readonly.branches("bob-mm", "client"));
  const rows = (await audit.rows()).filter((r) => r.principal !== "system");
  assert.deepEqual(
    rows.map((r) => [r.principal, r.tool, r.result]),
    [
      ["alice-mm", "git_file_at", "ok"],
      ["alice-mm", "git_diff", "ok"],
      ["alice-mm", "git_file_at", "ok"],
      ["bob-mm", "git_commit", "denied:repo_not_allowed"],
      ["bob-mm", "git_file_at", "denied:bad_ref"],
      ["bob-mm", "git_branches", "error"],
    ],
  );
  const [first, , big, refused, control] = rows;
  assert.equal(first?.repo, "server");
  assert.equal(first?.ref, "main");
  assert.equal(first?.path, "src/b.txt");
  assert.ok((first?.bytes ?? 0) > 0);
  assert.equal(first?.truncated, false);
  assert.equal(big?.truncated, true);
  assert.equal(refused?.repo, "other");
  assert.equal(refused?.bytes, 0);
  assert.equal(control?.ref, "--upload-pack=x?");
  assert.equal(control?.path, "../p?");
  assert.ok(rows.every((r) => r.at > 0 && r.ms >= 0 && typeof r.at === "number"));
  const stored = JSON.stringify(await audit.rows());
  assert.equal(stored.includes(SECRET), false);
  assert.equal(stored.includes("0123456789abcdef"), false);
  assert.equal(stored.includes("+extra"), false);
  const fetches = (await audit.rows()).filter((r) => r.tool === "git_fetch");
  assert.equal(fetches[0]?.result, "ok");
  assert.equal(fetches[0]?.principal, "system");
});
