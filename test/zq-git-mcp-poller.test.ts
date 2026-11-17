import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sweeper } from "../src/util/sweeper.ts";
import {
  GitMcpError,
  GitMcpUnreachable,
  type AckEntry,
  type BranchUpdate,
  type RepoUpdates,
  type UpdatesResponse,
} from "../src/zq/git-mcp/client.ts";
import { POLL_INTERVAL_MS, createGitCommitPoller, type CommitBatch, type PollError } from "../src/zq/git-mcp/poller.ts";

const commit = (sha: string) => ({
  sha,
  authorName: "A",
  authorEmail: "a@corp.example",
  date: "2025-01-01T00:00:00Z",
  subject: sha,
  branch: "main",
});

function service(rounds: BranchUpdate[][]) {
  let acked = 0;
  const calls: AckEntry[][] = [];
  const state = { down: false, repoError: false };
  return {
    state,
    calls,
    acked: () => acked,
    async checkUpdates(_caller: string, ack: readonly AckEntry[] = []): Promise<UpdatesResponse> {
      calls.push([...ack]);
      if (state.down) throw new GitMcpUnreachable("connect ECONNREFUSED");
      if (ack.length > 0) acked += ack.length;
      const updates = rounds[acked] ?? [];
      const repos: RepoUpdates[] = [
        { repo: "client", status: updates.length ? "changed" : "unchanged", updates },
        ...(state.repoError ? [{ repo: "server", status: "error" as const, error: "ls-remote failed" }] : []),
      ];
      return {
        repos,
        ack: updates.map((update) => ({
          repo: "client",
          branch: update.branch,
          from: "a".repeat(40),
          to: update.newTip ?? null,
        })),
        acknowledged: ack.length,
      };
    },
  };
}

const update = (sha: string): BranchUpdate => ({
  branch: "main",
  status: "updated",
  newTip: sha.repeat(40).slice(0, 40),
  commits: [commit(sha)],
});

function fakeSweeper() {
  const seen: { intervalMs: number; label?: string }[] = [];
  const state = { started: 0, stopped: 0, work: undefined as undefined | (() => unknown) };
  const create = (work: () => unknown, intervalMs: number, opts?: { label?: string }): Sweeper => {
    state.work = work;
    seen.push({ intervalMs, ...(opts?.label ? { label: opts.label } : {}) });
    return {
      start: () => void state.started++,
      stop: async () => void state.stopped++,
    };
  };
  return { create, seen, state };
}

function build(svc: ReturnType<typeof service>, handle: (batches: CommitBatch[]) => Promise<void>) {
  const errors: PollError[] = [];
  const sweeper = fakeSweeper();
  const poller = createGitCommitPoller({
    client: svc,
    caller: "zq-poller",
    handle,
    onError: (error) => errors.push(error),
    createSweeper: sweeper.create,
  });
  return { poller, errors, sweeper };
}

test("the poller is scheduled every five minutes through the injected scheduler and does nothing until started", async () => {
  const svc = service([]);
  const { poller, sweeper } = build(svc, async () => undefined);
  assert.deepEqual(sweeper.seen, [{ intervalMs: POLL_INTERVAL_MS, label: "zq git commit poller" }]);
  assert.equal(POLL_INTERVAL_MS, 300_000);
  assert.equal(sweeper.state.started, 0);
  assert.equal(svc.calls.length, 0);
  poller.start();
  assert.equal(sweeper.state.started, 1);
  await sweeper.state.work?.();
  assert.equal(svc.calls.length, 1);
  await poller.stop();
  assert.equal(sweeper.state.stopped, 1);
});

test("new commits go to the handler and the acknowledgement is sent only after it succeeded", async () => {
  const svc = service([[update("a")], [update("b")]]);
  const order: string[] = [];
  const { poller, errors } = build(svc, async (batches) => {
    order.push(
      `handled ${batches.flatMap((b) => b.commits.map((c) => c.sha)).join(",")} after ${svc.calls.length} polls, ${svc.acked()} acked`,
    );
  });
  const outcome = await poller.tick();
  assert.deepEqual(order, ["handled a after 1 polls, 0 acked", "handled b after 2 polls, 1 acked"]);
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.delivered, 2);
  assert.deepEqual(
    svc.calls.map((ack) => ack.length),
    [0, 1, 1],
  );
  assert.deepEqual(errors, []);
});

test("a failing handler means no acknowledgement and the same commits are offered again", async () => {
  const svc = service([[update("a")]]);
  let attempts = 0;
  const { poller, errors } = build(svc, async () => {
    if (++attempts === 1) throw new Error("mattermost is down");
  });
  const first = await poller.tick();
  assert.equal(first.status, "handler_failed");
  assert.equal(svc.acked(), 0);
  assert.deepEqual(
    errors.map((e) => [e.kind, e.message]),
    [["handler", "mattermost is down"]],
  );
  assert.deepEqual(
    svc.calls.map((ack) => ack.length),
    [0],
  );
  const second = await poller.tick();
  assert.equal(second.status, "ok");
  assert.equal(attempts, 2);
  assert.equal(svc.acked(), 1);
});

test("an unreachable service is a visible error and never a quiet no updates", async () => {
  const svc = service([[update("a")]]);
  svc.state.down = true;
  let handled = 0;
  const { poller, errors } = build(svc, async () => void handled++);
  const outcome = await poller.tick();
  assert.equal(outcome.status, "errors");
  assert.equal(handled, 0);
  assert.deepEqual(
    errors.map((e) => e.kind),
    ["unreachable"],
  );
  assert.match(errors[0]?.message ?? "", /ECONNREFUSED/);
});

test("a service side failure is reported as a service error", async () => {
  const errors: PollError[] = [];
  const poller = createGitCommitPoller({
    client: {
      async checkUpdates() {
        throw new GitMcpError("audit_unavailable", "the call could not be recorded and was not served");
      },
    },
    caller: "zq-poller",
    handle: async () => undefined,
    onError: (error) => errors.push(error),
    createSweeper: fakeSweeper().create,
  });
  assert.equal((await poller.tick()).status, "errors");
  assert.deepEqual(
    errors.map((e) => e.kind),
    ["service"],
  );
});

test("a repository that could not be polled is reported while the others are still handled", async () => {
  const svc = service([[update("a")]]);
  svc.state.repoError = true;
  const handled: string[] = [];
  const { poller, errors } = build(svc, async (batches) => void handled.push(...batches.map((b) => b.repo)));
  const outcome = await poller.tick();
  assert.equal(outcome.status, "errors");
  assert.deepEqual(handled, ["client"]);
  assert.deepEqual(
    errors.map((e) => [e.kind, e.repo, e.message]),
    [
      ["repo", "server", "ls-remote failed"],
      ["repo", "server", "ls-remote failed"],
    ],
  );
});

test("when the round limit is reached the last acknowledgement is still sent", async () => {
  const svc = service([[update("a")], [update("b")], [update("c")]]);
  const errors: PollError[] = [];
  const poller = createGitCommitPoller({
    client: svc,
    caller: "zq-poller",
    handle: async () => undefined,
    onError: (error) => errors.push(error),
    createSweeper: fakeSweeper().create,
    maxRounds: 2,
  });
  await poller.tick();
  assert.equal(svc.acked(), 2);
  assert.deepEqual(
    svc.calls.map((ack) => ack.length),
    [0, 1, 1],
  );
});
