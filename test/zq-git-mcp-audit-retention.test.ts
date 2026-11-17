import assert from "node:assert/strict";
import { test } from "node:test";
import { GIT_AUDIT_RETENTION_DAYS, gitAuditCutoff, pruneGitAudit } from "../src/zq/git-mcp/audit-retention.ts";

const NOW = Date.UTC(2026, 10, 16);

test("audit rows are kept for 180 days and the cutoff is an epoch millisecond", () => {
  assert.equal(GIT_AUDIT_RETENTION_DAYS, 180);
  assert.equal(gitAuditCutoff(NOW), NOW - 180 * 86_400_000);
  assert.equal(gitAuditCutoff(NOW, 30), NOW - 30 * 86_400_000);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => gitAuditCutoff(NOW, bad), /whole number of days/);
});

test("pruning asks the durable map to delete rows whose at is before the cutoff and nothing else", async () => {
  const calls: [string, number][] = [];
  const cutoff = await pruneGitAudit({ deleteBefore: async (field, at) => void calls.push([field, at]) }, NOW);
  assert.deepEqual(calls, [["at", NOW - 180 * 86_400_000]]);
  assert.equal(cutoff, NOW - 180 * 86_400_000);
});

test("a failing prune is raised to its caller", async () => {
  await assert.rejects(
    pruneGitAudit(
      {
        deleteBefore: async () => {
          throw new Error("database down");
        },
      },
      NOW,
    ),
    /database down/,
  );
});
