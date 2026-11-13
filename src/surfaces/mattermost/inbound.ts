import type { BlobTransferStore } from "../../persistence/blob-transfer.ts";
import type {
  ActorAssertion,
  ConversationTurn,
  IncomingAttachment,
  OverheardMessage,
  TurnRequest,
} from "../../types.ts";
import type { CachedMessage, IngestEvent } from "../../surface-cache/types.ts";
import { unfinishedTurnText, userFacingFailureClause } from "../../core/failure-copy.ts";
import { REACTION_DETECT_GUIDANCE } from "../../slack/reactions.ts";
import { errMessage, swallowAs } from "../../util/errors.ts";
import { MAX_BLOB_BYTES } from "../../persistence/blob-transfer.ts";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { HANDOFF_INSTRUCTION, REACTION_INSTRUCTION } from "./format.ts";
import type { LivePresenter } from "./live.ts";
import { verifiedEmail } from "./identity.ts";
import type { Onboarding } from "./onboarding.ts";
import {
  displayNameOf,
  editedEventData,
  encodeTarget,
  kindOfChannelType,
  postedEventData,
  postTs,
  reactionEventData,
  shortId,
  SURFACE,
  threadRefFor,
  timezoneOf,
  type MattermostKind,
  type MattermostPost,
  type MattermostUser,
  type WsEvent,
} from "./protocol.ts";
import type { ChannelView, Runtime } from "./runtime.ts";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const CONTEXT_POSTS = 20;
const ROOT_CACHE_MAX = 5_000;
const ACCOUNT = "default";

type Unprompted = "thread" | "reaction";

interface Incoming {
  post: MattermostPost;
  kind: MattermostKind;
  view: ChannelView;
  author: MattermostUser;
  mentioned: boolean;
  unprompted?: Unprompted;
  text: string;
  /** Set for a synthetic turn that continues this post after an OAuth sign-in. */
  resumeKey?: string;
}

function redeliverySuffix(inc: Incoming): string {
  if (inc.resumeKey) return `:${inc.resumeKey}`;
  return inc.unprompted === "reaction" ? ":reaction" : "";
}

function placeLabel(kind: MattermostKind, groupName: string, channelLabel: string): string {
  if (kind === "dm") return "a Mattermost direct message with the user";
  if (kind === "group") return `a Mattermost group message (${groupName})`;
  return `the Mattermost channel ${channelLabel}`;
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createInbound(deps: {
  rt: Runtime;
  live: LivePresenter;
  onboarding: Onboarding;
  blobs: Pick<BlobTransferStore, "put">;
  /** A turn started from this post is now queued as runId. */
  onQueued?: (runId: string, postId: string) => void;
}) {
  const { rt, live } = deps;
  const rootCreatedAt = new Map<string, number>();

  async function rootTs(post: MattermostPost): Promise<string | null> {
    if (!post.root_id) return null;
    let at = rootCreatedAt.get(post.root_id);
    if (at === undefined) {
      const root = await rt.client.post(post.root_id).catch(() => null);
      if (!root) return null;
      at = root.create_at;
      if (rootCreatedAt.size >= ROOT_CACHE_MAX) rootCreatedAt.clear();
      rootCreatedAt.set(post.root_id, at);
    }
    return postTs(post.root_id, at);
  }

  function mentionsBot(post: MattermostPost, mentions: readonly string[] | undefined): boolean {
    const bot = rt.bot();
    const named = new RegExp(`(^|[^\\w.-])@${bot.username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
    if (named.test(post.message)) return true;
    const broadcast = /(^|\s)@(channel|all|here)\b/i.test(post.message);
    return !broadcast && (mentions ?? []).includes(bot.id);
  }

  function stripBotMention(text: string): string {
    const bot = rt.bot();
    return text
      .replace(new RegExp(`(^|\\s)@${bot.username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[:,]?`, "gi"), "$1")
      .trim();
  }

  async function mirror(
    post: MattermostPost,
    view: ChannelView | null,
    extra: Partial<IngestEvent> = {},
  ): Promise<void> {
    if (post.type && !post.type.startsWith("custom_")) return;
    if (post.props?.["qm_placeholder"] === true) return;
    const self = post.user_id === rt.bot().id;
    const author = self ? undefined : await rt.user(post.user_id).catch(() => undefined);
    const sub = await rootTs(post);
    const authorKey = author ? (verifiedEmail(author) ?? `mattermost:${author.id}`) : post.user_id;
    const event: IngestEvent = {
      surface: SURFACE,
      container: post.channel_id,
      ts: postTs(post.id, post.create_at),
      sub,
      authorId: self ? "self" : authorKey,
      ...(author ? { authorName: displayNameOf(author) } : {}),
      text: post.message,
      ...(self ? { self: true, bot: true, handled: true } : {}),
      ...(author?.is_bot ? { bot: true } : {}),
      createdAt: post.create_at,
      ...(post.metadata?.files?.length
        ? {
            files: post.metadata.files.map((f) => ({
              fileId: f.id,
              name: f.name,
              size: f.size,
              ...(f.mime_type ? { mimetype: f.mime_type } : {}),
            })),
          }
        : {}),
      ...(view ? { kind: view.kind, containerName: view.name } : {}),
      ...extra,
    };
    await rt.app.ingestSurfaceEvents([event], SURFACE);
  }

  async function threadEngaged(post: MattermostPost): Promise<boolean> {
    const sub = await rootTs(post);
    if (!sub) return false;
    const msgs = await rt.app
      .readSurfaceMessages(post.channel_id, { surface: SURFACE, sub, limit: 200, noFallback: true })
      .catch(() => [] as CachedMessage[]);
    if (msgs.some((m) => m.self || m.mentionsSelf)) return true;
    const [root] = await rt.app
      .readSurfaceMessages(post.channel_id, { surface: SURFACE, timestamps: [sub], limit: 1, noFallback: true })
      .catch(() => [] as CachedMessage[]);
    return root?.self === true || root?.mentionsSelf === true;
  }

  async function conversationContext(
    inc: Incoming,
  ): Promise<{ header: string; priorTurns: ConversationTurn[]; overheard: OverheardMessage[]; allowed: Set<string> }> {
    const root = inc.post.root_id || (inc.kind === "dm" ? "" : inc.post.id);
    const fetched: MattermostPost[] = root
      ? await rt.client.thread(root).catch(() => [])
      : await rt.client.channelPosts(inc.post.channel_id, { perPage: CONTEXT_POSTS + 1 }).catch(() => []);
    const posts = fetched
      .filter((p) => p.id !== inc.post.id && (!p.type || p.type.startsWith("custom_")) && !p.props?.["qm_placeholder"])
      .sort((a, b) => a.create_at - b.create_at)
      .slice(-CONTEXT_POSTS);
    const people = await rt.users(posts.map((p) => p.user_id).filter((id) => id !== rt.bot().id));
    const allowed = new Set<string>([inc.post.id]);
    const turns: ConversationTurn[] = [];
    const overheard: OverheardMessage[] = [];
    for (const p of posts) {
      allowed.add(p.id);
      const self = p.user_id === rt.bot().id;
      const name = self
        ? undefined
        : displayNameOf(people.get(p.user_id) ?? { username: p.user_id, first_name: "", last_name: "", nickname: "" });
      const files = p.metadata?.files?.map((f) => f.name).filter(Boolean) ?? [];
      const body = `[${shortId(p.id)}] ${p.message}${files.length ? ` (files: ${files.join(", ")})` : ""}`;
      const prev = turns.at(-1);
      if (self) {
        if (prev?.role === "assistant") prev.text = `${prev.text}\n${body}`;
        else turns.push({ role: "assistant", text: body });
      } else if (prev?.role === "user") {
        prev.text = `${prev.name ? `${prev.name}: ` : ""}${prev.text}\n${name}: ${body}`;
        delete prev.name;
      } else turns.push({ role: "user", ...(name ? { name } : {}), text: body });
      overheard.push({
        ts: postTs(p.id, p.create_at),
        role: self ? "self" : "user",
        ...(name ? { name } : {}),
        text: p.message,
        ...(files.length ? { files } : {}),
      });
    }
    let where = `You are in ~${inc.view.channel.name || inc.view.name}${inc.view.channel.type === "P" ? " (private channel)" : ""} on Mattermost.`;
    if (inc.kind === "dm") where = "This is a Mattermost direct message.";
    if (inc.kind === "group") where = "This is a Mattermost group message.";
    const here = root ? "You are replying in a thread." : "You are replying to a top-level message.";
    return {
      header: `${where} ${here} The message you're answering is [${shortId(inc.post.id)}].`,
      priorTurns: turns,
      overheard,
      allowed,
    };
  }

  async function inboundFiles(post: MattermostPost, author: string) {
    const attachments: IncomingAttachment[] = [];
    const notes: string[] = [];
    const ids = post.file_ids ?? post.metadata?.files?.map((f) => f.id) ?? [];
    for (const id of ids.slice(0, MAX_FILES)) {
      try {
        const info = post.metadata?.files?.find((f) => f.id === id) ?? (await rt.client.fileInfo(id));
        if (info.size > MAX_FILE_BYTES) {
          notes.push(`skipped "${info.name}" — it's larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
          continue;
        }
        const bytes = await rt.client.download(id, Math.min(MAX_FILE_BYTES, MAX_BLOB_BYTES));
        const staged = await deps.blobs.put(Readable.from([Buffer.from(bytes)]), {
          maxBytes: MAX_BLOB_BYTES,
          expectedSha256: hash(bytes),
        });
        attachments.push({
          name: info.name || id,
          mimetype: info.mime_type || "application/octet-stream",
          sizeBytes: bytes.length,
          blobId: staged.blobId,
          sourceId: id,
          author,
        });
      } catch (e) {
        notes.push(`couldn't read an attached file (${errMessage(e)})`);
      }
    }
    if (ids.length > MAX_FILES) notes.push(`only the first ${MAX_FILES} files were read`);
    return { attachments, notes };
  }

  async function reply(inc: Pick<Incoming, "post" | "kind">, text: string): Promise<void> {
    const root = inc.kind === "dm" ? inc.post.root_id || undefined : inc.post.root_id || inc.post.id;
    await rt.client
      .createPost({ channel_id: inc.post.channel_id, message: text, ...(root ? { root_id: root } : {}) })
      .catch(swallowAs("mattermost: notice reply", undefined));
  }

  async function submit(inc: Incoming, actor: ActorAssertion): Promise<void> {
    const bot = rt.bot();
    const { post, kind, view } = inc;
    const replyRoot = kind === "dm" ? post.root_id || undefined : post.root_id || post.id;
    const ts = postTs(post.id, post.create_at);
    const threadRef =
      kind === "dm"
        ? threadRefFor("dm", post.channel_id, post.root_id || undefined)
        : threadRefFor(kind, post.channel_id, replyRoot);
    const audience = kind === "dm" ? [actor] : await rt.audienceFor(view);
    if (audience.some((a) => a.isExternalGuest)) {
      if (!inc.unprompted)
        await rt.client
          .ephemeral(post.user_id, {
            channel_id: post.channel_id,
            message: "I can't respond here — someone in this conversation has no verified company email. Try a DM.",
            ...(replyRoot ? { root_id: replyRoot } : {}),
          })
          .catch(swallowAs("mattermost: ephemeral", undefined));
      return;
    }
    const addressed = !inc.unprompted;
    const trigger = { channel: post.channel_id, ...(replyRoot ? { root: replyRoot } : {}), triggerPostId: post.id };
    if (addressed) await live.ack(trigger);
    const context = kind !== "dm" || post.root_id ? await conversationContext(inc).catch(() => null) : null;
    const files = inc.resumeKey
      ? { attachments: [], notes: [] }
      : await inboundFiles(post, actor.displayName ?? actor.externalId);
    if (inc.unprompted && !inc.text && !files.attachments.length) return;
    const deliveryTarget = encodeTarget({ channel: post.channel_id, ...(replyRoot ? { root: replyRoot } : {}) });
    const channelLabel = view.channel.name ? `~${view.channel.name}` : view.name;
    const timezone = timezoneOf(inc.author);
    const request: TurnRequest = {
      surface: SURFACE,
      actor,
      surfaceOrigin: {
        author: { surface: SURFACE, account: ACCOUNT, id: post.user_id },
        workspace: bot.teamId,
        ...(replyRoot ? { replyThread: replyRoot } : {}),
        audience: "internal",
      },
      conversation: {
        kind,
        threadRef,
        ...(kind !== "dm"
          ? {
              channelRef: post.channel_id,
              channelName: kind === "channel" ? view.channel.name || view.name : view.name,
            }
          : {}),
        audience,
        ...(kind !== "dm" ? { isPrivate: view.channel.type !== "O" } : {}),
        ...(kind === "group" ? { isMpim: true } : {}),
      },
      deliveryTarget,
      ...(kind !== "dm" && replyRoot
        ? {
            deliveryCandidates: [
              { target: deliveryTarget, label: "this thread" },
              {
                target: post.channel_id,
                label: `${channelLabel} (the whole ${kind === "group" ? "group" : "channel"})`,
              },
            ],
          }
        : {}),
      text: inc.text,
      gatewayContext: {
        location: placeLabel(kind, view.name, channelLabel),
        details: { channel: post.channel_id, ...(replyRoot ? { thread_root: replyRoot } : {}) },
        instructions: kind === "dm" ? REACTION_INSTRUCTION : `${REACTION_INSTRUCTION}\n\n${HANDOFF_INSTRUCTION}`,
        reactionGuidance: REACTION_DETECT_GUIDANCE,
        botHandle: `@${bot.username}`,
      },
      origin: addressed ? { kind: "human", messageTs: ts } : { kind: "ambient", entryTs: ts, live: true },
      ...(context?.header ? { conversationHeader: context.header } : {}),
      ...(context?.priorTurns.length ? { priorTurns: context.priorTurns } : {}),
      ...(context?.overheard.length ? { overheard: context.overheard } : {}),
      ...(context && !addressed
        ? {
            detectContext: context.overheard
              .filter((m) => m.role === "user")
              .map((m) => `${m.name ?? "someone"}: ${m.text}`)
              .join("\n"),
          }
        : {}),
      ...(files.attachments.length ? { attachments: files.attachments } : {}),
      ...(files.notes.length ? { inboundNotes: files.notes } : {}),
      ...(timezone ? { timezone } : {}),
      redeliveryKey: `${SURFACE}:${post.id}${redeliverySuffix(inc)}`,
      async: true,
    };
    let result;
    try {
      result = await rt.app.turn(request);
    } catch (e) {
      console.error(`[mattermost] turn failed for post ${post.id}: ${errMessage(e)}`);
      if (addressed) {
        await live.unack(trigger);
        await reply(inc, "⚠️ Something went wrong on my side — please try again in a moment.");
      }
      return;
    }
    if (result.status === "queued" && result.runId && !result.steered) {
      deps.onQueued?.(result.runId, post.id);
      await live.begin(result.runId, trigger, { placeholder: addressed });
      return;
    }
    if (addressed) await live.unack(trigger);
    if (addressed && result.status === "refused") await reply(inc, unfinishedTurnText(userFacingFailureClause(result)));
    if (addressed && result.status === "pending_approval")
      await reply(inc, result.reason ?? "This conversation is waiting on a pending approval.");
  }

  async function command(inc: Incoming): Promise<boolean> {
    if (inc.kind !== "dm") return false;
    const word = inc.text.trim().toLowerCase();
    if (word === "unlink" || word === "disconnect") {
      const removed = await rt.links.unlink(inc.author.id);
      await reply(
        inc,
        removed
          ? `Disconnected. This Mattermost account is no longer linked to QM account **${removed.email}**. Message me again any time to reconnect.`
          : "This Mattermost account isn't linked to QM.",
      );
      return true;
    }
    if (word === "whoami") {
      const link = await rt.links.linkFor(inc.author);
      await reply(
        inc,
        link ? `You're linked to QM account **${link.email}**.` : "This Mattermost account isn't linked to QM yet.",
      );
      return true;
    }
    return false;
  }

  async function inject(postId: string, note: (authorName: string) => string, key: string): Promise<void> {
    const post = await rt.client.post(postId);
    const view = await rt.channel(post.channel_id);
    const author = await rt.user(post.user_id);
    if (author.is_bot || author.delete_at) return;
    const actor = await rt.actorFor(author);
    if (!actor) return;
    await submit(
      { post, kind: view.kind, view, author, mentioned: true, text: note(displayNameOf(author)), resumeKey: key },
      actor,
    );
  }

  async function onPosted(ev: WsEvent, replay = false): Promise<void> {
    const parsed = postedEventData.safeParse(ev.data);
    if (!parsed.success) return;
    const { post, mentions } = parsed.data;
    const kind = kindOfChannelType(parsed.data.channel_type);
    if (!kind) return;
    const view = await rt.channel(post.channel_id).catch((e: unknown) => {
      console.error(`[mattermost] couldn't read channel ${post.channel_id}: ${errMessage(e)}`);
      return null;
    });
    const mentioned = post.user_id !== rt.bot().id && mentionsBot(post, mentions);
    if (!replay)
      await mirror(post, view, mentioned ? { mentionsSelf: true } : {}).catch(
        swallowAs("mattermost: mirror", undefined),
      );
    if (!view || post.user_id === rt.bot().id || (post.type && !post.type.startsWith("custom_"))) return;
    if (post.props?.["from_webhook"] === "true" || post.props?.["from_bot"] === "true") return;
    const author = await rt.user(post.user_id).catch(() => null);
    if (!author || author.is_bot || author.delete_at) return;
    const text = kind === "dm" ? post.message.trim() : stripBotMention(post.message);
    let unprompted: Unprompted | undefined;
    if (kind !== "dm" && !mentioned) {
      if (!post.root_id || !(await threadEngaged(post))) return;
      unprompted = "thread";
    }
    const inc: Incoming = { post, kind, view, author, mentioned, text, ...(unprompted ? { unprompted } : {}) };
    if (!unprompted && (await command(inc))) return;
    const actor = await rt.actorFor(author);
    if (!actor) {
      if (!unprompted) await deps.onboarding.begin(author, inc, ev);
      return;
    }
    await submit(inc, actor);
  }

  async function onEdited(ev: WsEvent): Promise<void> {
    const parsed = editedEventData.safeParse(ev.data);
    if (!parsed.success) return;
    const view = await rt.channel(parsed.data.post.channel_id).catch(() => null);
    await mirror(parsed.data.post, view, { editedAt: Date.now() });
  }

  async function onDeleted(ev: WsEvent): Promise<void> {
    const parsed = editedEventData.safeParse(ev.data);
    if (!parsed.success) return;
    await mirror(parsed.data.post, null, { deleted: true });
  }

  async function onReaction(ev: WsEvent): Promise<void> {
    const parsed = reactionEventData.safeParse(ev.data);
    if (!parsed.success) return;
    const { reaction } = parsed.data;
    if (reaction.user_id === rt.bot().id) return;
    const post = await rt.client.post(reaction.post_id).catch(() => null);
    if (!post || post.user_id !== rt.bot().id || post.props?.["attachments"]) return;
    const view = await rt.channel(post.channel_id).catch(() => null);
    if (!view) return;
    const author = await rt.user(reaction.user_id).catch(() => null);
    if (!author || author.is_bot) return;
    const actor = await rt.actorFor(author);
    if (!actor) return;
    const quote = post.message.length > 300 ? `${post.message.slice(0, 300)}…` : post.message;
    const text = `[Mattermost reaction] ${displayNameOf(author)} reacted with :${reaction.emoji_name}: on your message [${shortId(post.id)}]: "${quote}"`;
    await submit({ post, kind: view.kind, view, author, mentioned: false, text, unprompted: "reaction" }, actor);
  }

  return {
    async handle(ev: WsEvent): Promise<void> {
      switch (ev.event) {
        case "posted":
          return onPosted(ev);
        case "post_edited":
          return onEdited(ev);
        case "post_deleted":
          return onDeleted(ev);
        case "reaction_added":
          return onReaction(ev);
        case "user_added":
        case "user_removed":
        case "channel_updated":
        case "channel_converted":
        case "channel_member_updated":
          if (ev.broadcast.channel_id) rt.forgetChannel(ev.broadcast.channel_id);
          return;
        case "user_updated":
          if (typeof (ev.data["user"] as { id?: unknown } | undefined)?.id === "string")
            rt.forgetUser((ev.data["user"] as { id: string }).id);
          return;
        default:
          return;
      }
    },
    replay: (ev: WsEvent) => onPosted(ev, true),
    /** Continue the request in `postId`'s conversation after its author connected `serverId`. */
    async resume(postId: string, serverId: string): Promise<void> {
      await inject(
        postId,
        (name) =>
          `[QM system note, not typed by the user] ${name} has just connected their own "${serverId}" account. Continue the request in this conversation that was waiting for that sign-in, using their connection.`,
        `resume:${serverId}:${Date.now()}`,
      );
    },
    /** Start a turn in `postId`'s conversation, as that post's author, with a system note as its text. */
    async inject(postId: string, note: string, key: string): Promise<void> {
      await inject(postId, () => note, key);
    },
    submit,
    reply,
  };
}

export type Inbound = ReturnType<typeof createInbound>;
export type { Incoming };
