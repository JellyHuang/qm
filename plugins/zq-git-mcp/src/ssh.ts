import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SshOptions {
  target: string;
  keyB64: string;
  hostFingerprint: string;
  scan?: (host: string) => Promise<string>;
  binary?: string;
  tmpRoot?: string;
  warmTimeoutMs?: number;
}

export interface Ssh {
  start(): Promise<void>;
  command(): string;
  warm(): Promise<void>;
  stop(): Promise<void>;
  dir(): string;
}

function fingerprintOf(keyBase64: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("base64").replace(/=+$/, "")}`;
}

function pinnedHostKeys(scanned: string, fingerprint: string): string[] {
  return scanned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      const [, , key = ""] = line.split(/\s+/);
      return !line.startsWith("#") && key !== "" && fingerprintOf(key) === fingerprint;
    });
}

function scanWithSshKeyscan(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ssh-keyscan",
      ["-T", "15", host],
      { timeout: 30_000, env: { PATH: "/usr/local/bin:/usr/bin:/bin" } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function sshOptionArgs(paths: { key: string; knownHosts: string; control: string }): string[] {
  return [
    "-F",
    "/dev/null",
    "-i",
    paths.key,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${paths.knownHosts}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=10m",
    "-o",
    `ControlPath=${paths.control}`,
    "-o",
    "ServerAliveInterval=30",
  ];
}

export function createSsh(options: SshOptions): Ssh {
  const binary = options.binary ?? "ssh";
  let dir: string | undefined;
  let keyFile = "";

  const need = () => {
    if (dir === undefined) throw new Error("ssh not started");
    return dir;
  };
  const optionArgs = () =>
    sshOptionArgs({ key: keyFile, knownHosts: join(need(), "known_hosts"), control: join(need(), "%C") });
  const run = (args: string[], timeoutMs: number) =>
    new Promise<void>((resolve) => {
      execFile(binary, args, { timeout: timeoutMs, env: { PATH: "/usr/local/bin:/usr/bin:/bin" } }, () => resolve());
    });

  return {
    async start() {
      const host = options.target.split("@").pop() ?? options.target;
      const pinned = pinnedHostKeys(await (options.scan ?? scanWithSshKeyscan)(host), options.hostFingerprint);
      if (pinned.length === 0) throw new Error(`no host key offered by ${host} matches the pinned fingerprint`);
      dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "zqgit-ssh-"));
      keyFile = join(dir, "key");
      const key = Buffer.from(options.keyB64, "base64").toString("utf8");
      await writeFile(keyFile, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
      await writeFile(join(dir, "known_hosts"), `${pinned.join("\n")}\n`, { mode: 0o600 });
    },
    command: () => ["ssh", ...optionArgs()].map((part, i) => (i === 0 ? part : quote(part))).join(" "),
    warm: () => run([...optionArgs(), options.target], options.warmTimeoutMs ?? 30_000),
    async stop() {
      if (dir === undefined) return;
      const root = dir;
      await run(["-O", "exit", ...optionArgs(), options.target], 5000);
      const size = (await stat(keyFile).catch(() => undefined))?.size ?? 0;
      await writeFile(keyFile, Buffer.alloc(size), { mode: 0o600 }).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
      dir = undefined;
    },
    dir: need,
  };
}
