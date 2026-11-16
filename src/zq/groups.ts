import type { DurableMap } from "../persistence/durable-map.ts";

const CLAIM_STALE_MS = 10 * 60_000;

export interface ZqGroup {
  featureId: number;
  groupRef: string;
  memberMmUserIds: string[];
  participantOpUserIds: string[];
  remarkWritten?: boolean;
  createdAt: number;
}

export interface ZqGroups {
  ensure(
    featureId: number,
    memberMmUserIds: readonly string[],
    create: (members: string[]) => Promise<string>,
    participantOpUserIds?: readonly string[],
  ): Promise<{ group: ZqGroup; created: boolean }>;
  get(featureId: number): Promise<ZqGroup | null>;
  markRemarkWritten(featureId: number): Promise<void>;
}

export function createZqGroups(opts: { map: DurableMap<ZqGroup>; now?: () => number }): ZqGroups {
  const now = opts.now ?? (() => Date.now());
  const key = (featureId: number) => `feature:${featureId}`;
  return {
    get: (featureId) => opts.map.get(key(featureId)),
    async markRemarkWritten(featureId) {
      await opts.map.merge(key(featureId), { remarkWritten: true });
    },
    async ensure(featureId, memberMmUserIds, create, participantOpUserIds = []) {
      const members = [...new Set(memberMmUserIds)].sort();
      const claim: ZqGroup = {
        featureId,
        groupRef: "",
        memberMmUserIds: members,
        participantOpUserIds: [...new Set(participantOpUserIds)].sort(),
        createdAt: now(),
      };
      if (!(await opts.map.insertIfAbsent(key(featureId), claim))) {
        const existing = (await opts.map.get(key(featureId))) ?? claim;
        const abandoned = !existing.groupRef && now() - existing.createdAt > CLAIM_STALE_MS;
        if (!abandoned) return { group: existing, created: false };
        await opts.map.deleteIf(key(featureId), (g) => !g.groupRef && g.createdAt === existing.createdAt);
        return this.ensure(featureId, memberMmUserIds, create, participantOpUserIds);
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

export function channelRemarkArgs(input: {
  featureId: number;
  channelId: string;
  participantOpUserIds: readonly string[];
}): Record<string, unknown> {
  return {
    feature_id: input.featureId,
    event_kind: "feature_channel_created",
    payload: { channel_id: input.channelId, participant_user_ids: input.participantOpUserIds },
    reason: "QM 创建了功能讨论频道",
    source: { kind: "qm" },
    idempotency_key: `feature-channel-created:${input.featureId}`,
    request_id: `qm-feature-channel-${input.featureId}`,
  };
}
