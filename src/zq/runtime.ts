import type { DurableMap } from "../persistence/durable-map.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import type { Sweeper } from "../util/sweeper.ts";
import type { ZqConfig } from "./config.ts";
import { createZqIdentityMap, type ZqIdentityLink } from "./identity-map.ts";
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
}

export interface ZqRuntime {
  start(): void;
  stop(): Promise<void>;
  decide(op: "report" | "link", id: string, approve: boolean, clickerMmUserId: string): Promise<string>;
  connectorConnected(provider: string, principalId: string): Promise<void>;
}

export function createZqRuntime(deps: {
  config: ZqConfig;
  call: OpCall;
  chat: ZqChat;
  map: <T>(table: string) => DurableMap<T>;
  leaderLease: LeaderLease;
  createSweeper: (work: () => unknown, intervalMs: number, opts?: { label?: string }) => Sweeper;
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

  const service = createZqService({
    config,
    reader: createMcpOpReader({ call: deps.call, serverId: OPENPROJECT_SERVER }),
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
                { id: "approve", name: "Looks right", style: "good", op: "report", ref: draftId, approve: true },
                { id: "discard", name: "Discard", op: "report", ref: draftId, approve: false },
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
    start() {
      if (config.scanner.enabled || config.reports.enabled) sweeper.start();
    },
    stop: () => sweeper.stop(),
    async decide(op, id, approve, clickerMmUserId) {
      if (op === "report") {
        const draft = await reports.decide(id, approve, clickerMmUserId, clickerMmUserId);
        return draft.status === "confirmed" ? "Report confirmed." : "Report discarded.";
      }
      if (id !== clickerMmUserId) throw new Error("only the person being linked can answer this");
      if (!approve) {
        await identity.unlink(id);
        return "OpenProject account not linked.";
      }
      await identity.confirm(id, clickerMmUserId);
      return "OpenProject account linked.";
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
        await chat.sendButtons(mmUserId, `Link this Mattermost account to OpenProject user ${me.login}?`, [
          { id: "link", name: "Yes, that's me", style: "good", op: "link", ref: mmUserId, approve: true },
          { id: "unlink", name: "Not me", op: "link", ref: mmUserId, approve: false },
        ]);
    },
  };
}
