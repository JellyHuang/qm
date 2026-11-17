import { randomUUID } from "node:crypto";
import type { DurableMap } from "../../persistence/durable-map.ts";
import { GitRateLimited } from "./limits.ts";
import { GitDenied, printable } from "./validate.ts";

type GitAuditResult = "ok" | `denied:${string}` | "rate_limited" | "error";

export interface GitAuditRow {
  at: number;
  principal: string;
  tool: string;
  repo?: string;
  ref?: string;
  path?: string;
  bytes: number;
  truncated: boolean;
  result: GitAuditResult;
  ms: number;
}

export interface GitAuditTarget {
  repo?: unknown;
  ref?: unknown;
  path?: unknown;
}

export interface GitAudit {
  audited<T extends { truncated: boolean }>(
    principal: string,
    tool: string,
    target: GitAuditTarget,
    call: () => Promise<T>,
  ): Promise<T>;
  rows(): Promise<GitAuditRow[]>;
  bytesSince(principal: string, since: number): Promise<number>;
}

export const resultBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

function resultOf(e: unknown): GitAuditResult {
  if (e instanceof GitRateLimited) return "rate_limited";
  return e instanceof GitDenied ? `denied:${e.reason}` : "error";
}

export function createGitAudit(deps: { map: DurableMap<GitAuditRow>; now: () => number }): GitAudit {
  const { map, now } = deps;

  async function record(
    principal: string,
    tool: string,
    target: GitAuditTarget,
    started: number,
    outcome: { bytes: number; truncated: boolean; result: GitAuditResult },
  ): Promise<void> {
    const repo = printable(target.repo);
    const ref = printable(target.ref);
    const path = printable(target.path);
    await map.put(randomUUID(), {
      at: started,
      principal,
      tool,
      ...(repo === undefined ? {} : { repo }),
      ...(ref === undefined ? {} : { ref }),
      ...(path === undefined ? {} : { path }),
      ...outcome,
      ms: now() - started,
    });
  }

  return {
    async audited(principal, tool, target, call) {
      const started = now();
      try {
        const value = await call();
        const bytes = resultBytes(value);
        await record(principal, tool, target, started, { bytes, truncated: value.truncated, result: "ok" });
        return value;
      } catch (e) {
        await record(principal, tool, target, started, { bytes: 0, truncated: false, result: resultOf(e) });
        throw e;
      }
    },
    async rows() {
      return (await map.all()).sort((a, b) => a.at - b.at);
    },
    async bytesSince(principal, since) {
      return (await map.all())
        .filter((row) => row.principal === principal && row.at >= since)
        .reduce((sum, row) => sum + row.bytes, 0);
    },
  };
}
