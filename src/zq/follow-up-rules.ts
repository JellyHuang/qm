export type StatusClass = "open" | "active" | "blocked" | "closed";

type FollowUpKind = "remind-stale" | "remind-overdue" | "escalate-blocked";

export interface WorkPackageState {
  id: number;
  status: string;
  assigneeOpUserId?: string;
  assigneeName?: string;
  dueAt?: number;
  statusChangedAt: number;
  updatedAt: number;
  lastFollowUpAt?: number;
}

interface StatusRule {
  staleAfterMs?: number;
  remindEveryMs: number;
  escalateAfterMs?: number;
}

export interface FollowUpPolicy {
  statusClasses: Record<string, StatusClass>;
  rules: Record<Exclude<StatusClass, "closed">, StatusRule>;
}

export interface FollowUpAction {
  kind: FollowUpKind;
  workPackageId: number;
  assigneeOpUserId?: string;
  assigneeName?: string;
  dedupeKey: string;
  reason: string;
}

const DAY = 86_400_000;

const STATUS_CLASSES: Record<StatusClass, readonly string[]> = {
  open: ["new", "pm.planned"],
  active: [
    "pm.in_progress",
    "fm.in_progress",
    "fm.review",
    "fm.rework",
    "fm.qa",
    "dv.in_progress",
    "dv.review",
    "dv.qa",
    "qa.confirmed",
    "qa.fixing",
    "qa.verify",
    "qa.reopened",
    "mt.in_progress",
  ],
  blocked: ["pm.suspended", "fm.suspended", "dv.suspended"],
  closed: [
    "pm.done",
    "pm.closed",
    "fm.formal",
    "fm.closed",
    "dv.done",
    "dv.closed",
    "qa.closed",
    "qa.rejected",
    "mt.done",
    "mt.cancelled",
  ],
};

export const DEFAULT_FOLLOW_UP_POLICY: FollowUpPolicy = {
  statusClasses: Object.fromEntries(
    Object.entries(STATUS_CLASSES).flatMap(([cls, keys]) => keys.map((k) => [k, cls as StatusClass])),
  ),
  rules: {
    open: { staleAfterMs: 3 * DAY, remindEveryMs: 3 * DAY },
    active: { staleAfterMs: 5 * DAY, remindEveryMs: 2 * DAY },
    blocked: { staleAfterMs: 2 * DAY, remindEveryMs: 2 * DAY, escalateAfterMs: 5 * DAY },
  },
};

export interface StatusActivity {
  createdAt: number;
  statusTo?: string;
}

export function latestStatusChangeAt(
  activities: readonly StatusActivity[],
  currentStatus: string,
  fallback: number,
): number {
  const target = currentStatus.trim().toLowerCase();
  const hits = activities.filter((a) => a.statusTo?.trim().toLowerCase() === target).map((a) => a.createdAt);
  return hits.length ? Math.max(...hits) : fallback;
}

export interface ExitRule {
  from: string;
  to: string;
  requires: readonly string[];
}

export const DEFAULT_EXIT_RULES: readonly ExitRule[] = [
  { from: "fm.review", to: "fm.qa", requires: ["review_result"] },
  { from: "fm.qa", to: "fm.formal", requires: ["review_result", "qa_result"] },
  { from: "dv.review", to: "dv.qa", requires: ["review_result"] },
  { from: "dv.qa", to: "dv.done", requires: ["review_result", "qa_result"] },
  { from: "fm.in_progress", to: "fm.suspended", requires: ["suspend_reason"] },
  { from: "pm.in_progress", to: "pm.suspended", requires: ["suspend_reason"] },
  { from: "dv.in_progress", to: "dv.suspended", requires: ["suspend_reason"] },
];

export function exitBlockers(
  from: string,
  to: string,
  fields: Readonly<Record<string, string | null | undefined>>,
  rules: readonly ExitRule[] = DEFAULT_EXIT_RULES,
): string[] {
  const norm = (v: string) => v.trim().toLowerCase();
  return rules
    .filter((r) => r.from === norm(from) && r.to === norm(to))
    .flatMap((r) => r.requires)
    .filter((key) => !fields[key]?.trim());
}

export function classifyStatus(status: string, policy: FollowUpPolicy): StatusClass | undefined {
  return policy.statusClasses[status.trim().toLowerCase()];
}

function bucket(since: number, now: number, everyMs: number): number {
  return Math.floor(Math.max(0, now - since) / everyMs);
}

export function evaluateFollowUp(
  wp: WorkPackageState,
  now: number,
  policy: FollowUpPolicy = DEFAULT_FOLLOW_UP_POLICY,
): FollowUpAction[] {
  const statusClass = classifyStatus(wp.status, policy);
  if (!statusClass || statusClass === "closed") return [];
  const rule = policy.rules[statusClass];
  const cooling = wp.lastFollowUpAt !== undefined && now - wp.lastFollowUpAt < rule.remindEveryMs;
  const base = {
    workPackageId: wp.id,
    ...(wp.assigneeOpUserId ? { assigneeOpUserId: wp.assigneeOpUserId } : {}),
    ...(wp.assigneeName ? { assigneeName: wp.assigneeName } : {}),
  };
  const actions: FollowUpAction[] = [];

  if (wp.dueAt !== undefined && now > wp.dueAt && !cooling) {
    actions.push({
      ...base,
      kind: "remind-overdue",
      dedupeKey: `${wp.id}:overdue:${bucket(wp.dueAt, now, rule.remindEveryMs)}`,
      reason: `due ${Math.floor((now - wp.dueAt) / DAY)} day(s) ago while ${wp.status}`,
    });
  }

  const idleMs = now - wp.updatedAt;
  if (rule.staleAfterMs !== undefined && idleMs >= rule.staleAfterMs && !cooling && !actions.length) {
    actions.push({
      ...base,
      kind: "remind-stale",
      dedupeKey: `${wp.id}:stale:${bucket(wp.updatedAt + rule.staleAfterMs, now, rule.remindEveryMs)}`,
      reason: `no update for ${Math.floor(idleMs / DAY)} day(s) while ${wp.status}`,
    });
  }

  if (
    statusClass === "blocked" &&
    rule.escalateAfterMs !== undefined &&
    now - wp.statusChangedAt >= rule.escalateAfterMs
  ) {
    actions.push({
      ...base,
      kind: "escalate-blocked",
      dedupeKey: `${wp.id}:escalate:${wp.statusChangedAt}`,
      reason: `${wp.status} for ${Math.floor((now - wp.statusChangedAt) / DAY)} day(s)`,
    });
  }
  return actions;
}
