import type { DirectoryChannel, DirectoryMember } from "../../directory/directory-store.ts";
import { errMessage } from "../../util/errors.ts";
import { verifiedEmail } from "./identity.ts";
import { displayNameOf } from "./protocol.ts";
import type { Runtime } from "./runtime.ts";

const MIN_MEMBERS_FOR_SYNC = 1;

export function createDirectorySync(deps: { rt: Runtime }) {
  const { rt } = deps;

  async function sync(): Promise<{ members: number; channels: number; groups: number }> {
    const bot = rt.bot();
    const users = await rt.allUsers(true);
    const emailById = new Map<string, string>();
    const members: DirectoryMember[] = [];
    for (const u of users) {
      if (u.is_bot || u.delete_at) continue;
      const email = verifiedEmail(u);
      if (!email || emailById.has(u.id)) continue;
      emailById.set(u.id, email);
      members.push({ principalId: email, displayName: displayNameOf(u), type: "internal" });
    }
    if (members.length < MIN_MEMBERS_FOR_SYNC)
      throw new Error("Mattermost returned no members; skipping directory sync");
    const channels = await rt.client.myChannels(bot.teamId);
    const directoryChannels: DirectoryChannel[] = [];
    const channelMembers: Array<{ channelId: string; principalId: string }> = [];
    const groupMembers: Array<{ groupId: string; principalId: string }> = [];
    const groupIds: string[] = [];
    for (const ch of channels) {
      if (ch.delete_at) continue;
      if (ch.type !== "O" && ch.type !== "P" && ch.type !== "G") continue;
      const ids = await rt.client.channelMemberIds(ch.id);
      const emails = ids.map((id) => emailById.get(id)).filter((e): e is string => Boolean(e));
      if (ch.type === "G") {
        groupIds.push(ch.id);
        for (const principalId of emails) groupMembers.push({ groupId: ch.id, principalId });
        continue;
      }
      directoryChannels.push({
        channelId: ch.id,
        name: ch.name || ch.display_name,
        ...(ch.type === "P" ? { isPrivate: true } : {}),
      });
      for (const principalId of emails) channelMembers.push({ channelId: ch.id, principalId });
    }
    const at = Date.now();
    await rt.app.setDirectoryWorkspaceUrl(`${rt.client.baseUrl}/${bot.teamName}`);
    await rt.app.upsertDirectory(members, at);
    await rt.app.upsertChannels(
      directoryChannels,
      channelMembers,
      at,
      directoryChannels.map((c) => c.channelId),
    );
    await rt.app.upsertGroups(groupMembers, at, groupIds, groupIds);
    return { members: members.length, channels: directoryChannels.length, groups: groupIds.length };
  }

  return {
    async run(): Promise<void> {
      try {
        const counts = await sync();
        console.log(
          `[mattermost] directory synced: ${counts.members} people, ${counts.channels} channels, ${counts.groups} group messages`,
        );
      } catch (e) {
        console.error(`[mattermost] directory sync failed: ${errMessage(e)}`);
      }
    },
  };
}
