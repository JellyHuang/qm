import type { DurableMap } from "../persistence/durable-map.ts";
import type { ZqChangeCursor, ZqChangeLine, ZqSnapshot } from "./changes.ts";
import type { PersonField, ZqContract } from "./contract.ts";
import type { ZqGroup } from "./groups.ts";
import type { ZqReminder } from "./reminders.ts";
import type { FeatureFacts, OpUserRef } from "./rules.ts";
import type { OpReader, ScanPerson } from "./scanner.ts";

export interface RoleplayPersona {
  opUserId: string;
  name: string;
  roles: string[];
}

export interface RoleplayChat {
  sendDm(mmUserId: string, text: string): Promise<void>;
  sendButtons: (mmUserId: string, text: string, buttons: never) => Promise<void>;
  createGroup?: (feature: { id: number; subject: string; url?: string }, members: string[]) => Promise<string>;
  postToChannel?: (channelId: string, text: string) => Promise<void>;
}

const DUTY_ROLES: Record<string, string> = {
  producer: "制作人",
  pm: "项目经理",
  art_lead: "美术负责人",
  client_lead: "客户端负责人",
  server_lead: "服务端负责人",
  planning_lead: "策划负责人",
  qa_lead: "QA 负责人",
  ui_lead: "UI 负责人",
};

const PREFIX = "rp:";
const FIELD_ROLES: Record<PersonField, string> = {
  responsiblePlanner: "策划",
  pm: "项目经理",
  reviewer: "评审",
  qaOwner: "QA",
  acceptor: "验收人",
  regressionOwner: "回归负责人",
};

export const roleplayRecipient = (opUserId: string) => `${PREFIX}${opUserId}`;
const isRoleplayRecipient = (id: string) => id.startsWith(PREFIX);

export function createRoleplay(opts: {
  mmUserId: string;
  projectIds: readonly string[];
  contract?: ZqContract;
  personas: DurableMap<RoleplayPersona>;
  reminders: DurableMap<ZqReminder>;
  groups: DurableMap<ZqGroup>;
  features: DurableMap<{ featureId: number }>;
  snapshots: DurableMap<ZqSnapshot>;
  lines: DurableMap<ZqChangeLine>;
  cursors: DurableMap<ZqChangeCursor>;
}) {
  const { mmUserId, personas } = opts;
  const projects = new Set(opts.projectIds);

  function rolesOf(fact: FeatureFacts): Array<[OpUserRef, string]> {
    const out: Array<[OpUserRef, string]> = [];
    for (const [field, role] of Object.entries(FIELD_ROLES) as Array<[PersonField, string]>) {
      const user = fact.feature[field];
      if (user) out.push([user, role]);
    }
    for (const child of fact.children) {
      if (!child.assignee) continue;
      const owner = opts.contract?.typeOwners[child.typeKey];
      out.push([child.assignee, (owner?.kind === "duty" && DUTY_ROLES[owner.duty]) || "执行人"]);
    }
    for (const bug of fact.bugs ?? []) if (bug.assignee) out.push([bug.assignee, "BUG 处理人"]);
    return out;
  }

  async function remember(facts: readonly FeatureFacts[], extra: Array<[OpUserRef, string]> = []): Promise<void> {
    for (const [user, role] of [...facts.flatMap(rolesOf), ...extra]) {
      const known = await personas.get(user.id);
      const roles = known?.roles ?? [];
      if (!roles.includes(role))
        await personas.put(user.id, { opUserId: user.id, name: user.name, roles: [...roles, role] });
    }
    for (const fact of facts) await opts.features.put(String(fact.feature.id), { featureId: fact.feature.id });
  }

  async function labelOf(to: string): Promise<string> {
    if (to === mmUserId) return "当前你扮演:你本人";
    const id = to.slice(PREFIX.length);
    const persona = await personas.get(id);
    if (!persona) return `当前你扮演:OpenProject 用户 #${id}`;
    return `当前你扮演:${persona.roles.join("/")} ${persona.name}`;
  }

  async function recipient(to: string): Promise<{ to: string; label: string }> {
    if (to !== mmUserId && !isRoleplayRecipient(to))
      throw new Error(`角色扮演验收模式只允许发给 ${mmUserId},拒绝发送给 ${to}`);
    return { to: mmUserId, label: await labelOf(to) };
  }

  return {
    mmUserIdOfOpUser: async (opUserId: string): Promise<string> => roleplayRecipient(opUserId),

    async lineLabel(line: ZqChangeLine): Promise<string> {
      const about = line.aboutOpUserId ? roleplayRecipient(line.aboutOpUserId) : line.fallbackMmUserId;
      return labelOf(about ?? mmUserId);
    },

    people: (all: readonly ScanPerson[]): ScanPerson[] => all.filter((p) => p.mmUserId === mmUserId),

    reader(base: OpReader): OpReader {
      return {
        ...base,
        async features(person) {
          const read = await base.features(person);
          const facts = read.facts.filter(
            (f) => f.feature.projectId !== undefined && projects.has(f.feature.projectId),
          );
          await remember(facts);
          return { ...read, facts };
        },
        async dutyHolders(person, projectId, duty) {
          const holders = await base.dutyHolders(person, projectId, duty);
          await remember(
            [],
            (holders ?? []).map((u) => [u, DUTY_ROLES[duty] ?? duty]),
          );
          return holders;
        },
      };
    },

    chat<C extends RoleplayChat>(base: C): C {
      return {
        ...base,
        sendDm: async (to, text) => {
          const r = await recipient(to);
          await base.sendDm(r.to, `${r.label}\n${text}`);
        },
        sendButtons: async (to: string, text: string, buttons: never) => {
          const r = await recipient(to);
          await base.sendButtons(r.to, `${r.label}\n${text}`, buttons);
        },
        ...(base.createGroup
          ? {
              createGroup: async (feature: { id: number; subject: string; url?: string }, members: string[]) => {
                for (const member of members) await recipient(member);
                const roster = await Promise.all(
                  members.filter(isRoleplayRecipient).map((m) => labelOf(m).then((l) => l.replace("当前你扮演:", ""))),
                );
                const channel = await base.createGroup!({ ...feature, subject: `【角色扮演】${feature.subject}` }, [
                  mmUserId,
                ]);
                await base.postToChannel?.(
                  channel,
                  `角色扮演验收群:本群只有你和 QM,以下角色都由你扮演。\n${roster.map((r) => `- ${r}`).join("\n")}`,
                );
                return channel;
              },
            }
          : {}),
      };
    },

    async reportClicker(clicker: string, addressees: readonly string[] | undefined): Promise<string> {
      return clicker === mmUserId ? (addressees?.find(isRoleplayRecipient) ?? clicker) : clicker;
    },

    async reset() {
      const out = { personas: 0, reminders: 0, groups: 0, changeLines: 0, snapshots: 0 };
      for (const [id] of await personas.entries()) {
        await personas.delete(id);
        out.personas++;
      }
      for (const [id, r] of await opts.reminders.entries()) {
        if (!isRoleplayRecipient(r.recipientMmUserId)) continue;
        await opts.reminders.delete(id);
        out.reminders++;
      }
      const featureIds = new Set((await opts.features.all()).map((f) => f.featureId));
      for (const [id, g] of await opts.groups.entries()) {
        if (!featureIds.has(g.featureId)) continue;
        await opts.groups.delete(id);
        out.groups++;
      }
      for (const [id, l] of await opts.lines.entries()) {
        if (!featureIds.has(l.featureId)) continue;
        await opts.lines.delete(id);
        out.changeLines++;
      }
      for (const [id, snap] of await opts.snapshots.entries()) {
        if (!featureIds.has(snap.featureId)) continue;
        await opts.snapshots.delete(id);
        out.snapshots++;
      }
      for (const [id] of await opts.cursors.entries())
        if (projects.has(id.split(":")[0]!)) await opts.cursors.delete(id);
      for (const [id] of await opts.features.entries()) await opts.features.delete(id);
      return out;
    },
  };
}
