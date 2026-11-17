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
      root = mkdtempSync(join(tmpdir(), "zqgit-it-"));
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

  test(
    "diff_xlsx on gameconfig workbooks of different sizes stays within the memory bound",
    { timeout: TEST_TIMEOUT_MS },
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

      const learned: { path: string; size: number; commits: string[] }[] = [];
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
        const log = await call("list_commits", { repo: "gameconfig", path, limit: 2 });
        assert.notEqual(log.isError, true, JSON.stringify(log));
        const commits = (log.commits as { sha: string }[]).map((commit) => commit.sha);
        if (commits.length >= 2 && size <= XLSX_PICK_MAX_MB * MB) learned.push({ path, size, commits });
      }
      assert.ok(learned.length > 0, "no candidate xlsx with two commits and a usable size was found");

      learned.sort((a, b) => a.size - b.size);
      const smallest = learned[0];
      const largest = learned[learned.length - 1];
      assert.ok(smallest && largest);
      const middle = learned
        .filter((entry) => entry !== smallest && entry !== largest)
        .sort(
          (a, b) =>
            Math.abs(Math.log(a.size / Math.sqrt(smallest.size * largest.size))) -
            Math.abs(Math.log(b.size / Math.sqrt(smallest.size * largest.size))),
        )[0];
      const picks = [...new Set([smallest, middle, largest].filter((entry) => entry !== undefined))];

      for (const pick of picks) {
        const [head, base] = pick.commits as [string, string];
        const run = await measured(
          (signal) => call("diff_xlsx", { repo: "gameconfig", path: pick.path, base, head }, signal),
          Number.MAX_SAFE_INTEGER,
        );
        assert.notEqual(run, "oversize");
        const result = run as Measured<Body>;
        downloadedBytes += result.packPeakBytes;
        const body = result.value;
        assert.notEqual(body.isError, true, JSON.stringify(body).slice(0, 500));
        assert.ok(body.kind === "xlsx_diff" || body.kind === "unchanged", `unexpected kind ${String(body.kind)}`);
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
          path: pick.path,
          sizeBytes: pick.size,
          baseSha12: base.slice(0, 12),
          headSha12: head.slice(0, 12),
          seconds: round(result.seconds),
          differences: body.kind === "unchanged" ? 0 : Number(body.total ?? 0),
          kind: body.kind,
          summary: counts,
          rssPeakMB: round(result.rssGrowthMB),
        });
        assert.ok(
          result.rssGrowthMB < XLSX_RSS_BOUND_MB,
          `rss grew ${round(result.rssGrowthMB)} MB, bound ${XLSX_RSS_BOUND_MB} MB`,
        );
      }
    },
  );

  test(
    "a very large zq-ui PSD is read by range without growing the service memory",
    { timeout: TEST_TIMEOUT_MS },
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
