import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { privateDecrypt, constants } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { createZqChanges, type ZqChangeCursor, type ZqChangeLine, type ZqSnapshot } from "../src/zq/changes.ts";
import { parseContract } from "../src/zq/contract.ts";
import { createZqGroups, type ZqGroup } from "../src/zq/groups.ts";
import { createMcpOpReader } from "../src/zq/op-reader.ts";
import { createReportSource } from "../src/zq/report-source.ts";
import { createZqReminderStore, type ZqReminder } from "../src/zq/reminders.ts";
import { createZqReports, type ZqReportDraft } from "../src/zq/reports.ts";
import { createRoleplay, type RoleplayPersona } from "../src/zq/roleplay.ts";
import type { ScanPerson } from "../src/zq/scanner.ts";
import { createZqService, type ZqRunState } from "../src/zq/service.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const need = (name: string): string => {
  const v = arg(name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
};

const DAY = 86_400_000;
const mcpUrl = need("mcp");
const projects = need("projects");
const jellyOpUser = need("jelly-op-user");
const outFile = need("out");
const stateFile = arg("state");
const contractFile = arg("contract") ?? new URL("../test/fixtures/zq-contract-keys.json", import.meta.url).pathname;

function token(): string {
  const encrypted = arg("token-file");
  if (!encrypted) {
    const env = process.env["ZQ_TEST_TOKEN"];
    if (!env) throw new Error("give --token-file with --key, or ZQ_TEST_TOKEN");
    return env;
  }
  const plain = privateDecrypt(
    { key: readFileSync(need("key"), "utf8"), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(readFileSync(encrypted, "utf8").trim(), "base64"),
  );
  return plain.toString("utf8").trim();
}

function memoryMap<T>(name: string, saved: Record<string, Record<string, T>>): DurableMap<T> {
  const rows = new Map<string, T>(Object.entries(saved[name] ?? {}));
  saved[name] = Object.fromEntries(rows);
  const sync = () => void (saved[name] = Object.fromEntries(rows));
  const api = {
    all: async () => [...rows.values()],
    entries: async () => [...rows.entries()],
    select: async (query: { where?: { field: string; anyOfFold: readonly string[] } }) => {
      const wanted = query.where?.anyOfFold.map((v) => v.toLowerCase());
      return [...rows.values()].filter((row) => {
        if (!query.where || !wanted) return true;
        const value = (row as Record<string, unknown>)[query.where.field];
        return typeof value === "string" && wanted.includes(value.toLowerCase());
      });
    },
    get: async (id: string) => rows.get(id) ?? null,
    put: async (id: string, v: T) => void (rows.set(id, v), sync()),
    putIfAbsent: async (id: string, v: T) => {
      if (!rows.has(id)) rows.set(id, v);
      sync();
      return rows.get(id)!;
    },
    insertIfAbsent: async (id: string, v: T) => {
      if (rows.has(id)) return false;
      rows.set(id, v);
      sync();
      return true;
    },
    merge: async (id: string, patch: Partial<T>) => {
      const cur = rows.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      rows.set(id, next);
      sync();
      return next;
    },
    update: async (id: string, fn: (v: T) => T) => {
      const cur = rows.get(id);
      if (!cur) return null;
      const next = fn(cur);
      rows.set(id, next);
      sync();
      return next;
    },
    deleteIf: async (id: string, pred: (v: T) => boolean) => {
      const cur = rows.get(id);
      if (!cur || !pred(cur)) return false;
      rows.delete(id);
      sync();
      return true;
    },
    delete: async (id: string) => void (rows.delete(id), sync()),
    take: async (id: string) => {
      const cur = rows.get(id) ?? null;
      rows.delete(id);
      sync();
      return cur;
    },
  };
  return api as unknown as DurableMap<T>;
}

const saved: Record<string, Record<string, unknown>> = stateFile && existsSync(stateFile)
  ? (JSON.parse(readFileSync(stateFile, "utf8")) as typeof saved)
  : {};
const maps = new Map<string, unknown>();
const map = <T>(name: string): DurableMap<T> => {
  if (!maps.has(name)) maps.set(name, memoryMap<T>(name, saved as Record<string, Record<string, T>>));
  return maps.get(name) as DurableMap<T>;
};

const raw = JSON.parse(readFileSync(contractFile, "utf8")) as Record<string, unknown>;
const contract = parseContract({
  ...raw,
  optimizationType: raw["optimizationType"] ?? "optimization",
  fields: { ...(raw["fields"] as object), completionSubmitted: "delivery_result" },
});

const client = new Client({ name: "zq-roleplay-report", version: "1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token()}` } },
  }),
);
const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const result = await client.callTool({ name: name.replace(/^openproject_/, ""), arguments: args });
  const parts = (result["content"] as Array<{ type: string; text?: string }> | undefined) ?? [];
  return parts.flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("\n");
};

const JELLY = "jelly-test";
const person: ScanPerson = { mmUserId: JELLY, principalId: "internal:jelly", opUserId: jellyOpUser, opName: "jelly" };
const outbox: Array<{ kind: string; to: string; text: string }> = [];
const roleplay = createRoleplay({
  mmUserId: JELLY,
  projectIds: projects.split(","),
  contract,
  personas: map<RoleplayPersona>("personas"),
  reminders: map<ZqReminder>("reminders"),
  groups: map<ZqGroup>("groups"),
  features: map<{ featureId: number }>("features"),
  snapshots: map<ZqSnapshot>("snapshots"),
  lines: map<ZqChangeLine>("lines"),
  cursors: map<ZqChangeCursor>("cursors"),
});
const chat = roleplay.chat({
  sendDm: async (to: string, text: string) => void outbox.push({ kind: "私信", to, text }),
  sendButtons: async (to: string, text: string) => void outbox.push({ kind: "按钮卡", to, text }),
  createGroup: async (feature: { id: number; subject: string }) => {
    outbox.push({
      kind: "建群",
      to: JELLY,
      text: `群名:【角色扮演】${feature.subject}(功能 #${feature.id}),成员:jelly + QM`,
    });
    return `chan-${feature.id}`;
  },
  postToChannel: async (channel: string, text: string) =>
    void outbox.push({ kind: `群消息(${channel})`, to: JELLY, text }),
});

const reader = roleplay.reader(createMcpOpReader({ call, contract }));
const env = {
  ZQ_SCANNER: "1",
  ZQ_REMINDER_DELIVERY: "1",
  ZQ_CONTRACT_FILE: contractFile,
  ZQ_REPORTS: "1",
  ZQ_REPORT_DAILY_AT: "09:00",
  ZQ_REPORT_WEEKLY_AT: "09:00",
  ZQ_ROLEPLAY_MM_USER: JELLY,
  ZQ_ROLEPLAY_PROJECTS: projects,
};
const clock = { now: Date.now() };
const reports = createZqReports({
  map: map<ZqReportDraft>("report_drafts"),
  write: undefined,
  writeBack: async () => {},
});
const serviceWith = (scanner: boolean) =>
  createZqService({
    config: zqConfigFromEnv(scanner ? env : { ...env, ZQ_SCANNER: "", ZQ_REMINDER_DELIVERY: "" }),
    contract,
    reader,
    mmUserIdOfOpUser: roleplay.mmUserIdOfOpUser,
    people: async () => roleplay.people([person]),
    groups: { store: createZqGroups({ map: map<ZqGroup>("groups") }), create: chat.createGroup! },
    changes: {
      store: createZqChanges({
        snapshots: map<ZqSnapshot>("snapshots"),
        lines: map<ZqChangeLine>("lines"),
        cursors: map<ZqChangeCursor>("cursors"),
      }),
      channel: chat.postToChannel!,
      lineLabel: roleplay.lineLabel,
    },
    reminders: createZqReminderStore({ map: map<ZqReminder>("reminders") }),
    state: map<ZqRunState>("run_state"),
    send: chat.sendDm,
    reports: {
      store: reports,
      source: { build: createReportSource({ reader, call, contract, timezone: "Asia/Shanghai" }) },
      sendCard: (to, _id, text) => chat.sendButtons(to, text),
    },
    now: () => clock.now,
    sendRetryDelayMs: 0,
  });

const realNow = Date.now();
const problems: string[] = [];
for (const [at, service] of [
  [realNow - 8 * DAY, serviceWith(false)],
  [realNow, serviceWith(true)],
] as const) {
  clock.now = at;
  try {
    const out = await service.tick();
    if (out.scanned?.problemSamples.length) problems.push(...out.scanned.problemSamples);
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
}
await client.close();
if (stateFile) writeFileSync(stateFile, JSON.stringify(saved));

const lines = [
  `# 角色扮演消息清单`,
  ``,
  `生成时间:${new Date(realNow).toISOString()};项目:${projects};共 ${outbox.length} 条。所有消息只会发给 jelly 一人,下面是它们的完整内容。`,
  ``,
  ...outbox.flatMap((m, i) => [`## ${i + 1}. ${m.kind}`, ``, "```", m.text, "```", ``]),
  ...(problems.length ? [`## 读取问题`, ``, ...[...new Set(problems)].map((p) => `- ${p}`)] : []),
];
writeFileSync(outFile, lines.join("\n"));
console.log(`${outbox.length} messages written to ${outFile}`);
