import "./support/auto-fake-sprites.ts";
import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { setPublicOAuthClients } from "../src/connectors/oauth.ts";
import { createMcpServerStore, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService, type McpToolService } from "../src/mcp/mcp-tool-service.ts";
import type { McpToolContract } from "../src/mcp/tool-contract.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { parseContract, type ZqContract } from "../src/zq/contract.ts";
import { channelRemarkArgs, createZqGroups, type ZqGroup } from "../src/zq/groups.ts";
import { createMcpOpReader, parseWorkView } from "../src/zq/op-reader.ts";
import { createZqReminderStore, type ZqReminder } from "../src/zq/reminders.ts";
import { dayKeyIn, scanIsDue, scanOnce, type ScanPerson } from "../src/zq/scanner.ts";
import { createZqService, type ZqRunState } from "../src/zq/service.ts";
import { loopbackFetch, startMcpTestServer, type McpTestServer } from "./support/mcp-test-server.ts";
import { testMap } from "./support/test-database.ts";

const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/openproject-mcp-tools.json", import.meta.url), "utf8"),
) as { tools: Tool[] };
const toolContract = JSON.parse(
  readFileSync(new URL("./fixtures/openproject-tool-contract.json", import.meta.url), "utf8"),
) as McpToolContract;
const keyTable = JSON.parse(
  readFileSync(new URL("./fixtures/zq-contract-keys.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const contract: ZqContract = parseContract({
  ...keyTable,
  typeLeads: {},
  defaultLead: undefined,
  tools: { dutyHolders: "zq_duty_holders" },
});

const DAY = 86_400_000;
const NOON_SHANGHAI = Date.UTC(2026, 10, 14, 4, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const ALICE_OP = { id: "11", login: "alice", name: "Alice A" };
const asUser = (u: { id: string; login: string; name: string }) => ({ ...u, type: "User" });
const BOB_OP = { id: "12", login: "bob", name: "Bob B" };
const CAROL_OP = { id: "13", login: "carol", name: "Carol C" };
const ALICE: ScanPerson = { mmUserId: "mm-alice", principalId: "internal:alice", opUserId: "11", opName: "Alice A" };
const BOB: ScanPerson = { mmUserId: "mm-bob", principalId: "internal:bob", opUserId: "12", opName: "Bob B" };
const MM_OF: Record<string, string> = { "11": "mm-alice", "12": "mm-bob" };

function detail(id: number, over: Record<string, unknown> = {}) {
  const status = (over["status_key"] as string | undefined) ?? "execution.active";
  return {
    id,
    subject: `单${id}`,
    type_key: "backend",
    status_key: status,
    stage_key: status,
    lifecycle: "normal",
    project_id: "p1",
    lock_version: 1,
    status_changed_at: iso(NOON_SHANGHAI - DAY),
    updated_at: iso(NOON_SHANGHAI - DAY),
    ...over,
  };
}

const DETAILS = [
  detail(1, { type_key: "feature", status_key: "feature.staffing", planner: ALICE_OP, assignee: asUser(ALICE_OP) }),
  detail(2, { type_key: "vfx", status_key: "execution.unassigned", parent_id: 1 }),
  detail(20, {
    type_key: "feature",
    status_key: "feature.development",
    planner: ALICE_OP,
    assignee: asUser(ALICE_OP),
    due_date: "2026-12-31",
  }),
  detail(21, { parent_id: 20, assignee: asUser(BOB_OP), due_date: "2026-12-30", start_date: "2026-11-09" }),
  detail(22, {
    parent_id: 20,
    assignee: asUser(BOB_OP),
    due_date: "2026-11-11",
    estimated_hours: 8,
    start_date: "2026-11-09",
  }),
  detail(30, { type_key: "feature", status_key: "feature.planning_unassigned", lifecycle: "suspended" }),
  detail(50, { type_key: "feature", status_key: "feature.staffing", planner: ALICE_OP, assignee: asUser(ALICE_OP) }),
];

const extraTools: Tool[] = ["zq_list_work_packages", "zq_duty_holders"].map((name) => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
}));

interface Harness {
  mcp: McpTestServer;
  oa: McpToolService;
  sent: Array<{ to: string; text: string }>;
  reminders: ReturnType<typeof createZqReminderStore>;
  state: ReturnType<typeof testMap<ZqRunState>>;
  clock: { now: number };
  calls: string[];
  reader: ReturnType<typeof createMcpOpReader>;
  service: (
    env: NodeJS.ProcessEnv,
    extra?: Partial<Parameters<typeof createZqService>[0]>,
  ) => ReturnType<typeof createZqService>;
}

async function harness(
  t: { after(fn: () => unknown): void },
  visible: Record<string, number[]> = {},
): Promise<Harness> {
  const calls: string[] = [];
  const who = (authorization: string | undefined) => (authorization === "Bearer alice-token" ? "alice" : "bob");
  const mcp = await startMcpTestServer(t as Parameters<typeof startMcpTestServer>[0], {
    tools: [...recorded.tools, ...extraTools],
    call: (name, args, authorization) => {
      calls.push(`${name}:${who(authorization)}`);
      const ids = visible[who(authorization)] ?? (who(authorization) === "alice" ? DETAILS.map((d) => d.id) : []);
      const mine = DETAILS.filter((d) => ids.includes(d.id));
      let body: unknown = {};
      if (name === "zq_list_work_packages") {
        const offset = Number(args["offset"] ?? 0);
        const page = mine.slice(offset, offset + 3);
        body = {
          offset,
          limit: 3,
          count: page.length,
          next_offset: offset + 3 < mine.length ? offset + 3 : null,
          truncated: false,
          results: page,
        };
      } else if (name === "zq_duty_holders") {
        body = {
          next_offset: null,
          results: args["duty"] === "lead_artist" ? [BOB_OP] : [],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(body) }] };
    },
  });
  const store = createMcpServerStore(testMap<McpServer>());
  const tokens: Record<string, string> = { "internal:alice": "alice-token", "internal:bob": "bob-token" };
  const oa = createMcpToolService({
    fetch: loopbackFetch,
    servers: store,
    userTokens: {
      connectorAccessToken: async (_host, principalId) => tokens[principalId] ?? null,
      connectorTokenStatus: async (_host, principalId) => ({ connected: principalId in tokens }),
    },
  });
  t.after(() => {
    oa.close();
    setPublicOAuthClients([]);
  });
  await store.put({
    id: "openproject",
    name: "OpenProject",
    url: `${mcp.url}/mcp`,
    auth: "oauth-user",
    credentialScope: "per-user",
    credentialHost: "op.example.com",
    clientId: "op-client",
    oauthAuthorizeUrl: "https://op.example.com/oauth/authorize",
    oauthTokenUrl: "https://op.example.com/oauth/token",
    toolContract,
    readOnly: false,
    enabled: true,
    updatedAt: 0,
    updatedBy: "internal:admin",
  });
  await oa.refresh();
  await oa.call("openproject_sign_in", {}, "internal:alice");
  await oa.call("openproject_sign_in", {}, "internal:bob");

  const clock = { now: NOON_SHANGHAI };
  const sent: Array<{ to: string; text: string }> = [];
  const reminders = createZqReminderStore({ map: testMap<ZqReminder>(), now: () => clock.now });
  const state = testMap<ZqRunState>();
  const reader = createMcpOpReader({ call: (tool, args, principalId) => oa.call(tool, args, principalId), contract });
  return {
    mcp,
    oa,
    sent,
    reminders,
    state,
    clock,
    calls,
    reader,
    service: (env, extra = {}) =>
      createZqService({
        config: zqConfigFromEnv({ ZQ_CONTRACT_FILE: "/unused.json", ...env }),
        reader,
        contract,
        mmUserIdOfOpUser: async (id) => MM_OF[id],
        people: async () => [ALICE, BOB],
        reminders,
        state,
        send: async (to, text) => void sent.push({ to, text }),
        now: () => clock.now,
        ...extra,
      }),
  };
}

const DAY_KEY = "2026-11-14";
const parseWork = (d: unknown) => parseWorkView(d, contract)!;
const ids = async (h: Harness, mm: string) => (await h.reminders.pendingFor(mm)).map((r) => r.rule).sort();

test("everything stays off unless switched on", async (t) => {
  const h = await harness(t);
  const before = h.mcp.requests.length;
  const out = await h.service({}).tick();
  assert.deepEqual(out, { reportsSent: 0, weeklyCardFailed: 0 });
  assert.equal(h.mcp.requests.length, before, "no OpenProject calls while the scanner is off");
  assert.equal(await h.state.get("scanner"), null);
});

test("a dry-run scan walks the pages, stores what it would send per rule, target and day, and sends nothing", async (t) => {
  const h = await harness(t);
  const service = h.service({ ZQ_SCANNER: "1", ZQ_ESCALATION_DUTIES: "art_lead" });
  const out = await service.tick();
  assert.equal(out.scanned?.mode, "dry-run");
  assert.deepEqual(
    { ...out.scanned, mode: undefined },
    {
      mode: undefined,
      peopleScanned: 2,
      peopleFailed: 0,
      featuresSeen: 4,
      created: 5,
      alreadyKnown: 0,
      ceilingHit: 0,
      noHolder: 0,
      unlinked: 0,
      groupsCreated: 0,
      remarkFailed: 0,
      changesRecorded: 0,
      changeResync: 0,
      unsetResponsibility: 0,
      contractProblems: 0,
      problemSamples: [],
    },
  );
  assert.deepEqual(h.sent, []);
  assert.deepEqual(await ids(h, "mm-alice"), ["staffing-trades"]);
  assert.deepEqual(await ids(h, "mm-bob"), [
    "production-missing-plan",
    "task-overdue",
    "task-overdue-escalation",
    "task-unassigned",
  ]);
  const missing = (await h.reminders.pendingFor("mm-bob")).find((r) => r.rule === "production-missing-plan")!;
  assert.equal(missing.id, `production-missing-plan:wp:21:mm-bob:${DAY_KEY}`);
  assert.match(missing.text, /缺少:预计工时。/);
  assert.equal(
    await h.reminders.has(`planner-unassigned:wp:30:mm-alice:${DAY_KEY}`),
    false,
    "a suspended feature is left alone",
  );
  assert.ok(
    h.calls.filter((c) => c.startsWith("zq_list_work_packages")).length >= 3,
    "the 7 rows were read in pages of 3 for each person",
  );
});

test("each feature is handled once even when two people can see it, and each person is read through their own token", async (t) => {
  const h = await harness(t, { alice: [1, 2, 20, 21, 22, 30, 50], bob: [20, 21, 22] });
  await h.service({ ZQ_SCANNER: "1" }).tick();
  assert.deepEqual(
    [
      h.calls.filter((c) => c === "zq_list_work_packages:alice").length,
      h.calls.filter((c) => c === "zq_list_work_packages:bob").length,
    ],
    [3, 1],
    "seven rows are three pages for Alice, three rows one page for Bob",
  );
  assert.equal((await h.reminders.pendingFor("mm-bob")).filter((r) => r.rule === "task-overdue").length, 1);
  assert.ok(
    !h.calls.some((c) => c.startsWith("get_work_package") || c.startsWith("list_work_packages")),
    "no per-order reads",
  );
  h.clock.now += 5 * 60_000;
  const again = (await h.service({ ZQ_SCANNER: "1" }).tick()).scanned!;
  assert.equal(again.created, 0);
  assert.ok(again.alreadyKnown > 0);
});

test("going live delivers the Chinese texts to the people the rules name, once", async (t) => {
  const h = await harness(t);
  await h.service({ ZQ_SCANNER: "1" }).tick();
  h.clock.now += 5 * 60_000;
  const live = h.service({ ZQ_SCANNER: "1", ZQ_REMINDER_DELIVERY: "1" });
  const out = await live.tick();
  assert.equal(out.scanned?.mode, "live");
  assert.deepEqual(out.delivered, { sent: 4, failed: 0 });
  assert.match(h.sent.find((m) => m.to === "mm-alice")!.text, /请确认本功能需要哪些专业和交付项/);
  assert.ok(h.sent.some((m) => m.to === "mm-bob" && /已超过计划结束时间 2 天/.test(m.text)));
  h.clock.now += 5 * 60_000;
  assert.deepEqual((await live.tick()).delivered, { sent: 0, failed: 0 }, "nothing is sent twice");
});

test("the same reminder repeats the next Shanghai day and a failed delivery is retried", async (t) => {
  const h = await harness(t);
  let fail = true;
  const live = h.service(
    { ZQ_SCANNER: "1", ZQ_REMINDER_DELIVERY: "1" },
    {
      send: async (to, text) => {
        if (fail) throw new Error("mattermost down");
        h.sent.push({ to, text });
      },
    },
  );
  assert.deepEqual((await live.tick()).delivered, { sent: 0, failed: 4 });
  fail = false;
  h.clock.now += 5 * 60_000;
  assert.deepEqual((await live.tick()).delivered, { sent: 4, failed: 0 });
  h.clock.now = NOON_SHANGHAI + DAY;
  const next = await live.tick();
  assert.equal(next.scanned?.created, 4);
  assert.equal(await h.reminders.countForDay("mm-alice", "2026-11-15"), 1);
});

test("a configured ceiling stops further reminders for a person that day and is reported", async (t) => {
  const h = await harness(t);
  const out = (await h.service({ ZQ_SCANNER: "1", ZQ_REMINDER_DAILY_CEILING: "1" }).tick()).scanned!;
  assert.equal(await h.reminders.countForDay("mm-bob", DAY_KEY), 1);
  assert.equal(out.ceilingHit, 2);
});

test("scanning again on the same day creates nothing new and a ceiling never drops a reminder already stored", async (t) => {
  const h = await harness(t);
  const live = h.service({ ZQ_SCANNER: "1", ZQ_REMINDER_DAILY_CEILING: "1" });
  const first = (await live.tick()).scanned!;
  const stored = await h.reminders.countForDay("mm-bob", DAY_KEY);
  assert.deepEqual([first.created, stored, first.ceilingHit], [2, 1, 2]);
  h.clock.now += 5 * 60_000;
  const second = (await live.tick()).scanned!;
  assert.equal(second.created, 0);
  assert.equal(second.alreadyKnown, 2);
  assert.equal(second.ceilingHit, 2, "the same two stay held back, none is lost or duplicated");
  assert.equal(await h.reminders.countForDay("mm-bob", DAY_KEY), stored);
});

test("a ceiling counts per person and per day, so the held-back reminders are created the next day", async (t) => {
  const h = await harness(t);
  const live = h.service({ ZQ_SCANNER: "1", ZQ_REMINDER_DAILY_CEILING: "1" });
  await live.tick();
  h.clock.now = NOON_SHANGHAI + DAY;
  const next = (await live.tick()).scanned!;
  assert.equal(await h.reminders.countForDay("mm-bob", "2026-11-15"), 1);
  assert.equal(await h.reminders.countForDay("mm-alice", "2026-11-15"), 1);
  assert.equal(next.created, 2);
});

test("an unlinked recipient and a duty without holders are counted, not guessed", async (t) => {
  const h = await harness(t);
  const out = (
    await h
      .service(
        { ZQ_SCANNER: "1", ZQ_ESCALATION_DUTIES: "planning_lead" },
        { mmUserIdOfOpUser: async (id) => (id === "12" ? "mm-bob" : undefined) },
      )
      .tick()
  ).scanned!;
  assert.equal(out.unlinked, 1, "Alice's staffing question has nobody to reach");
  assert.equal(out.noHolder, 1, "planning_lead has no holder");
  assert.deepEqual(await ids(h, "mm-alice"), []);
});

test("a person whose OpenProject read fails is skipped without stopping the rest", async (t) => {
  const h = await harness(t, { alice: [1, 2, 20, 21, 22, 30, 50], bob: [20, 21, 22] });
  const failing = createMcpOpReader({
    call: async (tool, args, principalId) => {
      if (principalId === "internal:alice") throw new Error("token revoked");
      return h.oa.call(tool, args, principalId);
    },
    contract,
  });
  const out = await h.service({ ZQ_SCANNER: "1" }, { reader: failing }).tick();
  assert.deepEqual([out.scanned?.peopleScanned, out.scanned?.peopleFailed, out.scanned?.featuresSeen], [1, 1, 1]);
});

test("the group for a feature in the briefing stage is made once, only when every live order has an assignee", async () => {
  const feature = parseWork(
    detail(40, {
      type_key: "feature",
      status_key: "feature.briefing",
      planner: ALICE_OP,
      assignee: asUser(ALICE_OP),
      participants: [BOB_OP, CAROL_OP],
    }),
  );
  const ready = [
    parseWork(detail(41, { parent_id: 40, assignee: asUser(BOB_OP) })),
    parseWork(detail(42, { parent_id: 40, assignee: asUser(CAROL_OP) })),
    parseWork(detail(43, { parent_id: 40, lifecycle: "cancelled" })),
  ];
  const created: Array<{ feature: { id: number; subject: string; url?: string }; members: string[] }> = [];
  const run = async (children: typeof ready, groups = createZqGroups({ map: testMap<ZqGroup>() })) => {
    const report = await scanOnce({
      reader: {
        features: async () => ({ facts: [{ feature, children, meetings: [] }], problems: [] }),
        dutyHolders: async () => undefined,
      },
      contract,
      people: [ALICE],
      mmUserIdOfOpUser: async (id) => ({ ...MM_OF, "13": "mm-carol" })[id],
      reminders: createZqReminderStore({ map: testMap<ZqReminder>() }),
      groups: {
        store: groups,
        create: async (feature, members) => {
          created.push({ feature, members });
          return "channel-1";
        },
      },
      opBaseUrl: "https://op.example.com",
      mode: "live",
      now: NOON_SHANGHAI,
      timezone: "Asia/Shanghai",
      dailyCeiling: 100,
      escalation: { duties: [], afterDays: 2 },
    });
    return { report, groups };
  };
  assert.equal((await run([parseWork(detail(41, { parent_id: 40 })), ...ready.slice(1)])).report.groupsCreated, 0);
  const first = await run(ready);
  assert.equal(first.report.groupsCreated, 1);
  assert.deepEqual(created, [
    {
      feature: { id: 40, subject: "单40", url: "https://op.example.com/work_packages/40" },
      members: ["mm-alice", "mm-bob", "mm-carol"],
    },
  ]);
  assert.equal((await run(ready, first.groups)).report.groupsCreated, 0, "a second scan reuses the group");
  assert.equal(created.length, 1);
  assert.equal((await first.groups.get(40))?.groupRef, "channel-1");
});

test("the channel receipt is written to OpenProject once after the channel exists, retried while it fails, and never repeated", async () => {
  const feature = parseWork(
    detail(40, {
      type_key: "feature",
      status_key: "feature.briefing",
      planner: ALICE_OP,
      assignee: asUser(ALICE_OP),
      participants: [BOB_OP],
    }),
  );
  const children = [parseWork(detail(41, { parent_id: 40, assignee: asUser(BOB_OP) }))];
  const groups = createZqGroups({ map: testMap<ZqGroup>() });
  const remarks: Array<{ featureId: number; channelId: string; participantOpUserIds: string[] }> = [];
  let failing = true;
  const scan = () =>
    scanOnce({
      reader: {
        features: async () => ({ facts: [{ feature, children, meetings: [] }], problems: [] }),
        dutyHolders: async () => undefined,
      },
      contract,
      people: [ALICE],
      mmUserIdOfOpUser: async (id) => MM_OF[id],
      reminders: createZqReminderStore({ map: testMap<ZqReminder>() }),
      groups: {
        store: groups,
        create: async () => "channel-1",
        remark: async (input) => {
          if (failing) throw new Error("OpenProject is down");
          remarks.push(input);
        },
      },
      mode: "live",
      now: NOON_SHANGHAI,
      timezone: "Asia/Shanghai",
      dailyCeiling: 100,
      escalation: { duties: [], afterDays: 2 },
    });
  const first = await scan();
  assert.deepEqual([first.groupsCreated, first.remarkFailed], [1, 1]);
  assert.equal((await groups.get(40))?.remarkWritten, undefined);
  failing = false;
  assert.equal((await scan()).remarkFailed, 0);
  assert.deepEqual(remarks, [{ featureId: 40, channelId: "channel-1", participantOpUserIds: ["11", "12"] }]);
  await scan();
  assert.equal(remarks.length, 1);
  assert.equal((await groups.get(40))?.remarkWritten, true);
});

test("the receipt asks zq_add_system_remark for the one supported event, with an idempotency key OpenProject accepts (qm: prefix, 4 to 128 characters)", () => {
  const args = channelRemarkArgs({ featureId: 40, channelId: "channel-1", participantOpUserIds: ["11", "12"] });
  assert.deepEqual(args, {
    work_package_id: 40,
    kind: "channel_created",
    text: "QM 创建了功能讨论频道(channel-1),参与人 OpenProject 用户:#11、#12。",
    idempotency_key: "qm:mm:channel-created:40:channel-1",
    source: { kind: "qm", ref: "feature-channel:40" },
    confirm: true,
  });
  const key = String(args["idempotency_key"]);
  assert.match(key, /^qm:[A-Za-z0-9:._-]+$/);
  assert.ok(key.length >= 4 && key.length <= 128);
});

test("the scan schedule follows the cron in its timezone", () => {
  const start = Date.UTC(2026, 10, 14, 4, 1);
  assert.equal(scanIsDue("*/5 * * * *", "Asia/Shanghai", start, start + 3 * 60_000), false);
  assert.equal(scanIsDue("*/5 * * * *", "Asia/Shanghai", start, start + 4 * 60_000), true);
  assert.equal(scanIsDue("*/5 * * * *", "Asia/Shanghai", undefined, start), true);
});

test("the dedup day is the Shanghai calendar day", () => {
  assert.equal(dayKeyIn("Asia/Shanghai", Date.UTC(2026, 10, 14, 15, 59)), "2026-11-14");
  assert.equal(dayKeyIn("Asia/Shanghai", Date.UTC(2026, 10, 14, 16, 0)), "2026-11-15");
});
