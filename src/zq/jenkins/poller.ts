import { sleep } from "../../util/async.ts";
import { errMessage } from "../../util/errors.ts";
import type { Sweeper } from "../../util/sweeper.ts";
import { JenkinsHttpError, type JenkinsBuild, type JenkinsClient } from "./client.ts";
import {
  CHAIN_WINDOW_MS,
  HOUR_MS,
  causedByBot,
  decide,
  fingerprint,
  isCandidate,
  paramProblem,
  type DecisionPolicy,
  type NoticeKind,
  type SkipReason,
} from "./decision.ts";
import { noticeText, type JenkinsNoticeSink } from "./notices.ts";
import { recordKey, type JenkinsBuildRecord, type JenkinsStore } from "./store.ts";

const STALE_CLAIM_MS = 5 * 60_000;
const RESOLVE_ATTEMPTS = 3;
const RESOLVE_WAIT_MS = 2_000;

export interface PollError {
  kind: "auth" | "unreachable" | "job_not_found" | "notice";
  job?: string;
  message: string;
}

interface TickSummary {
  observed: number;
  skipped: number;
  requested: number;
  ignored: number;
  errors: number;
}

export interface JenkinsPoller {
  start(): void;
  stop(): Promise<void>;
  tick(): Promise<TickSummary>;
}

export interface JenkinsPollerDeps {
  client: JenkinsClient;
  store: JenkinsStore;
  policy: DecisionPolicy;
  jobs: readonly string[];
  live: boolean;
  noticeMode: "dry-run" | "live";
  channelId: string;
  sink: JenkinsNoticeSink;
  owner(job: string): string | undefined;
  onError(error: PollError): void;
  createSweeper(work: () => unknown, intervalMs: number, opts?: { label?: string }): Sweeper;
  intervalMs: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

export function createJenkinsPoller(deps: JenkinsPollerDeps): JenkinsPoller {
  const { client, store, policy } = deps;
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? sleep;
  const sweeper = deps.createSweeper(() => poller.tick(), deps.intervalMs, { label: "zq jenkins poller" });

  async function pollError(error: PollError): Promise<void> {
    await store.audit(`poll:${error.job ?? "-"}:${error.kind}:${Math.floor(now() / HOUR_MS)}`, {
      job: error.job ?? "",
      event: "poll_error",
      reason: error.kind,
      detail: error.message,
    });
    deps.onError(error);
  }

  async function enqueue(kind: NoticeKind, record: JenkinsBuildRecord): Promise<void> {
    const id =
      kind === "circuit_open"
        ? `breaker:${record.job}:${Math.floor(now() / HOUR_MS)}`
        : `${recordKey(record.job, record.number)}:${kind}`;
    await store.queueNotice({
      id,
      kind,
      job: record.job,
      ...(kind === "circuit_open" ? {} : { number: record.number }),
      channelId: deps.channelId,
      text: noticeText(kind, record, deps.owner(record.job), policy.hourlyCap),
      mode: deps.noticeMode,
    });
  }

  async function skip(
    record: JenkinsBuildRecord,
    reason: SkipReason,
    notice: NoticeKind | undefined,
    patch: Partial<JenkinsBuildRecord> = {},
  ): Promise<void> {
    if (notice) await enqueue(notice, { ...record, reason });
    await store.transition(record.job, record.number, ["observed", "eligible", "rerun_requested"], {
      ...patch,
      state: "skipped",
      reason,
    });
  }

  async function link(record: JenkinsBuildRecord, number: number): Promise<void> {
    const [original, created] = await Promise.all([
      client.build(record.job, record.number),
      client.build(record.job, number).catch(() => null),
    ]);
    const before = new Map(original?.params.map((p) => [p.name, p.value]));
    const after = new Map(created?.params.map((p) => [p.name, p.value]));
    const differences = [...new Set([...before.keys(), ...after.keys()])].filter((n) => before.get(n) !== after.get(n));
    await store.transition(record.job, record.number, ["rerun_requested"], {
      state: "rerun_running",
      rerunNumber: number,
      rerunUrl: created?.url ?? "",
      parameterDifferences: differences,
    });
  }

  async function resolveQueue(record: JenkinsBuildRecord, queueId: number, attempts: number): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await wait(RESOLVE_WAIT_MS);
      const started = await client.startedNumber(queueId).catch(() => null);
      if (started !== null) {
        await link(record, started);
        return true;
      }
    }
    return false;
  }

  async function perform(record: JenkinsBuildRecord, defined: () => Promise<string[]>): Promise<void> {
    const { job, number } = record;
    let original: JenkinsBuild | null;
    let problem: ReturnType<typeof paramProblem>;
    try {
      original = await client.build(job, number);
      problem = original ? paramProblem(original, await defined()) : "parameters_unreadable";
    } catch (e) {
      await store.transition(job, number, ["rerun_requested"], { state: "eligible", claimedAt: undefined });
      throw e;
    }
    if (problem || !original)
      return skip(record, problem ?? "parameters_unreadable", "needs_attention", { claimedAt: undefined });
    let queueId: number;
    try {
      queueId = (await client.rerun(job, original.params)).queueId;
    } catch (e) {
      if (!(e instanceof JenkinsHttpError)) {
        await pollError({ kind: "unreachable", job, message: errMessage(e) });
        return;
      }
      return skip(record, "request_rejected", "needs_attention", { claimedAt: undefined });
    }
    const requested = await store.transition(job, number, ["rerun_requested"], { state: "rerun_requested", queueId });
    if (requested) await resolveQueue(requested, queueId, RESOLVE_ATTEMPTS);
  }

  function withinCap(record: JenkinsBuildRecord, rows: JenkinsBuildRecord[]): boolean {
    const claimed = rows
      .filter((r) => r.job === record.job && r.claimedAt !== undefined && r.claimedAt > now() - HOUR_MS)
      .sort((a, b) => a.claimedAt! - b.claimedAt! || a.number - b.number);
    return claimed.findIndex((r) => r.number === record.number) < policy.hourlyCap;
  }

  async function pollJob(job: string, summary: TickSummary): Promise<void> {
    const builds = await client.recentBuilds(job);
    if (!builds) return pollError({ kind: "job_not_found", job, message: `${job} does not exist or is not visible` });
    builds.sort((a, b) => a.number - b.number);
    const rows = (await store.records()).filter((r) => r.job === job);
    const byNumber = new Map(rows.map((r) => [r.number, r]));
    const ours = new Set(rows.flatMap((r) => (r.rerunNumber ? [r.rerunNumber] : [])));
    const chain = new Set(
      rows.filter((r) => r.claimedAt !== undefined && r.claimedAt > now() - CHAIN_WINDOW_MS).map((r) => r.fingerprint),
    );
    let defined: string[] | undefined;
    const definedParams = async () => (defined ??= await client.parameterNames(job));
    let claims = rows.filter((r) => r.claimedAt !== undefined && r.claimedAt > now() - HOUR_MS).length;

    for (const build of builds) {
      let record = byNumber.get(build.number);
      if (record && record.state !== "observed" && record.state !== "eligible") continue;
      const candidate = isCandidate(build, policy, now());
      if (!record && !candidate) {
        summary.ignored++;
        continue;
      }
      const decision = decide(
        {
          job,
          build,
          newer: builds.filter(
            (b) => b.number > build.number && !ours.has(b.number) && !causedByBot(b, policy.botUsers),
          ),
          rerunNumbers: ours,
          definedParams: candidate && policy.rerunJobs.includes(job) ? await definedParams() : [],
          claimsLastHour: claims,
          chainFingerprints: chain,
          now: now(),
        },
        policy,
      );
      if (decision.action === "wait" || decision.action === "ignore") continue;
      if (!record) {
        const tail = await client.consoleTailHash(job, build.number).catch(() => null);
        record = {
          job,
          number: build.number,
          state: "observed",
          url: build.url,
          result: build.result ?? "",
          finishedAt: build.timestamp + build.duration,
          observedAt: now(),
          updatedAt: now(),
          causes: build.causes.map((c) => c.kind),
          fingerprint: fingerprint(build.params),
          parameterCount: build.params.length + build.maskedParams.length,
          ...(tail ? { consoleTailHash: tail } : {}),
        };
        if (!(await store.observe(record))) continue;
        summary.observed++;
      }
      if (decision.action === "skip") {
        await skip(record, decision.reason, decision.notice);
        summary.skipped++;
        continue;
      }
      if (record.state === "observed") await store.transition(job, build.number, ["observed"], { state: "eligible" });
      if (!deps.live) {
        await store.audit(`${recordKey(job, build.number)}:dry_run_would_rerun`, {
          job,
          number: build.number,
          event: "dry_run_would_rerun",
        });
        continue;
      }
      const claimed = await store.transition(job, build.number, ["eligible"], {
        state: "rerun_requested",
        claimedAt: now(),
      });
      if (!claimed) continue;
      claims++;
      chain.add(claimed.fingerprint);
      if (!withinCap(claimed, await store.records())) {
        await skip(claimed, "circuit_open", "circuit_open", { claimedAt: undefined });
        summary.skipped++;
        continue;
      }
      await perform(claimed, definedParams);
      summary.requested++;
    }
    await advance(job, builds);
  }

  async function advance(job: string, builds: JenkinsBuild[]): Promise<void> {
    const rows = (await store.records()).filter((r) => r.job === job);
    const taken = new Set(rows.flatMap((r) => (r.rerunNumber ? [r.rerunNumber] : [])));
    for (const record of rows) {
      if (record.state === "rerun_running" && record.rerunNumber !== undefined) {
        const created = builds.find((b) => b.number === record.rerunNumber);
        if (!created || created.building || created.result === null) continue;
        if (created.result === "SUCCESS") {
          await store.transition(job, record.number, ["rerun_running"], {
            state: "rerun_succeeded",
            rerunResult: created.result,
          });
          continue;
        }
        await enqueue("rerun_failed", { ...record, rerunResult: created.result });
        await store.transition(job, record.number, ["rerun_running"], {
          state: "rerun_failed",
          rerunResult: created.result,
        });
      } else if (record.state === "rerun_requested") {
        if (record.queueId !== undefined && (await resolveQueue(record, record.queueId, 1))) continue;
        if (now() - (record.claimedAt ?? 0) < STALE_CLAIM_MS) continue;
        const match = builds.find(
          (b) =>
            b.number > record.number &&
            !taken.has(b.number) &&
            causedByBot(b, policy.botUsers) &&
            fingerprint(b.params) === record.fingerprint,
        );
        if (match) {
          await link(record, match.number);
          taken.add(match.number);
          continue;
        }
        const waiting = (await client.queued(job)).some((q) => fingerprint(q.params) === record.fingerprint);
        if (!waiting) await skip(record, "claim_uncertain", "needs_attention");
      }
    }
  }

  async function deliverNotices(): Promise<void> {
    for (const pending of await store.pendingNotices()) {
      const notice = await store.claimNotice(pending.id);
      if (!notice) continue;
      try {
        await deps.sink.send({ id: notice.id, channelId: notice.channelId, text: notice.text });
      } catch (e) {
        await store.settleNotice(notice.id, "retry");
        await pollError({ kind: "notice", job: notice.job, message: errMessage(e) });
        continue;
      }
      await store.settleNotice(notice.id, "sent");
      if (notice.kind === "rerun_failed" && notice.number !== undefined)
        await store.transition(notice.job, notice.number, ["rerun_failed"], { state: "notified" });
    }
  }

  async function tick(): Promise<TickSummary> {
    const summary: TickSummary = { observed: 0, skipped: 0, requested: 0, ignored: 0, errors: 0 };
    for (const job of deps.jobs) {
      try {
        await pollJob(job, summary);
      } catch (e) {
        summary.errors++;
        const auth = e instanceof JenkinsHttpError && (e.status === 401 || e.status === 403);
        await pollError({ kind: auth ? "auth" : "unreachable", job, message: errMessage(e) });
      }
    }
    try {
      await deliverNotices();
    } catch (e) {
      summary.errors++;
      await pollError({ kind: "notice", message: errMessage(e) });
    }
    return summary;
  }

  const poller: JenkinsPoller = { start: () => sweeper.start(), stop: () => sweeper.stop(), tick };
  return poller;
}
