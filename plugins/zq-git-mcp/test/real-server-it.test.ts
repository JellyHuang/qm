import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { loadConfig } from "../src/config.ts";
import { startHarness, SECRET, type Harness } from "./support/harness.ts";

const MB = 1024 * 1024;
const env = process.env;
const keyB64 = env.ZQ_GIT_MCP_IT_KEY_B64 ?? env.GITLAB_QM_READONLY_SSH_KEY_B64;
const fingerprint = env.ZQ_GIT_MCP_IT_HOST_FINGERPRINT;
const baseUrl = env.ZQ_GIT_MCP_IT_BASE_URL;
const skip =
  baseUrl || (keyB64 && fingerprint)
    ? false
    : "set ZQ_GIT_MCP_IT_KEY_B64 and ZQ_GIT_MCP_IT_HOST_FINGERPRINT (or ZQ_GIT_MCP_IT_BASE_URL for a local fixture)";

const number = (name: string, fallback: number) => (env[name] ? Number(env[name]) : fallback);
const XLSX_RSS_BOUND_MB = number("ZQ_GIT_MCP_IT_XLSX_RSS_BOUND_MB", 700);
const PSD_RSS_BOUND_MB = number("ZQ_GIT_MCP_IT_PSD_RSS_BOUND_MB", 300);
const XLSX_CANDIDATE_CAP_MB = number("ZQ_GIT_MCP_IT_XLSX_CANDIDATE_CAP_MB", 60);
const XLSX_PICK_MAX_MB = number("ZQ_GIT_MCP_IT_XLSX_PICK_MAX_MB", 12);
const XLSX_CANDIDATES = number("ZQ_GIT_MCP_IT_XLSX_CANDIDATES", 14);
const XLSX_LEARN_BUDGET_MB = number("ZQ_GIT_MCP_IT_XLSX_LEARN_BUDGET_MB", 450);
const PSD_CAP_MB = number("ZQ_GIT_MCP_IT_PSD_CAP_MB", 400);
const PSD_TARGET_MB = number("ZQ_GIT_MCP_IT_PSD_TARGET_MB", 229);
const DOWNLOAD_BUDGET_MB = number("ZQ_GIT_MCP_IT_DOWNLOAD_BUDGET_MB", 1400);
const PSD_PATH_HINT = env.ZQ_GIT_MCP_IT_PSD_PATH;
const PAIRS = number("ZQ_GIT_MCP_IT_XLSX_PAIRS", 6);
const DIAG_REPO = env.ZQ_GIT_MCP_IT_DIAG_REPO ?? "";
const diagMode = DIAG_REPO !== "";

interface DiagPair {
  path?: string;
  baseRef?: string;
  headRef?: string;
  baseBlob?: string;
  headBlob?: string;
  ref?: string;
}

function diagPairsFromEnv(): DiagPair[] {
  const ref = env.ZQ_GIT_MCP_IT_DIAG_REF;
  const listed = (env.ZQ_GIT_MCP_IT_DIAG_PAIRS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry): DiagPair => {
      const [path, baseBlob, headBlob] = entry.split(":");
      return {
        ...(path ? { path } : {}),
        ...(baseBlob ? { baseBlob } : {}),
        ...(headBlob ? { headBlob } : {}),
        ...(ref ? { ref } : {}),
      };
    });
  const single: DiagPair = {
    ...(env.ZQ_GIT_MCP_IT_DIAG_PATH ? { path: env.ZQ_GIT_MCP_IT_DIAG_PATH } : {}),
    ...(env.ZQ_GIT_MCP_IT_DIAG_BASE_REF ? { baseRef: env.ZQ_GIT_MCP_IT_DIAG_BASE_REF } : {}),
    ...(env.ZQ_GIT_MCP_IT_DIAG_HEAD_REF ? { headRef: env.ZQ_GIT_MCP_IT_DIAG_HEAD_REF } : {}),
    ...(env.ZQ_GIT_MCP_IT_DIAG_BASE_BLOB ? { baseBlob: env.ZQ_GIT_MCP_IT_DIAG_BASE_BLOB } : {}),
    ...(env.ZQ_GIT_MCP_IT_DIAG_HEAD_BLOB ? { headBlob: env.ZQ_GIT_MCP_IT_DIAG_HEAD_BLOB } : {}),
    ...(ref ? { ref } : {}),
  };
  return [...listed, ...(Object.keys(single).some((key) => key !== "ref") ? [single] : [])];
}

const diagPairs = diagPairsFromEnv();
const CALL_TIMEOUT_MS = 18 * 60_000;
const TEST_TIMEOUT_MS = 20 * 60_000;
const SAMPLE_MS = 100;
const WATCH_MS = 250;
const RANGE_BYTES = 64 * 1024;

type Body = Record<string, unknown> & { isError?: boolean };

interface Measured<T> {
  value: T;
  seconds: number;
  rssGrowthMB: number;
  children: Record<string, number>;
  packPeakBytes: number;
}

interface ProcInfo {
  pid: number;
  ppid: number;
  comm: string;
  cmdline: string;
  rssKb: number;
  hwmKb: number;
}

function listProcesses(): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const name of readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const ppid = Number(stat.slice(close + 2).split(" ")[1]);
      const status = readFileSync(`/proc/${name}/status`, "utf8");
      out.push({
        pid: Number(name),
        ppid,
        comm: stat.slice(stat.indexOf("(") + 1, close),
        cmdline: readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " "),
        rssKb: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0),
        hwmKb: Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0),
      });
    } catch {
      continue;
    }
  }
  return out;
}

function descendants(): ProcInfo[] {
  const all = listProcesses();
  const mine = new Set([process.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const proc of all)
      if (!mine.has(proc.pid) && mine.has(proc.ppid)) {
        mine.add(proc.pid);
        grew = true;
      }
  }
  return all.filter((proc) => proc.pid !== process.pid && mine.has(proc.pid));
}

const childLabel = (proc: ProcInfo) => (proc.cmdline.includes("index-pack") ? "index-pack" : proc.comm);

async function settleChildren(): Promise<void> {
  for (let i = 0; i < 300 && descendants().some((proc) => proc.comm === "git" || proc.comm === "ssh"); i++)
    await new Promise((resolve) => setTimeout(resolve, 200));
}

function packBytes(dir: string): number {
  let total = 0;
  try {
    for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      if (!rel.includes(`objects${sep}pack${sep}`)) continue;
      try {
        total += statSync(join(dir, rel)).size;
      } catch {
        continue;
      }
    }
  } catch {
    return total;
  }
  return total;
}

describe("zq-git-mcp against a real server", { skip, timeout: TEST_TIMEOUT_MS }, () => {
  let root = "";
  let scratchDir = "";
  let harness: Harness;
  let client: Client;
  let downloadedBytes = 0;
  const savedTmp = env.TMPDIR;

  before(
    async () => {
      root = mkdtempSync(join(tmpdir(), "zi-"));
      env.TMPDIR = root;
      const config = loadConfig({
        ZQ_GIT_MCP_SECRET: SECRET,
        ZQ_GIT_MCP_DATA_DIR: join(root, "data"),
        ZQ_GIT_MCP_PORT: "0",
        ZQ_GIT_MCP_TRUNCATE_CHARS: "200000",
        ZQ_GIT_MCP_SCRATCH_CAP_BYTES: String(3 * 1024 * MB),
        ZQ_GIT_MCP_FREE_FLOOR_BYTES: String(1024 * MB),
        ZQ_GIT_MCP_CACHE_CAP_BYTES: String(1024 * MB),
        ZQ_GIT_MCP_REFRESH_MS: String(6 * 3_600_000),
        ZQ_GIT_MCP_FETCH_TIMEOUT_MS: String(15 * 60_000),
        ZQ_GIT_MCP_FETCH_NO_PROGRESS_MS: String(300_000),
        ZQ_GIT_MCP_GIT_TIMEOUT_MS: String(5 * 60_000),
        ZQ_GIT_MCP_XLSX_TIMEOUT_MS: String(10 * 60_000),
        ...(env.ZQ_GIT_MCP_GIT_BIN ? { ZQ_GIT_MCP_GIT_BIN: env.ZQ_GIT_MCP_GIT_BIN } : {}),
        ...(env.ZQ_GIT_MCP_PATH ? { ZQ_GIT_MCP_PATH: env.ZQ_GIT_MCP_PATH } : {}),
        ...(env.ZQ_GIT_MCP_SSH_BIN ? { ZQ_GIT_MCP_SSH_BIN: env.ZQ_GIT_MCP_SSH_BIN } : {}),
        ...(baseUrl
          ? { ZQ_GIT_MCP_REMOTE_BASE: baseUrl }
          : { ZQ_GIT_MCP_SSH_HOST_FINGERPRINT: fingerprint ?? "", GITLAB_QM_READONLY_SSH_KEY_B64: keyB64 ?? "" }),
      });
      scratchDir = config.scratchDir;
      harness = await startHarness(config);
      client = await harness.connect("real-server-it");
    },
    { timeout: TEST_TIMEOUT_MS },
  );

  after(
    async () => {
      await harness?.stop();
      if (savedTmp === undefined) delete env.TMPDIR;
      else env.TMPDIR = savedTmp;
      if (root) rmSync(root, { recursive: true, force: true });
    },
    { timeout: 120_000 },
  );

  async function measured<T>(
    run: (signal: AbortSignal) => Promise<T>,
    capBytes: number,
  ): Promise<Measured<T> | "oversize"> {
    const abort = new AbortController();
    const baseline = process.memoryUsage().rss;
    let peakRss = baseline;
    let packPeak = 0;
    let exceeded = false;
    const children: Record<string, number> = {};
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      for (const proc of descendants()) {
        const label = childLabel(proc);
        children[label] = Math.max(children[label] ?? 0, proc.hwmKb * 1024);
      }
    }, SAMPLE_MS);
    const watcher = setInterval(() => {
      packPeak = Math.max(packPeak, packBytes(scratchDir));
      if (packPeak > capBytes && !exceeded) {
        exceeded = true;
        abort.abort();
      }
    }, WATCH_MS);
    const started = performance.now();
    try {
      const value = await run(abort.signal);
      return {
        value,
        seconds: (performance.now() - started) / 1000,
        rssGrowthMB: Math.max(0, peakRss - baseline) / MB,
        children: Object.fromEntries(Object.entries(children).map(([label, bytes]) => [label, round(bytes / MB)])),
        packPeakBytes: packPeak,
      };
    } catch (e) {
      if (!exceeded) throw e;
      downloadedBytes += packPeak;
      await settleChildren();
      return "oversize";
    } finally {
      clearInterval(sampler);
      clearInterval(watcher);
    }
  }

  async function call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Body> {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    const content = result.content as { text: string }[];
    return { ...(JSON.parse(content[0]?.text ?? "{}") as Body), isError: result.isError === true };
  }

  const round = (value: number) => Math.round(value * 10) / 10;
  const emit = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);
  const budgetLeftBytes = () => DOWNLOAD_BUDGET_MB * MB - downloadedBytes;

  async function listPaths(repo: string, query: string): Promise<string[]> {
    const found = await call("search", { repo, ref: "main", kind: "path", query, limit: 100_000 });
    assert.notEqual(found.isError, true, JSON.stringify(found));
    return (found.paths as { path: string }[]).map((entry) => entry.path);
  }

  const REAL_KINDS = new Set(["xlsx_diff", "unchanged"]);
  const SKIP_KINDS = new Set(["file_added", "file_removed", "lfs_pointer", "lfs_pointer_changed"]);

  interface Candidate {
    path: string;
    size: number;
  }

  async function attemptFile(candidate: Candidate, errors: string[]): Promise<boolean> {
    const log = await call("list_commits", { repo: "gameconfig", path: candidate.path, limit: PAIRS + 1 });
    if (log.isError === true) {
      errors.push(`${candidate.path}: list_commits ${JSON.stringify(log).slice(0, 200)}`);
      return false;
    }
    const commits = (log.commits as { sha: string }[]).map((commit) => commit.sha);
    for (let i = 0; i + 1 < commits.length && i < PAIRS; i++) {
      const head = commits[i] as string;
      const base = commits[i + 1] as string;
      const line = {
        suite: "gameconfig-diff-xlsx-attempt",
        path: candidate.path,
        pair: i,
        baseSha12: base.slice(0, 12),
        headSha12: head.slice(0, 12),
      };
      const run = await measured(
        (signal) => call("diff_xlsx", { repo: "gameconfig", path: candidate.path, base, head }, signal),
        Number.MAX_SAFE_INTEGER,
      );
      const result = run as Measured<Body>;
      downloadedBytes += result.packPeakBytes;
      const body = result.value;
      if (body.isError === true) {
        errors.push(`${candidate.path} pair ${i}: ${JSON.stringify(body).slice(0, 300)}`);
        emit({ ...line, outcome: "error", error: JSON.stringify(body.error ?? body).slice(0, 200) });
        return false;
      }
      const kind = String(body.kind);
      if (SKIP_KINDS.has(kind)) {
        emit({ ...line, outcome: "skipped", kind, reason: `the pair gives ${kind}, trying the next older pair` });
        continue;
      }
      if (!REAL_KINDS.has(kind)) {
        errors.push(`${candidate.path} pair ${i}: unexpected kind ${kind}`);
        emit({ ...line, outcome: "error", kind });
        return false;
      }
      const sheets = ((body.summary as { sheets?: Record<string, unknown>[] } | undefined)?.sheets ?? []) as Record<
        string,
        unknown
      >[];
      const counts: Record<string, number> = { sheets: sheets.length };
      for (const sheet of sheets)
        for (const [key, value] of Object.entries(sheet))
          if (typeof value === "number") counts[key] = (counts[key] ?? 0) + value;
      emit({
        suite: "gameconfig-diff-xlsx",
        path: candidate.path,
        pair: i,
        sizeBytes: candidate.size,
        baseSha12: base.slice(0, 12),
        headSha12: head.slice(0, 12),
        seconds: round(result.seconds),
        differences: kind === "unchanged" ? 0 : Number(body.total ?? 0),
        kind,
        summary: counts,
        rssPeakMB: round(result.rssGrowthMB),
      });
      assert.ok(
        result.rssGrowthMB < XLSX_RSS_BOUND_MB,
        `rss grew ${round(result.rssGrowthMB)} MB, bound ${XLSX_RSS_BOUND_MB} MB`,
      );
      return true;
    }
    emit({
      suite: "gameconfig-diff-xlsx-attempt",
      path: candidate.path,
      outcome: "no_pair",
      reason: `none of the latest ${PAIRS} commit pairs gave a diff`,
    });
    return false;
  }

  test(
    "diff_xlsx on gameconfig workbooks of different sizes stays within the memory bound",
    { skip: diagMode ? "diagnostic mode" : false, timeout: TEST_TIMEOUT_MS },
    async () => {
      const all = (await listPaths("gameconfig", "designer_config/"))
        .filter((path) => path.startsWith("designer_config/") && /\.xlsx$/i.test(path))
        .filter((path) => !(path.split("/").pop() ?? "").startsWith("~$"))
        .sort();
      assert.ok(all.length > 0, "no xlsx files found under designer_config");
      const named = all.filter((path) => path.endsWith("/string.xlsx"));
      const rest = all.filter((path) => !named.includes(path));
      const step = Math.max(1, Math.floor(rest.length / Math.max(1, XLSX_CANDIDATES - named.length)));
      const sampled = rest.filter((_, i) => i % step === 0);
      const candidates = [...named, ...sampled].slice(0, XLSX_CANDIDATES);

      const learned: Candidate[] = [];
      let learnedBytes = 0;
      for (const path of candidates) {
        if (learnedBytes >= XLSX_LEARN_BUDGET_MB * MB || budgetLeftBytes() < XLSX_CANDIDATE_CAP_MB * MB) break;
        const probe = await measured(
          (signal) => call("read_file", { repo: "gameconfig", ref: "main", path }, signal),
          XLSX_CANDIDATE_CAP_MB * MB,
        );
        if (probe === "oversize") continue;
        assert.notEqual(probe.value.isError, true, JSON.stringify(probe.value));
        const size = Number(probe.value.size);
        downloadedBytes += probe.packPeakBytes;
        learnedBytes += probe.packPeakBytes;
        if (size <= XLSX_PICK_MAX_MB * MB) learned.push({ path, size });
      }
      assert.ok(learned.length > 0, "no candidate xlsx of a usable size was found");

      const bySize = [...learned].sort((a, b) => b.size - a.size);
      const largest = bySize[0] as Candidate;
      const others = bySize.slice(1).reverse();
      const smallest = others[0];
      const middle = others
        .slice(1)
        .sort(
          (a, b) =>
            Math.abs(Math.log(a.size / Math.sqrt((smallest?.size ?? a.size) * largest.size))) -
            Math.abs(Math.log(b.size / Math.sqrt((smallest?.size ?? b.size) * largest.size))),
        )[0];
      const wanted = [largest, smallest, middle].filter((entry): entry is Candidate => entry !== undefined);
      const reserve = others.filter((entry) => !wanted.includes(entry));

      const errors: string[] = [];
      let real = 0;
      for (const pick of wanted) {
        let queue: Candidate[] = [pick];
        while (queue.length > 0) {
          const next = queue.shift() as Candidate;
          if (await attemptFile(next, errors)) {
            real++;
            break;
          }
          if (next === largest) break;
          const replacement = reserve.shift();
          queue = replacement ? [replacement] : [];
        }
      }
      assert.deepEqual(errors, [], `errors: ${errors.join(" | ")}`);
      assert.ok(real > 0, "no workbook produced a real diff; see the attempt lines above");
    },
  );

  test(
    "structure diagnostics of two workbook versions print counts and letters only",
    { skip: diagMode ? false : "set ZQ_GIT_MCP_IT_DIAG_REPO", timeout: TEST_TIMEOUT_MS },
    async () => {
      assert.ok(diagPairs.length > 0, "no diagnostic pair given");
      for (const pair of diagPairs) {
        const lines = await harness.service.diagnoseXlsx({ repo: DIAG_REPO, ...pair });
        for (const line of lines) emit({ suite: "xlsx-diag", path: pair.path ?? null, ...line });
        assert.ok(
          lines.some((line) => line.type === "compare" || line.type === "sheet"),
          "no structure was produced",
        );
      }
    },
  );

  test(
    "a very large zq-ui PSD is read by range without growing the service memory",
    { skip: diagMode ? "diagnostic mode" : false, timeout: TEST_TIMEOUT_MS },
    async () => {
      const listed = (await listPaths("zq-ui", ".psd")).filter((path) => /\.psd$/i.test(path));
      const candidates = [
        ...(PSD_PATH_HINT ? [PSD_PATH_HINT] : []),
        ...listed.filter((path) => path !== PSD_PATH_HINT),
      ];
      assert.ok(candidates.length > 0, "no .psd files found in zq-ui");

      const results: { path: string; size: number; run: Measured<Body> }[] = [];
      for (const path of candidates) {
        if (budgetLeftBytes() < PSD_CAP_MB * MB) break;
        const run = await measured(
          (signal) => call("read_file", { repo: "zq-ui", ref: "main", path, offset: 0, length: RANGE_BYTES }, signal),
          PSD_CAP_MB * MB,
        );
        if (run === "oversize") continue;
        assert.notEqual(run.value.isError, true, JSON.stringify(run.value).slice(0, 500));
        downloadedBytes += run.packPeakBytes;
        const size = Number(run.value.size);
        results.push({ path, size, run });
        assert.ok(
          run.rssGrowthMB < PSD_RSS_BOUND_MB,
          `${path}: rss grew ${round(run.rssGrowthMB)} MB, bound ${PSD_RSS_BOUND_MB} MB`,
        );
        if (Math.abs(size - PSD_TARGET_MB * MB) <= 0.1 * PSD_TARGET_MB * MB) break;
      }
      assert.ok(results.length > 0, `no .psd below ${PSD_CAP_MB} MB could be read`);

      const chosen = results.reduce((best, entry) => (entry.size > best.size ? entry : best));
      const body = chosen.run.value;
      assert.equal(body.kind, "binary");
      assert.match(String(body.sha256), /^[0-9a-f]{64}$/);
      assert.equal(body.offset, 0);
      assert.equal(body.length, Math.min(RANGE_BYTES, chosen.size));
      assert.equal(Buffer.from(String(body.base64), "base64").length, body.length);
      emit({
        suite: "zq-ui-psd",
        path: chosen.path,
        sizeBytes: chosen.size,
        seconds: round(chosen.run.seconds),
        mbPerSec: round(chosen.size / MB / chosen.run.seconds),
        rssPeakMB: round(chosen.run.rssGrowthMB),
        childPeakMB: chosen.run.children,
        packPeakMB: round(chosen.run.packPeakBytes / MB),
        sha256: body.sha256,
        rangeOffset: body.offset,
        rangeLength: body.length,
        candidatesRead: results.length,
        downloadedMB: round(downloadedBytes / MB),
      });
    },
  );

  test("the whole run stayed within the download budget", () => {
    assert.ok(
      downloadedBytes <= DOWNLOAD_BUDGET_MB * MB + PSD_CAP_MB * MB,
      `downloaded about ${Math.round(downloadedBytes / MB)} MB`,
    );
  });
});
