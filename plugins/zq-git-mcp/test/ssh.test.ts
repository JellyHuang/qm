import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { after, test } from "node:test";
import { join } from "node:path";
import { createSsh } from "../src/ssh.ts";
import { fakeGit } from "./support/fake-git.ts";
import { makeRoot } from "./support/fixtures.ts";

const { root, cleanup } = makeRoot("zqgit-ssh-");
after(cleanup);

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA-test-key-material\n-----END OPENSSH PRIVATE KEY-----";
const HOST_BLOB = Buffer.from("pinned-host-key-material").toString("base64");
const OTHER_BLOB = Buffer.from("some-other-host-key").toString("base64");
const fingerprint = (blob: string) =>
  `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
const options = {
  target: "git@lab.example",
  keyB64: Buffer.from(KEY).toString("base64"),
  hostFingerprint: fingerprint(HOST_BLOB),
  scan: async () => `# lab.example:22\nlab.example ssh-rsa ${OTHER_BLOB}\nlab.example ssh-ed25519 ${HOST_BLOB}\n`,
};

test("the key and pinned host key live in a private directory and are shredded on stop", async () => {
  const ssh = createSsh({ ...options, tmpRoot: root });
  await ssh.start();
  const dir = ssh.dir();
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "key")).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, "key"), "utf8"), `${KEY}\n`);
  assert.equal(readFileSync(join(dir, "known_hosts"), "utf8"), `lab.example ssh-ed25519 ${HOST_BLOB}\n`);
  await ssh.stop();
  assert.equal(existsSync(dir), false);
});

test("the command pins the key and host key and shares one control master", async () => {
  const ssh = createSsh({ ...options, tmpRoot: root });
  await ssh.start();
  try {
    const command = ssh.command();
    const dir = ssh.dir();
    for (const part of [
      `'-i' '${join(dir, "key")}'`,
      "'IdentitiesOnly=yes'",
      "'StrictHostKeyChecking=yes'",
      `'UserKnownHostsFile=${join(dir, "known_hosts")}'`,
      "'BatchMode=yes'",
      "'ForwardAgent=no'",
      "'ControlMaster=auto'",
      "'ControlPersist=10m'",
      `'ControlPath=${join(dir, "%C")}'`,
      "'ServerAliveInterval=30'",
    ])
      assert.ok(command.includes(part), part);
    assert.ok(command.startsWith("ssh "));
  } finally {
    await ssh.stop();
  }
});

test("warming opens the master with the same options against the configured target and stop closes it", async () => {
  const log = join(root, "ssh-calls");
  const binary = fakeGit(root, `printf '%s\\n' "$*" >> ${log}`);
  const ssh = createSsh({ ...options, tmpRoot: root, binary });
  await ssh.start();
  await ssh.warm();
  const dir = ssh.dir();
  await ssh.stop();
  const [warm, exit] = readFileSync(log, "utf8").trim().split("\n");
  assert.ok(warm?.includes("ControlMaster=auto"));
  assert.ok(warm?.includes(`ControlPath=${dir}/%C`));
  assert.ok(warm?.endsWith("git@lab.example"));
  assert.ok(exit?.startsWith("-O exit"));
});

test("only host keys matching the pinned fingerprint are trusted and a mismatch refuses to start", async () => {
  const before = readdirSync(root).length;
  const ssh = createSsh({
    ...options,
    hostFingerprint: fingerprint(Buffer.from("different").toString("base64")),
    tmpRoot: root,
  });
  await assert.rejects(ssh.start(), /no host key offered by lab\.example matches the pinned fingerprint/);
  assert.equal(readdirSync(root).length, before);
  const unreachable = createSsh({
    ...options,
    tmpRoot: root,
    scan: async () => Promise.reject(new Error("scan failed")),
  });
  await assert.rejects(unreachable.start(), /scan failed/);
  assert.equal(readdirSync(root).length, before);
});
