import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchCompleteDiff } from "../src/zq/patch-package/diff-source.ts";
import { PatchPackageError } from "../src/zq/patch-package/settings.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);

function fakeClient(sizes: Record<string, number>, whole = false) {
  const calls: string[][] = [];
  return {
    calls,
    client: {
      call: async (_tool: string, args: Record<string, unknown>) => {
        const paths = args.paths as string[];
        calls.push(paths);
        const cut = paths.length > 1 ? whole : paths.some((p) => (sizes[p] ?? 0) > 100);
        return {
          base,
          head,
          files: paths.map((path) => ({ kind: "file", path, status: "M" })),
          diff: cut ? "diff --git a/x b/x\n+partial" : paths.map((p) => `diff --git a/${p} b/${p}\n+change`).join("\n"),
          truncated: cut,
        };
      },
    },
  };
}

test("a complete get_diff answer is used as it is", async () => {
  const { client, calls } = fakeClient({});
  const result = await fetchCompleteDiff(
    client,
    { repo: "gameconfig", range: `${base}..${head}`, paths: ["a.txt", "b.txt"] },
    "qm",
  );
  assert.equal(result.truncated, false);
  assert.equal(calls.length, 1);
  assert.match(result.diff, /a\/a\.txt[\s\S]*a\/b\.txt/);
});

test("a truncated answer is re-fetched one path at a time and stitched together", async () => {
  const { client, calls } = fakeClient({}, true);
  const result = await fetchCompleteDiff(
    client,
    { repo: "gameconfig", range: `${base}..${head}`, paths: ["a.txt", "b.txt"] },
    "qm",
  );
  assert.deepEqual(calls, [["a.txt", "b.txt"], ["a.txt"], ["b.txt"]]);
  assert.equal(result.truncated, false);
  assert.equal(result.base, base);
  assert.equal(result.files.length, 2);
  assert.ok(result.diff.endsWith("\n"));
});

test("a single path that still does not fit is refused, as are wildcards", async () => {
  const { client } = fakeClient({ "big.txt": 1000 });
  await assert.rejects(
    fetchCompleteDiff(client, { repo: "r", range: head, paths: ["big.txt"] }, "qm"),
    (e: unknown) => e instanceof PatchPackageError && e.code === "truncated_diff",
  );
  const whole = fakeClient({ "big.txt": 1000 }, true);
  await assert.rejects(
    fetchCompleteDiff(whole.client, { repo: "r", range: head, paths: ["ok.txt", "big.txt"] }, "qm"),
    (e: unknown) => e instanceof PatchPackageError && e.code === "truncated_diff" && /big\.txt/.test(e.message),
  );
  await assert.rejects(
    fetchCompleteDiff(client, { repo: "r", range: head, paths: ["*.txt"] }, "qm"),
    /without wildcards/,
  );
});
