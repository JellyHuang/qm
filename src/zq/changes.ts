import type { DurableMap } from "../persistence/durable-map.ts";
import type { ZqContract } from "./contract.ts";
import type { FeatureFacts, WorkView } from "./rules.ts";
import type { ZqGroups } from "./groups.ts";

export interface ZqSnapshot {
  id: number;
  featureId: number;
  title: string;
  stage: string;
  lifecycle: string;
  delayMarked: boolean;
  assigneeId: string;
  assigneeName: string;
  plannedEnd: number;
  seq: number;
}

export interface ZqChangeLine {
  id: string;
  featureId: number;
  featureTitle: string;
  text: string;
  createdAt: number;
  status: "pending" | "sent";
  fallbackMmUserId?: string;
}

export interface FeedEvent {
  id: string;
  ticketId: number;
  featureId: number;
  kinds: string[];
  oldStage?: string;
  newStage?: string;
  old: Record<string, unknown>;
  new: Record<string, unknown>;
  actorName?: string;
  actorId?: string;
  byRule: boolean;
  at: number;
  reason?: string;
  batchId?: string;
}

export interface FeedContext {
  facts: readonly FeatureFacts[];
  day: (at: number) => string;
  link: (id: number) => string;
  fallbackMmUserIdOf: (featureId: number) => string | undefined;
}

export interface ZqChangeCursor {
  id: string;
  cursor: string;
}

export interface RecordContext {
  day: (at: number) => string;
  link: (id: number) => string;
  fallbackMmUserId?: string;
}

export interface FlushTransport {
  channel: (channelId: string, text: string) => Promise<void>;
  dm: (mmUserId: string, text: string) => Promise<void>;
}

export interface FlushResult {
  sent: number;
  failed: number;
  undeliverable: number;
}

export interface ZqChanges {
  cursor(key: string): Promise<string | undefined>;
  saveCursor(key: string, cursor: string): Promise<void>;
  ingest(events: readonly FeedEvent[], contract: ZqContract, ctx: FeedContext): Promise<number>;
  record(fact: FeatureFacts, contract: ZqContract, ctx: RecordContext): Promise<number>;
  flush(groups: ZqGroups | undefined, transport: FlushTransport): Promise<FlushResult>;
}

const MESSAGE_LIMIT = 3000;

const snapshotOf = (w: WorkView, featureId: number, seq: number): ZqSnapshot => ({
  id: w.id,
  featureId,
  title: w.subject,
  stage: w.statusKey,
  lifecycle: w.lifecycle ?? "normal",
  delayMarked: w.delayMarked === true,
  assigneeId: w.assignee?.id ?? "",
  assigneeName: w.assignee?.name ?? "",
  plannedEnd: w.plannedEnd ?? 0,
  seq,
});

const LIFECYCLE_TEXT: Record<string, string> = { suspended: "已挂起", cancelled: "已取消", normal: "已恢复" };

interface Pending {
  key: string;
  kind: string;
  text: string;
}

export function createZqChanges(opts: {
  snapshots: DurableMap<ZqSnapshot>;
  lines: DurableMap<ZqChangeLine>;
  cursors: DurableMap<ZqChangeCursor>;
  now?: () => number;
}): ZqChanges {
  const now = opts.now ?? (() => Date.now());
  const key = (id: number) => `wp:${id}`;

  function changesOf(
    prev: ZqSnapshot,
    w: WorkView,
    isFeature: boolean,
    contract: ZqContract,
    ctx: RecordContext,
    planner: string,
  ): Pending[] {
    const at = (kind: string, text: string): Pending => ({ key: `${prev.id}:${prev.seq}:${kind}`, kind, text });
    const ref = `${isFeature ? "功能 " : `执行单「${w.subject}」`}[#${w.id}](${ctx.link(w.id)})`;
    const label = (stage: string) => contract.stages.feature[stage] ?? contract.stages.task[stage] ?? stage;
    const out: Pending[] = [];
    if (prev.stage !== w.statusKey) {
      const auto = isFeature && contract.autoAdvanceStages.includes(prev.stage) ? "(自动推进)" : "";
      const verb =
        !isFeature && w.statusKey === contract.stageRoles.taskDone
          ? "已完成"
          : `阶段 ${label(prev.stage)} → ${label(w.statusKey)}${auto}`;
      out.push(at("stage", `${ref} ${verb}`));
    }
    const lifecycle = w.lifecycle ?? "normal";
    if (prev.lifecycle !== lifecycle) out.push(at("lifecycle", `${ref} ${LIFECYCLE_TEXT[lifecycle] ?? lifecycle}`));
    if (prev.delayMarked !== (w.delayMarked === true))
      out.push(
        at(
          "delay",
          w.delayMarked
            ? `${ref} 被标记延期(执行人:${w.assignee?.name ?? "未指定"},负责策划:${planner || "未设置"})`
            : `${ref} 的延期标记已清除`,
        ),
      );
    if (prev.assigneeId !== (w.assignee?.id ?? ""))
      out.push(at("assignee", `${ref} 执行人 ${prev.assigneeName || "未指定"} → ${w.assignee?.name ?? "未指定"}`));
    if (prev.plannedEnd !== (w.plannedEnd ?? 0))
      out.push(
        at(
          "planned-end",
          `${ref} 计划结束时间 ${prev.plannedEnd ? ctx.day(prev.plannedEnd) : "未设置"} → ${w.plannedEnd ? ctx.day(w.plannedEnd) : "未设置"}`,
        ),
      );
    return out;
  }

  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const stageOf = (side: Record<string, unknown>) => text(side["stage"]) || text(side["stage_key"]);
  const lifecycleOf = (side: Record<string, unknown>) => text(side["lifecycle"]) || "normal";
  const REASON_MAX = 200;

  const PEOPLE_FIELDS = ["responsiblePlanner", "pm", "reviewer", "qaOwner", "acceptor", "regressionOwner"] as const;

  function namesOf(facts: readonly FeatureFacts[]): Map<string, string> {
    const names = new Map<string, string>();
    for (const f of facts) {
      const views = [f.feature, ...f.children];
      for (const w of views) {
        if (w.assignee) names.set(w.assignee.id, w.assignee.name);
        for (const field of PEOPLE_FIELDS) if (w[field]) names.set(w[field]!.id, w[field]!.name);
      }
    }
    return names;
  }

  function describe(e: FeedEvent, isFeature: boolean, contract: ZqContract, nameOf: (v: unknown) => string): string[] {
    const label = (stage: string) => contract.stages.feature[stage] ?? contract.stages.task[stage] ?? stage;
    const from = e.oldStage ?? stageOf(e.old);
    const to = e.newStage ?? stageOf(e.new);
    if (e.kinds.includes("created")) {
      const who = nameOf(e.new["assignee"]);
      return [`已新增${to ? `,阶段 ${label(to)}` : ""}${who ? `,执行人 ${who}` : ""}`];
    }
    const parts: string[] = [];
    if (e.kinds.includes("stage")) {
      const auto = isFeature && e.byRule ? "(自动推进)" : "";
      parts.push(
        !isFeature && to === contract.stageRoles.taskDone ? "已完成" : `阶段 ${label(from)} → ${label(to)}${auto}`,
      );
    }
    if (e.kinds.includes("lifecycle")) parts.push(LIFECYCLE_TEXT[lifecycleOf(e.new)] ?? lifecycleOf(e.new));
    if (e.kinds.includes("delay_marked")) parts.push(e.new["delay_marked"] === true ? "被标记延期" : "延期标记已清除");
    if (e.kinds.includes("assignee"))
      parts.push(`执行人 ${nameOf(e.old["assignee"]) || "未指定"} → ${nameOf(e.new["assignee"]) || "未指定"}`);
    if (e.kinds.includes("planned_end")) {
      const day = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 10) : "未设置");
      parts.push(`计划结束时间 ${day(e.old["planned_end"])} → ${day(e.new["planned_end"])}`);
    }
    return parts;
  }

  return {
    async cursor(cursorKey) {
      return (await opts.cursors.get(cursorKey))?.cursor;
    },
    async saveCursor(cursorKey, cursor) {
      await opts.cursors.put(cursorKey, { id: cursorKey, cursor });
    },

    async ingest(events, contract, ctx) {
      const byFeature = new Map<number, FeatureFacts>(ctx.facts.map((f) => [f.feature.id, f]));
      const names = namesOf(ctx.facts);
      const nameOf = (v: unknown) => {
        if (typeof v === "object" && v !== null) return text((v as Record<string, unknown>)["name"]);
        return v === null || v === undefined || v === "" ? "" : (names.get(String(v)) ?? `用户#${String(v)}`);
      };
      const lines: Array<{ id: string; featureId: number; featureTitle: string; text: string; at: number }> = [];
      const batches = new Map<string, FeedEvent[]>();
      for (const e of [...events].sort((a, b) => a.at - b.at)) {
        const fact = byFeature.get(e.featureId);
        if (!fact) continue;
        const isFeature = e.ticketId === e.featureId;
        const child = fact.children.find((c) => c.id === e.ticketId);
        if (!isFeature && !child) continue;
        if (!isFeature && e.batchId && e.kinds.includes("lifecycle")) {
          batches.set(e.batchId, [...(batches.get(e.batchId) ?? []), e]);
          continue;
        }
        const parts = describe(e, isFeature, contract, nameOf);
        if (!parts.length) continue;
        const subject = isFeature ? fact.feature.subject : child!.subject;
        const who = e.byRule ? `规则${e.actorName ? ` ${e.actorName}` : ""}` : (e.actorName ?? "");
        const why = e.byRule && e.reason ? `,原因:${e.reason.slice(0, REASON_MAX)}` : "";
        const by = who ? `(${who}${why})` : "";
        lines.push({
          id: e.id,
          featureId: e.featureId,
          featureTitle: fact.feature.subject,
          at: e.at,
          text: `${isFeature ? "功能 " : `执行单「${subject}」`}[#${e.ticketId}](${ctx.link(e.ticketId)}) ${parts.join(";")}${by}`,
        });
      }
      for (const [batchId, group] of batches) {
        const fact = byFeature.get(group[0]!.featureId)!;
        const state = LIFECYCLE_TEXT[lifecycleOf(group[0]!.new)] ?? "";
        lines.push({
          id: `batch:${batchId}`,
          featureId: fact.feature.id,
          featureTitle: fact.feature.subject,
          at: group[0]!.at,
          text: `随总单${state},影响 ${group.length} 张执行单:${group.map((e) => `#${e.ticketId}`).join("、")}`,
        });
      }
      let created = 0;
      for (const l of lines) {
        const pm = ctx.fallbackMmUserIdOf(l.featureId);
        const line: ZqChangeLine = {
          id: l.id,
          featureId: l.featureId,
          featureTitle: l.featureTitle,
          text: l.text,
          createdAt: l.at,
          status: "pending",
          ...(pm ? { fallbackMmUserId: pm } : {}),
        };
        if (await opts.lines.insertIfAbsent(line.id, line)) created++;
      }
      return created;
    },

    async record(fact, contract, ctx) {
      const { feature, children } = fact;
      const featureId = feature.id;
      const planner = feature.responsiblePlanner?.name ?? "";
      const pending: Pending[] = [];
      const next: ZqSnapshot[] = [];
      const cascade: string[] = [];
      let cascadeLifecycle = "";
      let cascadeKey = "";
      const featurePrev = await opts.snapshots.get(key(featureId));
      const known = featurePrev !== null;
      const featureCascades = featurePrev !== null && featurePrev.lifecycle !== (feature.lifecycle ?? "normal");
      for (const [w, isFeature] of [[feature, true] as const, ...children.map((c) => [c, false] as const)]) {
        const prev = await opts.snapshots.get(key(w.id));
        if (!prev) {
          next.push(snapshotOf(w, featureId, 0));
          if (!isFeature && known)
            pending.push({
              key: `${w.id}:created`,
              kind: "created",
              text: `新增执行单「${w.subject}」[#${w.id}](${ctx.link(w.id)})${w.assignee ? `,执行人 ${w.assignee.name}` : ""}`,
            });
          continue;
        }
        const found = changesOf(prev, w, isFeature, contract, ctx, planner);
        if (!found.length) continue;
        next.push(snapshotOf(w, featureId, prev.seq + 1));
        for (const change of found) {
          if (!isFeature && featureCascades && change.kind === "lifecycle") {
            cascade.push(`#${w.id}`);
            cascadeLifecycle = LIFECYCLE_TEXT[w.lifecycle ?? "normal"] ?? "";
            cascadeKey = `${featureId}:${featurePrev!.seq}:cascade`;
          } else pending.push(change);
        }
      }
      if (cascade.length)
        pending.push({
          key: cascadeKey,
          kind: "cascade",
          text: `随总单${cascadeLifecycle},影响 ${cascade.length} 张执行单:${cascade.join("、")}`,
        });
      let created = 0;
      for (const p of pending) {
        const line: ZqChangeLine = {
          id: p.key,
          featureId,
          featureTitle: feature.subject,
          text: p.text,
          createdAt: now(),
          status: "pending",
          ...(ctx.fallbackMmUserId ? { fallbackMmUserId: ctx.fallbackMmUserId } : {}),
        };
        if (await opts.lines.insertIfAbsent(line.id, line)) created++;
      }
      for (const snapshot of next) await opts.snapshots.put(key(snapshot.id), snapshot);
      return created;
    },

    async flush(groups, transport) {
      const result: FlushResult = { sent: 0, failed: 0, undeliverable: 0 };
      const pending = (await opts.lines.all())
        .filter((l) => l.status === "pending")
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      const byFeature = new Map<number, ZqChangeLine[]>();
      for (const line of pending) byFeature.set(line.featureId, [...(byFeature.get(line.featureId) ?? []), line]);
      for (const [featureId, lines] of byFeature) {
        const channelId = (await groups?.get(featureId))?.groupRef;
        const dmTo = lines.findLast((l) => l.fallbackMmUserId)?.fallbackMmUserId;
        if (!channelId && !dmTo) {
          result.undeliverable += lines.length;
          continue;
        }
        const title = lines[0]!.featureTitle;
        const batches: ZqChangeLine[][] = [];
        let size = 0;
        for (const line of lines) {
          if (!batches.length || size + line.text.length > MESSAGE_LIMIT) {
            batches.push([]);
            size = 0;
          }
          batches.at(-1)!.push(line);
          size += line.text.length + 3;
        }
        for (const batch of batches) {
          const text = `功能「${title}」(#${featureId}) 有 ${batch.length} 项变化:\n${batch.map((l) => `- ${l.text}`).join("\n")}`;
          try {
            if (channelId) await transport.channel(channelId, text);
            else await transport.dm(dmTo!, text);
            for (const line of batch) await opts.lines.merge(line.id, { status: "sent" });
            result.sent += batch.length;
          } catch {
            result.failed += batch.length;
          }
        }
      }
      return result;
    },
  };
}
