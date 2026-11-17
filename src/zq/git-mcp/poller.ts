import { errMessage } from "../../util/errors.ts";
import type { Sweeper } from "../../util/sweeper.ts";
import {
  GitMcpUnreachable,
  type AckEntry,
  type BranchUpdate,
  type GitMcpClient,
  type UpdatedCommit,
} from "./client.ts";

export const POLL_INTERVAL_MS = 5 * 60_000;
const MAX_ROUNDS = 20;

export interface CommitBatch {
  repo: string;
  branch: string;
  status: BranchUpdate["status"];
  oldTip?: string;
  newTip?: string;
  commits: UpdatedCommit[];
}

export interface PollError {
  kind: "unreachable" | "service" | "repo" | "handler";
  repo?: string;
  message: string;
}

interface PollOutcome {
  status: "ok" | "errors" | "handler_failed";
  delivered: number;
  errors: PollError[];
}

export interface GitCommitPoller {
  start(): void;
  stop(): Promise<void>;
  tick(): Promise<PollOutcome>;
}

export interface GitCommitPollerDeps {
  client: Pick<GitMcpClient, "checkUpdates">;
  caller: string;
  handle(batches: CommitBatch[]): Promise<void>;
  onError(error: PollError): void;
  createSweeper(work: () => unknown, intervalMs: number, opts?: { label?: string }): Sweeper;
  intervalMs?: number;
  maxRounds?: number;
}

export function createGitCommitPoller(deps: GitCommitPollerDeps): GitCommitPoller {
  const maxRounds = deps.maxRounds ?? MAX_ROUNDS;
  const sweeper = deps.createSweeper(() => poller.tick(), deps.intervalMs ?? POLL_INTERVAL_MS, {
    label: "zq git commit poller",
  });

  async function tick(): Promise<PollOutcome> {
    const errors: PollError[] = [];
    const fail = (error: PollError) => {
      errors.push(error);
      deps.onError(error);
    };
    let ack: AckEntry[] = [];
    let delivered = 0;
    for (let round = 0; round < maxRounds; round++) {
      let response;
      try {
        response = await deps.client.checkUpdates(deps.caller, ack);
      } catch (e) {
        fail({ kind: e instanceof GitMcpUnreachable ? "unreachable" : "service", message: errMessage(e) });
        return { status: "errors", delivered, errors };
      }
      for (const repo of response.repos)
        if (repo.status === "error") fail({ kind: "repo", repo: repo.repo, message: repo.error ?? "the poll failed" });
      const batches = response.repos.flatMap((repo) =>
        (repo.updates ?? []).map((update): CommitBatch => ({
          repo: repo.repo,
          branch: update.branch,
          status: update.status,
          ...(update.oldTip ? { oldTip: update.oldTip } : {}),
          ...(update.newTip ? { newTip: update.newTip } : {}),
          commits: update.commits,
        })),
      );
      if (batches.length === 0) return { status: errors.length > 0 ? "errors" : "ok", delivered, errors };
      try {
        await deps.handle(batches);
      } catch (e) {
        fail({ kind: "handler", message: errMessage(e) });
        return { status: "handler_failed", delivered, errors };
      }
      delivered += batches.reduce((sum, batch) => sum + batch.commits.length, 0);
      ack = response.ack;
    }
    if (ack.length > 0) {
      try {
        await deps.client.checkUpdates(deps.caller, ack);
      } catch (e) {
        fail({ kind: e instanceof GitMcpUnreachable ? "unreachable" : "service", message: errMessage(e) });
      }
    }
    return { status: errors.length > 0 ? "errors" : "ok", delivered, errors };
  }

  const poller: GitCommitPoller = {
    start: () => sweeper.start(),
    stop: () => sweeper.stop(),
    tick,
  };
  return poller;
}
