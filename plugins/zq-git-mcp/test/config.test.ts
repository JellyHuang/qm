import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, DEFAULT_REMOTE_BASE, loadConfig, sshTarget } from "../src/config.ts";

const FINGERPRINT = "SHA256:DkCVY8DnWnZqf8eTvxgHTj5IRFmOtYj3IMgVy4PiTCQ";
const SSH = { GITLAB_QM_READONLY_SSH_KEY_B64: "a2V5", ZQ_GIT_MCP_SSH_HOST_FINGERPRINT: FINGERPRINT };
const BASE = { ZQ_GIT_MCP_SECRET: "0123456789abcdef", ZQ_GIT_MCP_DATA_DIR: "/srv/zq" };

test("a complete environment loads with the documented defaults", () => {
  const config = loadConfig({ ...BASE, ...SSH });
  assert.equal(config.remoteBase, DEFAULT_REMOTE_BASE);
  assert.deepEqual(config.ssh, {
    target: "git@lab.skyunion.net",
    keyB64: "a2V5",
    hostFingerprint: FINGERPRINT,
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
  assert.equal(config.maxBigFetches, 2);
  assert.equal(config.fetchNoProgressMs, 180_000);
  assert.equal(config.fetchFailureTtlMs, 60_000);
  assert.equal(config.fetchTimeoutMs, 30 * 60_000);
});

test("a host key fingerprint must be a SHA256 fingerprint, never a key or accept-new setting", () => {
  for (const bad of ["accept-new", "lab.example ssh-ed25519 AAAA", "SHA256:short", "MD5:aa:bb"])
    assert.throws(() => loadConfig({ ...BASE, ...SSH, ZQ_GIT_MCP_SSH_HOST_FINGERPRINT: bad }), /fingerprint/);
});

test("each required value fails fast and the message names it without echoing secrets", () => {
  assert.throws(() => loadConfig({ ...SSH, ZQ_GIT_MCP_DATA_DIR: "/srv/zq" }), /secret/);
  assert.throws(() => loadConfig({ ...SSH, ZQ_GIT_MCP_SECRET: "0123456789abcdef" }), /dataDir/);
  assert.throws(() => loadConfig({ ...BASE, GITLAB_QM_READONLY_SSH_KEY_B64: "a2V5" }), /sshHostFingerprint/);
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

test("audit, tips and blob metadata default to memory, a failed audit write defaults to serve and the spool has defaults", () => {
  const config = loadConfig({ ...BASE, ...SSH });
  assert.equal(config.audit, "memory");
  assert.equal(config.tips, "memory");
  assert.equal(config.blobMeta, "memory");
  assert.equal(config.database, undefined);
  assert.equal(config.auditOnFailure, "serve");
  assert.equal(config.auditSpoolDir, "/srv/zq/audit-spool");
  assert.equal(config.auditSpoolMaxBytes, 64 * 1024 * 1024);
  assert.equal(config.auditSpoolMaxAgeMs, 7 * 24 * 3600 * 1000);
});

test("postgres needs a database url, the url is not echoed and the environment overrides the file", () => {
  for (const key of ["ZQ_GIT_MCP_AUDIT", "ZQ_GIT_MCP_TIPS", "ZQ_GIT_MCP_BLOB_META"])
    assert.throws(() => loadConfig({ ...BASE, ...SSH, [key]: "postgres" }), /databaseUrl/);
  const url = "postgres://svc:hunter2@db.internal:5432/qm";
  const config = loadConfig({
    ...BASE,
    ...SSH,
    ZQ_GIT_MCP_AUDIT: "postgres",
    ZQ_GIT_MCP_DATABASE_URL: url,
    ZQ_GIT_MCP_TENANT_ID: "11111111-2222-4333-8444-555555555555",
    ZQ_GIT_MCP_AUDIT_ON_FAILURE: "fail",
  });
  assert.deepEqual(config.database, { url, tenantId: "11111111-2222-4333-8444-555555555555" });
  assert.equal(config.audit, "postgres");
  assert.equal(config.tips, "memory");
  assert.equal(config.auditOnFailure, "fail");
  for (const bad of [
    { ZQ_GIT_MCP_DATABASE_URL: "mysql://x:hunter2@db/qm" },
    { ZQ_GIT_MCP_TENANT_ID: "not-a-uuid" },
    { ZQ_GIT_MCP_AUDIT_ON_FAILURE: "ignore" },
    { ZQ_GIT_MCP_AUDIT: "sqlite" },
  ])
    assert.throws(
      () => loadConfig({ ...BASE, ...SSH, ZQ_GIT_MCP_AUDIT: "postgres", ZQ_GIT_MCP_DATABASE_URL: url, ...bad }),
      (e) => e instanceof ConfigError && !/hunter2/.test(e.message),
    );
  const files: Record<string, string> = {
    "/etc/zq.json": JSON.stringify({
      auditOnFailure: "fail",
      tips: "postgres",
      databaseUrl: url,
      remoteBase: "file:///x/",
      secret: "0123456789abcdef",
      dataDir: "/srv/a",
    }),
  };
  const merged = loadConfig(
    { ZQ_GIT_MCP_CONFIG: "/etc/zq.json", ZQ_GIT_MCP_AUDIT_ON_FAILURE: "serve" },
    (path) => files[path] ?? "",
  );
  assert.equal(merged.auditOnFailure, "serve");
  assert.equal(merged.tips, "postgres");
});

test("the git and ssh binaries and the child PATH are configurable and the git directory comes first", () => {
  const plain = loadConfig({ ...BASE, ...SSH });
  assert.equal(plain.gitBin, undefined);
  assert.equal(plain.sshBin, undefined);
  assert.equal(plain.childPath, "/usr/local/bin:/usr/bin:/bin");
  const custom = loadConfig({
    ...BASE,
    ...SSH,
    ZQ_GIT_MCP_GIT_BIN: "/opt/git247/bin/git",
    ZQ_GIT_MCP_SSH_BIN: "/opt/ssh/bin/ssh",
    ZQ_GIT_MCP_PATH: "/usr/bin:/bin",
  });
  assert.equal(custom.gitBin, "/opt/git247/bin/git");
  assert.equal(custom.sshBin, "/opt/ssh/bin/ssh");
  assert.equal(custom.childPath, "/opt/git247/bin:/usr/bin:/bin");
  for (const bad of [{ ZQ_GIT_MCP_GIT_BIN: "git" }, { ZQ_GIT_MCP_SSH_BIN: "ssh" }])
    assert.throws(() => loadConfig({ ...BASE, ...SSH, ...bad }), /absolute path/);
});
