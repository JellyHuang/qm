import type { DurableMap } from "../persistence/durable-map.ts";

const CLAIM_STALE_MS = 10 * 60_000;

export interface ZqGroup {
  featureId: number;
  groupRef: string;
  memberMmUserIds: string[];
  createdAt: number;
}

export interface ZqGroups {
  ensure(
    featureId: number,
    memberMmUserIds: readonly string[],
    create: (members: string[]) => Promise<string>,
  ): Promise<{ group: ZqGroup; created: boolean }>;
  get(featureId: number): Promise<ZqGroup | null>;
}

export function createZqGroups(opts: { map: DurableMap<ZqGroup>; now?: () => number }): ZqGroups {
  const now = opts.now ?? (() => Date.now());
  const key = (featureId: number) => `feature:${featureId}`;
  return {
    get: (featureId) => opts.map.get(key(featureId)),
    async ensure(featureId, memberMmUserIds, create) {
      const members = [...new Set(memberMmUserIds)].sort();
      const claim: ZqGroup = { featureId, groupRef: "", memberMmUserIds: members, createdAt: now() };
      if (!(await opts.map.insertIfAbsent(key(featureId), claim))) {
        const existing = (await opts.map.get(key(featureId))) ?? claim;
        const abandoned = !existing.groupRef && now() - existing.createdAt > CLAIM_STALE_MS;
        if (!abandoned) return { group: existing, created: false };
        await opts.map.deleteIf(key(featureId), (g) => !g.groupRef && g.createdAt === existing.createdAt);
        return this.ensure(featureId, memberMmUserIds, create);
      }
      try {
        const groupRef = await create(members);
        const group = (await opts.map.merge(key(featureId), { groupRef })) ?? { ...claim, groupRef };
        return { group, created: true };
      } catch (e) {
        await opts.map.delete(key(featureId));
        throw e;
      }
    },
  };
}
