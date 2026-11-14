import type { DurableMap } from "../persistence/durable-map.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import type { Sweeper } from "../util/sweeper.ts";
import type { ZqConfig } from "./config.ts";
import { createZqIdentityMap, type ZqIdentityLink, type ZqIdentityMap } from "./identity-map.ts";
import { loadZqContract } from "./config.ts";
import type { ZqContract } from "./contract.ts";
import { createZqGroups, type ZqGroup } from "./groups.ts";
import { createMcpOpReader, type OpCall } from "./op-reader.ts";
import { createZqReminderStore, type ZqReminder } from "./reminders.ts";
import { createZqReports, type ReportInput, type ZqReportDraft } from "./reports.ts";
import type { ScanPerson } from "./scanner.ts";
import { createZqService, type ZqRunState } from "./service.ts";

const TICK_MS = 60_000;
const OPENPROJECT_SERVER = "openproject";

export interface ZqChat {
  sendDm(mmUserId: string, text: string): Promise<void>;
  sendButtons(
    mmUserId: string,
    text: string,
    buttons: Array<{
      id: string;
      name: string;
      style?: "primary" | "danger" | "good" | "default";
      op: "report" | "link";
      ref: string;
      approve: boolean;
    }>,
  ): Promise<void>;
  mmUserIdOf(principalId: string): Promise<string | undefined>;
  principalOf(mmUserId: string): Promise<string | undefined>;
  createGroup?(name: string, memberMmUserIds: string[]): Promise<string>;
}

export type ZqIdentityAdmin = Pick<ZqIdentityMap, "enabled" | "list" | "confirm" | "unlink">;

export interface ZqRuntime {
  identityAdmin: ZqIdentityAdmin;
  start(): void;
  stop(): Promise<void>;
  decide(op: "report" | "link", id: string, approve: boolean, clickerMmUserId: string): Promise<string>;
  connectorConnected(provider: string, principalId: string): Promise<void>;
}

const noReader = {
  features: async () => [],
  dutyHolders: async () => undefined,
};

export function createZqRuntime(deps: {
  config: ZqConfig;
  call: OpCall;
  chat: ZqChat;
  map: <T>(table: string) => DurableMap<T>;
  leaderLease: LeaderLease;
  createSweeper: (work: () => unknown, intervalMs: number, opts?: { label?: string }) => Sweeper;
  contract?: ZqContract;
  reportSource?: (
    person: ScanPerson,
    period: ReportInput["period"],
    since: number,
    until: number,
  ) => Promise<ReportInput>;
}): ZqRuntime {
  const { config, chat } = deps;
  const identity = createZqIdentityMap({
    map: deps.map<ZqIdentityLink>("zq_identity_map"),
    enabled: config.identityMap,
  });
  const reminders = createZqReminderStore({ map: deps.map<ZqReminder>("zq_reminders") });
  const reports = createZqReports({
    map: deps.map<ZqReportDraft>("zq_report_drafts"),
    write: undefined,
    writeBack: async () => {},
  });

  async function people(): Promise<ScanPerson[]> {
    const links = (await deps.map<ZqIdentityLink>("zq_identity_map").all()).filter((l) => l.status === "confirmed");
    const resolved = await Promise.all(
      links.map(async (link) => {
        const principalId = await chat.principalOf(link.mmUserId);
        return principalId
          ? [{ mmUserId: link.mmUserId, principalId, opUserId: link.opUserId, opName: link.opName ?? link.opLogin }]
          : [];
      }),
    );
    return resolved.flat();
  }

  const contract = deps.contract ?? (config.contractFile ? loadZqContract(config.contractFile) : undefined);
  const groups = chat.createGroup
    ? { store: createZqGroups({ map: deps.map<ZqGroup>("zq_groups") }), create: chat.createGroup }
    : undefined;

  const service = createZqService({
    config,
    ...(contract
      ? { contract, reader: createMcpOpReader({ call: deps.call, contract, serverId: OPENPROJECT_SERVER }) }
      : { reader: noReader }),
    mmUserIdOfOpUser: async (opUserId) => (await identity.byOpenProject(opUserId))?.mmUserId,
    ...(groups ? { groups } : {}),
    people,
    reminders,
    state: deps.map<ZqRunState>("zq_run_state"),
    send: (to, text) => chat.sendDm(to, text),
    ...(config.reports.enabled && deps.reportSource
      ? {
          reports: {
            store: reports,
            source: { build: deps.reportSource },
            sendCard: (to: string, draftId: string, text: string) =>
              chat.sendButtons(to, text, [
                { id: "approve", name: "没问题,提交", style: "good", op: "report", ref: draftId, approve: true },
                { id: "discard", name: "放弃", op: "report", ref: draftId, approve: false },
              ]),
          },
        }
      : {}),
  });

  const sweeper = deps.createSweeper(
    () =>
      deps.leaderLease.hold("zq:scanner", async () => {
        await service.tick();
      }),
    TICK_MS,
    { label: "zq scanner" },
  );

  return {
    identityAdmin: identity,
    start() {
      if (config.scanner.enabled || config.reports.enabled) sweeper.start();
    },
    stop: () => sweeper.stop(),
    async decide(op, id, approve, clickerMmUserId) {
      if (op === "report") {
        const draft = await reports.decide(id, approve, clickerMmUserId, clickerMmUserId);
        return draft.status === "confirmed" ? "已确认日报。" : "已放弃这份草稿。";
      }
      if (id !== clickerMmUserId) throw new Error("只有被关联的本人可以回答");
      if (!approve) {
        await identity.unlink(id);
        return "已取消,没有关联 OpenProject 账号。";
      }
      await identity.confirm(id, clickerMmUserId);
      return "已关联 OpenProject 账号。";
    },
    async connectorConnected(provider, principalId) {
      if (!config.identityMap || provider !== OPENPROJECT_SERVER) return;
      const mmUserId = await chat.mmUserIdOf(principalId);
      if (!mmUserId) return;
      const text = await deps.call(`${OPENPROJECT_SERVER}_get_current_user`, {}, principalId);
      const me = JSON.parse(text) as { id?: unknown; login?: unknown; name?: unknown };
      if (typeof me.login !== "string" || (typeof me.id !== "string" && typeof me.id !== "number")) return;
      const link = await identity.propose({
        mmUserId,
        opUserId: String(me.id),
        opLogin: me.login,
        ...(typeof me.name === "string" ? { opName: me.name } : {}),
        source: "signin",
        proposedBy: principalId,
      });
      if (link.status === "pending")
        await chat.sendButtons(mmUserId, `把这个 Mattermost 账号关联到 OpenProject 用户 ${me.login} 吗?`, [
          { id: "link", name: "是我本人", style: "good", op: "link", ref: mmUserId, approve: true },
          { id: "unlink", name: "不是我", op: "link", ref: mmUserId, approve: false },
        ]);
    },
  };
}
