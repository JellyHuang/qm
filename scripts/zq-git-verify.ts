import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { createGitAudit, type GitAuditRow } from "../src/zq/git/audit.ts";
import { DEFAULT_GIT_LIMITS, createGitLimits } from "../src/zq/git/limits.ts";
import { createGitRunner, keyFileFrom, type GitRunner } from "../src/zq/git/runner.ts";
import { createGitReadonly, parseLsRemote, type GitReadonly } from "../src/zq/git/readonly.ts";
import { GIT_REPOS, GitDenied, isGitRepo } from "../src/zq/git/validate.ts";

const HOST = "lab.skyunion.net";
const KNOWN_HOSTS_LINE = `${HOST} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMEIOBJ8sBR+8HAyJpzbusIiN8rPdGAu3EyAlE0/abrv\n`;
const DEFAULT_DIR = "/tmp/zq-git-verify";
const DEFAULT_REPOS = ["gameconfig", "CommonMessage", "jenkinstasks"];
const READ_REPOS = ["gameconfig", "CommonMessage"];
const OUTSIDER = "qm-test";
const PRINCIPAL = "verify";
const TEXT_EXTENSIONS =
  /\.(txt|md|json|csv|cs|ts|js|lua|proto|go|py|ya?ml|xml|cfg|ini|sh|h|cpp|c|java|kt|groovy|gradle|properties)$/i;
const AUDIT_FIELDS = new Set(["at", "principal", "tool", "repo", "ref", "path", "bytes", "truncated", "result", "ms"]);

export const ZQ_REMOTES: Readonly<Record<string, string>> = Object.fromEntries(
  GIT_REPOS.map((repo) => [repo, `git@${HOST}:ca-programmer-zq/${repo}.git`]),
);

export const ZQ_DEFAULT_BRANCHES: Readonly<Record<string, string>> = Object.fromEntries(
  GIT_REPOS.map((repo) => [repo, repo === "jenkinstasks" ? "master" : "main"]),
);

export interface VerifyEnv {
  keyFile: string;
  dir: string;
  repos: string[];
}

export function parseVerifyEnv(env: Record<string, string | undefined>): VerifyEnv {
  const keyFile = env.ZQ_GIT_KEY_FILE?.trim();
  if (!keyFile) throw new Error("ZQ_GIT_KEY_FILE is required");
  const repos = (env.ZQ_GIT_VERIFY_REPOS?.trim() || DEFAULT_REPOS.join(","))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = repos.filter((name) => !isGitRepo(name));
  if (unknown.length > 0) throw new Error(`ZQ_GIT_VERIFY_REPOS names unknown repositories: ${unknown.join(", ")}`);
  return { keyFile, dir: env.ZQ_GIT_DIR?.trim() || DEFAULT_DIR, repos };
}

export interface AuditSummary {
  total: number;
  byResult: Record<string, number>;
  byTool: Record<string, number>;
  contentFree: boolean;
}

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export function summarizeAudit(rows: readonly GitAuditRow[]): AuditSummary {
  return {
    total: rows.length,
    byResult: tally(rows.map((row) => row.result)),
    byTool: tally(rows.map((row) => row.tool)),
    contentFree: rows.every((row) => Object.keys(row).every((key) => AUDIT_FIELDS.has(key))),
  };
}

function memoryAuditMap(): DurableMap<GitAuditRow> {
  const rows = new Map<string, GitAuditRow>();
  const map = {
    async put(id: string, value: GitAuditRow) {
      rows.set(id, value);
    },
    async all() {
      return [...rows.values()];
    },
  };
  return map as unknown as DurableMap<GitAuditRow>;
}

async function directoryBytes(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const sizes = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => (await stat(join(entry.parentPath, entry.name))).size),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

function errorClass(e: unknown): string {
  if (e instanceof GitDenied) return `denied:${e.reason}`;
  return e instanceof Error ? e.name : "error";
}

export interface VerifyOptions {
  remotes: Readonly<Record<string, string>>;
  defaults: Readonly<Record<string, string>>;
  dir: string;
  repos: readonly string[];
  runner: GitRunner;
  log: (line: string) => void;
}

export interface VerifyReport {
  failures: string[];
  summary: AuditSummary;
}

export async function runVerify(options: VerifyOptions): Promise<VerifyReport> {
  const { remotes, defaults, dir, repos, log } = options;
  const failures: string[] = [];
  let gitProcesses = 0;
  const runner: GitRunner = {
    run(gitDir, args, opts) {
      gitProcesses++;
      return options.runner.run(gitDir, args, opts);
    },
  };
  const check = (name: string, ok: boolean) => {
    log(`check ${name}: ${ok ? "pass" : "FAIL"}`);
    if (!ok) failures.push(name);
  };
  let clock = Date.now();
  const now = () => (clock = Math.max(clock + 1, Date.now()));
  const audit = createGitAudit({ map: memoryAuditMap(), now });
  const limits = createGitLimits({ config: DEFAULT_GIT_LIMITS, bytesSince: audit.bytesSince, now });
  const readonly = createGitReadonly({ config: { dir, remotes }, runner, audit, limits, now });

  log("step a: remote heads");
  for (const repo of GIT_REPOS) {
    const started = Date.now();
    try {
      const out = await runner.run(dir, ["ls-remote", "--symref", remotes[repo] ?? "", "HEAD", "refs/heads/*"], {
        remote: true,
      });
      const { heads, defaultBranch } = parseLsRemote(out.stdout.toString("utf8"));
      log(`${repo}: branches=${heads} default=${defaultBranch ?? "none"} ms=${Date.now() - started}`);
      check(`default branch of ${repo}`, defaultBranch === defaults[repo]);
    } catch (e) {
      log(`${repo}: error=${errorClass(e)} ms=${Date.now() - started}`);
      check(`ls-remote ${repo}`, false);
    }
  }

  log("step b: fetch");
  const fetched: string[] = [];
  for (const repo of repos) {
    const started = Date.now();
    try {
      await readonly.fetchRepo(repo);
      fetched.push(repo);
      const head = (await runner.run(join(dir, `${repo}.git`), ["symbolic-ref", "--short", "HEAD"])).stdout
        .toString("utf8")
        .trim();
      log(
        `${repo}: fetched ms=${Date.now() - started} bytes=${await directoryBytes(join(dir, `${repo}.git`))} head=${head}`,
      );
      check(`HEAD of ${repo} is the default branch`, head === defaults[repo]);
    } catch (e) {
      log(`${repo}: error=${errorClass(e)} ms=${Date.now() - started}`);
      check(`fetch ${repo}`, false);
    }
  }

  log("step c: read tools");
  for (const repo of READ_REPOS) {
    if (!fetched.includes(repo)) log(`${repo}: skipped, not fetched`);
    else await exerciseReads(readonly, repo, log, check);
  }

  log("step d: refused repository");
  const before = gitProcesses;
  const refused = await readonly.recentCommits(PRINCIPAL, OUTSIDER).then(
    () => undefined,
    (e: unknown) => e,
  );
  const rows = await audit.rows();
  const last = rows[rows.length - 1];
  log(`${OUTSIDER}: ${errorClass(refused)} audit=${last?.result ?? "none"} git processes=${gitProcesses - before}`);
  check("outsider refused before any git process", refused instanceof GitDenied && gitProcesses === before);
  check("outsider audited as denied", last?.result === "denied:repo_not_allowed");

  log("step e: audit");
  const summary = summarizeAudit(await audit.rows());
  log(`rows=${summary.total}`);
  log(`by result: ${JSON.stringify(summary.byResult)}`);
  log(`by tool: ${JSON.stringify(summary.byTool)}`);
  check("audit rows hold no content", summary.contentFree);
  log(failures.length === 0 ? "all checks passed" : `failed checks: ${failures.length}`);
  return { failures, summary };
}

async function exerciseReads(
  readonly: GitReadonly,
  repo: string,
  log: (line: string) => void,
  check: (name: string, ok: boolean) => void,
): Promise<void> {
  const report = async <T extends { truncated: boolean }>(tool: string, call: () => Promise<T>) => {
    try {
      const value = await call();
      log(`${repo} ${tool}: ok bytes=${Buffer.byteLength(JSON.stringify(value))} truncated=${value.truncated}`);
      return value;
    } catch (e) {
      log(`${repo} ${tool}: ${errorClass(e)}`);
      check(`${repo} ${tool}`, false);
      return undefined;
    }
  };
  const recent = await report("recentCommits", () => readonly.recentCommits(PRINCIPAL, repo, { limit: 1 }));
  const sha = recent?.commits[0]?.sha;
  if (!sha) return;
  log(`${repo}: latest=${sha.slice(0, 10)}`);
  const detail = await report("commit", () => readonly.commit(PRINCIPAL, repo, sha));
  await report("diff", () => readonly.diff(PRINCIPAL, repo, sha));
  await report("branches", () => readonly.branches(PRINCIPAL, repo));
  const candidate = detail?.files.find((f) => f.status !== "D" && !f.binary && TEXT_EXTENSIONS.test(f.path));
  if (!candidate) {
    log(`${repo}: fileAt and blame skipped, the latest commit changed no text file`);
    return;
  }
  const file = await report("fileAt", () => readonly.fileAt(PRINCIPAL, repo, sha, candidate.path));
  if (!file || file.binary) return;
  const lines = file.content.split("\n").length;
  await report("blame", () => readonly.blame(PRINCIPAL, repo, sha, candidate.path, 1, Math.min(20, lines)));
}

async function main(): Promise<void> {
  const env = parseVerifyEnv(process.env);
  const scratch = await mkdtemp(join(tmpdir(), "zq-git-verify-"));
  try {
    const knownHosts = join(scratch, "known_hosts");
    await writeFile(knownHosts, KNOWN_HOSTS_LINE);
    const runner = createGitRunner({
      knownHosts,
      withKeyFile: keyFileFrom(() => readFile(env.keyFile, "utf8")),
    });
    const { failures } = await runVerify({
      remotes: ZQ_REMOTES,
      defaults: ZQ_DEFAULT_BRANCHES,
      dir: env.dir,
      repos: env.repos,
      runner,
      log: (line) => console.log(line),
    });
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
