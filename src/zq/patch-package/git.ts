import { spawn } from "node:child_process";
import { PatchPackageError } from "./settings.ts";

export const ALLOWED_GIT_SUBCOMMANDS: readonly string[] = [
  "init",
  "rev-parse",
  "read-tree",
  "update-ref",
  "add",
  "apply",
  "diff",
  "cat-file",
  "commit",
  "format-patch",
  "am",
  "check-attr",
];

const OUTPUT_CAP_BYTES = 256 * 1024 * 1024;
const STDERR_CAP_BYTES = 16 * 1024;

interface GitRunOptions {
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
}

export interface GitRunner {
  run(subcommand: string, args: readonly string[], options: GitRunOptions): Promise<Buffer>;
}

export function createGitRunner(
  identity: { name: string; email: string },
  observe?: (subcommand: string, args: readonly string[]) => void,
): GitRunner {
  const base: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/nonexistent",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "none",
    GIT_PAGER: "cat",
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
  const config = [
    "core.autocrlf=false",
    "core.safecrlf=false",
    "core.fileMode=true",
    "core.hooksPath=/dev/null",
    "core.quotePath=false",
    "commit.gpgSign=false",
    "init.defaultBranch=main",
    "diff.renames=true",
    "diff.noprefix=false",
    "diff.mnemonicPrefix=false",
    "advice.detachedHead=false",
  ].flatMap((entry) => ["-c", entry]);

  return {
    run(subcommand, args, options) {
      if (!ALLOWED_GIT_SUBCOMMANDS.includes(subcommand))
        throw new PatchPackageError("git_failed", `git ${subcommand} is not allowed here`);
      observe?.(subcommand, args);
      return new Promise<Buffer>((resolve, reject) => {
        const child = spawn("git", [...config, subcommand, ...args], {
          cwd: options.cwd,
          env: { ...base, ...options.env },
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let outBytes = 0;
        let errBytes = 0;
        let overflow = false;
        child.stdout.on("data", (chunk: Buffer) => {
          outBytes += chunk.length;
          if (outBytes > OUTPUT_CAP_BYTES) {
            overflow = true;
            child.kill("SIGKILL");
            return;
          }
          out.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (errBytes >= STDERR_CAP_BYTES) return;
          errBytes += chunk.length;
          err.push(chunk);
        });
        child.stdin.on("error", () => undefined);
        child.on("error", (e) => reject(new PatchPackageError("git_failed", `git could not start: ${e.message}`)));
        child.on("close", (code) => {
          if (overflow)
            return reject(new PatchPackageError("git_failed", `git ${subcommand} produced too much output`));
          if (code !== 0) {
            const detail = Buffer.concat(err).toString("utf8").trim().split("\n").slice(-6).join(" | ");
            return reject(new PatchPackageError("git_failed", `git ${subcommand} failed (${code}): ${detail}`));
          }
          resolve(Buffer.concat(out));
        });
        child.stdin.end(options.stdin ?? "");
      });
    },
  };
}
