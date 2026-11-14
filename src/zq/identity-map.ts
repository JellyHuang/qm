import type { DurableMap } from "../persistence/durable-map.ts";

export interface ZqIdentityLink {
  mmUserId: string;
  opUserId: string;
  opLogin: string;
  email: string;
  source: "email-match" | "admin";
  linkedAt: number;
  linkedBy: string;
}

export interface ZqIdentityMap {
  enabled: boolean;
  link(link: Omit<ZqIdentityLink, "linkedAt">): Promise<ZqIdentityLink>;
  byMattermost(mmUserId: string): Promise<ZqIdentityLink | undefined>;
  byOpenProject(opUserId: string): Promise<ZqIdentityLink | undefined>;
  unlink(mmUserId: string): Promise<void>;
}

export function matchByEmail(
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
  return {
    enabled: opts.enabled,
    async link(input) {
      if (!opts.enabled) throw off();
      const taken = (await opts.map.all()).find((l) => l.opUserId === input.opUserId && l.mmUserId !== input.mmUserId);
      if (taken) throw new Error(`OpenProject user ${input.opUserId} is already linked to another Mattermost user`);
      const link: ZqIdentityLink = { ...input, linkedAt: now() };
      await opts.map.put(input.mmUserId, link);
      return link;
    },
    async byMattermost(mmUserId) {
      if (!opts.enabled) return undefined;
      return (await opts.map.get(mmUserId)) ?? undefined;
    },
    async byOpenProject(opUserId) {
      if (!opts.enabled) return undefined;
      return (await opts.map.all()).find((l) => l.opUserId === opUserId);
    },
    async unlink(mmUserId) {
      if (!opts.enabled) throw off();
      await opts.map.delete(mmUserId);
    },
  };
}
