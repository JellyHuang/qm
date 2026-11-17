import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
    assertGitVersion(createGitRunner({ gitBinary: printing("git version 2.43.0") }), "/opt/old/git"),
    /git 2\.43 \(\/opt\/old\/git\) is too old: 2\.44 or newer/,
  );
  await assert.rejects(
    assertGitVersion(createGitRunner({ gitBinary: printing("hello") }), "/x/git"),
    /cannot read the git version/,
  );
  assert.deepEqual(
    await assertGitVersion(createGitRunner({ gitBinary: printing("git version 2.44.0") }), "/opt/new/git"),
    {
      binary: "/opt/new/git",
      version: "2.44",
    },
  );
  await assertGitVersion(createGitRunner(), "git");
});

test("the service refuses to start on an old git", async () => {
  await assert.rejects(
    startHarness(testConfig(root, `file://${root}/none/`), { gitBinary: printing("git version 2.40.1") }),
    /too old/,
  );
});

test("the git binary in use is checked, reported in list_repos and its directory is first on the child PATH", async () => {
  const log = join(root, "service-path");
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = fakeGit(
    root,
    `case " $* " in *" --version "*) echo "git version 2.50.1";; *) printf '%s\\n' "$PATH" >> ${log}; exec ${real} "$@";; esac`,
  );
  const config = testConfig(root, `file://${root}/none/`, {
    gitBin: bin,
    childPath: `${dirname(bin)}:/usr/local/bin:/usr/bin:/bin`,
    clonesDir: join(root, "gitbin-clones"),
  });
  const h = await startHarness(config);
  try {
    const repos = await h.call("list_repos", {});
    assert.deepEqual(repos.body.git, { binary: bin, version: "2.50" });
    await h.call("list_commits", { repo: "client", limit: 1 });
    assert.ok(
      readFileSync(log, "utf8")
        .split("\n")[0]
        ?.startsWith(`${dirname(bin)}:`),
    );
  } finally {
    await h.stop();
  }
  const old = testConfig(root, `file://${root}/none/`, { gitBin: printing("git version 2.40.1") });
  await assert.rejects(
    startHarness(old),
    new RegExp(`git 2\\.40 \\(${old.gitBin?.replaceAll(".", "\\.")}\\) is too old`),
  );
});
