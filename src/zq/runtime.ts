import type { DurableMap } from "../persistence/durable-map.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import type { Sweeper } from "../util/sweeper.ts";
import type { ZqConfig } from "./config.ts";
import { createZqChildren, type ZqChildDraft, type ZqChildren } from "./children.ts";
import { createZqChanges, type ZqChangeCursor, type ZqChangeLine, type ZqSnapshot } from "./changes.ts";
import { createAuthorResolver, type AuthorResolver } from "./git/authors.ts";
import { createGitAudit, type GitAuditRow } from "./git/audit.ts";
import { createGitLimits } from "./git/limits.ts";
import { createGitReadonly, type GitReadonly } from "./git/readonly.ts";
import { createGitRunner, keyFileFrom } from "./git/runner.ts";
import { createZqIdentityMap, type ZqIdentityLink, type ZqIdentityMap } from "./identity-map.ts";
import { loadZqContract } from "./config.ts";
import { checkConfiguredDuties, type ZqContract } from "./contract.ts";
import { channelRemarkArgs, createZqGroups, type ZqGroup } from "./groups.ts";
import { createMcpOpReader, type OpCall } from "./op-reader.ts";
import { createZqReminderStore, type ZqReminder } from "./reminders.ts";
import { createRoleplay, type RoleplayPersona } from "./roleplay.ts";
import { createZqReports, type ZqReportDraft } from "./reports.ts";
import { createReportSource } from "./report-source.ts";
import type { ScanPerson, ZqFeatureRef } from "./scanner.ts";
import { createZqService, type ZqRunState } from "./service.ts";

const TICK_MS = 60_000;
export const GIT_KEY_SLUG = "gitlab-qm-readonly-key";
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
      op: "report" | "link" | "children";
      ref: string;
      approve: boolean;
    }>,
  ): Promise<void>;
  mmUserIdOf(principalId: string): Promise<string | undefined>;
  principalOf(mmUserId: string): Promise<string | undefined>;
  mmUserIdsOfEmail?(email: string): Promise<string[]>;
  createGroup?(feature: ZqFeatureRef, memberMmUserIds: string[]): Promise<string>;
  postToChannel?(channelId: string, text: string): Promise<void>;
}

export type ZqIdentityAdmin = Pick<ZqIdentityMap, "enabled" | "list" | "confirm" | "unlink">;

export interface ZqRuntime {
  identityAdmin: ZqIdentityAdmin;
  start(): void;
  stop(): Promise<void>;
  children?: Pick<ZqChildren, "propose">;
  git?: GitReadonly;
  commitAuthors?: AuthorResolver;
  decide(op: "report" | "link" | "children", id: string, approve: boolean, clickerMmUserId: string): Promise<string>;
  connectorConnected(provider: string, principalId: string): Promise<void>;
  roleplayReset?: () => Promise<Record<string, number>>;
}

const noReader = {
  features: async () => ({ facts: [], problems: [] }),
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
  readKey?: () => Promise<string>;
  now?: () => number;
}): ZqRuntime {
  const { config } = deps;
  const identity = createZqIdentityMap({
    map: deps.map<ZqIdentityLink>("zq_identity_map"),
    enabled: config.identityMap,
  });
  const reminders = createZqReminderStore({ map: deps.map<ZqReminder>("zq_reminders") });
  const reportDrafts = deps.map<ZqReportDraft>("zq_report_drafts");
  const reports = createZqReports({
    map: reportDrafts,
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
    const all = resolved.flat();
    return roleplay ? roleplay.people(all) : all;
  }

  const contract = deps.contract ?? (config.contractFile ? loadZqContract(config.contractFile) : undefined);
  if (contract)
    checkConfiguredDuties(contract, {
      ZQ_ESCALATION_DUTIES: config.escalation.duties,
      ZQ_UNSET_RESPONSIBILITY_DUTIES: config.unsetResponsibilityDuties,
    });
  const roleplay = config.roleplay
    ? createRoleplay({
        ...config.roleplay,
        ...(contract ? { contract } : {}),
        personas: deps.map<RoleplayPersona>("zq_roleplay_personas"),
        reminders: deps.map<ZqReminder>("zq_reminders"),
        groups: deps.map<ZqGroup>("zq_groups"),
        features: deps.map<{ featureId: number }>("zq_roleplay_features"),
        snapshots: deps.map<ZqSnapshot>("zq_snapshots"),
        lines: deps.map<ZqChangeLine>("zq_change_lines"),
        cursors: deps.map<ZqChangeCursor>("zq_change_cursors"),
      })
    : undefined;
  const chat = roleplay ? roleplay.chat(deps.chat) : deps.chat;
  const remarkWriter =
    (tool: string, principalId: string) =>
    async (input: { featureId: number; channelId: string; participantOpUserIds: string[] }) => {
      const text = await deps.call(`${OPENPROJECT_SERVER}_${tool}`, channelRemarkArgs(input), principalId);
      const error = (JSON.parse(text) as { error?: { code?: string } }).error;
      if (error) throw new Error(`OpenProject refused the channel remark: ${error.code ?? "error"}`);
    };
  const groups =
    config.featureChannels && chat.createGroup
      ? {
          store: createZqGroups({ map: deps.map<ZqGroup>("zq_groups") }),
          create: chat.createGroup.bind(chat),
          ...(contract?.tools.addSystemRemark && config.remarkPrincipal
            ? { remark: remarkWriter(contract.tools.addSystemRemark, config.remarkPrincipal) }
            : {}),
        }
      : undefined;

  const changes =
    config.changeDigest && chat.postToChannel
      ? {
          store: createZqChanges({
            snapshots: deps.map<ZqSnapshot>("zq_snapshots"),
            lines: deps.map<ZqChangeLine>("zq_change_lines"),
            cursors: deps.map<ZqChangeCursor>("zq_change_cursors"),
          }),
          channel: chat.postToChannel.bind(chat),
          ...(roleplay ? { lineLabel: roleplay.lineLabel } : {}),
        }
      : undefined;

  const mcpReader = contract
    ? createMcpOpReader({ call: deps.call, contract, serverId: OPENPROJECT_SERVER })
    : undefined;
  const reader = mcpReader && roleplay ? roleplay.reader(mcpReader) : mcpReader;
  const reportSource =
    reader && contract
      ? createReportSource({
          reader,
          call: deps.call,
          contract,
          timezone: config.scanner.timezone,
          serverId: OPENPROJECT_SERVER,
        })
      : undefined;

  const service = createZqService({
    config,
    ...(contract && reader ? { contract, reader } : { reader: noReader }),
    mmUserIdOfOpUser: roleplay
      ? roleplay.mmUserIdOfOpUser
      : async (opUserId) => (await identity.byOpenProject(opUserId))?.mmUserId,
    ...(groups ? { groups } : {}),
    ...(changes ? { changes } : {}),
    people,
    reminders,
    state: deps.map<ZqRunState>("zq_run_state"),
    send: (to, text) => chat.sendDm(to, text),
    ...(config.reports.enabled && reportSource
      ? {
          reports: {
            store: reports,
            source: { build: reportSource },
            sendCard: (to: string, draftId: string, text: string) =>
              chat.sendButtons(to, text, [
                { id: "approve", name: "没问题,提交", style: "good", op: "report", ref: draftId, approve: true },
                { id: "discard", name: "放弃", op: "report", ref: draftId, approve: false },
              ]),
          },
        }
      : {}),
  });

  const children =
    config.childOrders && contract
      ? createZqChildren({
          map: deps.map<ZqChildDraft>("zq_child_drafts"),
          call: (tool, args, principalId) => deps.call(`${OPENPROJECT_SERVER}_${tool}`, args, principalId),
          mmUserIdOf: (principalId) => chat.mmUserIdOf(principalId),
          ...(contract.tools.createChildOrders ? { tool: contract.tools.createChildOrders } : {}),
          sendCard: (to, draftId, text) =>
            chat.sendButtons(to, text, [
              { id: "approve", name: "确认创建", style: "good", op: "children", ref: draftId, approve: true },
              { id: "discard", name: "放弃", op: "children", ref: draftId, approve: false },
            ]),
        })
      : undefined;

  const git = config.git.enabled ? buildGit() : undefined;

  function buildGit(): GitReadonly {
    const { dir, knownHosts, remotes, limits, fetchTimeoutMs } = config.git;
    if (!dir) throw new Error("ZQ_GIT_READONLY needs ZQ_GIT_DIR (the bare clone directory)");
    if (!deps.readKey) throw new Error("ZQ_GIT_READONLY needs access to the keychain key");
    const now = deps.now ?? Date.now;
    const audit = createGitAudit({ map: deps.map<GitAuditRow>("zq_git_audit"), now });
    return createGitReadonly({
      config: { dir, remotes, fetchTimeoutMs },
      runner: createGitRunner({ withKeyFile: keyFileFrom(deps.readKey), ...(knownHosts ? { knownHosts } : {}) }),
      audit,
      limits: createGitLimits({ config: limits, bytesSince: audit.bytesSince, now }),
      now,
    });
  }

  const commitAuthors =
    git && chat.mmUserIdsOfEmail
      ? createAuthorResolver({ mmUserIdsOfEmail: chat.mmUserIdsOfEmail.bind(chat) })
      : undefined;

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
    ...(children ? { children } : {}),
    ...(git ? { git } : {}),
    ...(roleplay ? { roleplayReset: roleplay.reset } : {}),
    ...(commitAuthors ? { commitAuthors } : {}),
    start() {
      if (config.scanner.enabled || config.reports.enabled) sweeper.start();
    },
    stop: () => sweeper.stop(),
    async decide(op, id, approve, clickerMmUserId) {
      if (op === "children") {
        if (!children) throw new Error("增加子单的功能没有开启");
        return children.decide(id, approve, clickerMmUserId);
      }
      if (op === "report") {
        const asAddressee = roleplay
          ? await roleplay.reportClicker(clickerMmUserId, (await reportDrafts.get(id))?.addressees)
          : clickerMmUserId;
        const draft = await reports.decide(id, approve, asAddressee, asAddressee);
        if (draft.status !== "confirmed") return "已放弃这份草稿。";
        return draft.kind === "project"
          ? "已确认。这份项目周报不会写回 OpenProject。"
          : "已确认。这份草稿不会写回 OpenProject。";
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
