import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errMessage } from "../../../chassis/src/errors.ts";
import { BlobFetchError } from "../blobs.ts";
import { GitDenied, checkLine, checkPath, checkRepo } from "../validate.ts";
import { parseRawDiff } from "./raw-diff.ts";
import { lookupEntry, resolveCommit } from "./tree.ts";
import { defineTool } from "./types.ts";

const RESERVE_CHARS = 2000;
const HEADER = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

interface BlameLine {
  line: number;
  sha: string;
  author: string;
  date: string;
  text: string;
}

async function* porcelainLines(file: string): AsyncGenerator<string> {
  let rest = "";
  for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop() ?? "";
    yield* parts;
  }
  if (rest) yield rest;
}

async function* parseBlame(file: string): AsyncGenerator<BlameLine> {
  const authors = new Map<string, { author: string; time: number }>();
  let sha = "";
  let line = 0;
  for await (const raw of porcelainLines(file)) {
    if (raw.startsWith("\t")) {
      const meta = authors.get(sha);
      yield {
        line,
        sha,
        author: meta?.author ?? "",
        date: new Date((meta?.time ?? 0) * 1000).toISOString(),
        text: raw.slice(1),
      };
      continue;
    }
    const header = HEADER.exec(raw);
    if (header) {
      sha = header[1] ?? "";
      line = Number(header[2]);
      continue;
    }
    const known = authors.get(sha) ?? { author: "", time: 0 };
    if (raw.startsWith("author ")) authors.set(sha, { ...known, author: raw.slice("author ".length) });
    else if (raw.startsWith("author-time "))
      authors.set(sha, { ...known, time: Number(raw.slice("author-time ".length)) });
  }
}

export const blame = defineTool({
  name: "blame",
  description:
    "Blame a line range of a file at a ref: per line the commit sha, author, date and text. History blobs of the path are prefetched in one batch; the result reports how many lazy fetches git still needed and how long it took.",
  input: z.strictObject({
    repo: z.string(),
    ref: z.string(),
    path: z.string(),
    startLine: z.number(),
    endLine: z.number(),
  }),
  async run(ctx, args) {
    const repo = checkRepo(args.repo);
    const path = checkPath(args.path);
    const startLine = checkLine(args.startLine);
    const endLine = checkLine(args.endLine);
    if (endLine < startLine) throw new GitDenied("bad_number", "endLine is before startLine");
    await ctx.repos.ensure(repo);
    const commit = await resolveCommit(ctx, repo, args.ref);
    const entry = await lookupEntry(ctx, repo, commit, path);
    if (entry.type !== "blob") throw new GitDenied("not_a_file", "blame needs a regular file");
    const history = await ctx.git(repo, [
      "log",
      "--format=%H",
      "-z",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "--end-of-options",
      commit,
      "--",
      path,
    ]);
    const oids = [
      ...new Set(
        parseRawDiff(history.stdout.toString("utf8").replaceAll("\0\n", "\0")).flatMap((change) =>
          [change.oldOid, change.newOid].filter((oid): oid is string => !!oid),
        ),
      ),
    ];
    const started = Date.now();
    const budget = Math.max(500, ctx.truncateChars - RESERVE_CHARS);
    return ctx.blobs.withTempRepo(
      repo,
      async (temp) => {
        const problems = await temp.fetch(oids);
        const [lost] = problems;
        if (lost) throw new BlobFetchError(`fetch failed for ${repo} ${lost[0].slice(0, 10)}: ${lost[1]}`);
        const out = join(temp.dir, "blame.out");
        try {
          await temp.git(["blame", "--porcelain", "-L", `${startLine},${endLine}`, commit, "--", path], {
            sink: createWriteStream(out),
          });
        } catch (e) {
          if (/has only \d+ lines|no such path|invalid line/i.test(errMessage(e)))
            throw new GitDenied("bad_range", "the line range is outside the file");
          throw e;
        }
        const lines: BlameLine[] = [];
        let chars = 0;
        let cutLines = 0;
        for await (const row of parseBlame(out)) {
          chars += JSON.stringify(row).length + 1;
          if (cutLines === 0 && chars <= budget) lines.push(row);
          else cutLines++;
        }
        return {
          repo,
          ref: args.ref,
          commit,
          path,
          lines,
          cutLines,
          prefetched: oids.length,
          lazyFetches: await temp.lazyFetches(),
          seconds: (Date.now() - started) / 1000,
          truncated: cutLines > 0,
        };
      },
      { signal: ctx.signal },
    );
  },
});
