import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommitBatch } from "../src/zq/git-mcp/poller.ts";
import { dedupeBySha, type CommitSink } from "../src/zq/git-mcp/sink.ts";
import { fakeCommit } from "./support/fake-git-mcp.ts";

const batch = (repo: string, branch: string, ...shas: string[]): CommitBatch => ({
  repo,
  branch,
  status: "updated",
  commits: shas.map((sha) => fakeCommit(sha)),
});

function inner(failures = 0) {
  const received: string[] = [];
  let left = failures;
  const sink: CommitSink = {
    async record(batches) {
      if (left-- > 0) throw new Error("down");
      for (const b of batches) for (const c of b.commits) received.push(`${b.repo}:${c.sha}`);
    },
  };
  return { sink, received };
}

test("the same batch delivered twice, as after a failed ack, reaches the inner sink once per sha", async () => {
  const { sink, received } = inner();
  const deduped = dedupeBySha(sink, 100);
  const batches = [batch("client", "main", "a", "b"), batch("server", "main", "c")];
  await deduped.record(batches);
  await deduped.record(batches);
  assert.deepEqual(received, ["client:a", "client:b", "server:c"]);
});

test("a sha seen on two branches of one repo is recorded once, and a repeated batch with only old shas is dropped whole", async () => {
  const { sink, received } = inner();
  const deduped = dedupeBySha(sink, 100);
  await deduped.record([batch("client", "main", "a"), batch("client", "release", "a", "b")]);
  assert.deepEqual(received, ["client:a", "client:b"]);
});

test("a batch without commits, such as a deleted branch, still reaches the sink", async () => {
  const seen: CommitBatch[][] = [];
  const deduped = dedupeBySha({ record: async (b) => void seen.push([...b]) }, 10);
  const deleted: CommitBatch = { ...batch("client", "gone"), status: "deleted" };
  await deduped.record([deleted]);
  assert.equal(seen[0]![0]!.branch, "gone");
});

test("a sink that failed has not seen the commits, so the retry reaches it", async () => {
  const { sink, received } = inner(1);
  const deduped = dedupeBySha(sink, 100);
  await assert.rejects(deduped.record([batch("client", "main", "a")]), /down/);
  await deduped.record([batch("client", "main", "a")]);
  assert.deepEqual(received, ["client:a"]);
});

test("memory is bounded: the least recently seen shas are forgotten first", async () => {
  const { sink, received } = inner();
  const deduped = dedupeBySha(sink, 2);
  await deduped.record([batch("r", "main", "a")]);
  await deduped.record([batch("r", "main", "b")]);
  await deduped.record([batch("r", "main", "a")]);
  await deduped.record([batch("r", "main", "c")]);
  await deduped.record([batch("r", "main", "a")]);
  await deduped.record([batch("r", "main", "b")]);
  assert.deepEqual(received, ["r:a", "r:b", "r:c", "r:b"]);
});

test("a capacity below one is refused", () => {
  assert.throws(() => dedupeBySha(inner().sink, 0), /capacity/);
});
