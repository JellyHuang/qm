import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitRunnerOptions {
  timeoutMs?: number;
  killGraceMs?: number;
  maxBytes?: number;
  gitBinary?: string;
  knownHosts?: string;
  withKeyFile?: <T>(fn: (keyFile: string) => Promise<T>) => Promise<T>;
}

interface GitOutput {
  stdout: Buffer;
  truncated: boolean;
  cutBytes: number;
}

interface GitRunOptions {
  maxBytes?: number;
  timeoutMs?: number;
  remote?: boolean;
}

export interface GitRunner {
  run(gitDir: string, args: readonly string[], opts?: GitRunOptions): Promise<GitOutput>;
}

const GIT_TIMEOUT_MS = 60_000;
export const GIT_FETCH_TIMEOUT_MS = 30 * 60_000;
const GIT_KILL_GRACE_MS = 2000;
const GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const STDERR_BYTES = 4096;
const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin";
const liveGroups = new Set<number>();

export function killLiveGitGroups(): void {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      liveGroups.delete(pid);
    }
  }
}

export function keyFileFrom(readKey: () => Promise<string>): NonNullable<GitRunnerOptions["withKeyFile"]> {
  return async (fn) => {
    const dir = await mkdtemp(join(tmpdir(), "qm-gitkey-"));
    try {
      const file = join(dir, "key");
      const key = await readKey();
      await writeFile(file, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
      return await fn(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function sshCommand(keyFile: string, knownHosts: string): string {
  return [
    "ssh",
    "-F /dev/null",
    `-i ${shellQuote(keyFile)}`,
    "-o IdentitiesOnly=yes",
    "-o StrictHostKeyChecking=yes",
    `-o UserKnownHostsFile=${shellQuote(knownHosts)}`,
    "-o BatchMode=yes",
    "-o ForwardAgent=no",
  ].join(" ");
}

function cleanEnv(sshCmd?: string): NodeJS.ProcessEnv {
  return {
    PATH: SAFE_PATH,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_ALLOW_PROTOCOL: "ssh:file",
    GIT_OPTIONAL_LOCKS: "0",
    ...(sshCmd ? { GIT_SSH_COMMAND: sshCmd } : {}),
  };
}

export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const defaultTimeout = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const graceMs = options.killGraceMs ?? GIT_KILL_GRACE_MS;
  const defaultMax = options.maxBytes ?? GIT_MAX_OUTPUT_BYTES;
  const bin = options.gitBinary ?? "git";

  function spawnGit(
    gitDir: string,
    args: readonly string[],
    maxBytes: number,
    timeoutMs: number,
    sshCmd?: string,
  ): Promise<GitOutput> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, [`--git-dir=${gitDir}`, ...args], {
        env: cleanEnv(sshCmd),
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pid = child.pid;
      if (pid !== undefined) liveGroups.add(pid);
      const chunks: Buffer[] = [];
      let stderr = Buffer.alloc(0);
      let kept = 0;
      let cutBytes = 0;
      let timedOut = false;
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;
      const killGroup = () => {
        try {
          if (pid !== undefined) process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        if (pid !== undefined) liveGroups.delete(pid);
        clearTimeout(timer);
        clearTimeout(graceTimer);
        child.stdout.destroy();
        child.stderr.destroy();
        if (timedOut) return reject(new Error(`git timed out after ${timeoutMs} ms`));
        const stdout = Buffer.concat(chunks);
        if (cutBytes > 0) return resolve({ stdout, truncated: true, cutBytes });
        if (code !== 0)
          return reject(new Error(`git ${args[0] ?? ""} exited with ${code}: ${stderr.toString("utf8").trim()}`));
        resolve({ stdout, truncated: false, cutBytes: 0 });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        if (cutBytes > 0) {
          cutBytes += chunk.length;
          return;
        }
        const room = maxBytes - kept;
        chunks.push(chunk.subarray(0, room));
        kept += Math.min(room, chunk.length);
        if (chunk.length > room) {
          cutBytes = chunk.length - room;
          killGroup();
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = Buffer.concat([stderr, chunk]).subarray(0, STDERR_BYTES);
      });
      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        if (pid !== undefined) liveGroups.delete(pid);
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", (code) => {
        graceTimer = setTimeout(() => finish(code), graceMs);
      });
      child.on("close", finish);
    });
  }

  return {
    async run(gitDir, args, opts = {}) {
      const maxBytes = opts.maxBytes ?? defaultMax;
      const timeoutMs = opts.timeoutMs ?? defaultTimeout;
      const { withKeyFile, knownHosts } = options;
      if (!opts.remote || !withKeyFile) return spawnGit(gitDir, args, maxBytes, timeoutMs);
      if (!knownHosts) throw new Error("remote git needs a pinned known_hosts file");
      return withKeyFile((keyFile) => spawnGit(gitDir, args, maxBytes, timeoutMs, sshCommand(keyFile, knownHosts)));
    },
  };
}
