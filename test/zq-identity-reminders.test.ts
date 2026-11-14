import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createZqIdentityMap, matchByEmail, type ZqIdentityLink } from "../src/zq/identity-map.ts";
import { createZqReminderStore, type ZqReminder } from "../src/zq/reminders.ts";
import type { FollowUpAction } from "../src/zq/follow-up-rules.ts";
import { testMap } from "./support/test-database.ts";

const LINK = {
  mmUserId: "mm1",
  opUserId: "42",
  opLogin: "alice",
  email: "alice@example.com",
  source: "admin" as const,
  linkedBy: "internal:admin",
};

test("identity mapping is off unless ZQ_IDENTITY_MAP=1", async () => {
  assert.equal(zqConfigFromEnv({}).identityMap, false);
  assert.equal(zqConfigFromEnv({ ZQ_IDENTITY_MAP: "0" }).identityMap, false);
  assert.equal(zqConfigFromEnv({ ZQ_IDENTITY_MAP: "1" }).identityMap, true);
  const off = createZqIdentityMap({ map: testMap<ZqIdentityLink>(), enabled: false });
  await assert.rejects(off.link(LINK), /ZQ_IDENTITY_MAP/);
  assert.equal(await off.byMattermost("mm1"), undefined);
});

test("links resolve both ways, relink replaces, and one OpenProject user maps to one Mattermost user", async () => {
  const map = createZqIdentityMap({ map: testMap<ZqIdentityLink>(), enabled: true, now: () => 5 });
  const linked = await map.link(LINK);
  assert.equal(linked.linkedAt, 5);
  assert.equal((await map.byMattermost("mm1"))?.opLogin, "alice");
  assert.equal((await map.byOpenProject("42"))?.mmUserId, "mm1");
  await assert.rejects(map.link({ ...LINK, mmUserId: "mm2" }), /already linked/);
  await map.link({ ...LINK, opUserId: "43", opLogin: "alice2" });
  assert.equal(await map.byOpenProject("42"), undefined);
  await assert.rejects(map.link({ ...LINK, mmUserId: "mm2", opUserId: "43" }), /already linked/);
  assert.equal((await map.link({ ...LINK, mmUserId: "mm2" })).opUserId, "42");
  await map.unlink("mm1");
  assert.equal(await map.byMattermost("mm1"), undefined);
});

test("email matching links only an unambiguous OpenProject user", () => {
  const users = [
    { id: "1", login: "a", email: "Alice@Example.com" },
    { id: "2", login: "b", email: "bob@example.com" },
    { id: "3", login: "b2", email: "bob@example.com" },
    { id: "4", login: "nomail" },
  ];
  assert.deepEqual(matchByEmail(" alice@example.com", users), { id: "1", login: "a" });
  assert.equal(matchByEmail("bob@example.com", users), undefined);
  assert.equal(matchByEmail("carol@example.com", users), undefined);
});

const ACTION: FollowUpAction = {
  kind: "remind-stale",
  workPackageId: 7,
  assigneeOpUserId: "42",
  dedupeKey: "7:stale:0",
  reason: "no update for 6 day(s) while In progress",
};

test("a reminder is scheduled once per dedupe key, becomes due on time and is sent once", async () => {
  let clock = 1_000;
  const store = createZqReminderStore({ map: testMap<ZqReminder>(), now: () => clock });
  const first = await store.schedule(ACTION, 2_000);
  assert.equal(first.created, true);
  clock = 1_500;
  const again = await store.schedule(ACTION, 9_000);
  assert.equal(again.created, false);
  assert.equal(again.reminder.dueAt, 2_000);
  assert.deepEqual(await store.due(1_999), []);
  assert.deepEqual(
    (await store.due(2_000)).map((r) => r.id),
    ["7:stale:0"],
  );
  clock = 2_100;
  assert.equal((await store.markSent("7:stale:0"))?.sentAt, 2_100);
  clock = 3_000;
  assert.equal((await store.markSent("7:stale:0"))?.sentAt, 2_100);
  assert.deepEqual(await store.due(5_000), []);
});

test("cancelling a work package's reminders leaves sent ones alone", async () => {
  const store = createZqReminderStore({ map: testMap<ZqReminder>() });
  await store.schedule(ACTION, 1);
  await store.schedule({ ...ACTION, dedupeKey: "7:stale:1" }, 1);
  await store.schedule({ ...ACTION, workPackageId: 8, dedupeKey: "8:stale:0" }, 1);
  await store.markSent("7:stale:0");
  assert.equal(await store.cancelForWorkPackage(7), 1);
  assert.deepEqual(
    (await store.due(10)).map((r) => r.id),
    ["8:stale:0"],
  );
});
