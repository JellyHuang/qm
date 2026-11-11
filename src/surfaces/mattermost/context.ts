import type { SurfaceContextQuery, SurfaceContextResult } from "../../reach/reach.ts";
import { buildContextWindow } from "../context-window.ts";
import { errMessage, reportFailureAs } from "../../util/errors.ts";
import { displayNameOf, parseTarget, postIdOf, postTs, SURFACE, type MattermostPost } from "./protocol.ts";
import { verifiedEmail } from "./identity.ts";
import type { Runtime } from "./runtime.ts";

const DEFAULT_COUNT = 100;
const SCAN = 200;
const CLIP = 2_000;

export function createContextAnswers(deps: { rt: Runtime; syncDirectory: () => Promise<void> }) {
  const { rt } = deps;

  async function render(posts: MattermostPost[], query: SurfaceContextQuery, scanHasMore: boolean) {
    const visible = posts.filter((p) => (!p.type || p.type.startsWith("custom_")) && !p.props?.["qm_placeholder"]);
    const people = await rt.users(visible.map((p) => p.user_id).filter((id) => id !== rt.bot().id));
    const rootAt = new Map(visible.map((p) => [p.id, p.create_at] as const));
    return buildContextWindow(
      visible.map((p) => {
        const self = p.user_id === rt.bot().id;
        const author = people.get(p.user_id);
        const authorName = author ? displayNameOf(author) : p.user_id;
        const parentAt = p.root_id ? rootAt.get(p.root_id) : undefined;
        return {
          ts: postTs(p.id, p.create_at),
          name: self ? "you" : authorName,
          text: p.message,
          ...(self ? { isSelf: true } : {}),
          ...(p.root_id && parentAt !== undefined ? { parentTs: postTs(p.root_id, parentAt) } : {}),
          ...(p.metadata?.files?.length ? { files: p.metadata.files.map((f) => f.name) } : {}),
        };
      }),
      {
        count: query.count ?? DEFAULT_COUNT,
        ...(query.match ? { match: query.match } : {}),
        scanHasMore,
        clipChars: CLIP,
      },
    );
  }

  async function readable(channelId: string, viewer: string | undefined, current: boolean): Promise<string | null> {
    const view = await rt.channel(channelId).catch(() => null);
    if (!view) return "I'm not in that channel, so I can't read it.";
    if (!view.memberIds.includes(rt.bot().id)) return "I'm not a member of that channel, so I can't read it.";
    if (current || view.channel.type === "O") return null;
    if (!viewer) return "That conversation is private.";
    const members = await rt.users(view.memberIds);
    const ok = [...members.values()].some((u) => verifiedEmail(u) === viewer.trim().toLowerCase());
    return ok ? null : "That conversation is private and you're not in it.";
  }

  async function answer(query: SurfaceContextQuery): Promise<SurfaceContextResult> {
    if (query.syncDirectory) {
      await deps.syncDirectory();
      return { messages: [] };
    }
    if (query.openGroup) {
      const ids: string[] = [];
      for (const principal of query.openGroup.participants) {
        const u = await rt.mmUserForPrincipal(principal);
        if (!u) return { messages: [], note: `no Mattermost account matches ${principal}` };
        ids.push(u.id);
      }
      const unique = [...new Set([...ids, rt.bot().id])];
      if (unique.length < 3) return { messages: [], note: "a group message needs at least two other people" };
      const ch = await rt.client.groupChannel(unique);
      return { messages: [], group: { groupId: ch.id } };
    }
    const target = query.conversationTarget ? parseTarget(query.conversationTarget) : null;
    const channelId = target?.channel ?? query.channelId;
    if (!channelId) return { messages: [], note: "this conversation can't be read" };
    const denied = await readable(channelId, query.viewer, Boolean(target));
    if (denied) return { messages: [], note: denied };
    const before = query.before ? postIdOf(query.before) : null;
    let posts: MattermostPost[];
    let more = false;
    if (target?.root) {
      posts = await rt.client.thread(target.root);
      posts.sort((a, b) => a.create_at - b.create_at);
      if (before) {
        const cut = posts.findIndex((p) => p.id === before);
        if (cut >= 0) posts = posts.slice(0, cut);
      }
    } else {
      posts = await rt.client.channelPosts(channelId, { perPage: SCAN, ...(before ? { before } : {}) });
      more = posts.length >= SCAN;
    }
    return render(posts, query, more);
  }

  return {
    attach() {
      rt.app.onContextRequestCreated((request) => {
        if (request.source !== SURFACE) return;
        void answer(request.query)
          .then((result) => rt.app.fulfillContextRequest(request.id, { result }))
          .catch((e: unknown) =>
            rt.app
              .fulfillContextRequest(request.id, { error: errMessage(e) })
              .catch(reportFailureAs("mattermost: fail context request", undefined)),
          );
      });
    },
    async drainPending(): Promise<void> {
      for (const request of await rt.app.pendingContextRequests(SURFACE)) {
        await answer(request.query)
          .then((result) => rt.app.fulfillContextRequest(request.id, { result }))
          .catch((e: unknown) => rt.app.fulfillContextRequest(request.id, { error: errMessage(e) }))
          .catch(reportFailureAs("mattermost: drain context request", undefined));
      }
    },
  };
}
