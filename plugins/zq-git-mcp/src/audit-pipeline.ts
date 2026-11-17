import { AuditUnavailableError, type AuditHealth, type AuditRow, type AuditSink, type AuditTarget } from "./audit.ts";
import { createSpool } from "./audit-spool.ts";

export type AuditAlarmEvent =
  | { kind: "audit_write_failed"; error: string; backlog: number }
  | { kind: "audit_dropped"; reason: "spool_full" | "spool_unwritable" | "expired"; dropped: number }
  | { kind: "audit_recovered"; replayed: number };

export type AuditAlarm = (event: AuditAlarmEvent) => void;

export interface AuditPipelineOptions {
  target: AuditTarget;
  onFailure: "serve" | "fail";
  spoolDir: string;
  spoolMaxBytes: number;
  spoolMaxAgeMs: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
  alarm?: AuditAlarm;
  log?: (line: string) => void;
  now?: () => number;
}

export interface AuditPipeline extends AuditSink {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const MAX_ERROR_CHARS = 300;
const SECRET_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi;

export function describeFailure(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(SECRET_URL, "[url]").slice(0, MAX_ERROR_CHARS);
}

export function createAuditPipeline(options: AuditPipelineOptions): AuditPipeline {
  const { target } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(line));
  const initialMs = options.retryInitialMs ?? 1000;
  const maxMs = options.retryMaxMs ?? 60_000;
  const spool = createSpool({
    dir: options.spoolDir,
    maxBytes: options.spoolMaxBytes,
    maxAgeMs: options.spoolMaxAgeMs,
    now,
  });
  let chain: Promise<unknown> = Promise.resolve();
  let lastError: string | undefined;
  let lastAttemptFailed = false;
  let failures = 0;
  let dropped = 0;
  let delay = initialMs;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.catch(() => undefined);
    return run;
  };

  const raise = (event: AuditAlarmEvent) => {
    log(JSON.stringify({ level: "error", component: "zq-git-mcp", ...event }));
    try {
      options.alarm?.(event);
    } catch (e) {
      log(
        JSON.stringify({
          level: "error",
          component: "zq-git-mcp",
          kind: "audit_alarm_failed",
          error: describeFailure(e),
        }),
      );
    }
  };

  const failed = (e: unknown) => {
    failures++;
    lastAttemptFailed = true;
    lastError = describeFailure(e);
    raise({ kind: "audit_write_failed", error: lastError, backlog: spool.backlog() });
  };

  const drop = (reason: "spool_full" | "spool_unwritable" | "expired", count: number) => {
    dropped += count;
    raise({ kind: "audit_dropped", reason, dropped });
  };

  const schedule = () => {
    if (stopped || timer || spool.backlog() === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void serial(replay);
    }, delay);
    timer.unref();
  };

  async function replay(): Promise<void> {
    const result = await spool.drain((row) => target.record(row));
    if (result.expired > 0) drop("expired", result.expired);
    if (result.failure !== undefined) {
      failed(result.failure);
      delay = Math.min(delay * 2, maxMs);
      schedule();
      return;
    }
    delay = initialMs;
    if (lastAttemptFailed || result.replayed > 0) {
      lastAttemptFailed = false;
      raise({ kind: "audit_recovered", replayed: result.replayed });
    }
  }

  async function spoolRow(row: AuditRow): Promise<void> {
    try {
      if ((await spool.append(row)) === "dropped") drop("spool_full", 1);
    } catch (e) {
      failed(e);
      drop("spool_unwritable", 1);
    }
    schedule();
  }

  return {
    record(row) {
      return serial(async () => {
        if (options.onFailure === "fail") {
          try {
            await target.record(row);
            lastAttemptFailed = false;
          } catch (e) {
            failed(e);
            throw new AuditUnavailableError();
          }
          return;
        }
        if (spool.backlog() === 0) {
          try {
            await target.record(row);
            lastAttemptFailed = false;
            return;
          } catch (e) {
            failed(e);
          }
        }
        await spoolRow(row);
      });
    },
    health(): AuditHealth {
      return {
        auditBacklog: spool.backlog(),
        auditDegraded: spool.backlog() > 0 || lastAttemptFailed || dropped > 0,
        ...(lastError ? { auditLastError: lastError } : {}),
        auditDropped: dropped,
        auditFailures: failures,
      };
    },
    async start() {
      stopped = false;
      await serial(async () => {
        await spool.load();
        if (spool.backlog() > 0) await replay();
      });
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      await chain;
    },
  };
}
