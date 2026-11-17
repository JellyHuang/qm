import { createHash } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import { errMessage } from "../util/errors.ts";

interface ChildInput {
  typeKey: string;
  subject: string;
  description: string;
  assigneeId?: string;
  fields?: Record<string, unknown>;
}

export interface ZqChildDraft {
  id: string;
  requesterPrincipalId: string;
  requesterMmUserId: string;
  featureId: number;
  lockVersion: number;
  reason: string;
  source: { kind: string; ref: string };
  children: ChildInput[];
  preview: string;
  status: "pending" | "submitting" | "done" | "discarded" | "failed";
  result?: string;
  createdAt: number;
  expiresAt: number;
}

export interface ProposeInput {
  featureId: number;
  lockVersion: number;
  reason: string;
  sourceRef?: string;
  children: ChildInput[];
}

export interface ZqChildren {
  propose(input: ProposeInput, requesterPrincipalId: string): Promise<string>;
  decide(draftId: string, approve: boolean, clickerMmUserId: string): Promise<string>;
}

const MAX_CHILDREN = 50;
const TTL_MS = 15 * 60_000;
const PREVIEW_MAX = 1200;
const DEFAULT_TOOL = "zq_create_child_orders";

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function validate(input: ProposeInput): void {
  if (!Number.isSafeInteger(input.featureId) || input.featureId < 1)
    throw new Error("feature_id must be a work package id");
  if (!Number.isSafeInteger(input.lockVersion) || input.lockVersion < 0)
    throw new Error("lock_version must be the feature's current lockVersion");
  if (!input.reason.trim()) throw new Error("reason is required");
  if (!input.children.length || input.children.length > MAX_CHILDREN)
    throw new Error(`children must hold 1 to ${MAX_CHILDREN} orders`);
  for (const [i, c] of input.children.entries())
    for (const field of ["typeKey", "subject", "description"] as const)
      if (!c[field].trim())
        throw new Error(`children[${i}].${field} is required; description is that person's own scope`);
}

function wireChildren(children: readonly ChildInput[]): Array<Record<string, unknown>> {
  return children.map((c) => ({
    type_key: c.typeKey,
    subject: c.subject,
    description: c.description,
    ...(c.fields ? { fields: c.fields } : {}),
    ...(c.assigneeId ? { assignee_id: c.assigneeId } : {}),
  }));
}

function cardText(d: ZqChildDraft): string {
  const lines = d.children.map(
    (c) =>
      `- ${c.typeKey}「${c.subject}」${c.assigneeId ? `(建议执行人 #${c.assigneeId})` : ""}:${clip(c.description, 120)}`,
  );
  return [
    `请确认:为功能 #${d.featureId} 增加 ${d.children.length} 张执行单。`,
    `理由:${d.reason}`,
    ...lines,
    d.preview ? `OpenProject 预览:${clip(d.preview, PREVIEW_MAX)}` : "",
    `卡片 ${Math.round(TTL_MS / 60_000)} 分钟内有效,只有提出请求的人可以确认。`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function createZqChildren(opts: {
  map: DurableMap<ZqChildDraft>;
  call: (tool: string, args: Record<string, unknown>, principalId: string) => Promise<string>;
  mmUserIdOf: (principalId: string) => Promise<string | undefined>;
  sendCard: (mmUserId: string, draftId: string, text: string) => Promise<void>;
  tool?: string;
  now?: () => number;
}): ZqChildren {
  const now = opts.now ?? (() => Date.now());
  const tool = opts.tool ?? DEFAULT_TOOL;
  const args = (d: ZqChildDraft, confirm: boolean) => ({
    id: d.featureId,
    lockVersion: d.lockVersion,
    idempotency_key: `qm:mm:children:${d.id}`,
    reason: d.reason,
    source: d.source,
    children: wireChildren(d.children),
    confirm,
  });

  return {
    async propose(input, requesterPrincipalId) {
      validate(input);
      const mmUserId = await opts.mmUserIdOf(requesterPrincipalId);
      if (!mmUserId) throw new Error("this needs the requester's Mattermost account to be linked");
      const source = { kind: "qm", ref: input.sourceRef?.trim() || "mattermost" };
      const id = createHash("sha256")
        .update(
          JSON.stringify([
            requesterPrincipalId,
            input.featureId,
            input.lockVersion,
            input.reason,
            source,
            input.children,
          ]),
        )
        .digest("hex")
        .slice(0, 24);
      const existing = await opts.map.get(id);
      if (existing?.status === "done") return `这个请求已经提交过:${existing.result ?? ""}`;
      if (existing && ["pending", "submitting"].includes(existing.status) && existing.expiresAt > now())
        return "同样的确认卡片已经发给提问者,等待本人点击,不要重复提交。";
      const draft: ZqChildDraft = {
        id,
        requesterPrincipalId,
        requesterMmUserId: mmUserId,
        featureId: input.featureId,
        lockVersion: input.lockVersion,
        reason: input.reason.trim(),
        source,
        children: input.children,
        preview: "",
        status: "pending",
        createdAt: now(),
        expiresAt: now() + TTL_MS,
      };
      draft.preview = await opts.call(tool, args(draft, false), requesterPrincipalId);
      await opts.map.put(id, draft);
      await opts.sendCard(mmUserId, id, cardText(draft));
      return "已给提问者发了确认卡片;本人点击确认后才会创建子单。现在还没有创建任何东西。";
    },

    async decide(draftId, approve, clickerMmUserId) {
      const draft = await opts.map.get(draftId);
      if (!draft) return "找不到这个请求,请重新提出。";
      if (draft.requesterMmUserId !== clickerMmUserId) throw new Error("只有提出请求的人可以确认");
      if (draft.status === "done") return `已经创建过:${draft.result ?? ""}`;
      if (draft.status !== "pending")
        return draft.status === "submitting" ? "正在提交,请稍候。" : "这个请求已经结束,请重新提出。";
      let outcome: "claimed" | "expired" | "taken" = "taken";
      const claimed = await opts.map.update(draftId, (d) => {
        if (d.status !== "pending") return d;
        if (d.expiresAt <= now()) {
          outcome = "expired";
          return { ...d, status: "failed", result: "已过期" };
        }
        outcome = "claimed";
        return { ...d, status: approve ? "submitting" : "discarded" };
      });
      if (!claimed || outcome === "taken") return "这个请求已经在处理,不会重复提交。";
      if (outcome === "expired") return "确认已过期,没有创建子单,请重新提出。";
      if (!approve) return "已放弃,没有创建子单。";
      try {
        const text = await opts.call(tool, args(claimed, true), claimed.requesterPrincipalId);
        const result = clip(text, PREVIEW_MAX);
        await opts.map.merge(draftId, { status: "done", result });
        return `已创建子单:${result}`;
      } catch (e) {
        await opts.map.merge(draftId, { status: "failed", result: errMessage(e) });
        return `创建失败,没有写入:${errMessage(e)}`;
      }
    },
  };
}

export type ZqChildProposer = Pick<ZqChildren, "propose">;

let current: ZqChildProposer | undefined;
export function setZqChildren(service: ZqChildProposer | undefined): void {
  current = service;
}
export function zqChildren(): ZqChildProposer | undefined {
  return current;
}
