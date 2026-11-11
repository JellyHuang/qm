import type { App } from "../../api/app-types.ts";
import type { MattermostConfig } from "./config.ts";
import type { IdentityService } from "../../identity/identity-service.ts";
import type { ActorAssertion } from "../../types.ts";
import { errMessage } from "../../util/errors.ts";
import type { MattermostClient } from "./client.ts";
import type { ActionSigner } from "./cards.ts";
import type { Admission, LinkRegistry } from "./identity.ts";
import { principalFor, verifiedEmail } from "./identity.ts";
import {
  displayNameOf,
  kindOfChannelType,
  type MattermostChannel,
  type MattermostKind,
  type MattermostUser,
} from "./protocol.ts";

const USER_TTL_MS = 10 * 60_000;
const CHANNEL_TTL_MS = 5 * 60_000;
const DM_TTL_MS = 60 * 60_000;

export interface ChannelView {
  channel: MattermostChannel;
  kind: MattermostKind;
  name: string;
  memberIds: string[];
  fetchedAt: number;
}

export interface Bot {
  id: string;
  username: string;
  teamId: string;
  teamName: string;
}

export interface Runtime {
  config: MattermostConfig;
  client: MattermostClient;
  app: App;
  identity: IdentityService;
  links: LinkRegistry;
  admission: Admission;
  signer: ActionSigner;
  bot(): Bot;
  setBot(bot: Bot): void;
  user(id: string): Promise<MattermostUser>;
  cachedUsername(id: string): string | undefined;
  users(ids: readonly string[]): Promise<Map<string, MattermostUser>>;
  forgetUser(id: string): void;
  channel(id: string, fresh?: boolean): Promise<ChannelView>;
  forgetChannel(id: string): void;
  dmWith(userId: string): Promise<string>;
  actorFor(user: MattermostUser): Promise<ActorAssertion | null>;
  audienceFor(view: ChannelView): Promise<ActorAssertion[]>;
  mmUserForPrincipal(principalId: string): Promise<MattermostUser | null>;
  allUsers(fresh?: boolean): Promise<MattermostUser[]>;
}

export function createRuntime(deps: {
  config: MattermostConfig;
  client: MattermostClient;
  app: App;
  identity: IdentityService;
  links: LinkRegistry;
  admission: Admission;
  signer: ActionSigner;
  now?: () => number;
}): Runtime {
  const now = deps.now ?? Date.now;
  const { client, links } = deps;
  let bot: Bot | undefined;
  const users = new Map<string, { user: MattermostUser; at: number }>();
  const channels = new Map<string, ChannelView>();
  const dms = new Map<string, { channel: string; at: number }>();
  let roster: { users: MattermostUser[]; at: number } | undefined;

  const remember = (user: MattermostUser): MattermostUser => {
    users.set(user.id, { user, at: now() });
    return user;
  };

  async function user(id: string): Promise<MattermostUser> {
    const hit = users.get(id);
    if (hit && now() - hit.at < USER_TTL_MS) return hit.user;
    return remember(await client.user(id));
  }

  async function usersById(ids: readonly string[]): Promise<Map<string, MattermostUser>> {
    const out = new Map<string, MattermostUser>();
    const missing: string[] = [];
    for (const id of new Set(ids)) {
      const hit = users.get(id);
      if (hit && now() - hit.at < USER_TTL_MS) out.set(id, hit.user);
      else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += 100) {
      for (const u of await client.users(missing.slice(i, i + 100))) out.set(u.id, remember(u));
    }
    return out;
  }

  async function channel(id: string, fresh = false): Promise<ChannelView> {
    const hit = channels.get(id);
    if (!fresh && hit && now() - hit.fetchedAt < CHANNEL_TTL_MS) return hit;
    const [info, memberIds] = await Promise.all([client.channel(id), client.channelMemberIds(id)]);
    const kind = kindOfChannelType(info.type);
    if (!kind) throw new Error(`channel ${id} has an unsupported type ${info.type}`);
    const name = info.display_name || info.name || id;
    const view: ChannelView = { channel: info, kind, name, memberIds, fetchedAt: now() };
    channels.set(id, view);
    return view;
  }

  async function actorFor(u: MattermostUser): Promise<ActorAssertion | null> {
    const link = await links.linkFor(u);
    if (!link) return null;
    try {
      if (!(await deps.admission.admitted(link.email))) return null;
    } catch (e) {
      console.error(`[mattermost] admission check failed for @${u.username}: ${errMessage(e)}`);
      return null;
    }
    return principalFor(link, u);
  }

  async function audienceFor(view: ChannelView): Promise<ActorAssertion[]> {
    const members = await usersById(view.memberIds);
    const out: ActorAssertion[] = [];
    for (const id of view.memberIds) {
      const u = members.get(id);
      if (!u || u.delete_at) continue;
      if (u.is_bot) {
        if (id !== bot?.id)
          out.push({ externalId: `mattermost-bot:${u.id}`, isBot: true, displayName: displayNameOf(u) });
        continue;
      }
      const email = verifiedEmail(u);
      out.push(
        email
          ? { externalId: email, displayName: displayNameOf(u) }
          : { externalId: `mattermost:${u.id}`, isExternalGuest: true, displayName: displayNameOf(u) },
      );
    }
    return out;
  }

  async function allUsers(fresh = false): Promise<MattermostUser[]> {
    if (!fresh && roster && now() - roster.at < USER_TTL_MS) return roster.users;
    const list = await client.allUsers();
    for (const u of list) remember(u);
    roster = { users: list, at: now() };
    return list;
  }

  async function mmUserForPrincipal(principalId: string): Promise<MattermostUser | null> {
    const email = principalId.trim().toLowerCase();
    if (!email.includes("@")) {
      const id = email.startsWith("mattermost:") ? email.slice("mattermost:".length) : email;
      return /^[a-z0-9]{26}$/.test(id) ? user(id).catch(() => null) : null;
    }
    for (const link of await links.linksByEmail(email)) {
      const u = await user(link.mmUserId).catch(() => null);
      if (u && verifiedEmail(u) === email) return u;
    }
    const match = (await allUsers()).filter((u) => verifiedEmail(u) === email);
    return match.length === 1 ? match[0]! : null;
  }

  return {
    config: deps.config,
    client,
    app: deps.app,
    identity: deps.identity,
    links,
    admission: deps.admission,
    signer: deps.signer,
    bot() {
      if (!bot) throw new Error("mattermost bot identity is not loaded yet");
      return bot;
    },
    setBot(b) {
      bot = b;
    },
    user,
    cachedUsername: (id) => users.get(id)?.user.username,
    users: usersById,
    forgetUser: (id) => void users.delete(id),
    channel,
    forgetChannel: (id) => void channels.delete(id),
    async dmWith(userId) {
      const hit = dms.get(userId);
      if (hit && now() - hit.at < DM_TTL_MS) return hit.channel;
      const ch = await client.directChannel(this.bot().id, userId);
      dms.set(userId, { channel: ch.id, at: now() });
      return ch.id;
    },
    actorFor,
    audienceFor,
    mmUserForPrincipal,
    allUsers,
  };
}
