import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import type { LeaderLease } from "../src/persistence/leader-lease.ts";
import { withTenant } from "../src/tenants/context.ts";
import type { Sweeper } from "../src/util/sweeper.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createPatchRetentionRuntime } from "../src/zq/patch-package/retention-runtime.ts";
import type { PatchPackageRecord } from "../src/zq/patch-package/retention.ts";
import { scratchDir } from "./support/patch-package-fixture.ts";
import { TEST_TENANT } from "./support/test-tenant-id.ts";
import { tenantMap } from "./support/tenant-map.ts";

const DAY = 86_400_000;
const T0 = 1_763_000_000_000;
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";

function spies() {
  const mapRequests: string[] = [];
  const maps = new Map<string, DurableMap<never>>();
  const leases: string[] = [];
  const sweepers: { work: () => unknown; intervalMs: number; started: number; stopped: number }[] = [];
  const leaderLease: LeaderLease = {
    async hold(key, fn) {
      leases.push(key);
      return fn(new Promise<void>(() => {}));
    },
  };
  return {
    mapRequests,
    leases,
    sweepers,
    maps,
    deps: {
      map: <T>(table: string): DurableMap<T> => {
        mapRequests.push(table);
        const map = tenantMap<T>();
        maps.set(table, map as unknown as DurableMap<never>);
        return map;
      },
      leaderLease,
      createSweeper: (work: () => unknown, intervalMs: number): Sweeper => {
        const entry = { work, intervalMs, started: 0, stopped: 0 };
        sweepers.push(entry);
        return {
          start() {
            entry.started++;
          },
          async stop() {
            entry.stopped++;
          },
        };
      },
    },
  };
}

test("with retention off nothing is built: no map, no sweeper, no lease, no directory", async (t) => {
  const dir = join(scratchDir(t, "pp-off-"), "never-created");
  for (const env of [
    {},
    { ZQ_PATCH_RETAIN_DIR: dir },
    { ZQ_PATCH_RETAIN: "0", ZQ_PATCH_RETAIN_DIR: dir },
    { ZQ_PATCH_RETAIN: "true", ZQ_PATCH_RETAIN_DIR: dir },
    { ZQ_PATCH_RETAIN_DAYS: "nonsense", ZQ_PATCH_CLEANUP_BATCH: "0" },
    { ZQ_PATCH_OUTPUT_DIR: join(dir, "out"), ZQ_PATCH_MAX_PACKAGE_BYTES: "1000" },
  ]) {
    const config = zqConfigFromEnv(env);
    assert.equal(config.patchRetention, undefined, JSON.stringify(env));
    const spy = spies();
    assert.equal(createPatchRetentionRuntime({ config, ...spy.deps }), undefined);
    assert.deepEqual([spy.mapRequests, spy.leases, spy.sweepers], [[], [], []]);
  }
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(join(dir, "out")), false);
});

test("with retention on exactly one map named zq_patch_packages is requested and no timer exists before start", async (t) => {
  const dir = join(scratchDir(t, "pp-on-"), "retained");
  const spy = spies();
  const runtime = createPatchRetentionRuntime({
    config: { patchRetention: { dir, days: 30, recordDays: 30, cleanupBatch: 50 } },
    ...spy.deps,
  });
  assert.ok(runtime);
  assert.deepEqual(spy.mapRequests, ["zq_patch_packages"]);
  assert.equal(spy.sweepers.length, 1);
  assert.equal(spy.sweepers[0]?.started, 0);
  assert.equal(existsSync(dir), false);
  assert.deepEqual(spy.leases, []);

  await runtime.start();
  assert.equal(spy.sweepers[0]?.started, 1);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  await runtime.stop();
  assert.equal(spy.sweepers[0]?.stopped, 1);
});

test("start refuses with the setting name when the directory is unusable and starts no timer", async (t) => {
  const blocker = join(scratchDir(t, "pp-blocked-"), "afile");
  writeFileSync(blocker, "x");
  const spy = spies();
  const runtime = createPatchRetentionRuntime({
    config: { patchRetention: { dir: blocker, days: 30, recordDays: 30, cleanupBatch: 50 } },
    ...spy.deps,
  });
  await assert.rejects(runtime!.start(), /ZQ_PATCH_RETAIN_DIR/);
  assert.equal(spy.sweepers[0]?.started, 0);
});

test("a sweep runs under the retention lease and cleans every tenant that has records", async (t) => {
  const dir = join(scratchDir(t, "pp-sweep-"), "retained");
  const spy = spies();
  const runtime = createPatchRetentionRuntime({
    config: { patchRetention: { dir, days: 30, recordDays: 30, cleanupBatch: 2 } },
    now: () => T0 + 100 * DAY,
    ...spy.deps,
  })!;
  const map = spy.maps.get("zq_patch_packages") as unknown as DurableMap<PatchPackageRecord>;
  const row = (id: string, expiresAt: number): PatchPackageRecord => ({
    id,
    kind: "patch-package",
    ticket: "WP-1",
    recipient: { source: "requester" },
    baseCommit: "a".repeat(40),
    files: [],
    zip: { name: `${id}.zip`, sha256: "b".repeat(64), bytes: 1 },
    createdAt: T0,
    expiresAt,
  });
  for (const tenant of [TEST_TENANT, OTHER_TENANT])
    await withTenant(tenant, async () => {
      for (const n of [1, 2, 3, 4, 5]) await map.put(`WP-${n}-aaaaaaaaaaaa`, row(`WP-${n}-aaaaaaaaaaaa`, T0 + n * DAY));
      await map.put("WP-9-ffffffffffff", row("WP-9-ffffffffffff", T0 + 200 * DAY));
    });
  await runtime.start();
  await spy.sweepers[0]!.work();
  assert.deepEqual(spy.leases, ["zq:patch-retention"]);
  for (const tenant of [TEST_TENANT, OTHER_TENANT]) {
    const rows = await withTenant(tenant, () => map.all());
    assert.deepEqual(
      rows
        .filter((r) => r.deletedAt !== undefined)
        .map((r) => r.id)
        .sort(),
      [1, 2, 3, 4, 5].map((n) => `WP-${n}-aaaaaaaaaaaa`),
      "more than one batch of two per sweep is handled",
    );
    assert.equal(rows.find((r) => r.id === "WP-9-ffffffffffff")?.deletedAt, undefined);
  }
  assert.deepEqual(readdirSync(dir), []);
});

test("config: retention needs a directory, refuses relative, parent-segment and temporary paths, and names each setting", () => {
  assert.throws(() => zqConfigFromEnv({ ZQ_PATCH_RETAIN: "1" }), /ZQ_PATCH_RETAIN_DIR/);
  assert.throws(
    () => zqConfigFromEnv({ ZQ_PATCH_RETAIN: "1", ZQ_PATCH_RETAIN_DIR: "relative/dir" }),
    /ZQ_PATCH_RETAIN_DIR/,
  );
  assert.throws(
    () => zqConfigFromEnv({ ZQ_PATCH_RETAIN: "1", ZQ_PATCH_RETAIN_DIR: "/var/qm/../etc/x" }),
    /ZQ_PATCH_RETAIN_DIR/,
  );
  for (const under of [tmpdir(), join(tmpdir(), "nested", "retained")])
    assert.throws(
      () => zqConfigFromEnv({ ZQ_PATCH_RETAIN: "1", ZQ_PATCH_RETAIN_DIR: under }),
      /ZQ_PATCH_RETAIN_DIR must not be under the temporary directory/,
    );
  const base = { ZQ_PATCH_RETAIN: "1", ZQ_PATCH_RETAIN_DIR: "/var/lib/qm-patch-retain" };
  assert.deepEqual(zqConfigFromEnv(base).patchRetention, {
    dir: "/var/lib/qm-patch-retain",
    days: 30,
    recordDays: 30,
    cleanupBatch: 50,
  });
  assert.deepEqual(
    zqConfigFromEnv({
      ...base,
      ZQ_PATCH_RETAIN_DIR: "/var/lib/qm-patch-retain/",
      ZQ_PATCH_RETAIN_DAYS: "7",
      ZQ_PATCH_RECORD_DAYS: "90",
      ZQ_PATCH_CLEANUP_BATCH: "10",
    }).patchRetention,
    { dir: "/var/lib/qm-patch-retain", days: 7, recordDays: 90, cleanupBatch: 10 },
  );
  for (const [name, bad] of [
    ["ZQ_PATCH_RETAIN_DAYS", "0"],
    ["ZQ_PATCH_RETAIN_DAYS", "3651"],
    ["ZQ_PATCH_RECORD_DAYS", "1.5"],
    ["ZQ_PATCH_RECORD_DAYS", "soon"],
    ["ZQ_PATCH_CLEANUP_BATCH", "0"],
    ["ZQ_PATCH_CLEANUP_BATCH", "1001"],
  ] as const)
    assert.throws(() => zqConfigFromEnv({ ...base, [name]: bad }), new RegExp(name), `${name}=${bad}`);
});
