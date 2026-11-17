export const GIT_REPOS = {
  client: "main",
  clientcode: "main",
  CommonMessage: "main",
  gameconfig: "main",
  jenkinstasks: "master",
  server: "main",
  "zq-ui": "main",
} as const;

export type GitRepo = keyof typeof GIT_REPOS;

export class GitDenied extends Error {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "GitDenied";
    this.reason = reason;
  }
}

const MAX_REF_LENGTH = 200;
const MAX_PATH_LENGTH = 1024;
const MAX_AUTHOR_LENGTH = 200;
export const MAX_COMMITS = 10_000;

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/+@-]*$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/+@^~-]*$/;
const SHA = /^[0-9a-f]{7,64}$/i;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SINCE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const HAS_CONTROL = /[\u0000-\u001f\u007f]/;

function isGitRepo(name: string): name is GitRepo {
  return Object.hasOwn(GIT_REPOS, name);
}

export function checkRepo(name: unknown): GitRepo {
  if (typeof name !== "string" || !isGitRepo(name)) throw new GitDenied("repo_not_allowed", "unknown repository");
  return name;
}

function refLike(kind: string, value: unknown, shape: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REF_LENGTH)
    throw new GitDenied(`bad_${kind}`, `length must be 1 through ${MAX_REF_LENGTH}`);
  if (!shape.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/") || value.endsWith("."))
    throw new GitDenied(`bad_${kind}`, "not a plain name");
  return value;
}

export function checkBranch(value: unknown): string {
  return refLike("branch", value, BRANCH);
}

function checkRevision(value: unknown): string {
  return refLike("ref", value, REVISION);
}

export function checkSha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new GitDenied("bad_sha", "expected 7 to 64 hex digits");
  return value.toLowerCase();
}

export function checkOid(value: unknown): string {
  if (typeof value !== "string" || !OID.test(value)) throw new GitDenied("bad_oid", "expected a full object id");
  return value;
}

export function checkRange(value: string): { base: string; head: string } | undefined {
  if (!value.includes("..")) return undefined;
  const parts = value.split("..");
  if (parts.length !== 2) throw new GitDenied("bad_range", "expected base..head");
  return { base: checkRevision(parts[0]), head: checkRevision(parts[1]) };
}

export function checkPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH)
    throw new GitDenied("bad_path", `length must be 1 through ${MAX_PATH_LENGTH}`);
  if (HAS_CONTROL.test(value)) throw new GitDenied("bad_path", "control characters");
  if (value.startsWith("/") || value.startsWith("-") || value.startsWith(":"))
    throw new GitDenied("bad_path", "must be repository-relative");
  if (value.split("/").some((part) => part === ".." || part === "." || part === ""))
    throw new GitDenied("bad_path", "no empty, . or .. segments");
  return value;
}

export function checkAuthor(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_AUTHOR_LENGTH)
    throw new GitDenied("bad_author", `length must be 1 through ${MAX_AUTHOR_LENGTH}`);
  if (HAS_CONTROL.test(value)) throw new GitDenied("bad_author", "control characters");
  return value;
}

export function checkSince(value: unknown): string {
  if (typeof value !== "string" || !SINCE.test(value) || Number.isNaN(Date.parse(value.replace(" ", "T"))))
    throw new GitDenied("bad_date", "expected an ISO date");
  return value;
}

export function checkCount(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new GitDenied("bad_number", "expected a positive integer");
  return Math.min(value, max);
}

export function printable(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(CONTROL, "?").slice(0, MAX_PATH_LENGTH) : undefined;
}
