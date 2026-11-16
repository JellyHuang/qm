import type { DurableMap } from "../../persistence/durable-map.ts";
import { errMessage } from "../../util/errors.ts";
import { sleep } from "../../util/async.ts";
import type { JenkinsBuild, JenkinsClient, JenkinsParam } from "./client.ts";

const HOUR_MS = 3_600_000;
const STALE_CLAIM_MS = 5 * 60_000;
const RESOLVE_ATTEMPTS = 5;
const RESOLVE_WAIT_MS = 2_000;

type RerunOutcome = "claimed" | "queued" | "started" | "refused" | "failed" | "unresolved";

export interface JenkinsRerunRow {
  job: string;
  number: number;
  claimedAt: number;
  outcome: RerunOutcome;
  reason?: string;
  queueId?: number;
  newBuildNumber?: number;
  parameterDifferences?: string[];
}

type RerunResult =
  | { status: "started"; row: JenkinsRerunRow }
  | { status: "skipped"; reason: SkipReason }
  | { status: "refused" | "failed" | "unresolved"; row: JenkinsRerunRow };

type SkipReason =
  "disabled" | "job_not_enabled" | "capped" | "not_found" | "still_running" | "not_failure" | "is_rerun" | "duplicate";

export interface JenkinsRerunner {
  rerun(job: string, number: number): Promise<RerunResult>;
  reconcile(job: string, number: number): Promise<JenkinsRerunRow | null>;
}

const rerunKey = (job: string, number: number): string => `${job}:${number}`;

const sameParams = (a: readonly JenkinsParam[], b: readonly JenkinsParam[]): boolean =>
  a.length === b.length && a.every((p) => b.some((q) => q.name === p.name && q.value === p.value));

function differences(before: readonly JenkinsParam[], after: readonly JenkinsParam[]): string[] {
  const names = new Set([...before, ...after].map((p) => p.name));
  return [...names].filter(
    (name) => before.find((p) => p.name === name)?.value !== after.find((p) => p.name === name)?.value,
  );
}

function incomplete(build: JenkinsBuild, defined: readonly string[]): string | undefined {
  if (build.maskedParams.length > 0) return "parameters masked or unreadable";
  const have = new Set(build.params.map((p) => p.name));
  if (defined.some((name) => !have.has(name)) || build.params.some((p) => !defined.includes(p.name)))
    return "parameters incomplete";
  return undefined;
}

export function createJenkinsRerunner(deps: {
  client: JenkinsClient;
  map: DurableMap<JenkinsRerunRow>;
  enabled: boolean;
  jobs: readonly string[];
  hourlyCap: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): JenkinsRerunner {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? sleep;
  const { client, map } = deps;

  async function settle(job: string, number: number, patch: Partial<JenkinsRerunRow>): Promise<JenkinsRerunRow> {
    const row = await map.merge(rerunKey(job, number), patch);
    if (!row) throw new Error(`rerun row ${rerunKey(job, number)} is missing`);
    return row;
  }

  async function resolveNumber(queueId: number): Promise<number | null> {
    for (let attempt = 0; attempt < RESOLVE_ATTEMPTS; attempt++) {
      const started = await client.startedNumber(queueId).catch(() => null);
      if (started !== null) return started;
      await wait(RESOLVE_WAIT_MS);
    }
    return null;
  }

  return {
    async rerun(job, number) {
      if (!deps.enabled) return { status: "skipped", reason: "disabled" };
      if (!deps.jobs.includes(job)) return { status: "skipped", reason: "job_not_enabled" };
      const rows = await map.all();
      if (rows.some((r) => r.job === job && r.newBuildNumber === number))
        return { status: "skipped", reason: "is_rerun" };
      if (rows.filter((r) => r.job === job && r.claimedAt > now() - HOUR_MS).length >= deps.hourlyCap)
        return { status: "skipped", reason: "capped" };
      const original = await client.build(job, number);
      if (!original) return { status: "skipped", reason: "not_found" };
      if (original.building || original.result === null) return { status: "skipped", reason: "still_running" };
      if (original.result !== "FAILURE") return { status: "skipped", reason: "not_failure" };
      const claim: JenkinsRerunRow = { job, number, claimedAt: now(), outcome: "claimed" };
      if (!(await map.insertIfAbsent(rerunKey(job, number), claim))) return { status: "skipped", reason: "duplicate" };
      try {
        const reason = incomplete(original, await client.parameterNames(job));
        if (reason) return { status: "refused", row: await settle(job, number, { outcome: "refused", reason }) };
        const { queueId } = await client.rerun(job, original.params);
        await settle(job, number, { outcome: "queued", queueId });
        const newNumber = await resolveNumber(queueId);
        if (newNumber === null)
          return { status: "unresolved", row: await settle(job, number, { outcome: "unresolved" }) };
        const created = await client.build(job, newNumber).catch(() => null);
        const parameterDifferences = created ? differences(original.params, created.params) : [];
        const row = await settle(job, number, { outcome: "started", newBuildNumber: newNumber, parameterDifferences });
        return { status: "started", row };
      } catch (e) {
        return { status: "failed", row: await settle(job, number, { outcome: "failed", reason: errMessage(e) }) };
      }
    },

    async reconcile(job, number) {
      const row = await map.get(rerunKey(job, number));
      if (!row || row.outcome !== "claimed" || row.claimedAt > now() - STALE_CLAIM_MS) return row;
      const original = await client.build(job, number);
      if (!original) return settle(job, number, { outcome: "unresolved", reason: "original build not found" });
      const taken = new Set((await map.all()).flatMap((r) => (r.newBuildNumber ? [r.newBuildNumber] : [])));
      const newer = (await client.recentBuilds(job)).filter((b) => b.number > number && !taken.has(b.number));
      const match = newer.find((b) => sameParams(b.params, original.params));
      if (match)
        return settle(job, number, {
          outcome: "started",
          newBuildNumber: match.number,
          parameterDifferences: [],
        });
      const waiting = (await client.queued(job)).some((q) => sameParams(q.params, original.params));
      return settle(job, number, {
        outcome: "unresolved",
        reason: waiting ? "a matching build is still queued" : "no matching build found",
      });
    },
  };
}
