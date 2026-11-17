import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildFixture, git, makeRoot, type Fixture } from "./support/fixtures.ts";
import { buildFilesFixture, type FilesFixture } from "./support/files-fixture.ts";
import { startHarness, testConfig, type Harness } from "./support/harness.ts";

const { root, cleanup } = makeRoot("zqgit-bitmap-");
let fx: Fixture;
let ff: FilesFixture;
let h: Harness;

before(async () => {
  fx = buildFixture(root);
  ff = buildFilesFixture(fx);
  const bare = join(fx.remotes, "gameconfig.git");
  git(bare, ["config", "pack.writeBitmaps", "true"]);
  git(bare, ["repack", "-a", "-d", "-b"]);
  h = await startHarness(testConfig(root, fx.remoteBase));
});
after(async () => {
  await h.stop();
  cleanup();
});

test("read_file, get_diff and blame all succeed against a bitmap packed server", async () => {
  const file = await h.call("read_file", { repo: "gameconfig", ref: ff.c3, path: "app.txt" });
  assert.equal(file.isError, false, JSON.stringify(file.body));
  assert.equal(file.body.content, "alpha\nBETA\ngamma\ndelta");
  const diff = await h.call("get_diff", { repo: "gameconfig", range: ff.c2, paths: ["app.txt", "pic.png"] });
  assert.equal(diff.isError, false, JSON.stringify(diff.body));
  assert.match(diff.body.diff as string, /^\+BETA$/m);
  const blame = await h.call("blame", { repo: "gameconfig", ref: ff.c3, path: "app.txt", startLine: 1, endLine: 4 });
  assert.equal(blame.isError, false, JSON.stringify(blame.body));
  assert.equal((blame.body.lines as unknown[]).length, 4);
});
