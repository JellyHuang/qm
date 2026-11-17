import assert from "node:assert/strict";
import { after, test } from "node:test";
import { assertGitVersion, gitVersionSupported, parseGitVersion } from "../src/git-version.ts";
import { createGitRunner } from "../src/runner.ts";
import { fakeGit } from "./support/fake-git.ts";
import { makeRoot } from "./support/fixtures.ts";
import { startHarness, testConfig } from "./support/harness.ts";

const { root, cleanup } = makeRoot("zqgit-version-");
after(cleanup);

const printing = (text: string) => fakeGit(root, `echo '${text}'`);

test("the version parser reads common git version strings", () => {
  assert.deepEqual(parseGitVersion("git version 2.47.1"), { major: 2, minor: 47 });
  assert.deepEqual(parseGitVersion("git version 2.39.5 (Apple Git-154)"), { major: 2, minor: 39 });
  assert.deepEqual(parseGitVersion("git version 2.44.0.windows.1"), { major: 2, minor: 44 });
  assert.equal(parseGitVersion("not git"), undefined);
});

test("versions below 2.44 are unsupported and 2.44 and later are accepted", () => {
  assert.equal(gitVersionSupported({ major: 2, minor: 43 }), false);
  assert.equal(gitVersionSupported({ major: 1, minor: 99 }), false);
  assert.equal(gitVersionSupported({ major: 2, minor: 44 }), true);
  assert.equal(gitVersionSupported({ major: 2, minor: 52 }), true);
  assert.equal(gitVersionSupported({ major: 3, minor: 0 }), true);
});

test("the gate rejects an old or unreadable git and accepts a new one", async () => {
  await assert.rejects(
    assertGitVersion(createGitRunner({ gitBinary: printing("git version 2.43.0") })),
    /2\.43 is too old: 2\.44 or newer/,
  );
  await assert.rejects(
    assertGitVersion(createGitRunner({ gitBinary: printing("hello") })),
    /cannot read the git version/,
  );
  await assertGitVersion(createGitRunner({ gitBinary: printing("git version 2.44.0") }));
  await assertGitVersion(createGitRunner());
});

test("the service refuses to start on an old git", async () => {
  await assert.rejects(
    startHarness(testConfig(root, `file://${root}/none/`), { gitBinary: printing("git version 2.40.1") }),
    /too old/,
  );
});
