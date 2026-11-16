import { spawn } from "node:child_process";

export interface GitRunnerOptions {
  timeoutMs?: number;
  maxBytes?: number;
  gitBinary?: string;
  knownHosts?: string;
  withKeyFile?: <T>(fn: (keyFile: string) => Promise<T>) => Promise<T>;
}

export interface GitOutput {
  stdout: Buffer;
  truncated: boolean;
  cutBytes: number;
}

export interface GitRunOptions {
  maxBytes?: number;
  remote?: boolean;
}

export interface GitRunner {
  run(gitDir: string, args: readonly string[], opts?: GitRunOptions): Promise<GitOutput>;
}

export const GIT_TIMEOUT_MS = 60_000;
export const GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const STDERR_BYTES = 4096;
const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin";

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
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const defaultMax = options.maxBytes ?? GIT_MAX_OUTPUT_BYTES;
  const bin = options.gitBinary ?? "git";

  function spawnGit(gitDir: string, args: readonly string[], maxBytes: number, sshCmd?: string): Promise<GitOutput> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, [`--git-dir=${gitDir}`, ...args], {
        env: cleanEnv(sshCmd),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let stderr = Buffer.alloc(0);
      let kept = 0;
      let cutBytes = 0;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
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
          child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = Buffer.concat([stderr, chunk]).subarray(0, STDERR_BYTES);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new Error(`git timed out after ${timeoutMs} ms`));
        const stdout = Buffer.concat(chunks);
        if (cutBytes > 0) return resolve({ stdout, truncated: true, cutBytes });
        if (code !== 0)
          return reject(new Error(`git ${args[0] ?? ""} exited with ${code}: ${stderr.toString("utf8").trim()}`));
        resolve({ stdout, truncated: false, cutBytes: 0 });
      });
    });
  }

  return {
    async run(gitDir, args, opts = {}) {
      const maxBytes = opts.maxBytes ?? defaultMax;
      const { withKeyFile, knownHosts } = options;
      if (!opts.remote || !withKeyFile) return spawnGit(gitDir, args, maxBytes);
      if (!knownHosts) throw new Error("remote git needs a pinned known_hosts file");
      return withKeyFile((keyFile) => spawnGit(gitDir, args, maxBytes, sshCommand(keyFile, knownHosts)));
    },
  };
}
