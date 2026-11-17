export const GIT_AUDIT_RETENTION_DAYS = 180;

const DAY_MS = 86_400_000;

export interface GitAuditPrunable {
  deleteBefore(field: "at", cutoff: number): Promise<void>;
}

export function gitAuditCutoff(now: number, days = GIT_AUDIT_RETENTION_DAYS): number {
  if (!Number.isInteger(days) || days < 1) throw new Error("the audit retention is a whole number of days from 1");
  return now - days * DAY_MS;
}

export async function pruneGitAudit(
  map: GitAuditPrunable,
  now: number,
  days = GIT_AUDIT_RETENTION_DAYS,
): Promise<number> {
  const cutoff = gitAuditCutoff(now, days);
  await map.deleteBefore("at", cutoff);
  return cutoff;
}
