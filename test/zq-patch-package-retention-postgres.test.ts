import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withTenant } from "../src/tenants/context.ts";
import { createPatchRetention, type PatchPackageRecord } from "../src/zq/patch-package/retention.ts";
import { buildFrom, makeLfsRepo } from "./support/patch-package-apply.ts";
import { put, scratchDir } from "./support/patch-package-fixture.ts";
import { TEST_TENANT } from "./support/test-tenant-id.ts";
import { testMap } from "./support/test-database.ts";

const DAY = 86_400_000;
const T0 = 1_763_000_000_000;

test(
  "retention against a real Postgres map: record, idempotent record, expiry, purge",
  {
    skip:
      !process.env.DATABASE_URL && "set DATABASE_URL (a Postgres the tests may create databases on) to run this test",
  },
  async (t) => {
    const fixture = makeLfsRepo(t);
    put(fixture.repo, "readme.txt", "one\nTWO\nthree\n");
    const pkg = await buildFrom(t, fixture, { repo: "client" });
    const dir = join(scratchDir(t, "pp-pg-"), "retained");
    const map = testMap<PatchPackageRecord>();
    const retention = createPatchRetention({
      map,
      settings: { dir, days: 30, recordDays: 30, cleanupBatch: 50 },
      now: () => T0,
    });
    await withTenant(TEST_TENANT, async () => {
      const first = await retention.retain(pkg, { mmUserId: "mmuser0000000000000000001", source: "requester" });
      assert.deepEqual(await map.get(pkg.id), first.record);
      const again = await retention.retain(pkg, { mmUserId: "mmuser0000000000000000001", source: "requester" });
      assert.equal(again.written, false);
      assert.equal((await map.all()).length, 1);
      assert.deepEqual(await retention.cleanup({ now: T0 + 31 * DAY }), { deleted: 1, purged: 0, refused: [] });
      assert.equal(existsSync(join(dir, TEST_TENANT, pkg.id)), false);
      assert.equal((await map.get(pkg.id))?.deletedAt, T0 + 31 * DAY);
      assert.deepEqual(await retention.cleanup({ now: T0 + 61 * DAY }), { deleted: 0, purged: 1, refused: [] });
      assert.equal(await map.get(pkg.id), null);
    });
  },
);
