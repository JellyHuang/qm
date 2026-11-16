import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createZqChanges,
  type FeedEvent,
  type ZqChangeCursor,
  type ZqChangeLine,
  type ZqSnapshot,
} from "../src/zq/changes.ts";
import { parseContract } from "../src/zq/contract.ts";
import { createZqGroups, type ZqGroup } from "../src/zq/groups.ts";
import { createZqReminderStore, type ZqReminder } from "../src/zq/reminders.ts";
import type { FeatureFacts, WorkView } from "../src/zq/rules.ts";
import { scanOnce, type ScanPerson } from "../src/zq/scanner.ts";
import { testMap } from "./support/test-database.ts";

const contract = parseContract(
  JSON.parse(readFileSync(new URL("./fixtures/zq-contract-keys.json", import.meta.url), "utf8")),
);
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 14, 4, 0);
const ALICE_OP = { id: "11", name: "Alice A" };
const BOB_OP = { id: "12", name: "Bob B" };
const PM_OP = { id: "13", name: "Pm P" };
const PERSON: ScanPerson = { mmUserId: "mm-alice", principalId: "internal:alice", opUserId: "11", opName: "Alice A" };

const work = (id: number, over: Partial<WorkView> = {}): WorkView => ({
  id,
  subject: `单${id}`,
  typeKey: "backend",
  statusKey: "execution.active",
  ...over,
});
const feature = (over: Partial<WorkView> = {}): WorkView =>
  work(1, {
    typeKey: "feature",
    statusKey: "feature.development",
    responsiblePlanner: ALICE_OP,
    pm: PM_OP,
    plannedEnd: NOW + 30 * DAY,
    projectId: "p1",
    ...over,
  });

function harness() {
  const snapshots = testMap<ZqSnapshot>();
  const lines = testMap<ZqChangeLine>();
  const changes = createZqChanges({ snapshots, lines, cursors: testMap<ZqChangeCursor>() });
  const groups = createZqGroups({ map: testMap<ZqGroup>() });
  const channel: Array<{ to: string; text: string }> = [];
  const dm: Array<{ to: string; text: string }> = [];
  let fail = false;
  const transport = {
    channel: async (to: string, text: string) => {
      if (fail) throw new Error("mattermost down");
      channel.push({ to, text });
    },
    dm: async (to: string, text: string) => void dm.push({ to, text }),
  };
  const feedCalls: Array<string | null> = [];
  let feed: (cursor: string | null) => { events: FeedEvent[]; nextCursor: string } = () => ({
    events: [],
    nextCursor: "c0",
  });
  const scan = (fact: FeatureFacts, withFeed = false) =>
    scanOnce({
      reader: {
        features: async () => ({ facts: [fact], problems: [] }),
        dutyHolders: async () => undefined,
        ...(withFeed
          ? {
              changes: async (_p: ScanPerson, _project: string, cursor: string | null) => {
                feedCalls.push(cursor);
                return feed(cursor);
              },
            }
          : {}),
      },
      contract,
      people: [PERSON],
      mmUserIdOfOpUser: async (id) => ({ "11": "mm-alice", "13": "mm-pm" })[id],
      reminders: createZqReminderStore({ map: testMap<ZqReminder>() }),
      changes,
      opBaseUrl: "https://op.example.com",
      mode: "live",
      now: NOW,
      timezone: "Asia/Shanghai",
      dailyCeiling: 1000,
      escalation: { duties: [], afterDays: 2 },
    });
  return {
    scan,
    flush: () => changes.flush(groups, transport),
    groups,
    channel,
    dm,
    feedCalls,
    setFeed: (f: typeof feed) => void (feed = f),
    breakChannel: (broken: boolean) => (fail = broken),
  };
}

test("the first scan is only a baseline, and each later change is one line carrying nothing but the change and a link", async () => {
  const h = harness();
  const f = feature();
  const first = await h.scan({ feature: f, children: [work(2, { assignee: BOB_OP })] });
  assert.equal(first.changesRecorded, 0);
  assert.deepEqual(await h.flush(), { sent: 0, failed: 0, undeliverable: 0 });
  const second = await h.scan({
    feature: f,
    children: [
      work(2, {
        statusKey: "execution.done",
        assignee: { id: "14", name: "Dan D" },
        plannedEnd: NOW + DAY,
        delayMarked: true,
        estimateHours: 99,
      }),
      work(3, { assignee: BOB_OP }),
    ],
  });
  assert.equal(second.changesRecorded, 5);
  await h.groups.ensure(1, ["mm-alice"], async () => "ch-1");
  const flushed = await h.flush();
  assert.deepEqual(flushed, { sent: 5, failed: 0, undeliverable: 0 });
  assert.equal(h.channel.length, 1);
  assert.equal(h.channel[0]!.to, "ch-1");
  const text = h.channel[0]!.text;
  assert.match(text, /功能「单1」\(#1\) 有 5 项变化/);
  assert.match(text, /执行单「单2」\[#2\]\(https:\/\/op\.example\.com\/work_packages\/2\) 已完成/);
  assert.match(text, /执行人 Bob B → Dan D/);
  assert.match(text, /被标记延期\(执行人:Dan D,负责策划:Alice A\)/);
  assert.match(text, /计划结束时间 未设置 → 2026-11-15/);
  assert.match(text, /新增执行单「单3」/);
  assert.doesNotMatch(text, /99/);
});

test("nothing is posted twice: a repeated scan of the same state adds no line, and a sent line is not sent again", async () => {
  const h = harness();
  await h.scan({ feature: feature(), children: [work(2)] });
  const changed: FeatureFacts = { feature: feature(), children: [work(2, { statusKey: "execution.done" })] };
  assert.equal((await h.scan(changed)).changesRecorded, 1);
  assert.equal((await h.scan(changed)).changesRecorded, 0);
  await h.groups.ensure(1, [], async () => "ch-1");
  await h.flush();
  await h.flush();
  assert.equal(h.channel.length, 1);
});

test("a feature without a channel sends the digest to its PM by DM, and a failed post stays pending until it works", async () => {
  const h = harness();
  await h.scan({ feature: feature(), children: [work(2)] });
  await h.scan({ feature: feature(), children: [work(2, { lifecycle: "suspended" })] });
  assert.deepEqual(await h.flush(), { sent: 1, failed: 0, undeliverable: 0 });
  assert.deepEqual(
    h.dm.map((d) => d.to),
    ["mm-pm"],
  );
  assert.match(h.dm[0]!.text, /已挂起/);

  await h.scan({ feature: feature(), children: [work(2, { lifecycle: "normal" })] });
  await h.groups.ensure(1, [], async () => "ch-1");
  h.breakChannel(true);
  assert.deepEqual(await h.flush(), { sent: 0, failed: 1, undeliverable: 0 });
  h.breakChannel(false);
  assert.deepEqual(await h.flush(), { sent: 1, failed: 0, undeliverable: 0 });
  assert.match(h.channel[0]!.text, /已恢复/);
});

test("a feature with neither a channel nor a PM keeps its lines pending instead of dropping them", async () => {
  const h = harness();
  const noPm = feature({ pm: undefined });
  await h.scan({ feature: noPm, children: [work(2)] });
  await h.scan({ feature: noPm, children: [work(2, { statusKey: "execution.done" })] });
  assert.deepEqual(await h.flush(), { sent: 0, failed: 0, undeliverable: 1 });
  await h.groups.ensure(1, [], async () => "ch-1");
  assert.deepEqual(await h.flush(), { sent: 1, failed: 0, undeliverable: 0 });
});

test("suspending the feature is one line naming the affected orders, and an automatic stage move says it was automatic", async () => {
  const h = harness();
  await h.groups.ensure(1, [], async () => "ch-1");
  const kids = (lifecycle?: WorkView["lifecycle"]) => [2, 3, 4].map((id) => work(id, lifecycle ? { lifecycle } : {}));
  await h.scan({ feature: feature(), children: kids() });
  await h.scan({ feature: feature({ lifecycle: "suspended" }), children: kids("suspended") });
  await h.flush();
  const lines = h.channel[0]!.text.split("\n").slice(1);
  assert.equal(lines.length, 2, lines.join("|"));
  assert.match(lines[0]!, /功能「单1」.*已挂起/);
  assert.match(lines[1]!, /随总单已挂起,影响 3 张执行单:#2、#3、#4/);

  await h.scan({ feature: feature({ statusKey: "feature.acceptance" }), children: kids() });
  await h.flush();
  assert.match(h.channel.at(-1)!.text, /功能「单1」.*阶段 研发制作中 → 策划验收\(自动推进\)/);
});

test("a long digest is split into several posts without losing a line", async () => {
  const h = harness();
  await h.groups.ensure(1, [], async () => "ch-1");
  const kids = (done: boolean) =>
    Array.from({ length: 60 }, (_, i) =>
      work(100 + i, { subject: "很长的执行单名称".repeat(5), ...(done ? { statusKey: "execution.done" } : {}) }),
    );
  await h.scan({ feature: feature(), children: kids(false) });
  await h.scan({ feature: feature(), children: kids(true) });
  const result = await h.flush();
  assert.equal(result.sent, 60);
  assert.ok(h.channel.length > 1);
  assert.equal(
    h.channel.map((c) => c.text.split("\n").length - 1).reduce((a, b) => a + b),
    60,
  );
});

const event = (over: Partial<FeedEvent>): FeedEvent => ({
  id: "j1",
  ticketId: 2,
  featureId: 1,
  kinds: ["stage"],
  old: { stage: "execution.active" },
  new: { stage: "execution.done" },
  actorName: "Bob B",
  byRule: false,
  at: NOW,
  ...over,
});

test("with the change feed, the first read is only a baseline and later events become lines keyed by their event id", async () => {
  const h = harness();
  await h.groups.ensure(1, [], async () => "ch-1");
  const fact: FeatureFacts = { feature: feature(), children: [work(2), work(3)] };
  h.setFeed(() => ({ events: [event({ id: "old" })], nextCursor: "c1" }));
  const first = await h.scan(fact, true);
  assert.deepEqual([first.changesRecorded, h.feedCalls], [0, [null]]);

  h.setFeed(() => ({
    events: [
      event({ id: "j2" }),
      event({
        id: "j3",
        ticketId: 3,
        kinds: ["assignee", "delay_marked"],
        old: { assignee: { name: "Bob B" } },
        new: { assignee: { name: "Dan D" }, delay_marked: true },
      }),
      event({
        id: "j4",
        ticketId: 1,
        kinds: ["stage"],
        old: { stage: "feature.development" },
        new: { stage: "feature.acceptance" },
        actorName: "zq-feature-rule",
        byRule: true,
        reason: "全部非取消执行单已完成;子单:#2 #3",
      }),
    ],
    nextCursor: "c2",
  }));
  const second = await h.scan(fact, true);
  assert.deepEqual([second.changesRecorded, h.feedCalls.at(-1)], [3, "c1"]);
  await h.flush();
  const text = h.channel[0]!.text;
  assert.match(text, /执行单「单2」\[#2\].*已完成\(Bob B\)/);
  assert.match(text, /被标记延期;执行人 Bob B → Dan D\(Bob B\)/);
  assert.match(
    text,
    /功能「单1」.*阶段 研发制作中 → 策划验收\(自动推进\)\(规则 zq-feature-rule,原因:全部非取消执行单已完成;子单:#2 #3\)/,
  );

  const again = await h.scan(fact, true);
  assert.equal(again.changesRecorded, 0, "the same events read again add nothing");
  assert.deepEqual(h.feedCalls.at(-1), "c2");
});

test("a feed event read twice, and a batch of lifecycle changes, give single lines", async () => {
  const h = harness();
  await h.groups.ensure(1, [], async () => "ch-1");
  const fact: FeatureFacts = { feature: feature(), children: [work(2), work(3), work(4)] };
  h.setFeed(() => ({ events: [], nextCursor: "c1" }));
  await h.scan(fact, true);
  const suspended = (id: string, ticketId: number) =>
    event({
      id,
      ticketId,
      kinds: ["lifecycle"],
      old: { lifecycle: "normal" },
      new: { lifecycle: "suspended" },
      batchId: "b1",
    });
  const events = [
    event({
      id: "f1",
      ticketId: 1,
      kinds: ["lifecycle"],
      old: { lifecycle: "normal" },
      new: { lifecycle: "suspended" },
      batchId: "b1",
    }),
    suspended("c2", 2),
    suspended("c3", 3),
    suspended("c4", 4),
    event({ id: "x9", ticketId: 99, kinds: ["stage"] }),
  ];
  h.setFeed(() => ({ events, nextCursor: "c2" }));
  assert.equal((await h.scan(fact, true)).changesRecorded, 2);
  h.setFeed(() => ({ events, nextCursor: "c3" }));
  assert.equal((await h.scan(fact, true)).changesRecorded, 0);
  await h.flush();
  const lines = h.channel[0]!.text.split("\n").slice(1);
  assert.equal(lines.length, 2);
  assert.match(lines.join("|"), /功能「单1」.*已挂起/);
  assert.match(lines.join("|"), /随总单已挂起,影响 3 张执行单:#2、#3、#4/);
});

test("an invalid or out-of-scope cursor is read again from the start as a new baseline and reported", async () => {
  const h = harness();
  const fact: FeatureFacts = { feature: feature(), children: [work(2)] };
  h.setFeed(() => ({ events: [], nextCursor: "c1" }));
  await h.scan(fact, true);
  let calls = 0;
  h.setFeed((cursor) => {
    calls++;
    if (cursor !== null) throw Object.assign(new Error("expired"), { code: "cursor_invalid" });
    return { events: [event({ id: "late" })], nextCursor: "c9" };
  });
  const report = await h.scan(fact, true);
  assert.deepEqual([report.changeResync, report.changesRecorded, calls], [1, 0, 2]);
  h.setFeed(() => ({ events: [], nextCursor: "c10" }));
  await h.scan(fact, true);
  assert.deepEqual(h.feedCalls.at(-1), "c9");
});
