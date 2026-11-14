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
import { createMcpOpReader } from "../src/zq/op-reader.ts";
import { createZqReminderStore, type ZqReminder } from "../src/zq/reminders.ts";
import { dayKeyIn, scanIsDue, type ScanPerson } from "../src/zq/scanner.ts";
import { createZqService, type ZqRunState } from "../src/zq/service.ts";
import { loopbackFetch, startMcpTestServer, type McpTestServer } from "./support/mcp-test-server.ts";
import { testMap } from "./support/test-database.ts";

const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/openproject-mcp-tools.json", import.meta.url), "utf8"),
) as { tools: Tool[] };
const contract = JSON.parse(
  readFileSync(new URL("./fixtures/openproject-tool-contract.json", import.meta.url), "utf8"),
) as McpToolContract;

const DAY = 86_400_000;
const NOON_SHANGHAI = Date.UTC(2026, 10, 14, 4, 0);
const iso = (ms: number) => new Date(ms).toISOString();

const ALICE: ScanPerson = { mmUserId: "mm-alice", principalId: "internal:alice", opName: "Alice A" };
const BOB: ScanPerson = { mmUserId: "mm-bob", principalId: "internal:bob", opName: "Bob B" };

function wp(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    subject: `Task ${id}`,
    status: "fm.in_progress",
    updated_at: iso(NOON_SHANGHAI - DAY),
    assignee: "Alice A",
    custom_fields: {},
    ...over,
  };
}

const ALICE_WPS = [
  wp(7, { updated_at: iso(NOON_SHANGHAI - 6 * DAY) }),
  wp(8, { status: "fm.qa", updated_at: iso(NOON_SHANGHAI - 6 * DAY), custom_fields: { review_result: "pass" } }),
  wp(9, { status: "qa.closed", updated_at: iso(NOON_SHANGHAI - 30 * DAY) }),
  wp(10, { status: "pm.in_progress", due_date: iso(NOON_SHANGHAI - 2 * DAY), updated_at: iso(NOON_SHANGHAI - DAY) }),
  wp(11, { updated_at: iso(NOON_SHANGHAI - 8 * DAY) }),
  wp(12, { assignee: "Someone Else", updated_at: iso(NOON_SHANGHAI - 9 * DAY) }),
];

const BOB_MEETINGS = [
  { id: "m1", title: "Weekly sync", end_time: iso(NOON_SHANGHAI - 20 * 60_000), state: "open", organizer: "Bob B" },
  { id: "m2", title: "Closed sync", end_time: iso(NOON_SHANGHAI - 3 * 3_600_000), state: "closed", organizer: "Bob B" },
  { id: "m3", title: "Just ended", end_time: iso(NOON_SHANGHAI - 5 * 60_000), state: "open", organizer: "Bob B" },
  { id: "m4", title: "Alice's meeting", end_time: iso(NOON_SHANGHAI - 3_600_000), state: "open", organizer: "Alice A" },
];

interface Harness {
  mcp: McpTestServer;
  oa: McpToolService;
  sent: Array<{ to: string; text: string }>;
  reminders: ReturnType<typeof createZqReminderStore>;
  state: ReturnType<typeof testMap<ZqRunState>>;
  clock: { now: number };
  service: (env: NodeJS.ProcessEnv) => ReturnType<typeof createZqService>;
}

async function harness(t: { after(fn: () => unknown): void }): Promise<Harness> {
  const mcp = await startMcpTestServer(t as Parameters<typeof startMcpTestServer>[0], {
    tools: recorded.tools,
    call: (name, _args, authorization) => {
      const bodies: Record<string, unknown> = {
        "Bearer alice-token": { list_work_packages: { work_packages: ALICE_WPS }, list_meetings: { meetings: [] } },
        "Bearer bob-token": { list_work_packages: { work_packages: [] }, list_meetings: { meetings: BOB_MEETINGS } },
      };
      const body = (bodies[authorization ?? ""] as Record<string, unknown> | undefined)?.[name] ?? {};
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
    toolContract: contract,
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
  const reader = createMcpOpReader({ call: (tool, args, principalId) => oa.call(tool, args, principalId) });
  return {
    mcp,
    oa,
    sent,
    reminders,
    state,
    clock,
    service: (env) =>
      createZqService({
        config: zqConfigFromEnv(env),
        reader,
        people: async () => [ALICE, BOB],
        reminders,
        state,
        send: async (to, text) => void sent.push({ to, text }),
        now: () => clock.now,
      }),
  };
}

test("everything stays off unless switched on", async (t) => {
  const h = await harness(t);
  const before = h.mcp.requests.length;
  const out = await h.service({}).tick();
  assert.deepEqual(out, { reportsSent: 0 });
  assert.equal(h.mcp.requests.length, before, "no OpenProject calls while the scanner is off");
  assert.equal(await h.state.get("scanner"), null);
});

test("a dry-run scan stores what it would send, reads as each person, sends nothing, and is idempotent", async (t) => {
  const h = await harness(t);
  const service = h.service({ ZQ_SCANNER: "1" });
  const out = await service.tick();
  assert.deepEqual(
    { ...out.scanned, mode: undefined },
    {
      mode: undefined,
      peopleScanned: 2,
      peopleFailed: 0,
      workPackagesSeen: 5,
      meetingsSeen: 3,
      created: 4,
      alreadyKnown: 0,
      cappedOut: 1,
      unassigned: 0,
    },
  );
  assert.equal(out.scanned?.mode, "dry-run");
  assert.equal(out.delivered, undefined);
  assert.deepEqual(h.sent, []);

  const authorizations = new Set(
    h.mcp.requests.filter((r) => r.rpc?.startsWith("tools/call")).map((r) => r.authorization),
  );
  assert.ok(authorizations.has("Bearer alice-token") && authorizations.has("Bearer bob-token"));

  const aliceCount = await h.reminders.countForDay("mm-alice", "2026-11-14");
  const bobCount = await h.reminders.countForDay("mm-bob", "2026-11-14");
  assert.equal(aliceCount, 3, "the daily cap holds");
  assert.equal(bobCount, 1);
  const bob = await h.reminders.pendingFor("mm-bob");
  assert.deepEqual(
    bob.map((r) => [r.id, r.mode, r.kind]),
    [["meeting:m1:follow-up", "dry-run", "meeting-follow-up"]],
  );
  const alice = await h.reminders.pendingFor("mm-alice");
  assert.ok(alice.every((r) => r.mode === "dry-run"));
  assert.ok(alice.some((r) => r.subjectId === "wp:8" && r.blockers.join() === "qa_result"));
  assert.equal(await h.reminders.has("wp:9:stale:0"), false, "closed work is left alone");
  assert.equal(await h.reminders.lastLiveAt("wp:12"), undefined, "someone else's work is not Alice's reminder");

  assert.deepEqual(
    (await service.tick()).scanned,
    undefined,
    "the next tick inside the same 5 minutes does not rescan",
  );
  h.clock.now += 5 * 60_000;
  const again = (await service.tick()).scanned!;
  assert.equal(again.created, 1, "the meeting that had just ended is now past its grace period");
  assert.equal(await h.reminders.has("meeting:m3:follow-up"), true);
  assert.equal(again.alreadyKnown, 4);
});

test("going live delivers the stored reminders by Mattermost DM with the exit-blocker names", async (t) => {
  const h = await harness(t);
  await h.service({ ZQ_SCANNER: "1" }).tick();
  h.clock.now += 5 * 60_000;
  const live = h.service({ ZQ_SCANNER: "1", ZQ_REMINDER_DELIVERY: "1" });
  const out = await live.tick();
  assert.equal(out.scanned?.mode, "live");
  assert.deepEqual(out.delivered, { sent: 5, failed: 0 });
  assert.equal(h.sent.filter((m) => m.to === "mm-alice").length, 3);
  const qa = h.sent.find((m) => m.text.includes("wp:8"));
  assert.match(qa!.text, /Fill in before moving it on: qa_result/);
  assert.match(h.sent.find((m) => m.to === "mm-bob")!.text, /Weekly sync/);
  h.clock.now += 5 * 60_000;
  assert.deepEqual((await live.tick()).delivered, { sent: 0, failed: 0 }, "nothing is sent twice");
});

test("the cap resets with the Shanghai calendar day and a failed delivery is retried", async (t) => {
  const h = await harness(t);
  let fail = true;
  const live = createZqService({
    config: zqConfigFromEnv({ ZQ_SCANNER: "1", ZQ_REMINDER_DELIVERY: "1" }),
    reader: createMcpOpReader({ call: (tool, args, principalId) => h.oa.call(tool, args, principalId) }),
    people: async () => [ALICE],
    reminders: h.reminders,
    state: h.state,
    send: async (to, text) => {
      if (fail) throw new Error("mattermost down");
      h.sent.push({ to, text });
    },
    now: () => h.clock.now,
  });
  const first = await live.tick();
  assert.deepEqual(first.delivered, { sent: 0, failed: 3 });
  fail = false;
  h.clock.now += 5 * 60_000;
  assert.deepEqual((await live.tick()).delivered, { sent: 3, failed: 0 });
  h.clock.now = NOON_SHANGHAI + 3 * DAY;
  const nextDay = (await live.tick()).scanned!;
  assert.equal(await h.reminders.countForDay("mm-alice", "2026-11-17"), nextDay.created);
  assert.ok(nextDay.created >= 1 && nextDay.created <= 3);
});

test("a person whose OpenProject read fails is skipped without stopping the rest", async (t) => {
  const h = await harness(t);
  const out = await createZqService({
    config: zqConfigFromEnv({ ZQ_SCANNER: "1" }),
    reader: createMcpOpReader({
      call: async (tool, args, principalId) => {
        if (principalId === "internal:alice") throw new Error("token revoked");
        return h.oa.call(tool, args, principalId);
      },
    }),
    people: async () => [ALICE, BOB],
    reminders: h.reminders,
    state: h.state,
    send: async () => {},
    now: () => h.clock.now,
  }).tick();
  assert.deepEqual([out.scanned?.peopleScanned, out.scanned?.peopleFailed, out.scanned?.created], [1, 1, 1]);
});

test("the scan schedule follows the cron in its timezone", () => {
  const start = Date.UTC(2026, 10, 14, 4, 1);
  assert.equal(scanIsDue("*/5 * * * *", "Asia/Shanghai", start, start + 3 * 60_000), false);
  assert.equal(scanIsDue("*/5 * * * *", "Asia/Shanghai", start, start + 4 * 60_000), true);
  assert.equal(
    scanIsDue("0 9 * * *", "Asia/Shanghai", Date.UTC(2026, 10, 14, 0, 30), Date.UTC(2026, 10, 14, 0, 59)),
    false,
  );
  assert.equal(
    scanIsDue("0 9 * * *", "Asia/Shanghai", Date.UTC(2026, 10, 14, 0, 30), Date.UTC(2026, 10, 14, 1, 0)),
    true,
  );
  assert.equal(scanIsDue("*/5 * * * *", "Asia/Shanghai", undefined, start), true);
});

test("invalid scanner settings are refused at startup", () => {
  assert.throws(() => zqConfigFromEnv({ ZQ_SCANNER_CRON: "nonsense" }), /ZQ_SCANNER_CRON/);
  assert.throws(() => zqConfigFromEnv({ ZQ_SCANNER_TZ: "Mars/Base" }), /ZQ_SCANNER_TZ/);
  assert.throws(() => zqConfigFromEnv({ ZQ_REMINDER_DAILY_CAP: "0" }), /ZQ_REMINDER_DAILY_CAP/);
  const c = zqConfigFromEnv({});
  assert.deepEqual(
    [c.scanner, c.deliverReminders, c.reminderDailyCap, c.identityMap, c.reports.enabled],
    [{ enabled: false, cron: "*/5 * * * *", timezone: "Asia/Shanghai" }, false, 3, false, false],
  );
});

test("the daily cap uses the Shanghai calendar day", () => {
  assert.equal(dayKeyIn("Asia/Shanghai", Date.UTC(2026, 10, 14, 15, 59)), "2026-11-14");
  assert.equal(dayKeyIn("Asia/Shanghai", Date.UTC(2026, 10, 14, 16, 0)), "2026-11-15");
});
