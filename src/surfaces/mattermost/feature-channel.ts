import { MattermostHttpError, type MattermostClient } from "./client.ts";

const DISPLAY_NAME_MAX = 64;
const PURPOSE_MAX = 250;

export interface FeatureChannelInput {
  id: number;
  subject: string;
  url?: string;
}

export function featureChannelName(featureId: number): string {
  return `zq-feature-${featureId}`;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

export async function createFeatureChannel(
  client: MattermostClient,
  teamId: string,
  feature: FeatureChannelInput,
  memberMmUserIds: readonly string[],
): Promise<string> {
  const name = featureChannelName(feature.id);
  const input = {
    teamId,
    name,
    displayName: clip(`功能 #${feature.id} ${feature.subject}`, DISPLAY_NAME_MAX),
    purpose: clip(`功能「${feature.subject}」(#${feature.id})的讨论频道`, PURPOSE_MAX),
    ...(feature.url ? { header: `OpenProject 工作项:${feature.url}` } : {}),
  };
  const channel = await client.createPrivateChannel(input).catch(async (e: unknown) => {
    if (e instanceof MattermostHttpError && (e.status === 400 || e.status === 409))
      return client.channelByName(teamId, name);
    throw e;
  });
  for (const userId of new Set(memberMmUserIds)) await client.addChannelMember(channel.id, userId);
  return channel.id;
}
