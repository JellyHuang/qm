import { createHash } from "node:crypto";
import type { JenkinsBuild, JenkinsCauseKind, JenkinsParam } from "./client.ts";

export type JenkinsState =
  | "observed"
  | "eligible"
  | "rerun_requested"
  | "rerun_running"
  | "rerun_succeeded"
  | "rerun_failed"
  | "notified"
  | "skipped";

export type SkipReason =
  | "job_not_enabled"
  | "is_rerun"
  | "bot_triggered"
  | "manual_trigger"
  | "cause_not_allowed"
  | "chain_rerun"
  | "superseded"
  | "parameters_unreadable"
  | "parameters_incomplete"
  | "circuit_open"
  | "too_old"
  | "request_rejected"
  | "claim_uncertain";

export type NoticeKind = "rerun_failed" | "needs_attention" | "circuit_open";

export const HOUR_MS = 3_600_000;
export const CHAIN_WINDOW_MS = 24 * HOUR_MS;

export interface DecisionPolicy {
  failureResults: readonly string[];
  rerunJobs: readonly string[];
  causes: readonly JenkinsCauseKind[];
  maxAgeMs: number;
  hourlyCap: number;
  botUser: string;
}

export interface DecisionInput {
  job: string;
  build: JenkinsBuild;
  newer: ReadonlyArray<Pick<JenkinsBuild, "number" | "building" | "result">>;
  rerunNumbers: ReadonlySet<number>;
  definedParams: readonly string[];
  claimsLastHour: number;
  chainFingerprints: ReadonlySet<string>;
  now: number;
}

export type Decision =
  { action: "wait" | "ignore" | "rerun" } | { action: "skip"; reason: SkipReason; notice?: NoticeKind };

export const fingerprint = (params: readonly JenkinsParam[]): string =>
  createHash("sha256")
    .update(JSON.stringify(params.map((p) => [p.name, p.value]).sort()))
    .digest("hex");

export const causedByBot = (build: Pick<JenkinsBuild, "causes">, botUser: string): boolean =>
  build.causes.some((c) => c.kind === "user" && c.userId?.toLowerCase() === botUser.toLowerCase());

export function paramProblem(
  build: Pick<JenkinsBuild, "params" | "maskedParams">,
  defined: readonly string[],
): "parameters_unreadable" | "parameters_incomplete" | undefined {
  if (build.maskedParams.length > 0) return "parameters_unreadable";
  const have = new Set(build.params.map((p) => p.name));
  const known = new Set(defined);
  if (defined.some((name) => !have.has(name)) || build.params.some((p) => !known.has(p.name)))
    return "parameters_incomplete";
  return undefined;
}

export function isCandidate(build: JenkinsBuild, policy: DecisionPolicy, now: number): boolean {
  return (
    !build.building &&
    build.result !== null &&
    policy.failureResults.includes(build.result) &&
    now - (build.timestamp + build.duration) <= policy.maxAgeMs
  );
}

export function decide(input: DecisionInput, policy: DecisionPolicy): Decision {
  const { build, now } = input;
  if (build.building || build.result === null) return { action: "wait" };
  if (!policy.failureResults.includes(build.result)) return { action: "ignore" };
  const skip = (reason: SkipReason, notice?: NoticeKind): Decision => ({
    action: "skip",
    reason,
    ...(notice ? { notice } : {}),
  });
  if (!isCandidate(build, policy, now)) return skip("too_old");
  if (input.rerunNumbers.has(build.number)) return skip("is_rerun");
  if (causedByBot(build, policy.botUser)) return skip("bot_triggered");
  if (!policy.rerunJobs.includes(input.job)) return skip("job_not_enabled");
  const kinds: JenkinsCauseKind[] = build.causes.length > 0 ? build.causes.map((c) => c.kind) : ["other"];
  if (!kinds.every((kind) => policy.causes.includes(kind)))
    return skip(kinds.includes("user") && !policy.causes.includes("user") ? "manual_trigger" : "cause_not_allowed");
  if (kinds.includes("user") && input.chainFingerprints.has(fingerprint(build.params))) return skip("chain_rerun");
  if (input.newer.some((n) => n.building || n.result === "SUCCESS")) return skip("superseded");
  const problem = paramProblem(build, input.definedParams);
  if (problem) return skip(problem, "needs_attention");
  if (input.claimsLastHour >= policy.hourlyCap) return skip("circuit_open", "circuit_open");
  return { action: "rerun" };
}
