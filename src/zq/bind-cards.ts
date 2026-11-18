import type { ZqIdentityMap } from "./identity-map.ts";

export interface BindCandidate {
  mmUserId: string;
  opUserId: string;
  opLogin: string;
  opName: string;
  mmName?: string;
}

export function parseCandidates(text: string): BindCandidate[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error("the bind candidates file must hold a JSON array");
  const field = (row: Record<string, unknown>, key: string, index: number): string => {
    const value = row[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`bind candidate ${index}: ${key} is required`);
    return value.trim();
  };
  const seen = { mm: new Set<string>(), op: new Set<string>() };
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`bind candidate ${i} must be an object`);
    const row = entry as Record<string, unknown>;
    const candidate: BindCandidate = {
      mmUserId: field(row, "mmUserId", i),
      opUserId: field(row, "opUserId", i),
      opLogin: field(row, "opLogin", i),
      opName: field(row, "opName", i),
      ...(typeof row["mmName"] === "string" && row["mmName"].trim() ? { mmName: row["mmName"].trim() } : {}),
    };
    if (seen.mm.has(candidate.mmUserId) || seen.op.has(candidate.opUserId))
      throw new Error(`bind candidate ${i}: a Mattermost user or OpenProject user appears twice`);
    seen.mm.add(candidate.mmUserId);
    seen.op.add(candidate.opUserId);
    return candidate;
  });
}

export interface BindCards {
  tick(): Promise<number>;
  resend(mmUserId: string): Promise<boolean>;
  declined(mmUserId: string): Promise<void>;
}

export function createBindCards(opts: {
  identity: ZqIdentityMap;
  candidates: () => Promise<BindCandidate[]>;
  isAllowed: (mmUserId: string) => boolean;
  sendCard: (candidate: BindCandidate, text: string) => Promise<void>;
  notify?: (text: string) => Promise<void>;
}): BindCards {
  const cardText = (c: BindCandidate) =>
    `请确认身份:OpenProject 用户「${c.opName}」(账号 ${c.opLogin})是不是你?\n你的 Mattermost 账号:${c.mmName ? `@${c.mmName}` : c.mmUserId}。\n点「是我」后,QM 才会把这两个账号关联起来;点「不是我」会通知管理员,不会关联。`;

  async function push(c: BindCandidate): Promise<boolean> {
    if (!opts.isAllowed(c.mmUserId)) return false;
    await opts.identity.propose({
      mmUserId: c.mmUserId,
      opUserId: c.opUserId,
      opLogin: c.opLogin,
      opName: c.opName,
      source: "card",
      proposedBy: "bind-cards",
    });
    try {
      await opts.sendCard(c, cardText(c));
    } catch (e) {
      await opts.identity.unlink(c.mmUserId);
      throw e;
    }
    return true;
  }

  return {
    async tick() {
      let sent = 0;
      for (const c of await opts.candidates()) {
        if (await opts.identity.get(c.mmUserId)) continue;
        try {
          if (await push(c)) sent++;
        } catch {
          continue;
        }
      }
      return sent;
    },
    async resend(mmUserId) {
      const c = (await opts.candidates()).find((x) => x.mmUserId === mmUserId);
      if (!c) return false;
      await opts.identity.unlink(mmUserId);
      return push(c);
    },
    async declined(mmUserId) {
      const link = await opts.identity.get(mmUserId);
      if (!link) return;
      await opts.notify?.(
        `${link.opName ?? link.opLogin}(OpenProject 账号 ${link.opLogin})在收到身份确认卡片后点了「不是我」,没有关联。Mattermost 用户 id:${mmUserId}。`,
      );
    },
  };
}
