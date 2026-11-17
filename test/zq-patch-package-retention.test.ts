import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { withTenant } from "../src/tenants/context.ts";
import type { PatchPackage } from "../src/zq/patch-package/package.ts";
import {
  createPatchRetention,
  type PatchPackageRecipient,
  type PatchPackageRecord,
} from "../src/zq/patch-package/retention.ts";
import type { PatchRetentionSettings } from "../src/zq/patch-package/settings.ts";
import { buildFrom, makeLfsRepo } from "./support/patch-package-apply.ts";
import { put, scratchDir } from "./support/patch-package-fixture.ts";
import { TEST_TENANT } from "./support/test-tenant-id.ts";
import { tenantMap } from "./support/tenant-map.ts";

const DAY = 86_400_000;
const T0 = 1_763_000_000_000;
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const requester: PatchPackageRecipient = { mmUserId: "mmuser0000000000000000001", source: "requester" };

function setup(t: TestContext, over: Partial<PatchRetentionSettings> = {}) {
  const dir = join(scratchDir(t, "pp-retain-"), "retained");
  const settings: PatchRetentionSettings = { dir, days: 30, recordDays: 30, cleanupBatch: 50, ...over };
  const map = tenantMap<PatchPackageRecord>();
  const clock = { now: T0 };
  const logs: string[] = [];
  const retention = createPatchRetention({ map, settings, now: () => clock.now, log: (line) => logs.push(line) });
  return { dir, settings, map, clock, logs, retention, packageDir: (id: string) => join(dir, TEST_TENANT, id) };
}

function changedFixture(t: TestContext) {
  const fixture = makeLfsRepo(t);
  put(fixture.repo, "readme.txt", "one\nTWO\nthree\n");
  put(fixture.repo, "tables/items.xlsx", Buffer.from("PK-new-items-workbook-bytes".repeat(60)));
  return fixture;
}

async function build(t: TestContext, repo = "client", fixture = changedFixture(t)) {
  return buildFrom(t, fixture, { repo });
}

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return withTenant(TEST_TENANT, fn);
}

test("retain writes the zip with private permissions and a record of exactly the designed shape", async (t) => {
  const pkg = await build(t);
  await inTenant(async () => {
    const s = setup(t);
    const { record, written } = await s.retention.retain(pkg, requester);
    assert.equal(written, true);
    assert.deepEqual(record, {
      id: pkg.id,
      kind: "patch-package",
      ticket: "WP-123",
      repo: "client",
      recipient: requester,
      baseCommit: pkg.baseCommit,
      resultCommit: pkg.resultCommit,
      files: pkg.files.map((file) => ({ name: file.name, sha256: file.sha256, bytes: file.bytes })),
      zip: { name: `${pkg.id}.zip`, sha256: pkg.zip.sha256, bytes: pkg.zip.bytes },
      createdAt: T0,
      expiresAt: T0 + 30 * DAY,
    });
    assert.deepEqual(await s.map.get(pkg.id), record);
    const zipPath = join(s.packageDir(pkg.id), `${pkg.id}.zip`);
    assert.deepEqual(readFileSync(zipPath), pkg.zip.data);
    assert.equal(statSync(zipPath).mode & 0o777, 0o600);
    assert.equal(statSync(s.packageDir(pkg.id)).mode & 0o777, 0o700);
    assert.equal(statSync(join(s.dir, TEST_TENANT)).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(s.packageDir(pkg.id)), [`${pkg.id}.zip`]);
    const json = JSON.stringify(record);
    assert.ok(!json.includes(s.dir) && !json.includes("@") && !json.includes(pkg.dir));
    assert.ok(record.resultCommit && /^[0-9a-f]{40}$/.test(record.resultCommit));
  });
});

test("recording the same package again changes nothing, and a rebuilt zip under the same id updates the one row", async (t) => {
  const fixture = changedFixture(t);
  const pkg = await build(t, "client", fixture);
  const rebuilt = await build(t, "client-renamed", fixture);
  assert.equal(rebuilt.id, pkg.id);
  assert.notEqual(rebuilt.zip.sha256, pkg.zip.sha256);
  await inTenant(async () => {
    const s = setup(t);
    const first = await s.retention.retain(pkg, requester);
    s.clock.now = T0 + DAY;
    const again = await s.retention.retain(pkg, requester);
    assert.equal(again.written, false);
    assert.deepEqual(again.record, first.record);
    assert.equal((await s.map.all()).length, 1);

    const second = await s.retention.retain(rebuilt, requester);
    assert.equal(second.written, true);
    assert.equal((await s.map.all()).length, 1);
    assert.equal(second.record.zip.sha256, rebuilt.zip.sha256);
    assert.equal(second.record.createdAt, T0 + DAY);
    assert.deepEqual(readFileSync(join(s.packageDir(pkg.id), `${pkg.id}.zip`)), rebuilt.zip.data);
    assert.deepEqual(readdirSync(s.packageDir(pkg.id)), [`${pkg.id}.zip`]);
  });
});

test("crash window: a zip on disk without a record is reported, never deleted, and recording repairs it", async (t) => {
  const pkg = await build(t);
  await inTenant(async () => {
    const s = setup(t);
    await s.retention.retain(pkg, requester);
    await s.map.delete(pkg.id);
    assert.deepEqual(await s.retention.orphans(), { orphanDirectories: [pkg.id], missingZips: [] });
    assert.equal((await s.retention.cleanup({ now: T0 + 400 * DAY })).deleted, 0);
    assert.ok(existsSync(join(s.packageDir(pkg.id), `${pkg.id}.zip`)));
    const repaired = await s.retention.retain(pkg, requester);
    assert.equal(repaired.written, false);
    assert.deepEqual(await s.retention.orphans(), { orphanDirectories: [], missingZips: [] });
    assert.equal((await s.map.all()).length, 1);
  });
});

test("crash window: a record whose zip is gone or damaged is reported and recording rewrites the zip", async (t) => {
  const pkg = await build(t);
  await inTenant(async () => {
    const s = setup(t);
    const { record } = await s.retention.retain(pkg, requester);
    const zipPath = join(s.packageDir(pkg.id), `${pkg.id}.zip`);
    rmSync(zipPath);
    assert.deepEqual((await s.retention.orphans()).missingZips, [pkg.id]);
    writeFileSync(zipPath, Buffer.alloc(pkg.zip.bytes, 1));
    assert.deepEqual((await s.retention.orphans()).missingZips, [pkg.id]);
    const repaired = await s.retention.retain(pkg, requester);
    assert.equal(repaired.written, true);
    assert.deepEqual(repaired.record, record);
    assert.deepEqual(readFileSync(zipPath), pkg.zip.data);
    assert.deepEqual((await s.retention.orphans()).missingZips, []);
  });
});

test("a record that cannot be written leaves no zip behind for a new package and keeps the old one for a known package", async (t) => {
  const fixture = changedFixture(t);
  const pkg = await build(t, "client", fixture);
  const rebuilt = await build(t, "client-renamed", fixture);
  await inTenant(async () => {
    const s = setup(t);
    const failing: DurableMap<PatchPackageRecord> = {
      ...s.map,
      put: async () => {
        throw new Error("database unavailable");
      },
      get: s.map.get,
    };
    const broken = createPatchRetention({ map: failing, settings: s.settings, now: () => T0 });
    await assert.rejects(broken.retain(pkg, requester), /database unavailable/);
    assert.equal(existsSync(s.packageDir(pkg.id)), false);

    await s.retention.retain(pkg, requester);
    await assert.rejects(broken.retain(rebuilt, requester), /database unavailable/);
    assert.ok(existsSync(join(s.packageDir(pkg.id), `${pkg.id}.zip`)));
  });
});

test("a zip that does not match its own name and hash is refused before anything is written", async (t) => {
  const pkg = await build(t);
  await inTenant(async () => {
    const s = setup(t);
    const tampered: PatchPackage = { ...pkg, zip: { ...pkg.zip, data: Buffer.from("not the zip") } };
    await assert.rejects(s.retention.retain(tampered, requester), /does not match/);
    await assert.rejects(
      s.retention.retain({ ...pkg, zip: { ...pkg.zip, name: "other.zip" } }, requester),
      /does not match/,
    );
    await assert.rejects(
      s.retention.retain(pkg, { source: "everyone" } as unknown as PatchPackageRecipient),
      /recipient source/,
    );
    assert.equal(existsSync(s.dir), false);
    assert.equal((await s.map.all()).length, 0);
  });
});

test("package ids that could leave the directory are refused when recording", async (t) => {
  const pkg = await build(t);
  await inTenant(async () => {
    const s = setup(t);
    for (const id of ["../evil", "a/b", "..", ".", "", ".hidden", "a\\b", "/abs"]) {
      await assert.rejects(s.retention.retain({ ...pkg, id }, requester), /not a plain name/, JSON.stringify(id));
    }
    assert.equal(existsSync(s.dir), false);
  });
});

test("cleanup deletes the directory first, then marks the record, and a second run changes nothing", async (t) => {
  const pkg = await build(t);
  await inTenant(async () => {
    const s = setup(t);
    await s.retention.retain(pkg, requester);
    assert.deepEqual(await s.retention.cleanup({ now: T0 + 30 * DAY - 1 }), { deleted: 0, purged: 0, refused: [] });
    assert.ok(existsSync(s.packageDir(pkg.id)));

    const expiredAt = T0 + 30 * DAY;
    assert.deepEqual(await s.retention.cleanup({ now: expiredAt }), { deleted: 1, purged: 0, refused: [] });
    assert.equal(existsSync(s.packageDir(pkg.id)), false);
    const marked = await s.map.get(pkg.id);
    assert.equal(marked?.deletedAt, expiredAt);
    assert.equal(marked?.zip.sha256, pkg.zip.sha256);

    assert.deepEqual(await s.retention.cleanup({ now: expiredAt + 1000 }), { deleted: 0, purged: 0, refused: [] });
    assert.equal((await s.map.get(pkg.id))?.deletedAt, expiredAt);

    assert.deepEqual(await s.retention.cleanup({ now: expiredAt + 30 * DAY - 1 }), {
      deleted: 0,
      purged: 0,
      refused: [],
    });
    assert.deepEqual(await s.retention.cleanup({ now: expiredAt + 30 * DAY }), { deleted: 0, purged: 1, refused: [] });
    assert.equal(await s.map.get(pkg.id), null);
  });
});

test("crash window: a crash after the directory is deleted but before the record is marked finishes on the next run", async (t) => {
  const pkg = await build(t);
  await inTenant(async () => {
    const s = setup(t);
    await s.retention.retain(pkg, requester);
    let calls = 0;
    const crashing: DurableMap<PatchPackageRecord> = {
      ...s.map,
      get: s.map.get,
      all: s.map.all,
      update: async (id, fn) => {
        if (calls++ === 0) throw new Error("process died");
        return s.map.update(id, fn);
      },
    };
    const first = createPatchRetention({ map: crashing, settings: s.settings, now: () => T0 + 31 * DAY });
    await assert.rejects(first.cleanup(), /process died/);
    assert.equal(existsSync(s.packageDir(pkg.id)), false);
    assert.equal((await s.map.get(pkg.id))?.deletedAt, undefined);
    s.clock.now = T0 + 32 * DAY;
    assert.deepEqual(await s.retention.cleanup(), { deleted: 1, purged: 0, refused: [] });
    assert.equal((await s.map.get(pkg.id))?.deletedAt, T0 + 32 * DAY);
  });
});

test("cleanup handles at most one batch per call, oldest first", async (t) => {
  const pkg = await build(t);
  await inTenant(async () => {
    const s = setup(t, { cleanupBatch: 2 });
    const ids = ["WP-1-aaaaaaaaaaaa", "WP-2-bbbbbbbbbbbb", "WP-3-cccccccccccc"];
    for (const [i, id] of ids.entries()) {
      s.clock.now = T0 + i * DAY;
      const zip = { ...pkg.zip, name: `${id}.zip` };
      await s.retention.retain({ ...pkg, id, zip }, requester);
    }
    const now = T0 + 40 * DAY;
    assert.equal((await s.retention.cleanup({ now })).deleted, 2);
    assert.deepEqual(
      (await s.map.all()).filter((row) => row.deletedAt === undefined).map((row) => row.id),
      [ids[2]],
    );
    assert.equal((await s.retention.cleanup({ now })).deleted, 1);
    assert.equal((await s.retention.cleanup({ now })).deleted, 0);
  });
});

test("a record id or directory that would resolve outside the retention directory is refused, logged and never deleted", async (t) => {
  const pkg = await build(t);
  await inTenant(async () => {
    const s = setup(t);
    const outside = scratchDir(t, "pp-outside-");
    writeFileSync(join(outside, "precious.txt"), "keep");
    await s.retention.retain(pkg, requester);
    const base = (await s.map.get(pkg.id)) as PatchPackageRecord;
    for (const id of ["../../../" + outside.slice(1), "a/b", ".."]) await s.map.put(id, { ...base, id, expiresAt: T0 });
    rmSync(s.packageDir(pkg.id), { recursive: true });
    symlinkSync(outside, s.packageDir(pkg.id));

    const result = await s.retention.cleanup({ now: T0 + 31 * DAY });
    assert.equal(result.deleted, 0);
    assert.equal(result.refused.length, 4);
    assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "keep");
    assert.equal(s.logs.length, 4);
    for (const row of await s.map.all()) assert.equal(row.deletedAt, undefined);
  });
});

test("the orphan report lists directories without a record and deletes nothing", async (t) => {
  const pkg = await build(t);
  await inTenant(async () => {
    const s = setup(t);
    await s.retention.retain(pkg, requester);
    mkdirSync(join(s.dir, TEST_TENANT, "stray-dir"));
    writeFileSync(join(s.dir, TEST_TENANT, "stray.part"), "x");
    assert.deepEqual(await s.retention.orphans(), {
      orphanDirectories: ["stray-dir", "stray.part"],
      missingZips: [],
    });
    assert.deepEqual(readdirSync(join(s.dir, TEST_TENANT)).sort(), [pkg.id, "stray-dir", "stray.part"].sort());
  });
});

test("the orphan report on a directory that does not exist yet is empty", async (t) => {
  await inTenant(async () => {
    const s = setup(t);
    assert.deepEqual(await s.retention.orphans(), { orphanDirectories: [], missingZips: [] });
    assert.equal(existsSync(s.dir), false);
  });
});

test("tenants never share files: the same package id in two tenants has two directories", async (t) => {
  const pkg = await build(t);
  const s = setup(t);
  await withTenant(TEST_TENANT, () => s.retention.retain(pkg, requester));
  await withTenant(OTHER_TENANT, () => s.retention.retain(pkg, requester));
  assert.deepEqual(readdirSync(s.dir).sort(), [TEST_TENANT, OTHER_TENANT]);
  await withTenant(OTHER_TENANT, () => s.retention.cleanup({ now: T0 + 31 * DAY }));
  assert.equal(existsSync(join(s.dir, OTHER_TENANT, pkg.id)), false);
  assert.ok(existsSync(join(s.dir, TEST_TENANT, pkg.id, `${pkg.id}.zip`)));
  assert.equal((await withTenant(TEST_TENANT, () => s.map.get(pkg.id)))?.deletedAt, undefined);
});

test("verifyDirectory creates a private directory and names the setting when the path is unusable", async (t) => {
  const s = setup(t);
  await s.retention.verifyDirectory();
  assert.equal(statSync(s.dir).mode & 0o777, 0o700);
  const file = join(scratchDir(t, "pp-retain-file-"), "afile");
  writeFileSync(file, "x");
  const bad = createPatchRetention({ map: s.map, settings: { ...s.settings, dir: file } });
  await assert.rejects(bad.verifyDirectory(), /ZQ_PATCH_RETAIN_DIR/);
  const under = createPatchRetention({ map: s.map, settings: { ...s.settings, dir: join(file, "child") } });
  await assert.rejects(under.verifyDirectory(), /ZQ_PATCH_RETAIN_DIR/);
});
