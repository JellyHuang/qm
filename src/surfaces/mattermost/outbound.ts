import type { Send } from "../../delivery/relay.ts";
import type { KeychainApprovals } from "../../credentials/keychain-approval.ts";
import { approvalDeliveryKey } from "../../slack/approval-store.ts";
import { samePerson } from "../../directory/person.ts";
import type { BlobTransferStore } from "../../persistence/blob-transfer.ts";
import type { Delivery, OutgoingAttachment } from "../../types.ts";
import { errMessage, swallowAs } from "../../util/errors.ts";
import { trimTrailingSlashes } from "../../util/text.ts";
import { buffer } from "node:stream/consumers";
import { MattermostHttpError } from "./client.ts";
import { approvalCard, cardProps, deployAccessCard, keychainCard, type Card } from "./cards.ts";
import { chunks, cleanReply, deliveryFooter, normalizeEmoji, reactionTargets, withFooter } from "./format.ts";
import type { LivePresenter } from "./live.ts";
import { parseTarget, postIdOf, SURFACE, threadRefFor, type MattermostPost } from "./protocol.ts";
import type { Runtime } from "./runtime.ts";

const MAX_FILES_PER_POST = 10;
const RETRY_PROBE_AFTER_MS = 20_000;
const RETRY_PROBE_WINDOW_MS = 10 * 60_000;
export const MATTERMOST_CLAIM_MS = 60_000;

class Refused extends Error {}

interface Place {
  channel: string;
  root?: string;
  dm?: boolean;
}

function refusedHttp(e: unknown): boolean {
  return e instanceof MattermostHttpError && [400, 403, 404, 413].includes(e.status);
}

export function createMattermostSender(deps: {
  rt: Runtime;
  live: LivePresenter;
  blobs: Pick<BlobTransferStore, "open">;
  openArtifact: (artifactId: string, viewerId: string) => Promise<Buffer | null>;
  keychainApprovals?: KeychainApprovals;
}): Send {
  const { rt, live } = deps;
  const webBase = rt.config.publicWebUrl ? trimTrailingSlashes(rt.config.publicWebUrl) : undefined;

  async function rootOf(postRef: string | undefined): Promise<string | undefined> {
    if (!postRef) return undefined;
    const id = postIdOf(postRef);
    if (!id) throw new Refused(`bad thread reference ${postRef}`);
    const post = await rt.client.post(id).catch((e: unknown) => {
      if (refusedHttp(e)) throw new Refused(`thread ${id} is gone`);
      throw e;
    });
    return post.root_id || post.id;
  }

  async function place(d: Delivery): Promise<Place> {
    const dest = d.destination;
    if (dest.type === "principal") {
      const user = await rt.mmUserForPrincipal(dest.target);
      if (!user) throw new Refused(`no Mattermost account matches ${dest.target}`);
      if (user.id === rt.bot().id) throw new Refused("can't DM the bot itself");
      const channel = await rt.dmWith(user.id);
      const root = await rootOf(dest.threadTs);
      return { channel, ...(root ? { root } : {}), dm: true };
    }
    const target = parseTarget(dest.target);
    if (!target) throw new Refused(`unroutable ${dest.type} target ${dest.target}`);
    const root = await rootOf(dest.threadTs ?? target.root);
    return { channel: target.channel, ...(root ? { root } : {}) };
  }

  async function readAttachment(a: OutgoingAttachment): Promise<Buffer | null> {
    const blob = await deps.blobs.open(a.blobId).catch(() => null);
    if (blob) return buffer(blob.stream);
    if (a.artifactId && a.artifactViewerId) return deps.openArtifact(a.artifactId, a.artifactViewerId);
    return null;
  }

  async function uploadAll(channel: string, attachments: readonly OutgoingAttachment[] | undefined) {
    const ids: string[] = [];
    const failed: string[] = [];
    for (const a of attachments ?? []) {
      try {
        const bytes = await readAttachment(a);
        if (!bytes?.length) {
          failed.push(a.name);
          continue;
        }
        ids.push(await rt.client.upload(channel, a.name, bytes, a.mimetype));
      } catch (e) {
        console.error(`[mattermost] upload of ${a.name} failed: ${errMessage(e)}`);
        failed.push(a.name);
      }
    }
    return { ids, failed };
  }

  async function findKeyed(channel: string, key: string, since: number): Promise<MattermostPost | undefined> {
    const posts = await rt.client
      .channelPosts(channel, { since, perPage: 200 })
      .catch(swallowAs("mattermost: keyed post probe", [] as MattermostPost[]));
    return posts.find((post) => post.user_id === rt.bot().id && post.props?.["qm_key"] === key);
  }

  async function alreadyPosted(d: Delivery, p: Place): Promise<MattermostPost | undefined> {
    if (Date.now() - d.createdAt < RETRY_PROBE_AFTER_MS) return undefined;
    return findKeyed(p.channel, d.idempotencyKey, Math.max(d.createdAt - 60_000, Date.now() - RETRY_PROBE_WINDOW_MS));
  }

  async function postMessage(
    d: Delivery,
    p: Place,
    text: string,
    opts: { editRef?: string; attachments?: readonly OutgoingAttachment[]; props?: Record<string, unknown> } = {},
  ): Promise<string | undefined> {
    const reused = await alreadyPosted(d, p);
    if (reused) return reused.id;
    const parts = text.trim() ? chunks(text) : [];
    const files = await uploadAll(p.channel, opts.attachments);
    if (files.failed.length) parts.push(`_I couldn't attach ${files.failed.join(", ")} — ask me to send it again._`);
    const keyed = { qm_key: d.idempotencyKey, ...opts.props };
    let first: string | undefined;
    let fileIds = files.ids.slice(0, MAX_FILES_PER_POST);
    let rest = files.ids.slice(MAX_FILES_PER_POST);
    if (!parts.length && !fileIds.length) {
      if (opts.editRef)
        await rt.client.deletePost(opts.editRef).catch(swallowAs("mattermost: drop placeholder", undefined));
      return undefined;
    }
    if (opts.editRef) {
      try {
        await rt.client.patchPost(opts.editRef, { message: parts[0] ?? "", props: keyed });
        first = opts.editRef;
        parts.shift();
      } catch (e) {
        swallowAs("mattermost: finalize placeholder", undefined)(e);
        await rt.client.deletePost(opts.editRef).catch(swallowAs("mattermost: drop placeholder", undefined));
      }
    }
    const root = p.root;
    const threadUnder = (head: string | undefined): string | undefined => root ?? (head && !p.dm ? head : undefined);
    while (parts.length || fileIds.length) {
      const message = parts.shift() ?? "";
      const post = await rt.client.createPost({
        channel_id: p.channel,
        message,
        ...(threadUnder(first) ? { root_id: threadUnder(first)! } : {}),
        ...(fileIds.length && !parts.length ? { file_ids: fileIds } : {}),
        props: keyed,
      });
      if (fileIds.length && !parts.length) {
        fileIds = rest.slice(0, MAX_FILES_PER_POST);
        rest = rest.slice(MAX_FILES_PER_POST);
      }
      first ??= post.id;
    }
    return first;
  }

  async function postCard(d: Delivery, p: Place, card: Card): Promise<string> {
    const reused = await alreadyPosted(d, p);
    if (reused) return reused.id;
    const post = await rt.client.createPost({
      channel_id: p.channel,
      message: "",
      ...(p.root ? { root_id: p.root } : {}),
      props: { qm_key: d.idempotencyKey, ...cardProps(card, rt.signer, rt.config.actionUrl) },
    });
    return post.id;
  }

  async function ownPost(ref: string): Promise<string> {
    const id = postIdOf(ref);
    if (!id) throw new Refused(`bad message reference ${ref}`);
    const post = await rt.client.post(id).catch((e: unknown) => {
      if (refusedHttp(e)) throw new Refused(`message ${id} is gone`);
      throw e;
    });
    if (post.user_id !== rt.bot().id) throw new Refused("I can only change my own messages");
    return id;
  }

  async function react(postRef: string, names: readonly string[]): Promise<void> {
    const id = postIdOf(postRef);
    if (!id) throw new Refused(`bad message reference ${postRef}`);
    for (const raw of names) {
      const emoji = normalizeEmoji(raw);
      if (!emoji) continue;
      await rt.client.addReaction(rt.bot().id, id, emoji).catch((e: unknown) => {
        if (!refusedHttp(e)) throw e;
        console.error(`[mattermost] reaction :${emoji}: on ${id} refused: ${errMessage(e)}`);
      });
    }
  }

  async function deliverRun(d: Delivery, p: Place, runId: string): Promise<void> {
    const turn = await live.settle(runId);
    const { text, reactions } = cleanReply(d.text);
    await postMessage(d, p, text ? withFooter(text, deliveryFooter(d, webBase)) : "", {
      ...(d.destination.editRef ? { editRef: d.destination.editRef } : {}),
      ...(d.attachments?.length ? { attachments: d.attachments } : {}),
    });
    const trigger = turn?.triggerPostId;
    if (trigger && reactions.length) {
      for (const t of reactionTargets(reactions, trigger, new Set([trigger]))) await react(t.postId, t.names);
    }
    if (turn) await live.unack(turn);
  }

  async function deliver(d: Delivery): Promise<void> {
    const dest = d.destination;
    const p = await place(d);
    if (dest.keychainAskId) {
      const view = await deps.keychainApprovals?.card(dest.keychainAskId);
      if (!view) return;
      const origin = webBase && view.sessionId ? `${webBase}/s/${encodeURIComponent(view.sessionId)}` : undefined;
      const card = keychainCard(view, origin);
      const noticeKey = `ask:${dest.keychainAskId}:notice`;
      if (d.idempotencyKey === noticeKey) {
        await postCard(d, p, card);
        return;
      }
      const posted = await findKeyed(p.channel, noticeKey, view.ask.createdAt - 60_000);
      if (posted)
        await rt.client.patchPost(posted.id, {
          message: "",
          props: { qm_key: noticeKey, ...cardProps(card, rt.signer, rt.config.actionUrl) },
        });
      return;
    }
    if (dest.commandApprovalId) {
      const approval = await rt.app.getApproval(dest.commandApprovalId);
      const requester = approval?.request?.actor.externalId;
      if (
        !approval ||
        !requester ||
        !samePerson(requester, dest.target) ||
        d.idempotencyKey !== approvalDeliveryKey(dest.commandApprovalId, approval)
      )
        return;
      const origin =
        webBase && approval.sessionId ? `${webBase}/s/${encodeURIComponent(approval.sessionId)}` : undefined;
      await postCard(d, p, approvalCard({ ...approval, reason: approval.reason ?? "Approval required" }, origin));
      return;
    }
    if (dest.deploymentAccess) {
      await postCard(d, p, deployAccessCard(JSON.stringify(dest.deploymentAccess), d.text));
      return;
    }
    if (dest.react) {
      await react(dest.react.messageTs, [dest.react.emoji]);
      return;
    }
    if (dest.pin) {
      const id = postIdOf(dest.pin.messageTs);
      if (!id) throw new Refused(`bad message reference ${dest.pin.messageTs}`);
      await rt.client.pin(id, dest.pin.remove).catch((e: unknown) => {
        if (!refusedHttp(e)) throw e;
      });
      return;
    }
    if (dest.delete) {
      const id = await ownPost(dest.delete.messageTs).catch((e: unknown) => {
        if (e instanceof Refused && e.message.endsWith("is gone")) return null;
        throw e;
      });
      if (id) await rt.client.deletePost(id);
      return;
    }
    if (dest.edit) {
      const id = await ownPost(dest.edit.messageTs);
      const { text } = cleanReply(d.text);
      if (!text) return;
      await rt.client.patchPost(id, { message: withFooter(text, deliveryFooter(d, webBase)) });
      return;
    }
    const runId = d.idempotencyKey.startsWith("run:") ? d.idempotencyKey.slice(4) : undefined;
    if (runId) {
      await deliverRun(d, p, runId);
      return;
    }
    const { text } = cleanReply(d.text);
    const posted = await postMessage(d, p, withFooter(text, text ? deliveryFooter(d, webBase) : ""), {
      ...(d.destination.editRef ? { editRef: d.destination.editRef } : {}),
      ...(d.attachments?.length ? { attachments: d.attachments } : {}),
    });
    if (posted && p.dm && dest.type === "principal")
      await rt.app
        .recordPrincipalDelivery(d.id, threadRefFor("dm", p.channel, p.root))
        .catch(swallowAs("mattermost: record principal delivery", undefined));
  }

  return async (d) => {
    try {
      await deliver(d);
    } catch (e) {
      if (e instanceof Refused) return { refused: e.message };
      if (refusedHttp(e)) return { refused: errMessage(e) };
      throw e;
    }
  };
}

export const DELIVERY_TYPES = [SURFACE, "principal", "group"] as const;
