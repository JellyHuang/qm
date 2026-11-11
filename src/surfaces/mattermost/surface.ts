import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { reachEnqueue } from "../../reach/reach.ts";
import type { Surface, SurfacePromptHints } from "../contract.ts";
import { containerOf, encodeTarget, parseTarget, postIdOf, SURFACE, threadRefFor } from "./protocol.ts";

const PROMPT_HINTS: SurfacePromptHints = {
  mentionSyntax:
    "To @-mention someone on Mattermost, write `@` followed by their Mattermost username, e.g. `@jane.doe`.",
  linkSyntax: "Use Markdown links: `[label](https://example.com)`.",
  autonomousStyle:
    "You're in a Mattermost channel: keep each posted message short (a few sentences) unless asked for more. You see only a recent window here; use the `mattermost` tool's read actions (or `POST $AGENT_API_URL/v1/surface-context`) to reach further back.",
  conversationStyle:
    "- Mattermost renders GitHub-flavored Markdown: headings, lists, tables, code fences and links all display.\n- Keep replies focused; long answers are fine when asked for.\n- Each DM is one continuous conversation and each channel thread is its own session, so `history` only searches this one. If someone refers to something you can't find here, read the conversation with `POST $AGENT_API_URL/v1/surface-context` before asking them to repeat it.",
};

export function createMattermostSurface(deps: {
  deliveries: DeliveryStore;
  label?: string;
  usernameOf: (userId: string) => string | undefined;
}): Surface<null> {
  return {
    kind: SURFACE,
    label: deps.label ?? "Mattermost",
    capabilities: {
      mirrored: true,
      liveReplies: true,
      nativeActor: true,
      externalParticipants: false,
      textOnly: false,
    },
    promptHints: PROMPT_HINTS,
    async post(ref, message, idempotencyKey) {
      await reachEnqueue({
        deliveries: deps.deliveries,
        destination: {
          type: SURFACE,
          target: encodeTarget({ channel: ref.container, ...(ref.thread ? { root: ref.thread } : {}) }),
        },
        text: message.text,
        ...(message.attachments ? { attachments: message.attachments } : {}),
        idempotencyKey,
        provenance: message.provenance,
      });
    },
    async threadTarget(target, threadTs) {
      const parsed = parseTarget(target);
      const root = postIdOf(threadTs);
      if (!parsed || !root) throw new Error(`can't reply under ${threadTs} in ${target}`);
      return encodeTarget({ channel: parsed.channel, root: parsed.root ?? root });
    },
    containerOf,
    threadRefCandidates(container, ts, sub) {
      const root = postIdOf(sub ?? ts);
      if (!root) return [];
      return [
        threadRefFor("dm", container),
        threadRefFor("dm", container, root),
        threadRefFor("channel", container, root),
        threadRefFor("group", container, root),
      ];
    },
    principalFor: (user) => user.principal,
    mention: (user) => {
      const username = deps.usernameOf(user.id);
      return username ? `@${username}` : `@${user.principal.displayName ?? user.id}`;
    },
    readableText: (text) => text,
    native: () => null,
  };
}
