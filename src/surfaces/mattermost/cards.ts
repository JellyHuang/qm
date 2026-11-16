import { createHmac, randomBytes } from "node:crypto";
import { constantTimeEqual } from "../../util/crypto.ts";
import type { KeychainApprovalView } from "../../credentials/keychain-approval.ts";
import { parseScopeId, type PendingApproval } from "../../types.ts";

const ACTION_TTL_MS = 14 * 24 * 3_600_000;
const COMMAND_PREVIEW_MAX = 1500;

export type ActionPayload =
  | { k: "approval"; requestId: string; choice: "once" | "session" | "always" | "deny" }
  | { k: "keychain"; askId: string; choice: "once" | "standing" | "deny" }
  | { k: "deploy"; value: string; approve: boolean }
  | { k: "access"; email: string; approve: boolean }
  | { k: "zq"; op: "report" | "link" | "children"; id: string; approve: boolean };

export interface SignedContext {
  p: string;
  exp: number;
  n: string;
  sig: string;
}

export interface ActionSigner {
  sign(payload: ActionPayload): SignedContext;
  open(context: unknown, now?: number): ActionPayload | null;
}

export function createActionSigner(secret: string): ActionSigner {
  const mac = (p: string, exp: number, n: string) =>
    createHmac("sha256", secret).update(`mattermost-action:v1:${exp}:${n}:${p}`).digest("hex");
  return {
    sign(payload) {
      const p = JSON.stringify(payload);
      const exp = Date.now() + ACTION_TTL_MS;
      const n = randomBytes(12).toString("hex");
      return { p, exp, n, sig: mac(p, exp, n) };
    },
    open(context, now = Date.now()) {
      if (!context || typeof context !== "object") return null;
      const c = context as Partial<SignedContext>;
      if (typeof c.p !== "string" || typeof c.exp !== "number" || typeof c.n !== "string" || typeof c.sig !== "string")
        return null;
      if (c.exp <= now || c.p.length > 4000) return null;
      if (!constantTimeEqual(c.sig, mac(c.p, c.exp, c.n))) return null;
      try {
        return JSON.parse(c.p) as ActionPayload;
      } catch {
        return null;
      }
    },
  };
}

export interface CardButton {
  id: string;
  name: string;
  style?: "primary" | "danger" | "good" | "default";
  payload: ActionPayload;
}

export interface Card {
  message: string;
  title?: string;
  text: string;
  color?: string;
  buttons?: CardButton[];
  footer?: string;
}

export function cardProps(card: Card, signer: ActionSigner, actionUrl: string): Record<string, unknown> {
  return {
    attachments: [
      {
        fallback: card.message,
        ...(card.color ? { color: card.color } : {}),
        ...(card.title ? { title: card.title } : {}),
        text: card.text,
        ...(card.footer ? { footer: card.footer } : {}),
        ...(card.buttons?.length
          ? {
              actions: card.buttons.map((b) => ({
                id: b.id,
                name: b.name,
                type: "button",
                ...(b.style ? { style: b.style } : {}),
                integration: { url: actionUrl, context: signer.sign(b.payload) },
              })),
            }
          : {}),
      },
    ],
  };
}

export function settledProps(card: Omit<Card, "buttons">): Record<string, unknown> {
  return {
    attachments: [
      {
        fallback: card.message,
        ...(card.color ? { color: card.color } : {}),
        ...(card.title ? { title: card.title } : {}),
        text: card.text,
        ...(card.footer ? { footer: card.footer } : {}),
      },
    ],
  };
}

function fence(text: string): string {
  const clipped = text.length > COMMAND_PREVIEW_MAX ? `${text.slice(0, COMMAND_PREVIEW_MAX)}…` : text;
  return `\`\`\`\n${clipped.replaceAll("```", "ʼʼʼ")}\n\`\`\``;
}

export function approvalCard(
  approval: Pick<PendingApproval, "requestId" | "command" | "reason" | "purpose" | "summary" | "kind" | "grantModes">,
  originUrl?: string,
): Card {
  const input = approval.kind === "input";
  const headline = approval.summary?.trim() || (input ? "QM needs your input" : "QM wants to run a command");
  const lines = [
    approval.purpose?.trim() ? `**Why:** ${approval.purpose.trim()}` : "",
    approval.reason?.trim() ? `**Rule:** ${approval.reason.trim()}` : "",
    fence(approval.command),
    originUrl ? `[Open the conversation in QM](${originUrl})` : "",
  ].filter(Boolean);
  const modes = approval.grantModes ?? { session: true, always: true };
  const buttons: CardButton[] = [
    {
      id: "allowonce",
      name: "Allow once",
      style: "primary",
      payload: { k: "approval", requestId: approval.requestId, choice: "once" },
    },
    ...(modes.session
      ? [
          {
            id: "allowsession",
            name: "Allow session",
            payload: { k: "approval", requestId: approval.requestId, choice: "session" } as const,
          },
        ]
      : []),
    ...(modes.always
      ? [
          {
            id: "allowalways",
            name: "Allow always",
            payload: { k: "approval", requestId: approval.requestId, choice: "always" } as const,
          },
        ]
      : []),
    {
      id: "deny",
      name: "Deny",
      style: "danger",
      payload: { k: "approval", requestId: approval.requestId, choice: "deny" },
    },
  ];
  return {
    message: `Approval needed: ${headline}`,
    title: `🔐 Approval needed — ${headline}`,
    text: lines.join("\n\n"),
    color: "#f2c744",
    buttons,
  };
}

export function approvalDecision(choice: string, by: string, pending = false): string {
  if (pending) return `⏳ ${choiceLabel(choice)} by @${by} — resuming…`;
  return choice === "deny" ? `❌ Denied by @${by}.` : `✅ ${choiceLabel(choice)} by @${by}.`;
}

function choiceLabel(choice: string): string {
  if (choice === "session") return "Allowed for this session";
  if (choice === "always") return "Allowed always";
  if (choice === "deny") return "Denied";
  return "Allowed once";
}

export function keychainCard(view: KeychainApprovalView, originUrl?: string): Card {
  const { ask } = view;
  const pending = ask.status === "pending";
  const { kind } = parseScopeId(ask.requesterScopeId);
  let audience = "this group";
  if (kind === "personal") audience = "your personal conversations";
  if (kind === "channel") audience = "this channel";
  const standing = `ongoing access across ${audience}`;
  const place = originUrl ? `[${view.conversation}](${originUrl})` : view.conversation;
  const duration = pending ? ` (${ask.requestedMode === "once" ? "one-time access" : standing})` : "";
  let status = "This request expired.";
  if (ask.status === "approved") status = `Approved — ${view.mode === "standing" ? standing : "one-time access"}.`;
  if (ask.status === "declined") status = "Denied.";
  const summary = `Use your **${view.service.slice(0, 150)}** credential in ${place}${duration}.`;
  const order: Array<"once" | "standing"> = ask.requestedMode === "once" ? ["once", "standing"] : ["standing", "once"];
  return {
    message: pending
      ? `Approval needed: use your ${view.service} credential in ${view.conversation}${duration}.`
      : status,
    title: pending ? "🔒 Approval needed" : status,
    text: summary,
    color: keychainColor(ask.status),
    ...(pending
      ? {
          buttons: [
            ...order.map((choice, i) => ({
              id: choice === "once" ? "allowonce" : "allow",
              name: choice === "once" ? "Allow once" : "Allow",
              ...(i === 0 ? { style: "primary" as const } : {}),
              payload: { k: "keychain" as const, askId: ask.id, choice },
            })),
            {
              id: "deny",
              name: "Deny",
              style: "danger" as const,
              payload: { k: "keychain" as const, askId: ask.id, choice: "deny" as const },
            },
          ],
        }
      : {}),
  };
}

function keychainColor(status: string): string {
  if (status === "pending") return "#f2c744";
  return status === "approved" ? "#2eb67d" : "#8d8d8d";
}

export function deployAccessCard(value: string, text: string): Card {
  return {
    message: text,
    title: "🔑 Access request",
    text,
    color: "#f2c744",
    buttons: [
      { id: "approve", name: "Approve", style: "primary", payload: { k: "deploy", value, approve: true } },
      { id: "decline", name: "Decline", style: "danger", payload: { k: "deploy", value, approve: false } },
    ],
  };
}

export function accessRequestCard(r: { email: string; username: string; displayName: string }): Card {
  return {
    message: `@${r.username} (${r.email}) is asking to use QM.`,
    title: "👋 New QM access request",
    text: `**${r.displayName}** (@${r.username}, ${r.email}) wants to start using QM from Mattermost.\n\nApproving lets them register in QM with their email sign-in link.`,
    color: "#1d9bd1",
    buttons: [
      { id: "approve", name: "Approve", style: "primary", payload: { k: "access", email: r.email, approve: true } },
      { id: "deny", name: "Deny", style: "danger", payload: { k: "access", email: r.email, approve: false } },
    ],
  };
}
