import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createZqChanges, type ZqChangeCursor, type ZqChangeLine, type ZqSnapshot } from "../src/zq/changes.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createZqChildren, type ZqChildDraft } from "../src/zq/children.ts";
import { parseContract } from "../src/zq/contract.ts";
import { createZqGroups, type ZqGroup } from "../src/zq/groups.ts";
import { createZqReminderStore, type ZqReminder } from "../src/zq/reminders.ts";
import { createZqReports, type ZqReportDraft } from "../src/zq/reports.ts";
import { projectsOfFacts } from "../src/zq/report-source.ts";
import { createRoleplay, type RoleplayPersona } from "../src/zq/roleplay.ts";
import type { FeatureFacts, OpUserRef, WorkView } from "../src/zq/rules.ts";
import type { ScanPerson } from "../src/zq/scanner.ts";
import { createZqService, type ZqRunState } from "../src/zq/service.ts";
import { testMap } from "./support/test-database.ts";

const keyTable = JSON.parse(
  readFileSync(new URL("./fixtures/zq-contract-keys.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const contract = parseContract({ ...keyTable, tools: { dutyHolders: "zq_duty_holders" } });

const JELLY = "mm-jelly";
const PROJECT = "test-p";
const MINUTE = 60_000;
const WEDNESDAY_10AM_SHANGHAI = Date.UTC(2026, 10, 11, 2, 0);
const NEXT_WEDNESDAY_10AM_SHANGHAI = Date.UTC(2026, 10, 18, 2, 0);
const person: ScanPerson = { mmUserId: JELLY, principalId: "internal:jelly", opUserId: "1", opName: "jelly" };
const user = (id: string, name: string): OpUserRef => ({ id, login: name, name });
const PRODUCER = user("5", "制作人老P");
const PM = user("6", "项目经理老M");
const PLANNER = user("11", "策划小A");
const DEV = user("12", "服务端小B");
const DEV2 = user("14", "服务端小D");
const QA = user("13", "QA小C");

const view = (id: number, over: Partial<WorkView>): WorkView => ({
  id,
  subject: `单${id}`,
  typeKey: "backend",
  statusKey: "execution.active",
  lifecycle: "normal",
  projectId: PROJECT,
  statusChangedAt: WEDNESDAY_10AM_SHANGHAI - 3_600_000,
  ...over,
});

const label = (role: string, name: string) => `当前你扮演:${role} ${name}`;

function harness() {
  const clock = { now: WEDNESDAY_10AM_SHANGHAI };
  const sent: Array<{ to: string; text: string }> = [];
  const posts: Array<{ channel: string; text: string }> = [];
  const channels: string[][] = [];
  const maps = {
    reminders: testMap<ZqReminder>(),
    groups: testMap<ZqGroup>(),
    snapshots: testMap<ZqSnapshot>(),
    lines: testMap<ZqChangeLine>(),
    cursors: testMap<ZqChangeCursor>(),
    drafts: testMap<ZqReportDraft>(),
  };
  const roleplay = createRoleplay({
    mmUserId: JELLY,
    projectIds: [PROJECT],
    contract,
    personas: testMap<RoleplayPersona>(),
    reminders: maps.reminders,
    groups: maps.groups,
    features: testMap<{ featureId: number }>(),
    snapshots: maps.snapshots,
    lines: maps.lines,
    cursors: maps.cursors,
  });
  const chat = roleplay.chat({
    sendDm: async (to: string, text: string) => void sent.push({ to, text }),
    sendButtons: async (to: string, text: string) => void sent.push({ to, text }),
    createGroup: async (_f: { id: number; subject: string; url?: string }, members: string[]) => {
      channels.push(members);
      return "chan-1";
    },
    postToChannel: async (channel: string, text: string) => void posts.push({ channel, text }),
  });

  const world = {
    feature: view(1, { typeKey: "feature", statusKey: "feature.planning_unassigned", pm: PM }),
    children: [] as WorkView[],
    bugs: [] as WorkView[],
    extra: [] as FeatureFacts[],
  };
  const holders: Record<string, OpUserRef[]> = { producer: [PRODUCER], pm: [PM] };
  const facts = (): FeatureFacts[] => [
    { feature: world.feature, children: world.children, bugs: world.bugs, meetings: [] },
    ...world.extra,
    {
      feature: view(900, { typeKey: "feature", statusKey: "feature.planning_unassigned", projectId: "prod" }),
      children: [],
    },
  ];

  const reports = createZqReports({ map: maps.drafts, write: undefined, writeBack: async () => {} });
  const service = createZqService({
    config: zqConfigFromEnv({
      ZQ_SCANNER: "1",
      ZQ_REMINDER_DELIVERY: "1",
      ZQ_CONTRACT_FILE: "unused",
      ZQ_REPORTS: "1",
      ZQ_REPORT_WEEKLY_AT: "09:00",
      ZQ_ROLEPLAY_MM_USER: JELLY,
      ZQ_ROLEPLAY_PROJECTS: PROJECT,
    }),
    contract,
    reader: roleplay.reader({
      features: async () => ({ facts: facts(), problems: [] }),
      dutyHolders: async (_p, _project, duty) => holders[duty],
    }),
    mmUserIdOfOpUser: roleplay.mmUserIdOfOpUser,
    people: async () => roleplay.people([person]),
    groups: { store: createZqGroups({ map: maps.groups }), create: chat.createGroup! },
    changes: {
      store: createZqChanges({ snapshots: maps.snapshots, lines: maps.lines, cursors: maps.cursors }),
      channel: chat.postToChannel!,
      lineLabel: roleplay.lineLabel,
    },
    reminders: createZqReminderStore({ map: maps.reminders }),
    state: testMap<ZqRunState>(),
    send: chat.sendDm,
    reports: {
      store: reports,
      source: {
        build: async (p, period, since, until, scope) => ({
          mmUserId: p.mmUserId,
          opName: p.opName,
          period,
          since,
          until,
          statusChanges: [],
          timeEntries: [],
          projects: projectsOfFacts(scope?.facts ?? facts()),
        }),
      },
      sendCard: (to, _id, text) => chat.sendButtons(to, text),
    },
    now: () => clock.now,
    sendRetryDelayMs: 0,
  });

  async function step(minutes: number) {
    clock.now += minutes * MINUTE;
    const before = { sent: sent.length, posts: posts.length };
    await service.tick();
    return { sent: sent.slice(before.sent), posts: posts.slice(before.posts) };
  }
  return { clock, sent, posts, channels, maps, roleplay, chat, world, holders, reports, step };
}

test("role-play acceptance script: create, assign, develop, hand in, QA, finish, plus bug, sub-orders and weekly report", async () => {
  const h = harness();
  const everyone = () => new Set(h.sent.map((m) => m.to));

  const created = await h.step(0);
  const first = created.sent.map((m) => m.text);
  assert.ok(
    first.some((t) => t.startsWith(label("制作人", "制作人老P"))),
    "producer notice names the producer",
  );
  assert.ok(
    first.some((t) => t.startsWith(label("项目经理", "项目经理老M"))),
    "PM notice names the PM",
  );

  h.world.feature = { ...h.world.feature, statusKey: "feature.planning", responsiblePlanner: PLANNER };
  const assigned = await h.step(10);
  assert.match(assigned.sent.map((m) => m.text).join("\n"), new RegExp(`- ${label("策划", "策划小A")} 功能 \\[#1\\]`));

  h.world.feature = { ...h.world.feature, statusKey: "feature.briefing" };
  h.world.children = [view(41, { parentId: 1, assignee: DEV, typeKey: "backend" })];
  const briefing = await h.step(10);
  assert.deepEqual(h.channels, [[JELLY]], "the group holds only the tester");
  const roster = briefing.posts.find((p) => p.text.includes("角色扮演验收群"))!.text;
  assert.match(roster, /策划小A/);
  assert.match(roster, /服务端负责人 服务端小B/);

  h.world.feature = { ...h.world.feature, statusKey: "feature.development" };
  h.world.children = [...h.world.children, view(43, { parentId: 1, assignee: DEV2, typeKey: "backend" })];
  const developing = await h.step(10);
  const lines = developing.posts.map((p) => p.text).join("\n");
  assert.match(lines, new RegExp(`- ${label("策划", "策划小A")} 功能 \\[#1\\]`));
  assert.match(lines, new RegExp(`- ${label("服务端负责人", "服务端小D")} 新增执行单「单43」`));

  h.world.children = h.world.children.map((c) => (c.id === 41 ? { ...c, statusKey: "execution.done" } : c));
  const handedIn = await h.step(10);
  assert.match(
    handedIn.posts.map((p) => p.text).join("\n"),
    new RegExp(
      `- ${label("服务端负责人", "服务端小B")} 执行单「单41」 \\[#41\\]|- ${label("服务端负责人", "服务端小B")} 执行单「单41」`,
    ),
  );

  h.world.feature = { ...h.world.feature, statusKey: "feature.qa", qaOwner: QA };
  h.world.bugs = [view(70, { typeKey: "bug", parentId: 1, assignee: DEV, qaOwner: QA, blocking: true })];
  const qa = await h.step(10);
  const qaText = qa.sent.map((m) => m.text);
  assert.ok(qaText.some((t) => t.startsWith(label("服务端负责人/BUG 处理人", "服务端小B")) && t.includes("阻断 BUG")));
  assert.ok(qaText.some((t) => t.startsWith(label("QA", "QA小C")) && t.includes("阻断 BUG")));
  assert.match(
    qa.posts.map((p) => p.text).join("\n"),
    new RegExp(`- ${label("策划", "策划小A")} 功能 \\[#1\\].*QA 测试中`),
  );

  h.world.bugs = [];
  h.world.feature = { ...h.world.feature, statusKey: "feature.done" };
  const done = await h.step(10);
  assert.match(done.posts.map((p) => p.text).join("\n"), /已完成|阶段 .* → 已完成/);

  const optimization = (id: number, over: Partial<WorkView>) =>
    view(id, { typeKey: "optimization", statusKey: "execution.unassigned", responsiblePlanner: PLANNER, ...over });
  h.world.extra = [{ feature: optimization(80, {}), children: [], meetings: [] }];
  const unassigned = await h.step(10);
  assert.ok(
    unassigned.sent.some((m) => m.text.startsWith(label("策划", "策划小A")) && m.text.includes("优化单「单80」")),
    "an optimization order nobody is assigned to goes to its planner",
  );
  h.world.extra = [
    {
      feature: optimization(81, { statusKey: "execution.active" }),
      children: [
        view(82, { parentId: 81, assignee: DEV, statusKey: "execution.done" }),
        view(83, { parentId: 81, assignee: DEV2, typeKey: "frontend", statusKey: "execution.done" }),
      ],
      meetings: [],
    },
  ];
  const finished = await h.step(10);
  assert.ok(
    finished.sent.some((m) => m.text.startsWith(label("策划", "策划小A")) && m.text.includes("子单都已完成")),
    "finished child orders ask the planner to close the optimization order",
  );

  const children = createZqChildren({
    map: testMap<ZqChildDraft>(),
    call: async () => "预览:将创建 1 张执行单",
    mmUserIdOf: async () => JELLY,
    sendCard: (to, _id, text) => h.chat.sendButtons(to, text),
  });
  const before = h.sent.length;
  await children.propose(
    {
      featureId: 1,
      lockVersion: 3,
      reason: "补一张服务端执行单",
      children: [{ typeKey: "backend", subject: "新增接口", description: "实现接口" }],
    },
    "internal:jelly",
  );
  const card = h.sent[before]!;
  assert.deepEqual([card.to, card.text.startsWith("当前你扮演:你本人")], [JELLY, true]);

  h.clock.now = NEXT_WEDNESDAY_10AM_SHANGHAI;
  const weekly = await h.step(0);
  const weeklyCard = weekly.sent.find((m) => m.text.includes("周报"))!;
  assert.ok(
    weeklyCard.text.startsWith(label("项目经理", "项目经理老M")),
    "the weekly report is addressed to the PM persona",
  );
  const draft = (await h.maps.drafts.all()).find((d) => d.kind === "project")!;
  const clicker = await h.roleplay.reportClicker(JELLY, draft.addressees);
  assert.equal((await h.reports.decide(draft.id, true, clicker, clicker)).status, "confirmed");

  assert.deepEqual([...everyone()], [JELLY], "nothing reached anyone but the tester");
  assert.ok(h.sent.every((m) => m.text.startsWith("当前你扮演:")));
  assert.ok(h.posts.filter((p) => !p.text.includes("角色扮演验收群")).every((p) => p.text.includes("- 当前你扮演:")));

  const wiped = await h.roleplay.reset();
  assert.ok(wiped.changeLines > 0 && wiped.snapshots > 0 && wiped.groups === 1 && wiped.reminders > 0);
  assert.deepEqual(
    await Promise.all([h.maps.reminders.all(), h.maps.groups.all(), h.maps.lines.all(), h.maps.snapshots.all()]),
    [[], [], [], []],
  );
});
