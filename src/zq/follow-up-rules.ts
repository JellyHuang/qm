export type StatusClass = "open" | "active" | "blocked" | "closed";

type FollowUpKind = "remind-stale" | "remind-overdue" | "escalate-blocked";

export interface WorkPackageState {
  id: number;
  status: string;
  assigneeOpUserId?: string;
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
  dedupeKey: string;
  reason: string;
}

const DAY = 86_400_000;

export const DEFAULT_FOLLOW_UP_POLICY: FollowUpPolicy = {
  statusClasses: {
    new: "open",
    "in progress": "active",
    "on hold": "blocked",
    blocked: "blocked",
    closed: "closed",
    rejected: "closed",
    done: "closed",
  },
  rules: {
    open: { staleAfterMs: 3 * DAY, remindEveryMs: 3 * DAY },
    active: { staleAfterMs: 5 * DAY, remindEveryMs: 2 * DAY },
    blocked: { staleAfterMs: 2 * DAY, remindEveryMs: 2 * DAY, escalateAfterMs: 5 * DAY },
  },
};

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
  const base = { workPackageId: wp.id, ...(wp.assigneeOpUserId ? { assigneeOpUserId: wp.assigneeOpUserId } : {}) };
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
