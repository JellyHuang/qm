export type AuditResult = "ok" | "error" | `denied:${string}`;

export interface AuditRow {
  id: string;
  at: number;
  principal: string;
  tool: string;
  repo?: string;
  ref?: string;
  path?: string;
  args: unknown;
  bytes: number;
  truncated: boolean;
  result: AuditResult;
  ms: number;
  cache_hit: boolean;
}

export interface AuditHealth {
  auditBacklog: number;
  auditDegraded: boolean;
  auditLastError?: string;
  auditDropped: number;
  auditFailures: number;
}

export interface AuditSink {
  record(row: AuditRow): Promise<void>;
  health(): AuditHealth;
}

export interface AuditTarget {
  record(row: AuditRow): Promise<void>;
}

export class AuditUnavailableError extends Error {
  constructor() {
    super("the call could not be recorded and was not served");
    this.name = "AuditUnavailableError";
  }
}

export interface MemoryAuditSink extends AuditSink {
  rows(): AuditRow[];
}

const MEMORY_AUDIT_ROWS = 10_000;

const HEALTHY: AuditHealth = { auditBacklog: 0, auditDegraded: false, auditDropped: 0, auditFailures: 0 };

export function createMemoryAuditSink(max = MEMORY_AUDIT_ROWS): MemoryAuditSink {
  const rows: AuditRow[] = [];
  return {
    async record(row) {
      if (rows.some((existing) => existing.id === row.id)) return;
      rows.push(row);
      if (rows.length > max) rows.splice(0, rows.length - max);
    },
    health: () => HEALTHY,
    rows: () => [...rows],
  };
}
