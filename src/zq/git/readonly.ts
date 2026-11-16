import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resultBytes, type GitAudit, type GitAuditTarget } from "./audit.ts";
import type { GitLimits } from "./limits.ts";
import { GIT_FETCH_TIMEOUT_MS, type GitRunner } from "./runner.ts";
import {
  GitDenied,
  checkBranch,
  checkCount,
  checkFilter,
  checkLine,
  checkPath,
  checkPattern,
  checkRange,
  checkRepo,
  checkRevision,
  checkSha,
  checkSince,
  type GitRepo,
} from "./validate.ts";

export const MAX_COMMITS = 50;
export const MAX_FILES_PER_COMMIT_LISTING = 50;
export const MAX_COMMIT_MESSAGE_EXCERPT_BYTES = 1024;
export const MAX_FILES_IN_COMMIT = 200;
export const MAX_DIFF_BYTES = 64 * 1024;
export const MAX_DIFF_FILES = 20;
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_BLAME_LINES = 200;
export const MAX_BLAME_LINE_BYTES = 1024;
export const MAX_BRANCHES = 200;

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const BINARY_SNIFF_BYTES = 8000;
const BINARY_EXTENSIONS = /\.(xlsx|xlsm|xls)$/i;
const FIELD = "\u001f";
const FETCH_PRINCIPAL = "system";
const PARTIAL_CLONE_CONFIG = ["-c", "extensions.partialClone=origin", "-c", "remote.origin.promisor=true"];

export interface GitReadonlyConfig {
  dir: string;
  remotes: Readonly<Record<string, string>>;
  fetchTimeoutMs?: number;
}

export interface Cut {
  truncated: boolean;
  cutBytes?: number;
  cutItems?: number;
}

export interface FileChange {
  path: string;
  status: string;
  added: number | null;
  removed: number | null;
  binary: boolean;
  oldPath?: string;
  oldOid?: string;
  newOid?: string;
}

export interface BinaryFileInfo {
  path: string;
  status: string;
  oldOid?: string;
  newOid?: string;
  oldSize?: number;
  newSize?: number;
}

export interface CommitSummary {
  sha: string;
  authorName: string;
  authorEmail: string;
  date: string;
  subject: string;
  message: string;
  messageTruncated: boolean;
  branch: string;
  files: { path: string; status: string }[];
  filesTruncated: boolean;
}

export interface RecentCommits extends Cut {
  commits: CommitSummary[];
}

export interface CommitDetail extends Cut {
  sha: string;
  message: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  parents: string[];
  files: { path: string; status: string; added: number | null; removed: number | null; binary: boolean }[];
}

export interface DiffResult extends Cut {
  base: string;
  head: string;
  patch: string;
  files: { path: string; status: string; added: number | null; removed: number | null }[];
  binaryFiles: BinaryFileInfo[];
}

export type FileAtResult = Cut & { sha: string; path: string; oid: string; size: number } & (
    { binary: false; content: string } | { binary: true }
  );

export interface BlameLine {
  line: number;
  sha: string;
  author: string;
  date: string;
  text: string;
}

export interface BlameResult extends Cut {
  sha: string;
  path: string;
  lines: BlameLine[];
}

export interface BranchesResult extends Cut {
  branches: { name: string; sha: string; date: string }[];
}

export interface FetchResult extends Cut {
  repo: string;
}

export interface RemoteHeads {
  defaultBranch?: string;
  heads: number;
}

export function parseLsRemote(output: string): RemoteHeads {
  const lines = output.split("\n");
  const symref = lines.map((line) => /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line)?.[1]).find(Boolean);
  const heads = lines.filter((line) => /\trefs\/heads\/\S+$/.test(line)).length;
  return { ...(symref === undefined ? {} : { defaultBranch: checkBranch(symref) }), heads };
}

export interface GitReadonly {
  recentCommits(
    principal: string,
    repo: string,
    opts?: { branch?: string; since?: string; limit?: number },
  ): Promise<RecentCommits>;
  commit(principal: string, repo: string, sha: string): Promise<CommitDetail>;
  diff(principal: string, repo: string, target: string, path?: string): Promise<DiffResult>;
  fileAt(principal: string, repo: string, ref: string, path: string): Promise<FileAtResult>;
  blame(principal: string, repo: string, ref: string, path: string, start: number, end: number): Promise<BlameResult>;
  branches(principal: string, repo: string, pattern?: string): Promise<BranchesResult>;
  fetchRepo(repo: string, opts?: { filter?: string }): Promise<FetchResult>;
}

function clipUtf8(text: string, maxBytes: number): { text: string; cutBytes: number } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, cutBytes: 0 };
  return { text: decodeClipped(bytes.subarray(0, maxBytes)), cutBytes: bytes.length - maxBytes };
}

function decodeClipped(bytes: Buffer): string {
  return bytes.toString("utf8").replace(/�+$/, "");
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

const GLOB_TOKENS: Record<string, string> = { "*": ".*", "?": "." };

function globToRegExp(glob: string): RegExp {
  const body = [...glob].map((c) => GLOB_TOKENS[c] ?? c.replace(/[.+@/-]/g, "\\$&")).join("");
  return new RegExp(`^${body}$`);
}
function parseFileChanges(output: Buffer): FileChange[] {
  const tokens = output.toString("utf8").split("\0");
  const byPath = new Map<string, FileChange>();
  const order: FileChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (token.startsWith(":")) {
      const [, , oldOid, newOid, status = "M"] = token.split(" ");
      const renamed = status.startsWith("R") || status.startsWith("C");
      const oldPath = renamed ? tokens[++i] : undefined;
      const path = tokens[++i] ?? "";
      const zero = (oid: string | undefined) => (oid && /^0+$/.test(oid) ? undefined : oid);
      const change: FileChange = {
        path,
        status: status.slice(0, 1),
        added: null,
        removed: null,
        binary: BINARY_EXTENSIONS.test(path),
        ...(oldPath === undefined ? {} : { oldPath }),
        ...(zero(oldOid) ? { oldOid: zero(oldOid) } : {}),
        ...(zero(newOid) ? { newOid: zero(newOid) } : {}),
      };
      byPath.set(path, change);
      order.push(change);
      continue;
    }
    const stat = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(token);
    if (!stat) continue;
    const path = stat[3] === "" ? (tokens[(i += 2)] ?? "") : (stat[3] ?? "");
    const change = byPath.get(path);
    if (!change) continue;
    if (stat[1] === "-") change.binary = true;
    else {
      change.added = Number(stat[1]);
      change.removed = Number(stat[2]);
    }
  }
  return order;
}

export function createGitReadonly(deps: {
  config: GitReadonlyConfig;
  runner: GitRunner;
  audit: GitAudit;
  limits: GitLimits;
  now: () => number;
}): GitReadonly {
  const { config, runner, audit, limits } = deps;
  const limited = <T extends { truncated: boolean }>(
    principal: string,
    tool: string,
    target: GitAuditTarget,
    call: () => Promise<T>,
  ) =>
    audit.audited(principal, tool, target, async () => {
      await limits.admit(principal);
      const value = await call();
      await limits.settle(principal, resultBytes(value));
      return value;
    });
  const dirOf = (repo: GitRepo) => join(config.dir, `${repo}.git`);

  async function git(repo: GitRepo, args: readonly string[], maxBytes?: number) {
    return runner.run(dirOf(repo), args, maxBytes === undefined ? {} : { maxBytes });
  }

  async function gitText(repo: GitRepo, args: readonly string[]): Promise<string> {
    return (await git(repo, args)).stdout.toString("utf8");
  }

  async function resolveCommit(repo: GitRepo, rev: string): Promise<string> {
    try {
      return (await gitText(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`])).trim();
    } catch {
      throw new GitDenied("not_found", "no such revision");
    }
  }

  async function firstParent(repo: GitRepo, sha: string): Promise<string> {
    try {
      return (await gitText(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}^1`])).trim();
    } catch {
      return EMPTY_TREE;
    }
  }

  async function changesBetween(repo: GitRepo, base: string, head: string, paths: readonly string[] = []) {
    const args = ["diff", "--raw", "--numstat", "-z", "-M", "--no-abbrev", "--no-ext-diff", "--no-textconv"];
    const out = await git(repo, [...args, "--end-of-options", base, head, "--", ...paths]);
    return parseFileChanges(out.stdout);
  }

  async function blobAt(repo: GitRepo, sha: string, path: string): Promise<{ oid: string; size: number }> {
    const out = await gitText(repo, ["ls-tree", "-z", "-l", "--end-of-options", sha, "--", path]);
    const match = /^(\d+) (\w+) ([0-9a-f]+) +(\d+|-)\t([^\0]*)\0?$/.exec(out);
    if (!match || match[2] !== "blob" || match[5] !== path)
      throw new GitDenied("not_found", "no such file at that ref");
    return { oid: match[3] ?? "", size: Number(match[4]) };
  }

  async function blobSize(repo: GitRepo, oid: string | undefined): Promise<number | undefined> {
    if (!oid) return undefined;
    return Number((await gitText(repo, ["cat-file", "-s", oid])).trim());
  }

  async function recentCommits(
    principal: string,
    repoName: string,
    opts: { branch?: string; since?: string; limit?: number } = {},
  ): Promise<RecentCommits> {
    return limited(principal, "git_recent_commits", { repo: repoName, ref: opts.branch }, async () => {
      const repo = checkRepo(repoName);
      const branch = opts.branch === undefined ? undefined : checkBranch(opts.branch);
      const since = opts.since === undefined ? undefined : checkSince(opts.since);
      const limit = checkCount(opts.limit, MAX_COMMITS, MAX_COMMITS);
      const format = ["%H", "%P", "%an", "%ae", "%aI", "%s", "%B"].join("%x1f");
      const out = await git(repo, [
        "log",
        "-z",
        `--format=${format}`,
        "-n",
        String(limit + 1),
        ...(since ? [`--since=${since}`] : []),
        "--end-of-options",
        branch ? `refs/heads/${branch}` : "HEAD",
        "--",
      ]);
      const records = out.stdout.toString("utf8").split("\0").filter(Boolean);
      const commits: CommitSummary[] = [];
      for (const record of records.slice(0, limit)) {
        const [sha = "", parents = "", authorName = "", authorEmail = "", date = "", subject = "", ...rest] =
          record.split(FIELD);
        const message = clipUtf8(rest.join(FIELD).trim(), MAX_COMMIT_MESSAGE_EXCERPT_BYTES);
        const parent = parents.split(" ")[0] || EMPTY_TREE;
        const changes = await changesBetween(repo, parent, sha);
        commits.push({
          sha,
          authorName,
          authorEmail,
          date,
          subject,
          message: message.text,
          messageTruncated: message.cutBytes > 0,
          branch: branch ?? "HEAD",
          files: changes.slice(0, MAX_FILES_PER_COMMIT_LISTING).map(({ path, status }) => ({ path, status })),
          filesTruncated: changes.length > MAX_FILES_PER_COMMIT_LISTING,
        });
      }
      const more = records.length > limit || out.truncated;
      return { commits, truncated: more, ...(out.truncated ? { cutBytes: out.cutBytes } : {}) };
    });
  }

  async function commit(principal: string, repoName: string, shaArg: string): Promise<CommitDetail> {
    return limited(principal, "git_commit", { repo: repoName, ref: shaArg }, async () => {
      const repo = checkRepo(repoName);
      const sha = await resolveCommit(repo, checkSha(shaArg));
      const format = ["%H", "%P", "%an", "%ae", "%aI", "%cn", "%ce", "%cI", "%B"].join("%x1f");
      const out = await git(repo, ["log", "-n", "1", "-z", `--format=${format}`, "--end-of-options", sha, "--"]);
      const [, parents = "", an = "", ae = "", ad = "", cn = "", ce = "", cd = "", ...rest] = out.stdout
        .toString("utf8")
        .replace(/\0$/, "")
        .split(FIELD);
      const changes = await changesBetween(repo, parents.split(" ")[0] || EMPTY_TREE, sha);
      const shown = changes.slice(0, MAX_FILES_IN_COMMIT);
      return {
        sha,
        message: rest.join(FIELD).trim(),
        author: { name: an, email: ae, date: ad },
        committer: { name: cn, email: ce, date: cd },
        parents: parents.split(" ").filter(Boolean),
        files: shown.map(({ path, status, added, removed, binary }) => ({ path, status, added, removed, binary })),
        truncated: changes.length > shown.length,
        ...(changes.length > shown.length ? { cutItems: changes.length - shown.length } : {}),
      };
    });
  }

  async function diff(principal: string, repoName: string, target: string, pathArg?: string): Promise<DiffResult> {
    return limited(principal, "git_diff", { repo: repoName, ref: target, path: pathArg }, async () => {
      const repo = checkRepo(repoName);
      const range = typeof target === "string" ? checkRange(target) : undefined;
      const path = pathArg === undefined ? undefined : checkPath(pathArg);
      let base: string;
      let head: string;
      if (range) {
        base = await resolveCommit(repo, range.base);
        head = await resolveCommit(repo, range.head);
      } else {
        head = await resolveCommit(repo, checkSha(target));
        base = await firstParent(repo, head);
      }
      const changes = await changesBetween(repo, base, head, path ? [path] : []);
      const shown = changes.slice(0, MAX_DIFF_FILES);
      const text = shown.filter((c) => !c.binary);
      const binaryFiles: BinaryFileInfo[] = [];
      for (const c of shown.filter((f) => f.binary)) {
        const [oldSize, newSize] = [await blobSize(repo, c.oldOid), await blobSize(repo, c.newOid)];
        binaryFiles.push({
          path: c.path,
          status: c.status,
          ...(c.oldOid ? { oldOid: c.oldOid } : {}),
          ...(c.newOid ? { newOid: c.newOid } : {}),
          ...(oldSize === undefined ? {} : { oldSize }),
          ...(newSize === undefined ? {} : { newSize }),
        });
      }
      const pathspec = text.flatMap((c) => (c.oldPath ? [c.oldPath, c.path] : [c.path]));
      const out =
        pathspec.length === 0
          ? { stdout: Buffer.alloc(0), truncated: false, cutBytes: 0 }
          : await git(
              repo,
              [
                "diff",
                "-p",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "-M",
                "--end-of-options",
                base,
                head,
                "--",
                ...pathspec,
              ],
              MAX_DIFF_BYTES,
            );
      const filesCut = changes.length - shown.length;
      return {
        base,
        head,
        patch: decodeClipped(out.stdout),
        files: text.map(({ path: p, status, added, removed }) => ({ path: p, status, added, removed })),
        binaryFiles,
        truncated: out.truncated || filesCut > 0,
        ...(out.truncated ? { cutBytes: out.cutBytes } : {}),
        ...(filesCut > 0 ? { cutItems: filesCut } : {}),
      };
    });
  }

  async function fileAt(principal: string, repoName: string, refArg: string, pathArg: string): Promise<FileAtResult> {
    return limited(principal, "git_file_at", { repo: repoName, ref: refArg, path: pathArg }, async () => {
      const repo = checkRepo(repoName);
      const rev = checkRevision(refArg);
      const path = checkPath(pathArg);
      const sha = await resolveCommit(repo, rev);
      const { oid, size } = await blobAt(repo, sha, path);
      const base = { sha, path, oid, size };
      if (BINARY_EXTENSIONS.test(path)) return { ...base, binary: true, truncated: false };
      const out = await git(repo, ["cat-file", "blob", oid], MAX_FILE_BYTES);
      if (isBinary(out.stdout)) return { ...base, binary: true, truncated: false };
      const cutBytes = size - out.stdout.length;
      return {
        ...base,
        binary: false,
        content: decodeClipped(out.stdout),
        truncated: out.truncated,
        ...(out.truncated ? { cutBytes } : {}),
      };
    });
  }

  async function blame(
    principal: string,
    repoName: string,
    refArg: string,
    pathArg: string,
    startArg: number,
    endArg: number,
  ): Promise<BlameResult> {
    return limited(principal, "git_blame", { repo: repoName, ref: refArg, path: pathArg }, async () => {
      const repo = checkRepo(repoName);
      const rev = checkRevision(refArg);
      const path = checkPath(pathArg);
      const start = checkLine(startArg);
      const end = checkLine(endArg);
      if (end < start) throw new GitDenied("bad_number", "end is before start");
      const sha = await resolveCommit(repo, rev);
      await blobAt(repo, sha, path);
      const last = Math.min(end, start + MAX_BLAME_LINES - 1);
      const out = await gitText(repo, ["blame", "--porcelain", "-L", `${start},${last}`, sha, "--", path]);
      const meta = new Map<string, { author: string; date: string }>();
      const lines: BlameLine[] = [];
      let current: { sha: string; line: number } | undefined;
      let cutBytes = 0;
      for (const row of out.split("\n")) {
        if (row.startsWith("\t") && current) {
          const clipped = clipUtf8(row.slice(1), MAX_BLAME_LINE_BYTES);
          cutBytes += clipped.cutBytes;
          const m = meta.get(current.sha);
          lines.push({
            line: current.line,
            sha: current.sha,
            author: m?.author ?? "",
            date: m?.date ?? "",
            text: clipped.text,
          });
          continue;
        }
        const header = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(row);
        if (header) {
          current = { sha: header[1] ?? "", line: Number(header[2]) };
          if (!meta.has(current.sha)) meta.set(current.sha, { author: "", date: "" });
        } else if (current) {
          const m = meta.get(current.sha);
          if (m && row.startsWith("author ")) m.author = row.slice(7);
          if (m && row.startsWith("author-time ")) m.date = new Date(Number(row.slice(12)) * 1000).toISOString();
        }
      }
      const linesCut = end - last;
      return {
        sha,
        path,
        lines,
        truncated: linesCut > 0 || cutBytes > 0,
        ...(cutBytes > 0 ? { cutBytes } : {}),
        ...(linesCut > 0 ? { cutItems: linesCut } : {}),
      };
    });
  }

  async function branches(principal: string, repoName: string, patternArg?: string): Promise<BranchesResult> {
    return limited(principal, "git_branches", { repo: repoName, ref: patternArg }, async () => {
      const repo = checkRepo(repoName);
      const matcher = patternArg === undefined ? undefined : globToRegExp(checkPattern(patternArg));
      const format = ["%(refname:short)", "%(objectname)", "%(committerdate:iso-strict)"].join("%1f");
      const out = await gitText(repo, [
        "for-each-ref",
        `--format=${format}`,
        "--sort=refname",
        "--sort=-committerdate",
        "refs/heads",
      ]);
      const all = out
        .split("\n")
        .filter(Boolean)
        .map((row) => {
          const [name = "", sha = "", date = ""] = row.split(FIELD);
          return { name, sha, date };
        })
        .filter((b) => !matcher || matcher.test(b.name));
      const shown = all.slice(0, MAX_BRANCHES);
      return {
        branches: shown,
        truncated: all.length > shown.length,
        ...(all.length > shown.length ? { cutItems: all.length - shown.length } : {}),
      };
    });
  }

  async function fetchRepo(repoName: string, opts: { filter?: string } = {}): Promise<FetchResult> {
    return audit.audited(FETCH_PRINCIPAL, "git_fetch", { repo: repoName }, async () => {
      const repo = checkRepo(repoName);
      const url = config.remotes[repo];
      if (!url) throw new GitDenied("no_remote", "no remote configured");
      const filter = opts.filter === undefined ? undefined : checkFilter(opts.filter);
      const args = [
        ...(filter ? PARTIAL_CLONE_CONFIG : []),
        "fetch",
        "--prune",
        "--update-head-ok",
        "--no-write-fetch-head",
        "--quiet",
        ...(filter ? [`--filter=${filter}`] : []),
      ];
      const dir = dirOf(repo);
      await mkdir(config.dir, { recursive: true });
      await runner.run(dir, ["init", "--bare", "--quiet"]);
      const listed = await runner.run(dir, ["ls-remote", "--symref", url, "HEAD"], { remote: true });
      await runner.run(dir, [...args, url, "+refs/heads/*:refs/heads/*"], {
        remote: true,
        timeoutMs: config.fetchTimeoutMs ?? GIT_FETCH_TIMEOUT_MS,
      });
      const { defaultBranch } = parseLsRemote(listed.stdout.toString("utf8"));
      if (defaultBranch) await runner.run(dir, ["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`]);
      return { repo, truncated: false };
    });
  }

  return { recentCommits, commit, diff, fileAt, blame, branches, fetchRepo };
}

let active: GitReadonly | undefined;

export function setZqGit(module: GitReadonly | undefined): void {
  active = module;
}

export function zqGit(): GitReadonly | undefined {
  return active;
}
