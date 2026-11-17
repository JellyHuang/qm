import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, DEFAULT_REMOTE_BASE, loadConfig, sshTarget } from "../src/config.ts";

const SSH = { GITLAB_QM_READONLY_SSH_KEY_B64: "a2V5", ZQ_GIT_MCP_SSH_HOST_KEY: "lab.example ssh-ed25519 AAAA" };
const BASE = { ZQ_GIT_MCP_SECRET: "0123456789abcdef", ZQ_GIT_MCP_DATA_DIR: "/srv/zq" };

test("a complete environment loads with the documented defaults", () => {
  const config = loadConfig({ ...BASE, ...SSH });
  assert.equal(config.remoteBase, DEFAULT_REMOTE_BASE);
  assert.deepEqual(config.ssh, {
    target: "git@lab.skyunion.net",
    keyB64: "a2V5",
    hostKey: "lab.example ssh-ed25519 AAAA",
  });
  assert.equal(config.clonesDir, "/srv/zq/clones");
  assert.equal(config.scratchDir, "/srv/zq/scratch");
  assert.equal(config.cacheDir, "/srv/zq/cache");
  assert.equal(config.truncateChars, 60_000);
  assert.equal(config.scratchCapBytes, 20 * 1024 ** 3);
  assert.equal(config.freeFloorBytes, 5 * 1024 ** 3);
  assert.equal(config.cacheCapBytes, 2 * 1024 ** 3);
  assert.equal(config.maxFetches, 4);
  assert.equal(config.maxHeavyJobs, 2);
  assert.equal(config.port, 8765);
});

test("each required value fails fast and the message names it without echoing secrets", () => {
  assert.throws(() => loadConfig({ ...SSH, ZQ_GIT_MCP_DATA_DIR: "/srv/zq" }), /secret/);
  assert.throws(() => loadConfig({ ...SSH, ZQ_GIT_MCP_SECRET: "0123456789abcdef" }), /dataDir/);
  assert.throws(() => loadConfig({ ...BASE, GITLAB_QM_READONLY_SSH_KEY_B64: "a2V5" }), /sshHostKey/);
  assert.throws(() => loadConfig({ ...BASE, ZQ_GIT_MCP_SSH_HOST_KEY: "lab ssh-ed25519 AAAA" }), /sshKeyB64/);
  assert.throws(() => loadConfig({ ...BASE, ...SSH, ZQ_GIT_MCP_DATA_DIR: "relative/dir" }), /absolute/);
  assert.throws(
    () => loadConfig({ ...BASE, ...SSH, ZQ_GIT_MCP_SECRET: "short-secret" }),
    (e) => {
      assert.ok(e instanceof ConfigError);
      assert.doesNotMatch(e.message, /short-secret/);
      return /secret/.test(e.message);
    },
  );
});

test("a file remote needs no ssh key or host key", () => {
  const config = loadConfig({ ...BASE, ZQ_GIT_MCP_REMOTE_BASE: "file:///tmp/remotes/" });
  assert.equal(config.ssh, undefined);
  assert.equal(config.remoteBase, "file:///tmp/remotes/");
});

test("a JSON config file supplies values and the environment overrides it", () => {
  const files: Record<string, string> = {
    "/etc/zq.json": JSON.stringify({
      secret: "file-secret-0123456789",
      dataDir: "/srv/a",
      port: 9000,
      truncateChars: 5000,
      remoteBase: "file:///x/",
    }),
  };
  const read = (path: string) => files[path] ?? "";
  const config = loadConfig({ ZQ_GIT_MCP_CONFIG: "/etc/zq.json", ZQ_GIT_MCP_PORT: "9100" }, read);
  assert.equal(config.port, 9100);
  assert.equal(config.truncateChars, 5000);
  assert.equal(config.secret, "file-secret-0123456789");
  assert.equal(config.clonesDir, "/srv/a/clones");
});

test("an unreadable file, unknown keys and out of range numbers are rejected", () => {
  assert.throws(
    () =>
      loadConfig({ ZQ_GIT_MCP_CONFIG: "/missing.json" }, () => {
        throw new Error("ENOENT");
      }),
    /cannot read/,
  );
  assert.throws(() => loadConfig({ ZQ_GIT_MCP_CONFIG: "/a.json" }, () => "[]"), /JSON object/);
  assert.throws(
    () =>
      loadConfig({ ZQ_GIT_MCP_CONFIG: "/a.json" }, () =>
        JSON.stringify({ secret: "0123456789abcdef", dataDir: "/s", remoteBase: "file:///x/", url: "x" }),
      ),
    /url/,
  );
  for (const bad of [
    { ZQ_GIT_MCP_PORT: "70000" },
    { ZQ_GIT_MCP_TRUNCATE_CHARS: "10" },
    { ZQ_GIT_MCP_MAX_FETCHES: "0" },
    { ZQ_GIT_MCP_CACHE_CAP_BYTES: "abc" },
  ])
    assert.throws(() => loadConfig({ ...BASE, ...SSH, ...bad }), ConfigError);
});

test("the ssh target is derived from scp style and ssh urls and is absent for local remotes", () => {
  assert.equal(sshTarget("git@lab.skyunion.net:ca-programmer-zq/"), "git@lab.skyunion.net");
  assert.equal(sshTarget("ssh://git@host.example:2222/group/"), "git@host.example");
  assert.equal(sshTarget("file:///tmp/x/"), undefined);
  assert.equal(sshTarget("/tmp/x/"), undefined);
});
