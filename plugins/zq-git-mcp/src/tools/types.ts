import type { z } from "zod";
import type { AuditHealth } from "../audit.ts";
import type { TipStore } from "../tip-store.ts";
import type { BlobMetaLedger } from "../ledger.ts";
import type { BlobCache } from "../cache.ts";
import type { BlobStore } from "../blobs.ts";
import type { Repos } from "../repos.ts";
import type { GitOutput, GitRunOptions, GitRunner } from "../runner.ts";
import type { GitRepo } from "../validate.ts";

export interface ToolLimits {
  xlsxTimeoutMs: number;
  xlsxNoProgressMs: number;
  xlsxMaxHeapMb: number;
  regexTimeoutMs: number;
  regexMaxChars: number;
}

export class ToolFailure extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
    this.details = details;
  }
}

export interface Services {
  repos: Repos;
  runner: GitRunner;
  blobs: BlobStore;
  cache: BlobCache;
  ledger: BlobMetaLedger;
  tips: TipStore;
  gitInfo: { binary: string; version: string };
  limits: ToolLimits;
}

export interface ToolContext extends Services {
  caller: string;
  signal: AbortSignal;
  truncateChars: number;
  auditHealth(): AuditHealth;
  state: { cacheHit: boolean };
  git(repo: GitRepo, args: readonly string[], opts?: GitRunOptions): Promise<GitOutput>;
}

export type ToolData = Record<string, unknown> & { truncated?: boolean };

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodType;
  run(ctx: ToolContext, args: never): Promise<ToolData>;
}

export function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  input: S;
  run(ctx: ToolContext, args: z.infer<S>): Promise<ToolData>;
}): ToolDef {
  return def;
}
