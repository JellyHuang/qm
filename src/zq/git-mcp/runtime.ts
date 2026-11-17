import type { LeaderLease } from "../../persistence/leader-lease.ts";
import { errMessage } from "../../util/errors.ts";
import type { Sweeper } from "../../util/sweeper.ts";
import type { ZqConfig } from "../config.ts";
import { createGitMcpClient, type GitMcpClient } from "./client.ts";
import { GitMcpContractError } from "./contract.ts";
import { createGitCommitPoller, type CommitBatch, type PollError } from "./poller.ts";
import { dedupeBySha, type CommitSink } from "./sink.ts";

const GIT_POLL_CALLER = "qm-poller";
const LEASE_KEY = "zq:git-mcp";
const DEDUPE_CAPACITY = 10_000;
const REPEAT_LOG_MS = 10 * 60_000;

type GitPollResult =
  "ok" | "baseline" | "standby" | "unreachable" | "service_error" | "handler_failed" | "contract_violation";

interface GitPollStatus {
  lastPollAt: number | null;
  lastResult: GitPollResult | null;
  consecutiveFailures: number;
  pendingAck: number;
}

export interface GitMcpRuntime {
  start(): void;
  stop(): Promise<void>;
  status(): GitPollStatus;
}

interface GitMcpLog {
  info(line: string): void;
  error(line: string): void;
}

const FAILURE_RESULT: Record<PollError["kind"], GitPollResult> = {
  handler: "handler_failed",
  unreachable: "unreachable",
  service: "service_error",
  repo: "service_error",
};

export function createGitMcpRuntime(deps: {
  config: ZqConfig;
  leaderLease: LeaderLease;
  createSweeper: (work: () => unknown, intervalMs: number, opts?: { label?: string; immediate?: boolean }) => Sweeper;
  createClient?: (options: { url: string; secret: string }) => GitMcpClient;
  sink?: CommitSink;
  log?: GitMcpLog;
  now?: () => number;
}): GitMcpRuntime | undefined {
  const { gitPoll, gitMcp } = deps.config;
  if (!gitPoll.enabled || !gitMcp) return undefined;
  const log = deps.log ?? { info: console.log, error: console.error };
  const now = deps.now ?? Date.now;
  const client = (deps.createClient ?? createGitMcpClient)(gitMcp);
  const sink = dedupeBySha(
    deps.sink ?? {
      async record(batches) {
        for (const batch of batches)
          log.info(`[zq git poll] ${batch.repo}/${batch.branch}: ${batch.commits.length} commits (${batch.status})`);
      },
    },
    DEDUPE_CAPACITY,
  );
  const status: GitPollStatus = { lastPollAt: null, lastResult: null, consecutiveFailures: 0, pendingAck: 0 };
  const lastLogged = new Map<string, { at: number; suppressed: number }>();
  let tick = { errors: [] as PollError[], baselines: 0, lastBatch: 0 };
  let running = false;

  function reportRateLimited(kind: string, message: string) {
    const previous = lastLogged.get(kind);
    if (previous && now() - previous.at < REPEAT_LOG_MS) {
      previous.suppressed++;
      return;
    }
    const more = previous?.suppressed ? ` (${previous.suppressed} similar failures not logged)` : "";
    lastLogged.set(kind, { at: now(), suppressed: 0 });
    log.error(`[zq git poll] ${kind}: ${message}${more}`);
  }

  function finish(result: GitPollResult, pendingAck: number) {
    status.lastPollAt = now();
    status.lastResult = result;
    status.pendingAck = pendingAck;
    status.consecutiveFailures = result === "ok" || result === "baseline" ? 0 : status.consecutiveFailures + 1;
  }

  async function cycle(work: () => unknown) {
    try {
      await client.verify();
    } catch (e) {
      const drift = e instanceof GitMcpContractError;
      const kind = drift ? "contract_violation" : "unreachable";
      reportRateLimited(kind, drift ? `${errMessage(e)}; not polling until it matches` : errMessage(e));
      finish(kind, status.pendingAck);
      return;
    }
    tick = { errors: [], baselines: 0, lastBatch: 0 };
    await work();
    const failure = tick.errors.find((e) => e.kind === "handler") ?? tick.errors[0];
    if (!failure) return finish(tick.baselines > 0 ? "baseline" : "ok", 0);
    finish(FAILURE_RESULT[failure.kind], failure.kind === "repo" ? 0 : tick.lastBatch);
  }

  const poller = createGitCommitPoller({
    client: {
      async checkUpdates(caller, ack, repo) {
        const response = await client.checkUpdates(caller, ack, repo);
        for (const entry of response.repos)
          if (entry.status === "first_run") {
            tick.baselines++;
            log.info(`[zq git poll] baseline recorded for ${entry.repo} (${entry.branches ?? 0} branches)`);
          }
        return response;
      },
    },
    caller: GIT_POLL_CALLER,
    async handle(batches: CommitBatch[]) {
      tick.lastBatch = batches.reduce((sum, batch) => sum + batch.commits.length, 0);
      await sink.record(batches);
    },
    onError(error) {
      tick.errors.push(error);
      if (error.kind === "unreachable") reportRateLimited("unreachable", error.message);
      else log.error(`[zq git poll] ${error.kind}${error.repo ? ` ${error.repo}` : ""}: ${error.message}`);
    },
    intervalMs: gitPoll.intervalMs,
    createSweeper: (work, intervalMs, opts) =>
      deps.createSweeper(
        async () => {
          if (running) return;
          running = true;
          try {
            const held = await deps.leaderLease.hold(LEASE_KEY, async () => {
              await cycle(work);
              return true;
            });
            if (held === null) status.lastResult = "standby";
          } finally {
            running = false;
          }
        },
        intervalMs,
        { ...opts, immediate: true },
      ),
  });

  return { start: () => poller.start(), stop: () => poller.stop(), status: () => ({ ...status }) };
}
