import { z } from "zod";
import {
  GitDenied,
  MAX_COMMITS,
  type GitRepo,
  checkAuthor,
  checkContext,
  checkCount,
  checkPath,
  checkQuery,
  checkRegex,
  checkRepo,
  checkRevision,
  globToRegExp,
} from "../validate.ts";
import { COMMIT_FORMAT, parseCommitRecord } from "./commit-format.ts";
import { grepFile, type GrepHit } from "./grep.ts";
import { RegexTimeoutError, createRegexGrep } from "./regex-grep.ts";
import { readLfsPointer } from "./lfs.ts";
import { sniff } from "./text-scan.ts";
import { listTree, resolveCommit, type TreeEntry } from "./tree.ts";
import { ToolFailure, defineTool, type ToolContext } from "./types.ts";

const DEFAULT_LIMIT = 200;
const CHUNK = 100;
const LISTED_SKIPS = 50;
const RESERVE_CHARS = 4000;
const isGlob = (pattern: string) => /[*?]/.test(pattern);

function pathTest(pattern: string, insensitive: boolean): (path: string) => boolean {
  if (isGlob(pattern)) {
    const regex = globToRegExp(pattern, insensitive ? "i" : "");
    return (path) => regex.test(path);
  }
  const needle = insensitive ? pattern.toLowerCase() : pattern;
  return insensitive ? (path) => path.toLowerCase().includes(needle) : (path) => path.includes(needle);
}

interface Request {
  repo: GitRepo;
  ref: string;
  query: string;
  pathGlob?: string;
  limit?: number;
  author?: string;
  regex?: RegExp;
  insensitive: boolean;
  context: number;
}

async function searchMessages(ctx: ToolContext, request: Request) {
  const { repo, query, author } = request;
  const limit = request.limit ?? DEFAULT_LIMIT;
  const commit = await resolveCommit(ctx, repo, request.ref);
  const out = await ctx.git(repo, [
    "log",
    "-z",
    `--format=${COMMIT_FORMAT}`,
    "-n",
    String(limit + 1),
    "--fixed-strings",
    "--regexp-ignore-case",
    `--grep=${query}`,
    ...(author === undefined ? [] : [`--author=${author}`]),
    "--end-of-options",
    commit,
  ]);
  const records = out.stdout.toString("utf8").split("\0").filter(Boolean);
  return {
    repo,
    ref: request.ref,
    commit,
    kind: "message",
    commits: records.slice(0, limit).map(parseCommitRecord),
    more: records.length > limit || out.truncated,
    truncated: out.truncated,
  };
}

async function searchPaths(ctx: ToolContext, request: Request) {
  const { repo } = request;
  const filter = request.pathGlob === undefined ? undefined : pathTest(request.pathGlob, false);
  const limit = request.limit ?? DEFAULT_LIMIT;
  const commit = await resolveCommit(ctx, repo, request.ref);
  const { entries, truncated } = await listTree(ctx, repo, commit);
  const test = pathTest(request.query, true);
  const hits = entries.filter((entry) => test(entry.path) && (filter?.(entry.path) ?? true));
  const files = hits.filter((entry) => entry.type === "blob");
  return {
    repo,
    ref: request.ref,
    commit,
    kind: "path",
    paths: files.slice(0, limit).map(({ path, oid, mode }) => ({ path, oid, mode })),
    matched: files.length,
    submodulesSkipped: hits.length - files.length,
    more: files.length > limit,
    truncated,
  };
}

function lineMatcher(request: Request): (line: string) => boolean {
  const { regex, query } = request;
  if (regex) return (line) => regex.test(line);
  if (!request.insensitive) return (line) => line.includes(query);
  const needle = query.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

interface ContentMatch extends GrepHit {
  path: string;
}

async function searchContent(ctx: ToolContext, request: Request) {
  const { repo, context } = request;
  const glob = request.pathGlob ?? "";
  const limit = request.limit ?? Infinity;
  const matches = lineMatcher(request);
  const wanted = pathTest(glob, false);
  const commit = await resolveCommit(ctx, repo, request.ref);
  const tree = await listTree(ctx, repo, commit);
  const selected = tree.entries.filter((entry) => wanted(entry.path));
  const submodules = selected.filter((entry) => entry.type === "commit");
  const files = selected.filter((entry) => entry.type === "blob");
  const byOid = new Map<string, TreeEntry[]>();
  for (const file of files) byOid.set(file.oid, [...(byOid.get(file.oid) ?? []), file]);
  const oids = [...byOid.keys()];
  const budget = Math.max(500, ctx.truncateChars - RESERVE_CHARS);
  const found: ContentMatch[] = [];
  const lfs: { path: string; lfsOid: string; lfsSize: number }[] = [];
  const unavailable: { path: string; message: string }[] = [];
  let lfsCount = 0;
  let unavailableCount = 0;
  let binary = 0;
  let searched = 0;
  let chars = 0;
  let stopped = false;
  let matchCount = 0;
  let filesLeft = files.length;

  const regexGrep = request.regex
    ? createRegexGrep({
        pattern: request.regex.source,
        flags: request.regex.flags,
        context,
        timeoutMs: ctx.limits.regexTimeoutMs,
        signal: ctx.signal,
      })
    : undefined;
  const scan = async (file: string, onHit: (hit: GrepHit) => boolean) => {
    if (regexGrep) await regexGrep.grep(file, onHit);
    else await grepFile(file, { matches, context }, onHit);
  };

  try {
    for (let start = 0; start < oids.length && !stopped; start += CHUNK) {
      const chunk = oids.slice(start, start + CHUNK);
      await ctx.blobs.withBlobs(
        repo,
        chunk,
        async (paths, stats) => {
          if (stats.hits > 0) ctx.state.cacheHit = true;
          for (const oid of chunk) {
            if (stopped) return;
            const sites = byOid.get(oid) ?? [];
            const file = paths.get(oid);
            if (!file) {
              for (const site of sites) {
                unavailableCount++;
                if (unavailable.length < LISTED_SKIPS)
                  unavailable.push({ path: site.path, message: stats.failed.get(oid) ?? "unavailable" });
              }
              filesLeft -= sites.length;
              continue;
            }
            const isBinary = (await sniff(file)).includes(0);
            const pointer = isBinary ? undefined : await readLfsPointer(file);
            if (pointer) {
              for (const site of sites) {
                lfsCount++;
                if (lfs.length < LISTED_SKIPS)
                  lfs.push({ path: site.path, lfsOid: pointer.oid, lfsSize: pointer.size });
              }
              filesLeft -= sites.length;
              continue;
            }
            if (isBinary) {
              binary += sites.length;
              filesLeft -= sites.length;
              continue;
            }
            for (const site of sites) {
              await scan(file, (hit) => {
                const entry = { path: site.path, ...hit };
                chars += JSON.stringify(entry).length + 1;
                if (chars > budget || matchCount >= limit) {
                  stopped = true;
                  return false;
                }
                matchCount++;
                found.push(entry);
                return true;
              });
              if (stopped) return;
              searched++;
              filesLeft--;
            }
          }
        },
        { signal: ctx.signal, partial: true },
      );
    }
  } catch (e) {
    if (e instanceof RegexTimeoutError)
      throw new ToolFailure("regex_timeout", e.message, {
        repo,
        commit,
        searched,
        notSearched: filesLeft,
        matchCount,
        matches: found,
        truncated: true,
      });
    throw e;
  } finally {
    await regexGrep?.close();
  }

  return {
    repo,
    ref: request.ref,
    commit,
    kind: "content",
    pathGlob: glob,
    matchedCount: selected.length,
    searched,
    notSearched: stopped ? filesLeft : 0,
    skipped: {
      binary,
      lfsPointers: { count: lfsCount, items: lfs },
      submodules: {
        count: submodules.length,
        items: submodules.slice(0, LISTED_SKIPS).map((entry) => ({ path: entry.path, commit: entry.oid })),
      },
      unavailable: { count: unavailableCount, items: unavailable },
    },
    matches: found,
    matchCount,
    truncated: stopped || tree.truncated,
  };
}

function parse(
  maxRegexChars: number,
  args: {
    repo: string;
    ref: string;
    query: string;
    kind: string;
    pathGlob?: string | undefined;
    limit?: number | undefined;
    author?: string | undefined;
    regex?: boolean | undefined;
    ignoreCase?: boolean | undefined;
    context?: number | undefined;
  },
): Request {
  const repo = checkRepo(args.repo);
  const query = checkQuery(args.query);
  const insensitive = args.ignoreCase === true;
  if (args.regex === true && query.length > maxRegexChars)
    throw new GitDenied("bad_regex", `the pattern is longer than ${maxRegexChars} characters`);
  if (args.kind === "content" && (args.pathGlob === undefined || args.pathGlob === ""))
    throw new GitDenied("path_glob_required", "content search needs pathGlob to limit which files are fetched");
  return {
    repo,
    ref: args.ref,
    query,
    insensitive,
    context: checkContext(args.context),
    ...(args.pathGlob === undefined ? {} : { pathGlob: checkPath(args.pathGlob) }),
    ...(args.limit === undefined ? {} : { limit: checkCount(args.limit, 1, MAX_COMMITS * 100) }),
    ...(args.author === undefined ? {} : { author: checkAuthor(args.author) }),
    ...(args.regex === true ? { regex: checkRegex(query, insensitive) } : {}),
  };
}

export const search = defineTool({
  name: "search",
  description:
    "Search a repository at a ref. kind message: commit messages (fixed string, optional author). kind path: file paths of the tree (case-insensitive substring or glob). kind content: file contents, which requires pathGlob; matched blobs are fetched in batches and grepped by streaming, binary files are skipped and counted, LFS pointers and submodules are reported as skipped.",
  input: z.strictObject({
    repo: z.string(),
    ref: z.string(),
    query: z.string(),
    kind: z.enum(["message", "path", "content"]),
    pathGlob: z.string().optional(),
    limit: z.number().optional(),
    author: z.string().optional(),
    regex: z.boolean().optional(),
    ignoreCase: z.boolean().optional(),
    context: z.number().optional(),
  }),
  async run(ctx, args) {
    const request = parse(ctx.limits.regexMaxChars, args);
    checkRevision(request.ref);
    await ctx.repos.ensure(request.repo);
    if (args.kind === "message") return searchMessages(ctx, request);
    if (args.kind === "path") return searchPaths(ctx, request);
    return searchContent(ctx, request);
  },
});
