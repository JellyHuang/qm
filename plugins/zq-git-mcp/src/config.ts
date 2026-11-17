import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

export const DEFAULT_REMOTE_BASE = "git@lab.skyunion.net:ca-programmer-zq/";

const GIB = 1024 ** 3;

const ENV_KEYS = {
  ZQ_GIT_MCP_SECRET: "secret",
  ZQ_GIT_MCP_DATA_DIR: "dataDir",
  ZQ_GIT_MCP_PORT: "port",
  ZQ_GIT_MCP_REMOTE_BASE: "remoteBase",
  ZQ_GIT_MCP_SSH_HOST_FINGERPRINT: "sshHostFingerprint",
  GITLAB_QM_READONLY_SSH_KEY_B64: "sshKeyB64",
  ZQ_GIT_MCP_SCRATCH_DIR: "scratchDir",
  ZQ_GIT_MCP_CACHE_DIR: "cacheDir",
  ZQ_GIT_MCP_TRUNCATE_CHARS: "truncateChars",
  ZQ_GIT_MCP_SCRATCH_CAP_BYTES: "scratchCapBytes",
  ZQ_GIT_MCP_FREE_FLOOR_BYTES: "freeFloorBytes",
  ZQ_GIT_MCP_CACHE_CAP_BYTES: "cacheCapBytes",
  ZQ_GIT_MCP_MAX_FETCHES: "maxFetches",
  ZQ_GIT_MCP_MAX_HEAVY_JOBS: "maxHeavyJobs",
  ZQ_GIT_MCP_MAX_BIG_FETCHES: "maxBigFetches",
  ZQ_GIT_MCP_FETCH_NO_PROGRESS_MS: "fetchNoProgressMs",
  ZQ_GIT_MCP_FETCH_FAILURE_TTL_MS: "fetchFailureTtlMs",
  ZQ_GIT_MCP_REFRESH_MS: "refreshMs",
  ZQ_GIT_MCP_AUDIT: "audit",
  ZQ_GIT_MCP_TIPS: "tips",
  ZQ_GIT_MCP_BLOB_META: "blobMeta",
  ZQ_GIT_MCP_DATABASE_URL: "databaseUrl",
  ZQ_GIT_MCP_TENANT_ID: "tenantId",
  ZQ_GIT_MCP_AUDIT_ON_FAILURE: "auditOnFailure",
  ZQ_GIT_MCP_AUDIT_SPOOL_DIR: "auditSpoolDir",
  ZQ_GIT_MCP_AUDIT_SPOOL_MAX_BYTES: "auditSpoolMaxBytes",
  ZQ_GIT_MCP_AUDIT_SPOOL_MAX_AGE_MS: "auditSpoolMaxAgeMs",
  ZQ_GIT_MCP_XLSX_TIMEOUT_MS: "xlsxTimeoutMs",
  ZQ_GIT_MCP_XLSX_MAX_HEAP_MB: "xlsxMaxHeapMb",
  ZQ_GIT_MCP_XLSX_NO_PROGRESS_MS: "xlsxNoProgressMs",
  ZQ_GIT_MCP_REGEX_TIMEOUT_MS: "regexTimeoutMs",
  ZQ_GIT_MCP_REGEX_MAX_CHARS: "regexMaxChars",
  ZQ_GIT_MCP_FETCH_TIMEOUT_MS: "fetchTimeoutMs",
  ZQ_GIT_MCP_GIT_TIMEOUT_MS: "gitTimeoutMs",
  ZQ_GIT_MCP_GIT_BIN: "gitBin",
  ZQ_GIT_MCP_SSH_BIN: "sshBin",
  ZQ_GIT_MCP_PATH: "path",
} as const;

const count = (min: number, fallback: number) => z.coerce.number().int().min(min).default(fallback);

const schema = z
  .strictObject({
    secret: z.string().min(16, "must be at least 16 characters"),
    dataDir: z.string().refine(isAbsolute, "must be an absolute path"),
    port: z.coerce.number().int().min(0).max(65535).default(8765),
    remoteBase: z.string().min(1).default(DEFAULT_REMOTE_BASE),
    sshHostFingerprint: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]{43}$/, "expected a SHA256:<base64> host key fingerprint")
      .optional(),
    sshKeyB64: z.string().min(1).optional(),
    scratchDir: z.string().refine(isAbsolute, "must be an absolute path").optional(),
    cacheDir: z.string().refine(isAbsolute, "must be an absolute path").optional(),
    truncateChars: count(1000, 60_000),
    scratchCapBytes: count(1, 20 * GIB),
    freeFloorBytes: count(0, 5 * GIB),
    cacheCapBytes: count(1, 2 * GIB),
    maxFetches: count(1, 4),
    maxHeavyJobs: count(1, 2),
    maxBigFetches: count(1, 2),
    fetchNoProgressMs: count(1000, 180_000),
    fetchFailureTtlMs: count(0, 60_000),
    refreshMs: count(0, 60_000),
    audit: z.enum(["memory", "postgres"]).default("memory"),
    tips: z.enum(["memory", "postgres"]).default("memory"),
    blobMeta: z.enum(["memory", "postgres"]).default("memory"),
    databaseUrl: z
      .string()
      .regex(/^postgres(ql)?:\/\//, "must be a postgres:// url")
      .optional(),
    tenantId: z.uuid().optional(),
    auditOnFailure: z.enum(["serve", "fail"]).default("serve"),
    auditSpoolDir: z.string().refine(isAbsolute, "must be an absolute path").optional(),
    auditSpoolMaxBytes: count(1024, 64 * 1024 * 1024),
    auditSpoolMaxAgeMs: count(1000, 7 * 24 * 3600 * 1000),
    xlsxTimeoutMs: count(1000, 15 * 60_000),
    xlsxMaxHeapMb: count(64, 768),
    xlsxNoProgressMs: count(100, 180_000),
    regexTimeoutMs: count(100, 30_000),
    regexMaxChars: count(1, 500),
    fetchTimeoutMs: count(1000, 30 * 60_000),
    gitTimeoutMs: count(1000, 60_000),
    gitBin: z.string().refine(isAbsolute, "must be an absolute path").optional(),
    sshBin: z.string().refine(isAbsolute, "must be an absolute path").optional(),
    path: z.string().min(1).default("/usr/local/bin:/usr/bin:/bin"),
  })
  .superRefine((value, ctx) => {
    if (
      (value.audit === "postgres" || value.tips === "postgres" || value.blobMeta === "postgres") &&
      !value.databaseUrl
    )
      ctx.addIssue({
        code: "custom",
        path: ["databaseUrl"],
        message: "required when audit, tips or blobMeta is postgres",
      });
    if (sshTarget(value.remoteBase) === undefined) return;
    for (const key of ["sshHostFingerprint", "sshKeyB64"] as const)
      if (!value[key]) ctx.addIssue({ code: "custom", path: [key], message: "required for an ssh remote" });
  });

export interface Config {
  secret: string;
  port: number;
  remoteBase: string;
  ssh?: { target: string; keyB64: string; hostFingerprint: string };
  clonesDir: string;
  scratchDir: string;
  cacheDir: string;
  truncateChars: number;
  scratchCapBytes: number;
  freeFloorBytes: number;
  cacheCapBytes: number;
  maxFetches: number;
  maxHeavyJobs: number;
  maxBigFetches: number;
  fetchNoProgressMs: number;
  fetchFailureTtlMs: number;
  refreshMs: number;
  audit: "memory" | "postgres";
  tips: "memory" | "postgres";
  blobMeta: "memory" | "postgres";
  database?: { url: string; tenantId?: string };
  auditOnFailure: "serve" | "fail";
  auditSpoolDir: string;
  auditSpoolMaxBytes: number;
  auditSpoolMaxAgeMs: number;
  xlsxTimeoutMs: number;
  xlsxMaxHeapMb: number;
  xlsxNoProgressMs: number;
  regexTimeoutMs: number;
  regexMaxChars: number;
  fetchTimeoutMs: number;
  gitTimeoutMs: number;
  gitBin?: string;
  sshBin?: string;
  childPath: string;
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
    ...(target && value.sshKeyB64 && value.sshHostFingerprint
      ? { ssh: { target, keyB64: value.sshKeyB64, hostFingerprint: value.sshHostFingerprint } }
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
    maxBigFetches: value.maxBigFetches,
    fetchNoProgressMs: value.fetchNoProgressMs,
    fetchFailureTtlMs: value.fetchFailureTtlMs,
    refreshMs: value.refreshMs,
    audit: value.audit,
    tips: value.tips,
    blobMeta: value.blobMeta,
    ...(value.databaseUrl
      ? { database: { url: value.databaseUrl, ...(value.tenantId ? { tenantId: value.tenantId } : {}) } }
      : {}),
    auditOnFailure: value.auditOnFailure,
    auditSpoolDir: value.auditSpoolDir ?? join(value.dataDir, "audit-spool"),
    auditSpoolMaxBytes: value.auditSpoolMaxBytes,
    auditSpoolMaxAgeMs: value.auditSpoolMaxAgeMs,
    xlsxTimeoutMs: value.xlsxTimeoutMs,
    xlsxMaxHeapMb: value.xlsxMaxHeapMb,
    xlsxNoProgressMs: value.xlsxNoProgressMs,
    regexTimeoutMs: value.regexTimeoutMs,
    regexMaxChars: value.regexMaxChars,
    fetchTimeoutMs: value.fetchTimeoutMs,
    gitTimeoutMs: value.gitTimeoutMs,
    ...(value.gitBin ? { gitBin: value.gitBin } : {}),
    ...(value.sshBin ? { sshBin: value.sshBin } : {}),
    childPath: [...new Set([...(value.gitBin ? [dirname(value.gitBin)] : []), ...value.path.split(":")])].join(":"),
  };
}
