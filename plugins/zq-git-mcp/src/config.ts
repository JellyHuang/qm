import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

export const DEFAULT_REMOTE_BASE = "git@lab.skyunion.net:ca-programmer-zq/";

const GIB = 1024 ** 3;

const ENV_KEYS = {
  ZQ_GIT_MCP_SECRET: "secret",
  ZQ_GIT_MCP_DATA_DIR: "dataDir",
  ZQ_GIT_MCP_PORT: "port",
  ZQ_GIT_MCP_REMOTE_BASE: "remoteBase",
  ZQ_GIT_MCP_SSH_HOST_KEY: "sshHostKey",
  GITLAB_QM_READONLY_SSH_KEY_B64: "sshKeyB64",
  ZQ_GIT_MCP_SCRATCH_DIR: "scratchDir",
  ZQ_GIT_MCP_CACHE_DIR: "cacheDir",
  ZQ_GIT_MCP_TRUNCATE_CHARS: "truncateChars",
  ZQ_GIT_MCP_SCRATCH_CAP_BYTES: "scratchCapBytes",
  ZQ_GIT_MCP_FREE_FLOOR_BYTES: "freeFloorBytes",
  ZQ_GIT_MCP_CACHE_CAP_BYTES: "cacheCapBytes",
  ZQ_GIT_MCP_MAX_FETCHES: "maxFetches",
  ZQ_GIT_MCP_MAX_HEAVY_JOBS: "maxHeavyJobs",
  ZQ_GIT_MCP_REFRESH_MS: "refreshMs",
  ZQ_GIT_MCP_FETCH_TIMEOUT_MS: "fetchTimeoutMs",
  ZQ_GIT_MCP_GIT_TIMEOUT_MS: "gitTimeoutMs",
} as const;

const count = (min: number, fallback: number) => z.coerce.number().int().min(min).default(fallback);

const schema = z
  .strictObject({
    secret: z.string().min(16, "must be at least 16 characters"),
    dataDir: z.string().refine(isAbsolute, "must be an absolute path"),
    port: z.coerce.number().int().min(0).max(65535).default(8765),
    remoteBase: z.string().min(1).default(DEFAULT_REMOTE_BASE),
    sshHostKey: z.string().min(1).optional(),
    sshKeyB64: z.string().min(1).optional(),
    scratchDir: z.string().refine(isAbsolute, "must be an absolute path").optional(),
    cacheDir: z.string().refine(isAbsolute, "must be an absolute path").optional(),
    truncateChars: count(1000, 60_000),
    scratchCapBytes: count(1, 20 * GIB),
    freeFloorBytes: count(0, 5 * GIB),
    cacheCapBytes: count(1, 2 * GIB),
    maxFetches: count(1, 4),
    maxHeavyJobs: count(1, 2),
    refreshMs: count(0, 60_000),
    fetchTimeoutMs: count(1000, 30 * 60_000),
    gitTimeoutMs: count(1000, 60_000),
  })
  .superRefine((value, ctx) => {
    if (sshTarget(value.remoteBase) === undefined) return;
    for (const key of ["sshHostKey", "sshKeyB64"] as const)
      if (!value[key]) ctx.addIssue({ code: "custom", path: [key], message: "required for an ssh remote" });
  });

export interface Config {
  secret: string;
  port: number;
  remoteBase: string;
  ssh?: { target: string; keyB64: string; hostKey: string };
  clonesDir: string;
  scratchDir: string;
  cacheDir: string;
  truncateChars: number;
  scratchCapBytes: number;
  freeFloorBytes: number;
  cacheCapBytes: number;
  maxFetches: number;
  maxHeavyJobs: number;
  refreshMs: number;
  fetchTimeoutMs: number;
  gitTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function sshTarget(remoteBase: string): string | undefined {
  const url = URL.parse(remoteBase);
  if (url?.protocol === "ssh:") return `${url.username ? `${url.username}@` : ""}${url.hostname}`;
  if (url?.protocol === "file:" || remoteBase.startsWith("/")) return undefined;
  return /^([^@/:]+@)?([^:/]+):/.exec(remoteBase)?.slice(1, 3).join("");
}

export function loadConfig(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Config {
  const fromFile: Record<string, unknown> = {};
  const file = env.ZQ_GIT_MCP_CONFIG;
  if (file) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFile(file));
    } catch {
      throw new ConfigError(`ZQ_GIT_MCP_CONFIG: cannot read ${file} as JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new ConfigError("ZQ_GIT_MCP_CONFIG: expected a JSON object");
    Object.assign(fromFile, parsed);
  }
  const fromEnv = Object.fromEntries(
    Object.entries(ENV_KEYS)
      .filter(([name]) => env[name])
      .map(([name, key]) => [key, env[name]]),
  );
  const parsed = schema.safeParse({ ...fromFile, ...fromEnv });
  if (!parsed.success)
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; "),
    );
  const value = parsed.data;
  const target = sshTarget(value.remoteBase);
  return {
    secret: value.secret,
    port: value.port,
    remoteBase: value.remoteBase,
    ...(target && value.sshKeyB64 && value.sshHostKey
      ? { ssh: { target, keyB64: value.sshKeyB64, hostKey: value.sshHostKey } }
      : {}),
    clonesDir: join(value.dataDir, "clones"),
    scratchDir: value.scratchDir ?? join(value.dataDir, "scratch"),
    cacheDir: value.cacheDir ?? join(value.dataDir, "cache"),
    truncateChars: value.truncateChars,
    scratchCapBytes: value.scratchCapBytes,
    freeFloorBytes: value.freeFloorBytes,
    cacheCapBytes: value.cacheCapBytes,
    maxFetches: value.maxFetches,
    maxHeavyJobs: value.maxHeavyJobs,
    refreshMs: value.refreshMs,
    fetchTimeoutMs: value.fetchTimeoutMs,
    gitTimeoutMs: value.gitTimeoutMs,
  };
}
