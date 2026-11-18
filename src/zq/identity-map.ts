import type { DurableMap } from "../persistence/durable-map.ts";

export interface ZqIdentityLink {
  mmUserId: string;
  opUserId: string;
  opLogin: string;
  opName?: string;
  emailHint?: string;
  source: "signin" | "admin" | "card";
  status: "pending" | "confirmed" | "declined";
  proposedAt: number;
  proposedBy: string;
  confirmedAt?: number;
  confirmedBy?: string;
  declinedAt?: number;
}

interface ZqIdentityProposal {
  mmUserId: string;
  opUserId: string;
  opLogin: string;
  opName?: string;
  emailHint?: string;
  source: ZqIdentityLink["source"];
  proposedBy: string;
}

export interface ZqIdentityMap {
  enabled: boolean;
  propose(input: ZqIdentityProposal): Promise<ZqIdentityLink>;
  confirm(mmUserId: string, confirmedBy: string): Promise<ZqIdentityLink>;
  decline(mmUserId: string): Promise<ZqIdentityLink>;
  get(mmUserId: string): Promise<ZqIdentityLink | undefined>;
  byMattermost(mmUserId: string): Promise<ZqIdentityLink | undefined>;
  byOpenProject(opUserId: string): Promise<ZqIdentityLink | undefined>;
  pending(): Promise<ZqIdentityLink[]>;
  list(): Promise<ZqIdentityLink[]>;
  unlink(mmUserId: string): Promise<void>;
}

export function hintByEmail(
  email: string,
  opUsers: ReadonlyArray<{ id: string; login: string; email?: string }>,
): { id: string; login: string } | undefined {
  const wanted = email.trim().toLowerCase();
  const hits = opUsers.filter((u) => u.email?.trim().toLowerCase() === wanted);
  return hits.length === 1 ? { id: hits[0]!.id, login: hits[0]!.login } : undefined;
}

export function createZqIdentityMap(opts: {
  map: DurableMap<ZqIdentityLink>;
  enabled: boolean;
  now?: () => number;
}): ZqIdentityMap {
  const now = opts.now ?? (() => Date.now());
  const off = () => new Error("identity mapping is off (set ZQ_IDENTITY_MAP=1)");
  const confirmed = async () => (await opts.map.all()).filter((l) => l.status === "confirmed");
  return {
    enabled: opts.enabled,
    async propose(input) {
      if (!opts.enabled) throw off();
      const current = await opts.map.get(input.mmUserId);
      if (current?.status === "confirmed" && current.opUserId === input.opUserId) return current;
      const taken = (await opts.map.all()).find((l) => l.opUserId === input.opUserId && l.mmUserId !== input.mmUserId);
      if (taken) throw new Error(`OpenProject user ${input.opUserId} is already linked to another Mattermost user`);
      const link: ZqIdentityLink = { ...input, status: "pending", proposedAt: now() };
      await opts.map.put(input.mmUserId, link);
      return link;
    },
    async confirm(mmUserId, confirmedBy) {
      if (!opts.enabled) throw off();
      const updated = await opts.map.update(mmUserId, (l) =>
        l.status === "confirmed" ? l : { ...l, status: "confirmed", confirmedAt: now(), confirmedBy },
      );
      if (!updated) throw new Error(`no proposed link for Mattermost user ${mmUserId}`);
      return updated;
    },
    async decline(mmUserId) {
      if (!opts.enabled) throw off();
      const updated = await opts.map.update(mmUserId, (l) =>
        l.status === "pending" ? { ...l, status: "declined", declinedAt: now() } : l,
      );
      if (!updated) throw new Error(`no proposed link for Mattermost user ${mmUserId}`);
      return updated;
    },
    async get(mmUserId) {
      if (!opts.enabled) return undefined;
      return (await opts.map.get(mmUserId)) ?? undefined;
    },
    async byMattermost(mmUserId) {
      if (!opts.enabled) return undefined;
      const link = await opts.map.get(mmUserId);
      return link?.status === "confirmed" ? link : undefined;
    },
    async byOpenProject(opUserId) {
      if (!opts.enabled) return undefined;
      return (await confirmed()).find((l) => l.opUserId === opUserId);
    },
    async list() {
      if (!opts.enabled) return [];
      return (await opts.map.all()).sort((a, b) => a.mmUserId.localeCompare(b.mmUserId));
    },
    async pending() {
      if (!opts.enabled) return [];
      return (await opts.map.all()).filter((l) => l.status === "pending");
    },
    async unlink(mmUserId) {
      if (!opts.enabled) throw off();
      await opts.map.delete(mmUserId);
    },
  };
}
