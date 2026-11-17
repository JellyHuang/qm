import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { loggingGit } from "./support/fake-git.ts";
import { ALICE, BOB, buildFixture, commitAll, makeRoot, pushAll, type Fixture } from "./support/fixtures.ts";
import { buildFilesFixture, type FilesFixture } from "./support/files-fixture.ts";
import { startHarness, testConfig, type Harness } from "./support/harness.ts";

const { root, cleanup } = makeRoot("zqgit-blame-");
const logger = loggingGit(root);
let fx: Fixture;
let ff: FilesFixture;
let h: Harness;

before(async () => {
  fx = buildFixture(root);
  ff = buildFilesFixture(fx);
  const long = fx.work.server;
  writeFileSync(
    join(long, "long.txt"),
    Array.from({ length: 3000 }, (_, i) => `row ${i + 1} ${"y".repeat(60)}`).join("\n") + "\n",
  );
  commitAll(long, "long file", ALICE, "2024-09-01T10:00:00Z");
  pushAll(long);
  h = await startHarness(testConfig(root, fx.remoteBase), { gitBinary: logger.bin });
});
after(async () => {
  await h.stop();
  cleanup();
});

interface Row {
  line: number;
  sha: string;
  author: string;
  date: string;
  text: string;
}

async function blame(args: Record<string, unknown>, harness = h, repo = "gameconfig") {
  return harness.call("blame", { repo, ...args });
}

describe("blame", () => {
  test("attributes each line to the commit that last changed it and prefetches the history in one batch", async () => {
    const out = await blame({ ref: ff.c3, path: "app.txt", startLine: 1, endLine: 4 });
    assert.equal(out.isError, false, JSON.stringify(out.body));
    const lines = out.body.lines as Row[];
    assert.deepEqual(
      lines.map((row) => [row.line, row.text, row.sha, row.author]),
      [
        [1, "alpha", ff.c1, ALICE.name],
        [2, "BETA", ff.c2, BOB.name],
        [3, "gamma", ff.c1, ALICE.name],
        [4, "delta", ff.c3, ALICE.name],
      ],
    );
    assert.equal(lines[1]?.date, "2024-03-01T10:00:00.000Z");
    assert.equal(out.body.prefetched, 3);
    assert.equal(out.body.lazyFetches, 0);
    assert.ok((out.body.seconds as number) >= 0);
    assert.equal(out.body.truncated, false);
    assert.equal(out.body.cutLines, 0);
  });

  test("honours the line range and non-ASCII paths", async () => {
    const part = await blame({ ref: ff.c3, path: "app.txt", startLine: 2, endLine: 3 });
    assert.deepEqual(
      (part.body.lines as Row[]).map((row) => row.text),
      ["BETA", "gamma"],
    );
    const zh = await blame({ ref: "main", path: "配置/说明.txt", startLine: 1, endLine: 2 });
    assert.deepEqual(
      (zh.body.lines as Row[]).map((row) => [row.text, row.sha]),
      [
        ["中文说明", ff.c1],
        ["第二行", ff.c1],
      ],
    );
  });

  test("follows a rename through lazy fetches and counts them", async () => {
    const out = await blame({ ref: ff.c4, path: "notes2.txt", startLine: 1, endLine: 10 });
    assert.equal(out.isError, false, JSON.stringify(out.body));
    const lines = out.body.lines as Row[];
    assert.equal(lines[0]?.sha, ff.c1);
    assert.equal(lines[8]?.sha, ff.c1);
    assert.equal(lines[9]?.sha, ff.c4);
    assert.ok((out.body.lazyFetches as number) >= 1);
  });

  test("refuses ranges outside the file, directories, submodules and missing paths", async () => {
    const beyond = await blame({ ref: ff.c3, path: "app.txt", startLine: 5, endLine: 9 });
    assert.equal((beyond.body.error as { code: string }).code, "bad_range");
    const dir = await blame({ ref: ff.c5, path: "配置", startLine: 1, endLine: 1 });
    assert.equal((dir.body.error as { code: string }).code, "not_a_file");
    const sub = await blame({ ref: ff.c5, path: "vendor/lib", startLine: 1, endLine: 1 });
    assert.equal((sub.body.error as { code: string }).code, "not_a_file");
    const missing = await blame({ ref: ff.c3, path: "nope.txt", startLine: 1, endLine: 1 });
    assert.equal((missing.body.error as { code: string }).code, "not_found");
  });

  test("hostile arguments are refused before any process starts", async () => {
    const started = logger.calls().length;
    for (const [args, reason] of [
      [{ ref: "--x", path: "a", startLine: 1, endLine: 2 }, "bad_ref"],
      [{ ref: "main", path: "../a", startLine: 1, endLine: 2 }, "bad_path"],
      [{ ref: "main", path: "a", startLine: 0, endLine: 2 }, "bad_number"],
      [{ ref: "main", path: "a", startLine: 5, endLine: 2 }, "bad_number"],
      [{ ref: "main", path: "a", startLine: 1 }, "bad_arguments"],
    ] as const) {
      const out = await blame(args);
      assert.equal((out.body.error as { code: string }).code, reason, JSON.stringify(args));
    }
    assert.equal(logger.calls().length, started);
  });

  test("a long range is cut at the response limit and the cut lines are counted", async () => {
    const small = await startHarness(
      testConfig(root, fx.remoteBase, { truncateChars: 8000, clonesDir: join(root, "small-blame-clones") }),
    );
    try {
      const out = await blame({ ref: "main", path: "long.txt", startLine: 1, endLine: 3000 }, small, "server");
      assert.equal(out.isError, false, JSON.stringify(out.body).slice(0, 300));
      const lines = out.body.lines as Row[];
      assert.equal(out.body.truncated, true);
      assert.ok(lines.length > 5 && lines.length < 3000);
      assert.equal(lines.length + (out.body.cutLines as number), 3000);
      assert.ok(JSON.stringify(out.body).length <= 8000);
    } finally {
      await small.stop();
    }
  });

  test("the audit records the call without any file content", async () => {
    const row = h.audit.rows().find((entry) => entry.tool === "blame" && entry.result === "ok");
    assert.equal(row?.repo, "gameconfig");
    const dump = JSON.stringify(h.audit.rows());
    for (const content of ["alpha", "BETA", "中文说明", "note number"]) assert.equal(dump.includes(content), false);
  });
});
