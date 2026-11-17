import type { z } from "zod";
import type { BlobMetaLedger } from "../ledger.ts";
import type { BlobCache } from "../cache.ts";
import type { BlobStore } from "../blobs.ts";
import type { Repos } from "../repos.ts";
import type { GitOutput, GitRunOptions, GitRunner } from "../runner.ts";
import type { GitRepo } from "../validate.ts";

export interface Services {
  repos: Repos;
  runner: GitRunner;
  blobs: BlobStore;
  cache: BlobCache;
  ledger: BlobMetaLedger;
}

export interface ToolContext extends Services {
  caller: string;
  signal: AbortSignal;
  truncateChars: number;
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
