export type AuditResult = "ok" | `refused:${string}` | "error";

interface AuditRow {
  at: number;
  caller: string;
  tool: string;
  repo?: string;
  ref?: string;
  path?: string;
  args: string;
  bytes: number;
  truncated: boolean;
  result: AuditResult;
  durationMs: number;
  cacheHit: boolean;
}

export interface AuditSink {
  record(row: AuditRow): Promise<void>;
}

export interface MemoryAuditSink extends AuditSink {
  rows(): AuditRow[];
}

const MEMORY_AUDIT_ROWS = 10_000;

export function createMemoryAuditSink(max = MEMORY_AUDIT_ROWS): MemoryAuditSink {
  const rows: AuditRow[] = [];
  return {
    async record(row) {
      rows.push(row);
      if (rows.length > max) rows.splice(0, rows.length - max);
    },
    rows: () => [...rows],
  };
}
