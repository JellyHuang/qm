import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { parseContract } from "../src/zq/contract.ts";
import { deliverDue } from "../src/zq/delivery.ts";
import { createZqGroups, type ZqGroup } from "../src/zq/groups.ts";
import { parseWorkView } from "../src/zq/op-reader.ts";
import { createZqReminderStore, type ZqReminder } from "../src/zq/reminders.ts";
import { createRoleplay, type RoleplayPersona } from "../src/zq/roleplay.ts";
import { scanOnce, type ScanPerson } from "../src/zq/scanner.ts";
import { testMap } from "./support/test-database.ts";

const keyTable = JSON.parse(
  readFileSync(new URL("./fixtures/zq-contract-keys.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const contract = parseContract({ ...keyTable, tools: { dutyHolders: "zq_duty_holders" } });

const NOON = Date.UTC(2026, 10, 14, 4, 0);
const DAY = 86_400_000;
const PLANNER = { id: "11", login: "alice", name: "策划小A" };
const DEV = { id: "12", login: "bob", name: "服务端小B", type: "User" };
const JELLY = "mm-jelly";
const person: ScanPerson = { mmUserId: JELLY, principalId: "internal:jelly", opUserId: "1", opName: "jelly" };

function work(id: number, over: Record<string, unknown>) {
  const status = (over["status_key"] as string | undefined) ?? "execution.active";
  return parseWorkView(
    {
      id,
      subject: `单${id}`,
      type_key: "backend",
      status_key: status,
      stage_key: status,
      lifecycle: "normal",
      project_id: "test-p",
      lock_version: 1,
      status_changed_at: new Date(NOON - DAY).toISOString(),
      updated_at: new Date(NOON - DAY).toISOString(),
      ...over,
    },
    contract,
  )!;
}

function harness() {
  const sent: Array<{ to: string; text: string }> = [];
  const channels: Array<{ members: string[]; subject: string }> = [];
  const posts: string[] = [];
  const reminderMap = testMap<ZqReminder>();
  const groupMap = testMap<ZqGroup>();
  const roleplay = createRoleplay({
    mmUserId: JELLY,
    projectIds: ["test-p"],
    contract,
    personas: testMap<RoleplayPersona>(),
    reminders: reminderMap,
    groups: groupMap,
    features: testMap(),
    snapshots: testMap(),
    lines: testMap(),
    cursors: testMap(),
  });
  const chat = roleplay.chat({
    sendDm: async (to: string, text: string) => void sent.push({ to, text }),
    sendButtons: async (to: string, text: string) => void sent.push({ to, text }),
    createGroup: async (f: { id: number; subject: string; url?: string }, members: string[]) => {
      channels.push({ members, subject: f.subject });
      return "chan-1";
    },
    postToChannel: async (_c: string, text: string) => void posts.push(text),
  });
  return { sent, channels, posts, reminderMap, groupMap, roleplay, chat };
}

const feature = work(40, {
  type_key: "feature",
  status_key: "feature.briefing",
  planner: PLANNER,
  project_id: "test-p",
});
const devFeature = work(20, {
  type_key: "feature",
  status_key: "feature.development",
  planner: PLANNER,
  due_date: "2026-12-31",
});
const task = work(41, {
  parent_id: 20,
  assignee: DEV,
  due_date: "2026-11-11",
  estimated_hours: 8,
  start_date: "2026-11-09",
});
const realFeature = work(90, {
  type_key: "feature",
  status_key: "feature.briefing",
  planner: PLANNER,
  project_id: "prod",
});

test("every notice and group for a test feature reaches only the tester, labelled with the role being played", async () => {
  const h = harness();
  const reminders = createZqReminderStore({ map: h.reminderMap });
  const groups = createZqGroups({ map: h.groupMap });
  const reader = h.roleplay.reader({
    features: async () => ({
      facts: [
        { feature, children: [work(42, { parent_id: 40, assignee: DEV })], meetings: [] },
        { feature: devFeature, children: [task], meetings: [] },
        { feature: realFeature, children: [], meetings: [] },
      ],
      problems: [],
    }),
    dutyHolders: async () => undefined,
  });
  const report = await scanOnce({
    reader,
    contract,
    people: h.roleplay.people([person, { ...person, mmUserId: "mm-real" }]),
    mmUserIdOfOpUser: h.roleplay.mmUserIdOfOpUser,
    reminders,
    groups: { store: groups, create: h.chat.createGroup! },
    mode: "live",
    now: NOON,
    timezone: "Asia/Shanghai",
    dailyCeiling: 100,
    escalation: { duties: [], afterDays: 2 },
  });
  assert.equal(report.featuresSeen, 2, "a feature outside the test projects is never read");
  assert.equal(report.groupsCreated, 1);
  assert.deepEqual(h.channels, [{ members: [JELLY], subject: "【角色扮演】单40" }]);
  assert.match(h.posts[0]!, /策划小A/);

  const delivered = await deliverDue({ reminders, send: h.chat.sendDm, now: NOON });
  assert.ok(delivered.sent > 0);
  assert.deepEqual([...new Set(h.sent.map((s) => s.to))], [JELLY]);
  const bodies = h.sent.map((s) => s.text);
  assert.ok(bodies.every((t) => t.startsWith("当前你扮演:") && /\n本应推送给:.+\n推送理由:.+\n/.test(t)));
  assert.ok(bodies.some((t) => t.startsWith("当前你扮演:") && t.includes("服务端小B")));
});

test("a real user is refused instead of notified, and reset clears only role-play rows", async () => {
  const h = harness();
  await assert.rejects(h.chat.sendDm("mm-real", "hi"), /拒绝发送给 mm-real/);
  await assert.rejects(h.chat.createGroup!({ id: 1, subject: "x" }, ["mm-real"]), /拒绝发送给 mm-real/);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.channels, []);
  const reminders = createZqReminderStore({ map: h.reminderMap });
  const draft = (id: string, to: string) => ({
    id,
    rule: "task-overdue" as const,
    subjectId: id,
    recipientMmUserId: to,
    text: "t",
    dayKey: "d",
    dueAt: NOON,
  });
  await reminders.schedule(draft("a", "rp:12"), "live");
  await reminders.schedule(draft("b", "mm-real"), "live");
  assert.equal((await h.roleplay.reset()).reminders, 1);
  assert.equal(await reminders.has("a"), false);
  assert.equal(await reminders.has("b"), true);
});

test("role-play needs both the tester and the test projects, and is off by default", () => {
  assert.equal(zqConfigFromEnv({}).roleplay, undefined);
  assert.deepEqual(zqConfigFromEnv({ ZQ_ROLEPLAY_MM_USER: "u", ZQ_ROLEPLAY_PROJECTS: "a, b" }).roleplay, {
    mmUserId: "u",
    projectIds: ["a", "b"],
  });
  assert.throws(() => zqConfigFromEnv({ ZQ_ROLEPLAY_MM_USER: "u" }), /set together/);
});

test("a message names the role it is for, not every role the same person holds", async () => {
  const h = harness();
  const reminders = createZqReminderStore({ map: h.reminderMap });
  const both = { id: "11", login: "a", name: "策划小A" };
  const reader = h.roleplay.reader({
    features: async () => ({
      facts: [{ feature: { ...feature, pm: both, qaOwner: both }, children: [], meetings: [] }],
      problems: [],
    }),
    dutyHolders: async () => undefined,
  });
  await scanOnce({
    reader,
    contract,
    people: h.roleplay.people([person]),
    mmUserIdOfOpUser: h.roleplay.mmUserIdOfOpUser,
    reminders,
    mode: "live",
    now: NOON,
    timezone: "Asia/Shanghai",
    dailyCeiling: 100,
    escalation: { duties: [], afterDays: 2 },
  });
  await deliverDue({ reminders, send: h.chat.sendDm, now: NOON });
  const meeting = h.sent.find((s) => s.text.includes("briefing-meeting-missing"))!;
  assert.match(meeting.text, /^当前你扮演:策划 策划小A\n/);
  assert.doesNotMatch(meeting.text.split("\n")[0]!, /项目经理|QA/);
});

test("every responsible planner is reminded, and the group takes the participants and no longer the order executors", async () => {
  const h = harness();
  const reminders = createZqReminderStore({ map: h.reminderMap });
  const groups = createZqGroups({ map: h.groupMap });
  const second = { id: "15", login: "c", name: "策划小C" };
  const guest = { id: "16", login: "d", name: "美术小D" };
  const lead = { ...feature, planners: [PLANNER, second], participants: [guest] };
  const reader = h.roleplay.reader({
    features: async () => ({
      facts: [{ feature: lead, children: [work(42, { parent_id: 40, assignee: DEV })], meetings: [] }],
      problems: [],
    }),
    dutyHolders: async () => undefined,
  });
  await scanOnce({
    reader,
    contract,
    people: h.roleplay.people([person]),
    mmUserIdOfOpUser: h.roleplay.mmUserIdOfOpUser,
    reminders,
    groups: { store: groups, create: async (_f, members) => (h.channels.push({ members, subject: "" }), "chan-9") },
    mode: "live",
    now: NOON,
    timezone: "Asia/Shanghai",
    dailyCeiling: 100,
    escalation: { duties: [], afterDays: 2 },
  });
  const meeting = (await reminders.pendingFor("rp:11")).concat(await reminders.pendingFor("rp:15"));
  assert.deepEqual(meeting.map((r) => r.recipientMmUserId).sort(), ["rp:11", "rp:15"]);
  assert.deepEqual([...h.channels[0]!.members].sort(), ["rp:11", "rp:15", "rp:16"]);
});
