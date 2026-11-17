import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SshOptions {
  target: string;
  keyB64: string;
  hostFingerprint: string;
  scan?: (host: string, path: string) => Promise<string>;
  binary?: string;
  path?: string;
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

function scanWithSshKeyscan(host: string, searchPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ssh-keyscan", ["-T", "15", host], { timeout: 30_000, env: { PATH: searchPath } }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
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

const DIR_PREFIX = "z-";
const DIR_SUFFIX = 6;
const SOCKET_NAME = "c";
const SOCKET_TEMP_SUFFIX = 17;
const SOCKET_PATH_LIMIT = 100;
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

export function controlSocketLength(base: string): number {
  return base.length + 1 + DIR_PREFIX.length + DIR_SUFFIX + 1 + SOCKET_NAME.length + SOCKET_TEMP_SUFFIX;
}

function assertSocketPath(base: string): void {
  const length = controlSocketLength(base);
  if (length > SOCKET_PATH_LIMIT) {
    const room = SOCKET_PATH_LIMIT - controlSocketLength("");
    throw new Error(
      `the ssh control socket path would be ${length} characters, more than the ${SOCKET_PATH_LIMIT} allowed (unix sockets are limited to 107): shorten TMPDIR or the data directory so that the ssh base directory "${base}" is at most ${room} characters`,
    );
  }
}

export function createSsh(options: SshOptions): Ssh {
  const binary = options.binary ?? "ssh";
  const searchPath = options.path ?? DEFAULT_PATH;
  let dir: string | undefined;
  let keyFile = "";

  const need = () => {
    if (dir === undefined) throw new Error("ssh not started");
    return dir;
  };
  const optionArgs = () =>
    sshOptionArgs({ key: keyFile, knownHosts: join(need(), "known_hosts"), control: join(need(), SOCKET_NAME) });
  const run = (args: string[], timeoutMs: number) =>
    new Promise<void>((resolve) => {
      execFile(binary, args, { timeout: timeoutMs, env: { PATH: searchPath } }, () => resolve());
    });

  return {
    async start() {
      const base = options.tmpRoot ?? tmpdir();
      assertSocketPath(base);
      const host = options.target.split("@").pop() ?? options.target;
      const pinned = pinnedHostKeys(
        await (options.scan ?? scanWithSshKeyscan)(host, searchPath),
        options.hostFingerprint,
      );
      if (pinned.length === 0) throw new Error(`no host key offered by ${host} matches the pinned fingerprint`);
      dir = await mkdtemp(join(base, DIR_PREFIX));
      keyFile = join(dir, "key");
      const key = Buffer.from(options.keyB64, "base64").toString("utf8");
      await writeFile(keyFile, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
      await writeFile(join(dir, "known_hosts"), `${pinned.join("\n")}\n`, { mode: 0o600 });
    },
    command: () => [binary === "ssh" ? "ssh" : quote(binary), ...optionArgs().map(quote)].join(" "),
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
