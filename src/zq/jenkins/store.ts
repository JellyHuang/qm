import type { DurableMap } from "../../persistence/durable-map.ts";
import type { JenkinsCauseKind } from "./client.ts";
import type { JenkinsState, NoticeKind, SkipReason } from "./decision.ts";

export interface JenkinsBuildRecord {
  job: string;
  number: number;
  state: JenkinsState;
  reason?: SkipReason | "rerun_unresolved";
  url: string;
  result: string;
  finishedAt: number;
  observedAt: number;
  updatedAt: number;
  causes: JenkinsCauseKind[];
  fingerprint: string;
  parameterCount: number;
  consoleTailHash?: string;
  claimedAt?: number | undefined;
  queueId?: number;
  rerunNumber?: number;
  rerunUrl?: string;
  rerunResult?: string;
  parameterDifferences?: string[];
}

export interface JenkinsAuditRow {
  id: string;
  at: number;
  job: string;
  number?: number;
  event: string;
  from?: JenkinsState;
  to?: JenkinsState;
  reason?: string;
  actor: "poller";
  detail?: string;
}

export interface JenkinsNotice {
  id: string;
  kind: NoticeKind;
  job: string;
  number?: number;
  channelId: string;
  text: string;
  mode: "dry-run" | "live";
  status: "pending" | "sending" | "sent" | "failed";
  attempts: number;
  createdAt: number;
  sentAt?: number;
}

export interface JenkinsStore {
  records(): Promise<JenkinsBuildRecord[]>;
  observe(record: JenkinsBuildRecord): Promise<boolean>;
  transition(
    job: string,
    number: number,
    from: readonly JenkinsState[],
    patch: Partial<JenkinsBuildRecord> & { state: JenkinsState },
  ): Promise<JenkinsBuildRecord | null>;
  audit(id: string, row: Omit<JenkinsAuditRow, "id" | "at" | "actor">): Promise<void>;
  auditRows(): Promise<JenkinsAuditRow[]>;
  queueNotice(notice: Omit<JenkinsNotice, "status" | "attempts" | "createdAt">): Promise<boolean>;
  pendingNotices(): Promise<JenkinsNotice[]>;
  claimNotice(id: string): Promise<JenkinsNotice | null>;
  settleNotice(id: string, outcome: "sent" | "retry" | "failed"): Promise<void>;
  notices(): Promise<JenkinsNotice[]>;
}

const MAX_NOTICE_ATTEMPTS = 5;

function settledStatus(outcome: "sent" | "retry" | "failed", attempts: number): JenkinsNotice["status"] {
  if (outcome === "retry") return attempts < MAX_NOTICE_ATTEMPTS ? "pending" : "failed";
  return outcome;
}

export const recordKey = (job: string, number: number): string => `${job}:${number}`;

export function createJenkinsStore(deps: {
  builds: DurableMap<JenkinsBuildRecord>;
  audits: DurableMap<JenkinsAuditRow>;
  noticeMap: DurableMap<JenkinsNotice>;
  now?: () => number;
}): JenkinsStore {
  const now = deps.now ?? Date.now;

  async function audit(id: string, row: Omit<JenkinsAuditRow, "id" | "at" | "actor">): Promise<void> {
    await deps.audits.insertIfAbsent(id, { ...row, id, at: now(), actor: "poller" });
  }

  async function swapNotice(
    id: string,
    from: JenkinsNotice["status"],
    apply: (n: JenkinsNotice) => JenkinsNotice,
  ): Promise<JenkinsNotice | null> {
    let won = false;
    const next = await deps.noticeMap.update(id, (n) => {
      won = n.status === from;
      return won ? apply(n) : n;
    });
    return won ? next : null;
  }

  return {
    records: () => deps.builds.all(),
    async observe(record) {
      const created = await deps.builds.insertIfAbsent(recordKey(record.job, record.number), record);
      if (created)
        await audit(`${recordKey(record.job, record.number)}:observed`, {
          job: record.job,
          number: record.number,
          event: "observed",
          to: "observed",
          detail: `result=${record.result} causes=${record.causes.join("+") || "none"} parameters=${record.parameterCount}`,
        });
      return created;
    },
    async transition(job, number, from, patch) {
      const key = recordKey(job, number);
      let previous: JenkinsState | undefined;
      const next = await deps.builds.update(key, (r) => {
        previous = from.includes(r.state) ? r.state : undefined;
        return previous ? { ...r, ...patch, updatedAt: now() } : r;
      });
      if (!next || !previous) return null;
      await audit(`${key}:${patch.state}`, {
        job,
        number,
        event: patch.state,
        from: previous,
        to: patch.state,
        ...(patch.reason ? { reason: patch.reason } : {}),
      });
      return next;
    },
    audit,
    async auditRows() {
      return (await deps.audits.all()).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    },
    async queueNotice(notice) {
      const created = await deps.noticeMap.insertIfAbsent(notice.id, {
        ...notice,
        status: "pending",
        attempts: 0,
        createdAt: now(),
      });
      if (created)
        await audit(`${notice.id}:notice_queued`, {
          job: notice.job,
          ...(notice.number === undefined ? {} : { number: notice.number }),
          event: "notice_queued",
          reason: notice.kind,
          detail: `mode=${notice.mode}`,
        });
      return created;
    },
    async pendingNotices() {
      return (await deps.noticeMap.all())
        .filter((n) => n.status === "pending")
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    claimNotice: (id) => swapNotice(id, "pending", (n) => ({ ...n, status: "sending", attempts: n.attempts + 1 })),
    async settleNotice(id, outcome) {
      const settled = await swapNotice(id, "sending", (n) => ({
        ...n,
        status: settledStatus(outcome, n.attempts),
        ...(outcome === "sent" ? { sentAt: now() } : {}),
      }));
      if (settled && settled.status !== "pending")
        await audit(`${id}:notice_${settled.status}`, {
          job: settled.job,
          ...(settled.number === undefined ? {} : { number: settled.number }),
          event: `notice_${settled.status}`,
          reason: settled.kind,
          detail: `mode=${settled.mode} attempts=${settled.attempts}`,
        });
    },
    notices: () => deps.noticeMap.all(),
  };
}
