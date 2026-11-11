import { normalizeReaction, extractReactions, type ReactionDirective } from "../../slack/reactions.ts";
import { safeChunks } from "../../slack/safe-cut.ts";
import { extractPrivateContinuation } from "../../slack/external-access.ts";
import type { Delivery } from "../../types.ts";
import { cronIdOf } from "../../sessions/session-store.ts";
import { trimTrailingSlashes } from "../../util/text.ts";
import { postIdOf } from "./protocol.ts";

export const POST_SPLIT_LIMIT = 15_000;

export const REACTION_INSTRUCTION =
  "When a Mattermost user explicitly asks you to add an emoji reaction, you MUST actually react by writing " +
  "the directive `[[react: name1 name2]]` somewhere in your reply, using Mattermost emoji names with NO colons " +
  "(e.g. `[[react: eyes white_check_mark]]`, `[[react: +1]]`, `[[react: tada]]`). An emoji typed into prose does " +
  "nothing; only the directive adds a real reaction. The directive is removed from what people see, and the " +
  "reactions (up to 5) land on the message you are answering, so a reply can be JUST the directive. To react to a " +
  "DIFFERENT message in this conversation, copy its id from the brackets in the conversation above (like " +
  "`[~abc123…]`) and append it after `@`: `[[react: saluting_face @ ~abc123…]]`. Use reactions only when asked or " +
  "when an acknowledgement is the whole answer; never instead of answering a request that needs words.";

export const HANDOFF_INSTRUCTION =
  "When work needs another person's own logins, files or memory, follow the `hand-off` skill.";

export function normalizeEmoji(raw: string): string | null {
  const name = normalizeReaction(raw);
  if (!name) return null;
  return name.replace(/::skin-tone-(\d)$/, "_skin_tone_$1").slice(0, 64);
}

export function cleanReply(text: string): { text: string; reactions: ReactionDirective[] } {
  const extracted = extractReactions(text);
  return { text: extractPrivateContinuation(extracted.text).text.trim(), reactions: extracted.reactions };
}

export function reactionTargets(
  directives: readonly ReactionDirective[],
  defaultPostId: string,
  allowed: ReadonlySet<string>,
): Array<{ postId: string; names: string[] }> {
  const out: Array<{ postId: string; names: string[] }> = [];
  for (const d of directives) {
    const ref = d.targetId ?? d.target;
    const postId = ref ? postIdOf(ref) : defaultPostId;
    if (!postId || (ref && !allowed.has(postId))) continue;
    out.push({ postId, names: d.names });
  }
  return out;
}

export function chunks(text: string): string[] {
  return safeChunks(text, POST_SPLIT_LIMIT).filter((c) => c.trim());
}

export function deliveryFooter(d: Delivery, webBase?: string): string {
  const base = trimTrailingSlashes(webBase?.trim() ?? "");
  const parts: string[] = [];
  const sender = d.destination.relaySender?.trim().replace(/^@+/, "");
  if (sender) parts.push(`Sent for @${sender}`);
  if (d.destination.editNote) parts.push(d.destination.editNote);
  const persona = d.destination.persona;
  if (persona) {
    const name = persona.name.trim() || "Persona";
    parts.push(base ? `Persona: [${name}](${base}/personas/${encodeURIComponent(persona.id)})` : `Persona: ${name}`);
  }
  const cronId = d.provenance?.trigger === "cron" ? cronIdOf(d.provenance.sourceThreadRef) : null;
  if (base && cronId) {
    const title = d.provenance?.sourceTitle?.trim() || "Cron";
    parts.push(`${title} · [Settings](${base}/crons/${encodeURIComponent(cronId)})`);
  }
  return parts.length ? `\n\n_${parts.join(" · ")}_` : "";
}

export function withFooter(text: string, footer: string): string {
  return footer ? `${text}${footer}` : text;
}
