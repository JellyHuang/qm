import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { loggingGit } from "./support/fake-git.ts";
import { buildFixture, git, makeRoot, type Fixture } from "./support/fixtures.ts";
import { LFS_OID_ONE, LFS_OID_TWO, buildFilesFixture, type FilesFixture } from "./support/files-fixture.ts";
import { startHarness, testConfig, type Harness } from "./support/harness.ts";

const { root, cleanup } = makeRoot("zqgit-diff-");
const logger = loggingGit(root);
let fx: Fixture;
let ff: FilesFixture;
let h: Harness;

before(async () => {
  fx = buildFixture(root);
  ff = buildFilesFixture(fx);
  h = await startHarness(testConfig(root, fx.remoteBase), { gitBinary: logger.bin });
});
after(async () => {
  await h.stop();
  cleanup();
});

const initial = () => git(fx.work.gameconfig, ["rev-list", "--max-parents=0", "main"]);

interface DiffFile {
  kind: string;
  path: string;
  status: string;
  oldPath?: string;
  oldOid?: string;
  newOid?: string;
  oldCommit?: string;
  newCommit?: string;
  oldSize?: number;
  newSize?: number;
  lfsOid?: string;
  lfsSize?: number;
  oldLfs?: { oid: string; size: number };
  newLfs?: { oid: string; size: number };
  binary?: boolean;
  additions?: number;
  deletions?: number;
  oldMode?: string;
  newMode?: string;
}

const blobFetches = () =>
  logger.calls().filter((call) => call.includes("fetch") && call.includes("origin") && !call.includes("--prune"));

async function diff(args: Record<string, unknown>, harness = h) {
  const out = await harness.call("get_diff", { repo: "gameconfig", ...args });
  assert.equal(out.isError, false, JSON.stringify(out.body));
  return {
    body: out.body,
    files: out.body.files as DiffFile[],
    byPath: new Map((out.body.files as DiffFile[]).map((file) => [file.path, file])),
  };
}

describe("file list without paths", () => {
  test("lists status, object ids and modes and returns no content and no blob fetch", async () => {
    const before = blobFetches().length;
    const { body, byPath } = await diff({ range: ff.c2 });
    assert.equal(byPath.size, 3);
    const app = byPath.get("app.txt");
    assert.equal(app?.status, "M");
    assert.match(app?.oldOid ?? "", /^[0-9a-f]{40}$/);
    assert.match(app?.newOid ?? "", /^[0-9a-f]{40}$/);
    assert.notEqual(app?.oldOid, app?.newOid);
    assert.equal(app?.oldMode, "100644");
    assert.equal(byPath.get("pic.png")?.status, "M");
    assert.equal("diff" in body, false);
    assert.equal(blobFetches().length, before);
  });

  test("a root commit lists every file as added and a range lists the net change", async () => {
    const root1 = await diff({ range: ff.c1 });
    assert.ok(root1.files.every((file) => file.status === "A"));
    assert.ok(root1.byPath.has("配置/说明.txt"));
    assert.equal(root1.body.base, initial());
    const first = await diff({ range: initial() });
    assert.equal(first.body.base, null);
    assert.deepEqual(
      first.files.map((file) => `${file.status} ${file.path}`),
      ["A README.md"],
    );
    const range = await diff({ range: `${ff.c1}..${ff.c3}` });
    assert.deepEqual([...range.byPath.keys()].sort(), ["app.txt", "pic.png", "pointer.bin"]);
    assert.equal(range.body.base, ff.c1);
    assert.equal(range.body.head, ff.c3);
  });

  test("an exact rename is paired by object id", async () => {
    const { files } = await diff({ range: ff.c7 });
    assert.equal(files.length, 1);
    assert.equal(files[0]?.status, "R");
    assert.equal(files[0]?.path, "app-renamed.txt");
    assert.equal(files[0]?.oldPath, "app.txt");
    assert.equal(files[0]?.oldOid, files[0]?.newOid);
  });

  test("a submodule entry is reported as a submodule with its commit and no object ids", async () => {
    const before = blobFetches().length;
    const { byPath } = await diff({ range: ff.c5 });
    const sub = byPath.get("vendor/lib");
    assert.equal(sub?.kind, "submodule");
    assert.equal(sub?.newCommit, ff.submoduleCommit);
    assert.equal(sub?.oldCommit, undefined);
    assert.equal(sub?.newOid, undefined);
    const commit = await h.call("get_commit", { repo: "gameconfig", sha: ff.c5 });
    const listed = (commit.body.files as DiffFile[]).find((file) => file.path === "vendor/lib");
    assert.equal(listed?.kind, "submodule");
    assert.equal(listed?.newCommit, ff.submoduleCommit);
    assert.equal(blobFetches().length, before);
  });
});

describe("unified diff for requested paths", () => {
  test("fetches old and new blobs in one batch and returns the patch with line counts", async () => {
    const before = blobFetches().length;
    const { body, files } = await diff({ range: ff.c2, paths: ["app.txt"] });
    assert.equal(body.matched, 1);
    assert.equal(body.requested, 1);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.additions, 1);
    assert.equal(files[0]?.deletions, 1);
    assert.equal(files[0]?.oldSize, 17);
    assert.equal(files[0]?.newSize, 17);
    const text = body.diff as string;
    assert.match(text, /^diff --git a\/app\.txt b\/app\.txt$/m);
    assert.match(text, /^-beta$/m);
    assert.match(text, /^\+BETA$/m);
    assert.doesNotMatch(text, /pic\.png|pointer/);
    assert.equal(body.diffBytes, Buffer.byteLength(text));
    assert.equal(body.cutBytes, 0);
    assert.equal(body.truncated, false);
    const fetches = blobFetches().slice(before);
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0]?.length ?? 0, (fetches[0]?.indexOf("origin") ?? 0) + 1 + 2);
  });

  test("globs are expanded against the changed files and the count is reported", async () => {
    const txt = await diff({ range: `${ff.c1}..${ff.c4}`, paths: ["*.txt"] });
    assert.equal(txt.body.matched, 3);
    assert.deepEqual([...txt.byPath.keys()].sort(), ["app.txt", "notes.txt", "notes2.txt"]);
    const deep = await diff({ range: ff.c2, paths: ["**/*.png", "app.*"] });
    assert.equal(deep.body.matched, 2);
    const unicode = await diff({ range: ff.c1, paths: ["配置/*.txt"] });
    assert.equal(unicode.body.matched, 1);
    assert.match(unicode.body.diff as string, /\+中文说明/);
    const none = await diff({ range: ff.c2, paths: ["nothing/*"] });
    assert.equal(none.body.matched, 0);
    assert.deepEqual(none.files, []);
  });

  test("binary files are reported as changed with sizes only", async () => {
    const { body, files } = await diff({ range: ff.c2, paths: ["pic.png"] });
    assert.equal(files[0]?.binary, true);
    assert.equal(files[0]?.oldSize, 5008);
    assert.equal(files[0]?.newSize, 5011);
    assert.equal(files[0]?.additions, undefined);
    assert.match(body.diff as string, /Binary files a\/pic\.png and b\/pic\.png differ/);
  });

  test("changed LFS pointers are reported as lfs_pointer changes and not as a text patch", async () => {
    const { body, files } = await diff({ range: ff.c2, paths: ["pointer.bin"] });
    assert.equal(files[0]?.kind, "lfs_pointer");
    assert.equal(files[0]?.lfsOid, LFS_OID_TWO);
    assert.equal(files[0]?.lfsSize, 654321);
    assert.deepEqual(files[0]?.oldLfs, { oid: LFS_OID_ONE, size: 123456 });
    assert.deepEqual(files[0]?.newLfs, { oid: LFS_OID_TWO, size: 654321 });
    assert.equal(body.diff, "");
  });

  test("a file with real content under an LFS attributed path gets a normal patch", async () => {
    const { body, files } = await diff({ range: ff.c6, paths: ["real.bin"] });
    assert.equal(files[0]?.kind, "file");
    assert.match(body.diff as string, /^\+real content changed$/m);
  });

  test("submodules are reported without fetching and a rename has no patch", async () => {
    const before = blobFetches().length;
    const sub = await diff({ range: ff.c5, paths: ["vendor/lib"] });
    assert.equal(sub.files[0]?.kind, "submodule");
    assert.equal(sub.body.diff, "");
    assert.equal(blobFetches().length, before);
    const renamed = await diff({ range: ff.c7, paths: ["app-renamed.txt"] });
    assert.equal(renamed.files[0]?.status, "R");
    assert.equal(renamed.files[0]?.additions, 0);
    assert.equal(renamed.body.diff, "");
  });

  test("a root commit diffs against the empty tree", async () => {
    const { body } = await diff({ range: initial(), paths: ["README.md"] });
    assert.match(body.diff as string, /^\+# gameconfig$/m);
    assert.match(body.diff as string, /new file mode/);
  });

  test("a long patch is cut at the response limit and the total is reported", async () => {
    const small = await startHarness(
      testConfig(root, fx.remoteBase, { truncateChars: 3000, clonesDir: join(root, "small-diff-clones") }),
    );
    try {
      const { body } = await diff({ range: ff.c1, paths: ["**/*"] }, small);
      assert.equal(body.truncated, true);
      assert.ok((body.cutBytes as number) > 0);
      assert.ok((body.diffBytes as number) > Buffer.byteLength(body.diff as string));
      assert.equal((body.diffBytes as number) - (body.cutBytes as number), Buffer.byteLength(body.diff as string));
      assert.ok(JSON.stringify(body).length <= 3000);
    } finally {
      await small.stop();
    }
  });
});

describe("refusals", () => {
  test("hostile ranges and paths are refused before any process starts", async () => {
    const started = logger.calls().length;
    const cases: [Record<string, unknown>, string][] = [
      [{ range: "a..b..c" }, "bad_range"],
      [{ range: "--output=x..main" }, "bad_ref"],
      [{ range: "main..--help" }, "bad_ref"],
      [{ range: "main", paths: ["../x"] }, "bad_path"],
      [{ range: "main", paths: ["/etc/passwd"] }, "bad_path"],
      [{ range: "main", paths: [] }, "bad_path"],
      [{ range: "main", url: "x" }, "bad_arguments"],
    ];
    for (const [args, reason] of cases) {
      const out = await h.call("get_diff", { repo: "gameconfig", ...args });
      assert.equal((out.body.error as { code: string }).code, reason, JSON.stringify(args));
    }
    assert.equal(logger.calls().length, started);
  });

  test("an unknown revision is refused as not found and the audit holds no patch content", async () => {
    const out = await h.call("get_diff", { repo: "gameconfig", range: "nosuchbranch" });
    assert.equal((out.body.error as { code: string }).code, "not_found");
    const dump = JSON.stringify(h.audit.rows());
    for (const content of ["BETA", "alpha", "中文说明", "real content"]) assert.equal(dump.includes(content), false);
  });
});
