import { spawn } from "node:child_process";
import type { Writable } from "node:stream";

export interface GitRunnerOptions {
  timeoutMs?: number;
  killGraceMs?: number;
  maxBytes?: number;
  gitBinary?: string;
  sshCommand?: string;
}

export interface GitOutput {
  stdout: Buffer;
  bytes: number;
  truncated: boolean;
  cutBytes: number;
}

export interface GitRunOptions {
  maxBytes?: number;
  timeoutMs?: number;
  remote?: boolean;
  signal?: AbortSignal;
  sink?: Writable;
  input?: string;
}

export interface GitRunner {
  run(gitDir: string | undefined, args: readonly string[], opts?: GitRunOptions): Promise<GitOutput>;
}

const GIT_TIMEOUT_MS = 60_000;
const GIT_KILL_GRACE_MS = 2000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
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

function cleanEnv(remote: boolean, sshCommand: string | undefined): NodeJS.ProcessEnv {
  return {
    PATH: SAFE_PATH,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_ALLOW_PROTOCOL: "ssh:file",
    GIT_OPTIONAL_LOCKS: "0",
    ...(remote ? {} : { GIT_NO_LAZY_FETCH: "1" }),
    ...(remote && sshCommand ? { GIT_SSH_COMMAND: sshCommand } : {}),
  };
}

export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const defaultTimeout = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const graceMs = options.killGraceMs ?? GIT_KILL_GRACE_MS;
  const defaultMax = options.maxBytes ?? GIT_MAX_OUTPUT_BYTES;
  const bin = options.gitBinary ?? "git";

  return {
    run(gitDir, args, opts = {}) {
      const maxBytes = opts.maxBytes ?? defaultMax;
      const timeoutMs = opts.timeoutMs ?? defaultTimeout;
      const { sink, signal } = opts;
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const child = spawn(
          bin,
          ["-c", "core.quotepath=false", ...(gitDir === undefined ? [] : [`--git-dir=${gitDir}`]), ...args],
          {
            env: cleanEnv(opts.remote === true, options.sshCommand),
            shell: false,
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        const pid = child.pid;
        if (pid !== undefined) liveGroups.add(pid);
        const chunks: Buffer[] = [];
        let stderr = Buffer.alloc(0);
        let kept = 0;
        let total = 0;
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
        const settle = (outcome: () => void) => {
          if (settled) return;
          settled = true;
          if (pid !== undefined) liveGroups.delete(pid);
          clearTimeout(timer);
          clearTimeout(graceTimer);
          signal?.removeEventListener("abort", onAbort);
          child.stdout.destroy();
          child.stderr.destroy();
          outcome();
        };
        const onAbort = () => {
          killGroup();
          sink?.destroy();
          settle(() => reject(signal?.reason));
        };
        const finish = (code: number | null) => {
          if (settled) return;
          const done = () =>
            settle(() => {
              if (timedOut) return reject(new Error(`git timed out after ${timeoutMs} ms`));
              const stdout = Buffer.concat(chunks);
              if (cutBytes > 0) return resolve({ stdout, bytes: total, truncated: true, cutBytes });
              if (code !== 0)
                return reject(new Error(`git ${args[0] ?? ""} exited with ${code}: ${stderr.toString("utf8").trim()}`));
              resolve({ stdout, bytes: total, truncated: false, cutBytes: 0 });
            });
          if (!sink || timedOut || code !== 0) {
            sink?.destroy();
            return done();
          }
          sink.end();
          if (sink.writableFinished) return done();
          sink.once("finish", done);
          sink.once("error", (e) => settle(() => reject(e)));
        };
        const timer = setTimeout(() => {
          timedOut = true;
          killGroup();
        }, timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdin.on("error", () => undefined);
        child.stdin.end(opts.input ?? "");
        child.stdout.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (sink) {
            if (!sink.write(chunk)) {
              child.stdout.pause();
              sink.once("drain", () => child.stdout.resume());
            }
            return;
          }
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
        child.stdout.on("end", () => sink?.end());
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = Buffer.concat([stderr, chunk]).subarray(0, STDERR_BYTES);
        });
        sink?.on("error", () => killGroup());
        child.on("error", (e) => settle(() => reject(e)));
        child.on("exit", (code) => {
          graceTimer = setTimeout(() => finish(code), graceMs);
        });
        child.on("close", finish);
      });
    },
  };
}
