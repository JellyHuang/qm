import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createZqIdentityMap, hintByEmail, type ZqIdentityLink } from "../src/zq/identity-map.ts";
import { createZqReminderStore, type ZqReminder, type ZqReminderDraft } from "../src/zq/reminders.ts";
import { testMap } from "./support/test-database.ts";

const PROPOSAL = {
  mmUserId: "mm1",
  opUserId: "42",
  opLogin: "alice",
  opName: "Alice A",
  source: "signin" as const,
  proposedBy: "internal:alice",
};

test("identity mapping is off unless ZQ_IDENTITY_MAP=1", async () => {
  assert.equal(zqConfigFromEnv({}).identityMap, false);
  assert.equal(zqConfigFromEnv({ ZQ_IDENTITY_MAP: "0" }).identityMap, false);
  assert.equal(zqConfigFromEnv({ ZQ_IDENTITY_MAP: "1" }).identityMap, true);
  const off = createZqIdentityMap({ map: testMap<ZqIdentityLink>(), enabled: false });
  await assert.rejects(off.propose(PROPOSAL), /ZQ_IDENTITY_MAP/);
  await assert.rejects(off.confirm("mm1", "x"), /ZQ_IDENTITY_MAP/);
  assert.equal(await off.byMattermost("mm1"), undefined);
  assert.deepEqual(await off.pending(), []);
});

test("a sign-in proposal is invisible to lookups until someone confirms it", async () => {
  let clock = 5;
  const map = createZqIdentityMap({ map: testMap<ZqIdentityLink>(), enabled: true, now: () => clock });
  const proposed = await map.propose(PROPOSAL);
  assert.equal(proposed.status, "pending");
  assert.equal(await map.byMattermost("mm1"), undefined);
  assert.equal(await map.byOpenProject("42"), undefined);
  assert.deepEqual(
    (await map.pending()).map((l) => l.mmUserId),
    ["mm1"],
  );
  clock = 9;
  const confirmed = await map.confirm("mm1", "internal:admin");
  assert.deepEqual(
    [confirmed.status, confirmed.confirmedAt, confirmed.confirmedBy],
    ["confirmed", 9, "internal:admin"],
  );
  assert.equal((await map.byMattermost("mm1"))?.opLogin, "alice");
  assert.equal((await map.byOpenProject("42"))?.mmUserId, "mm1");
  assert.deepEqual(await map.pending(), []);
  clock = 20;
  assert.equal((await map.confirm("mm1", "someone-else")).confirmedAt, 9);
  await assert.rejects(map.confirm("nobody", "internal:admin"), /no proposed link/);
});

test("one OpenProject user maps to one Mattermost user, and a new proposal needs confirming again", async () => {
  const map = createZqIdentityMap({ map: testMap<ZqIdentityLink>(), enabled: true });
  await map.propose(PROPOSAL);
  await map.confirm("mm1", "internal:admin");
  await assert.rejects(map.propose({ ...PROPOSAL, mmUserId: "mm2" }), /already linked/);
  await map.propose({ ...PROPOSAL, opUserId: "43", opLogin: "alice2" });
  assert.equal(await map.byMattermost("mm1"), undefined);
  await map.confirm("mm1", "internal:admin");
  assert.equal((await map.propose({ ...PROPOSAL, mmUserId: "mm2" })).status, "pending");
  await map.unlink("mm1");
  assert.equal(await map.byMattermost("mm1"), undefined);
});

test("an email is only a hint and only an unambiguous match counts", () => {
  const users = [
    { id: "1", login: "a", email: "Alice@Example.com" },
    { id: "2", login: "b", email: "bob@example.com" },
    { id: "3", login: "b2", email: "bob@example.com" },
    { id: "4", login: "nomail" },
  ];
  assert.deepEqual(hintByEmail(" alice@example.com", users), { id: "1", login: "a" });
  assert.equal(hintByEmail("bob@example.com", users), undefined);
  assert.equal(hintByEmail("carol@example.com", users), undefined);
});

const DRAFT: ZqReminderDraft = {
  id: "wp:7:stale:0",
  kind: "remind-stale",
  subjectId: "wp:7",
  subjectTitle: "Boss intro cutscene",
  recipientMmUserId: "mm1",
  reason: "no update for 6 day(s) while fm.in_progress",
  blockers: [],
  dayKey: "2026-11-14",
  dueAt: 2_000,
};

test("a reminder is stored once per id, dry-run ones are never due, and going live upgrades them", async () => {
  let clock = 1_000;
  const store = createZqReminderStore({ map: testMap<ZqReminder>(), now: () => clock });
  const first = await store.schedule(DRAFT, "dry-run");
  assert.deepEqual([first.created, first.reminder.mode], [true, "dry-run"]);
  assert.deepEqual(await store.due(5_000), []);
  clock = 1_500;
  const live = await store.schedule({ ...DRAFT, dueAt: 9_000 }, "live");
  assert.deepEqual([live.created, live.reminder.mode, live.reminder.dueAt], [false, "live", 2_000]);
  assert.deepEqual(await store.due(1_999), []);
  assert.deepEqual(
    (await store.due(2_000)).map((r) => r.id),
    [DRAFT.id],
  );
  clock = 2_100;
  assert.equal((await store.markSent(DRAFT.id))?.sentAt, 2_100);
  clock = 3_000;
  assert.equal((await store.markSent(DRAFT.id))?.sentAt, 2_100);
  assert.deepEqual(await store.due(5_000), []);
  assert.equal((await store.schedule(DRAFT, "live")).created, false);
});

test("counts, last time and cancellation are per recipient and per subject", async () => {
  let clock = 10;
  const store = createZqReminderStore({ map: testMap<ZqReminder>(), now: () => clock });
  await store.schedule(DRAFT, "live");
  clock = 20;
  await store.schedule({ ...DRAFT, id: "wp:7:stale:1" }, "live");
  await store.schedule({ ...DRAFT, id: "wp:8:stale:0", subjectId: "wp:8", recipientMmUserId: "mm2" }, "live");
  await store.schedule({ ...DRAFT, id: "wp:7:stale:old", dayKey: "2026-11-13" }, "live");
  assert.equal(await store.countForDay("mm1", "2026-11-14"), 2);
  assert.equal(await store.countForDay("mm2", "2026-11-14"), 1);
  assert.equal(await store.lastLiveAt("wp:7"), 20);
  assert.equal(await store.lastLiveAt("wp:9"), undefined);
  assert.equal(await store.has("wp:8:stale:0"), true);
  await store.markSent(DRAFT.id);
  assert.equal(await store.cancelForSubject("wp:7"), 2);
  assert.equal(await store.countForDay("mm1", "2026-11-14"), 1);
  assert.deepEqual(
    (await store.pendingFor("mm2")).map((r) => r.id),
    ["wp:8:stale:0"],
  );
});
