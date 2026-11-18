import type { DurableMap } from "../persistence/durable-map.ts";
import type { ZqIdentityMap } from "./identity-map.ts";

export type OnboardingStep = "op" | "email" | "gitlab";
export type GitlabCheck = "found" | "missing" | "unavailable";

export interface OnboardingRecord {
  mmUserId: string;
  startedAt: number;
  email?: { value: string; confirmedAt: number };
  gitlab?: { username: string; confirmedAt: number };
  awaitingGitlab?: boolean;
}

export interface OnboardingStatus {
  op: boolean;
  email: boolean;
  gitlab: boolean;
  gitlabRequired: boolean;
  complete: boolean;
}

export interface OnboardingButton {
  id: string;
  name: string;
  style: "primary" | "good" | "danger" | "default";
  ref: string;
  approve: boolean;
}

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export const BLOCKED_TEXT = "请先完成绑定,完成前我只能处理绑定相关的事。";

export interface ZqOnboarding {
  status(mmUserId: string): Promise<OnboardingStatus>;
  ready(mmUserId: string): Promise<boolean>;
  gate(mmUserId: string, text: string): Promise<boolean>;
  tick(): Promise<number>;
  decide(ref: string, approve: boolean, clickerMmUserId: string): Promise<string>;
  reset(mmUserId: string, step: OnboardingStep): Promise<void>;
  list(): Promise<Array<{ mmUserId: string } & OnboardingStatus>>;
  mmUserOfGitlab(username: string): Promise<string | undefined>;
}

export function createOnboarding(opts: {
  map: DurableMap<OnboardingRecord>;
  identity: ZqIdentityMap;
  emailOf: (mmUserId: string) => Promise<string>;
  checkGitlab?: (username: string) => Promise<GitlabCheck>;
  isAllowed: (mmUserId: string) => boolean;
  candidates: () => Promise<ReadonlyArray<{ mmUserId: string }>>;
  sendText: (mmUserId: string, text: string) => Promise<void>;
  sendCard: (mmUserId: string, text: string, buttons: OnboardingButton[]) => Promise<void>;
  opCard: (mmUserId: string) => Promise<boolean>;
  now?: () => number;
}): ZqOnboarding {
  const now = opts.now ?? (() => Date.now());
  const gitlabRequired = opts.checkGitlab !== undefined;

  async function status(mmUserId: string): Promise<OnboardingStatus> {
    const record = await opts.map.get(mmUserId);
    const op = (await opts.identity.get(mmUserId))?.status === "confirmed";
    const email = record?.email !== undefined;
    const gitlab = record?.gitlab !== undefined;
    return { op, email, gitlab, gitlabRequired, complete: op && email && (gitlab || !gitlabRequired) };
  }

  async function ensure(mmUserId: string): Promise<OnboardingRecord> {
    const fresh: OnboardingRecord = { mmUserId, startedAt: now() };
    await opts.map.insertIfAbsent(mmUserId, fresh);
    return (await opts.map.get(mmUserId)) ?? fresh;
  }

  async function emailCard(mmUserId: string): Promise<void> {
    const email = await opts.emailOf(mmUserId).catch(() => "");
    if (!email) {
      await opts.sendCard(
        mmUserId,
        "你的 Mattermost 资料里还没有邮箱。邮箱只用来改密码,QM 不会给它发邮件。请在 Mattermost 头像 → 个人资料 里填上邮箱,填好后点「已填好」。",
        [{ id: "email-recheck", name: "已填好", style: "primary", ref: `email-recheck:${mmUserId}`, approve: true }],
      );
      return;
    }
    await opts.sendCard(mmUserId, `请确认你的邮箱:${email}\n邮箱只用来改密码,QM 不会给它发邮件,也不会发验证码。`, [
      { id: "email-yes", name: "是这个", style: "good", ref: `email:${mmUserId}`, approve: true },
      { id: "email-change", name: "我要改", style: "default", ref: `email:${mmUserId}`, approve: false },
    ]);
  }

  async function guide(mmUserId: string): Promise<void> {
    const s = await status(mmUserId);
    await opts.sendText(mmUserId, BLOCKED_TEXT);
    if (!s.op) {
      const sent = await opts.opCard(mmUserId).catch(() => false);
      if (!sent)
        await opts.sendText(mmUserId, "OpenProject 账号:请先在 QM 网页里连接 OpenProject,连接后我会发确认卡片给你。");
    }
    if (!s.email) await emailCard(mmUserId);
    if (s.gitlabRequired && !s.gitlab) {
      await opts.map.merge(mmUserId, { awaitingGitlab: true });
      await opts.sendText(mmUserId, "GitLab 账号:请直接回复你的 GitLab 用户名(只回用户名,不用带 @)。");
    }
  }

  async function gate(mmUserId: string, text: string): Promise<boolean> {
    if (!opts.isAllowed(mmUserId)) return false;
    const s = await status(mmUserId);
    if (s.complete) return false;
    const record = await ensure(mmUserId);
    const name = text.trim().replace(/^@/, "");
    if (record.awaitingGitlab && opts.checkGitlab && !s.gitlab) {
      if (!USERNAME.test(name)) {
        await opts.sendText(mmUserId, "这不像 GitLab 用户名。请只回复用户名,例如 zhangsan。");
        return true;
      }
      const found = await opts.checkGitlab(name).catch((): GitlabCheck => "unavailable");
      if (found === "found") {
        await opts.map.merge(mmUserId, { gitlab: { username: name, confirmedAt: now() }, awaitingGitlab: false });
        await opts.sendText(mmUserId, `已记录你的 GitLab 账号:${name}。`);
        const after = await status(mmUserId);
        if (!after.complete) await guide(mmUserId);
        else await opts.sendText(mmUserId, "三项绑定都完成了。");
        return true;
      }
      await opts.sendText(
        mmUserId,
        found === "missing"
          ? `GitLab 里查不到用户名「${name}」。请检查后重新回复。`
          : "现在查不了 GitLab,请稍后再回复一次用户名。",
      );
      return true;
    }
    await guide(mmUserId);
    return true;
  }

  return {
    status,
    async ready(mmUserId) {
      return (await status(mmUserId)).complete;
    },
    gate,
    async tick() {
      let started = 0;
      for (const { mmUserId } of await opts.candidates()) {
        if (!opts.isAllowed(mmUserId) || (await opts.map.get(mmUserId))) continue;
        if ((await status(mmUserId)).complete) continue;
        try {
          await ensure(mmUserId);
          await guide(mmUserId);
          started++;
        } catch {
          await opts.map.delete(mmUserId);
        }
      }
      return started;
    },
    async decide(ref, approve, clicker) {
      const [kind, mmUserId] = ref.split(":");
      if (!mmUserId) throw new Error("这张卡片已经失效");
      if (mmUserId !== clicker) throw new Error("只有本人可以回答");
      if (kind === "email-recheck") {
        await emailCard(mmUserId);
        return "我重新读了你的资料。";
      }
      if (kind !== "email") throw new Error("这张卡片已经失效");
      if (!approve) return "请在 Mattermost 头像 → 个人资料 里修改邮箱,改好后再回复我任意一句话,我会重新给你确认卡片。";
      const email = await opts.emailOf(mmUserId).catch(() => "");
      if (!email) {
        await emailCard(mmUserId);
        return "你的资料里还没有邮箱,请先填写。";
      }
      await ensure(mmUserId);
      await opts.map.merge(mmUserId, { email: { value: email, confirmedAt: now() } });
      return `已确认邮箱:${email}。`;
    },
    async reset(mmUserId, step) {
      if (step === "op") {
        await opts.identity.unlink(mmUserId);
        return;
      }
      await opts.map.update(mmUserId, (r) => {
        const { email, gitlab, ...rest } = r;
        return step === "email"
          ? { ...rest, ...(gitlab ? { gitlab } : {}) }
          : { ...rest, ...(email ? { email } : {}), awaitingGitlab: false };
      });
    },
    async list() {
      const out: Array<{ mmUserId: string } & OnboardingStatus> = [];
      for (const r of await opts.map.all()) out.push({ mmUserId: r.mmUserId, ...(await status(r.mmUserId)) });
      return out.sort((a, b) => a.mmUserId.localeCompare(b.mmUserId));
    },
    async mmUserOfGitlab(username) {
      const wanted = username.trim().toLowerCase();
      return (await opts.map.all()).find((r) => r.gitlab?.username.toLowerCase() === wanted)?.mmUserId;
    },
  };
}

export function gitlabUserCheck(opts: {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
}): (username: string) => Promise<GitlabCheck> {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  return async (username) => {
    const response = await doFetch(`${base}/api/v4/users?username=${encodeURIComponent(username)}`, {
      method: "GET",
      headers: { accept: "application/json", ...(opts.token ? { "private-token": opts.token } : {}) },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    if (!response || !response.ok) return "unavailable";
    const body: unknown = await response.json().catch(() => undefined);
    if (!Array.isArray(body)) return "unavailable";
    const hit = body.some(
      (u) =>
        typeof u === "object" &&
        u !== null &&
        String((u as { username?: unknown }).username).toLowerCase() === username.toLowerCase(),
    );
    return hit ? "found" : "missing";
  };
}
