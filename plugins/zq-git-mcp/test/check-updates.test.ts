import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { createMemoryTipStore } from "../src/tip-store.ts";
import { loggingGit } from "./support/fake-git.ts";
import { ALICE, BOB, buildFixture, commitAll, git, makeRoot, type Fixture } from "./support/fixtures.ts";
import { startHarness, testConfig, type Harness } from "./support/harness.ts";

const { root, cleanup } = makeRoot("zqgit-updates-");
const logger = loggingGit(root);
let fx: Fixture;
let h: Harness;
const tips = createMemoryTipStore();

before(async () => {
  fx = buildFixture(root);
  h = await startHarness(testConfig(root, fx.remoteBase), { gitBinary: logger.bin });
});
after(async () => {
  await h.stop();
  cleanup();
});

interface Update {
  branch: string;
  status: string;
  oldTip?: string;
  newTip?: string;
  commits: { sha: string; authorName: string; authorEmail: string; date: string; subject: string; branch: string }[];
  partial?: boolean;
}
interface RepoResult {
  repo: string;
  status: string;
  error?: string;
  branches?: number;
  updates: Update[];
}

async function check(args: Record<string, unknown> = {}, harness = h) {
  const out = await harness.call("check_updates", args);
  assert.equal(out.isError, false, JSON.stringify(out.body));
  const repos = out.body.repos as RepoResult[];
  return { repos, byName: new Map(repos.map((r) => [r.repo, r])), body: out.body };
}

const blobFetches = () =>
  logger.calls().filter((call) => call.includes("fetch") && call.includes("origin") && !call.includes("--prune"))
    .length;

function push(work: string, args: string[]) {
  git(work, ["push", "-q", "origin", ...args]);
}

describe("first observation and quiet polls", () => {
  test("the first poll of all seven repositories only records tips and clones nothing", async () => {
    const { repos } = await check();
    assert.equal(repos.length, 7);
    assert.ok(repos.every((r) => r.status === "first_run" && r.updates.length === 0));
    assert.equal(repos.find((r) => r.repo === "client")?.branches, 2);
    const listed = await h.call("list_repos", {});
    assert.ok((listed.body.repos as { cloned: boolean }[]).every((r) => !r.cloned));
    assert.equal(blobFetches(), 0);
  });

  test("a poll with nothing new reports unchanged for every repository", async () => {
    const { repos } = await check();
    assert.ok(repos.every((r) => r.status === "unchanged"));
  });
});

describe("changes", () => {
  test("new commits are listed oldest first with metadata, a new branch reports its tip and a deleted branch is reported", async () => {
    const work = fx.work.client;
    const before = git(work, ["rev-parse", "main"]);
    writeFileSync(join(work, "u1.txt"), "1\n");
    const c1 = commitAll(work, "update one", ALICE, "2024-11-01T10:00:00Z");
    writeFileSync(join(work, "u2.txt"), "2\n");
    const c2 = commitAll(work, "update two", BOB, "2024-11-02T10:00:00Z");
    git(work, ["checkout", "-q", "-b", "feature/two"]);
    writeFileSync(join(work, "t.txt"), "t\n");
    const tip = commitAll(work, "branch tip", BOB, "2024-11-03T10:00:00Z");
    git(work, ["checkout", "-q", "main"]);
    push(work, ["main", "feature/two"]);
    push(work, ["--delete", "feature/login"]);
    const { byName } = await check({ repo: "client" });
    const client = byName.get("client");
    assert.equal(client?.status, "changed");
    const updates = new Map(client?.updates.map((u) => [u.branch, u]));
    const main = updates.get("main");
    assert.equal(main?.status, "updated");
    assert.equal(main?.oldTip, before);
    assert.equal(main?.newTip, c2);
    assert.deepEqual(
      main?.commits.map((c) => c.sha),
      [c1, c2],
    );
    assert.deepEqual(main?.commits[1], {
      sha: c2,
      authorName: BOB.name,
      authorEmail: BOB.email,
      date: "2024-11-02T10:00:00Z",
      subject: "update two",
      branch: "main",
    });
    const added = updates.get("feature/two");
    assert.equal(added?.status, "new");
    assert.deepEqual(
      added?.commits.map((c) => c.sha),
      [tip],
    );
    assert.equal(updates.get("feature/login")?.status, "deleted");
    assert.equal(updates.get("feature/login")?.oldTip, fx.client.featureTip);
    assert.equal(blobFetches(), 0);
    const again = await check({ repo: "client" });
    assert.equal(again.byName.get("client")?.status, "unchanged");
  });

  test("concurrent callers do not both report the same commits", async () => {
    const work = fx.work.server;
    await check({ repo: "server" });
    writeFileSync(join(work, "c.txt"), "c\n");
    commitAll(work, "concurrent", ALICE, "2024-12-01T10:00:00Z");
    push(work, ["main"]);
    const results = await Promise.all([
      check({ repo: "server" }),
      check({ repo: "server" }),
      check({ repo: "server" }),
    ]);
    const reported = results.flatMap((r) => r.byName.get("server")?.updates ?? []).flatMap((u) => u.commits);
    assert.equal(reported.length, 1);
    assert.equal(reported[0]?.subject, "concurrent");
    assert.equal(results.filter((r) => r.byName.get("server")?.status === "changed").length, 1);
  });

  test("a rewritten branch is reported as rewritten and never as no updates", async () => {
    const work = fx.work.clientcode;
    await check({ repo: "clientcode" });
    writeFileSync(join(work, "r.txt"), "r\n");
    commitAll(work, "to be dropped", ALICE, "2024-12-02T10:00:00Z");
    push(work, ["main"]);
    await check({ repo: "clientcode" });
    git(work, ["reset", "-q", "--hard", "HEAD~1"]);
    push(work, ["--force", "main"]);
    const { byName } = await check({ repo: "clientcode" });
    const update = byName.get("clientcode")?.updates[0];
    assert.equal(update?.status, "rewritten");
    assert.equal(update?.commits.length, 1);
    assert.equal(update?.commits[0]?.sha, update?.newTip);
  });

  test("the response is cut by size without losing commits: the stored tip only advances over what was reported", async () => {
    const work = fx.work.gameconfig;
    const small = await startHarness(
      testConfig(root, fx.remoteBase, { truncateChars: 5000, clonesDir: join(root, "small-updates") }),
      { tips: createMemoryTipStore() },
    );
    try {
      await check({ repo: "gameconfig" }, small);
      const made: string[] = [];
      for (let i = 0; i < 60; i++) {
        writeFileSync(join(work, "bulk.txt"), `${i}\n`);
        made.push(
          commitAll(work, `bulk ${i} ${"m".repeat(100)}`, ALICE, `2025-01-01T10:${String(i).padStart(2, "0")}:00Z`),
        );
      }
      push(work, ["main"]);
      const seen: string[] = [];
      let rounds = 0;
      for (; rounds < 20; rounds++) {
        const { byName } = await check({ repo: "gameconfig" }, small);
        const result = byName.get("gameconfig");
        if (result?.status === "unchanged") break;
        const update = result?.updates[0];
        assert.ok(update && update.commits.length > 0);
        seen.push(...update.commits.map((c) => c.sha));
        if (rounds === 0) assert.equal(update.partial, true);
      }
      assert.ok(rounds > 1);
      assert.deepEqual(seen, made);
    } finally {
      await small.stop();
    }
  });
});

describe("failures and refusals", () => {
  test("an unreachable remote is a visible per repository error, the stored tips are kept", async () => {
    const store = createMemoryTipStore();
    await store.put("client", "main", "a".repeat(40), 1);
    const broken = await startHarness(
      testConfig(root, `file://${root}/missing/`, { clonesDir: join(root, "broken-updates") }),
      {
        tips: store,
      },
    );
    try {
      const { byName } = await check({ repo: "client" }, broken);
      assert.equal(byName.get("client")?.status, "error");
      assert.match(byName.get("client")?.error ?? "", /ls-remote|exited with/);
      assert.equal((await store.list("client")).get("main")?.tip, "a".repeat(40));
      const all = await check({}, broken);
      assert.ok(all.repos.every((r) => r.status === "error"));
    } finally {
      await broken.stop();
    }
  });

  test("an unknown repository is refused and the audit holds only the caller label and arguments", async () => {
    const out = await h.call("check_updates", { repo: "qm-test" }, "poller");
    assert.equal((out.body.error as { code: string }).code, "repo_not_allowed");
    const row = h.audit.rows().find((entry) => entry.caller === "poller");
    assert.equal(row?.result, "refused:repo_not_allowed");
    const ok = h.audit.rows().find((entry) => entry.tool === "check_updates" && entry.result === "ok");
    assert.ok(ok);
    assert.equal(JSON.stringify(h.audit.rows()).includes("update two"), false);
  });
});

test("the tip store is per repository and branch", async () => {
  await tips.put("client", "main", "x".repeat(40), 5);
  await tips.put("client", "dev", "y".repeat(40), 6);
  await tips.put("server", "main", "z".repeat(40), 7);
  assert.deepEqual([...(await tips.list("client")).keys()].sort(), ["dev", "main"]);
  await tips.delete("client", "dev");
  assert.deepEqual([...(await tips.list("client")).keys()], ["main"]);
  assert.equal((await tips.list("server")).get("main")?.tip, "z".repeat(40));
});
