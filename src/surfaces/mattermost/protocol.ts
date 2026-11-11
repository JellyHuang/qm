import { z } from "zod";

export const SURFACE = "mattermost";

const ID = /^[a-z0-9]{26}$/;
const ID_DIGITS = 41;
const MS_DIGITS = 3;

export type MattermostKind = "dm" | "channel" | "group";

export interface MattermostTarget {
  channel: string;
  root?: string;
}

export function isMattermostId(value: string | undefined | null): value is string {
  return typeof value === "string" && ID.test(value);
}

export function encodeTarget(t: MattermostTarget): string {
  return t.root ? `${t.channel}:${t.root}` : t.channel;
}

export function parseTarget(target: string): MattermostTarget | null {
  const [channel, root, ...rest] = target.split(":");
  if (!isMattermostId(channel) || rest.length || (root !== undefined && !isMattermostId(root))) return null;
  return { channel, ...(root ? { root } : {}) };
}

export function containerOf(target: string): string {
  return parseTarget(target)?.channel ?? target;
}

export function threadRefFor(kind: MattermostKind, channel: string, root?: string): string {
  if (kind === "dm") return root ? `mm:dm:${channel}:${root}` : `mm:dm:${channel}`;
  return `mm:${kind === "group" ? "grp" : "ch"}:${channel}:${root ?? ""}`;
}

export function kindOfChannelType(type: string | undefined): MattermostKind | null {
  if (type === "D") return "dm";
  if (type === "G") return "group";
  if (type === "O" || type === "P") return "channel";
  return null;
}

export function postTs(postId: string, createAt: number): string {
  const seconds = Math.floor(createAt / 1000);
  const ms = String(createAt % 1000).padStart(MS_DIGITS, "0");
  let value = 0n;
  for (const ch of postId) value = value * 36n + BigInt(parseInt(ch, 36));
  return `${seconds}.${ms}${value.toString().padStart(ID_DIGITS, "0")}`;
}

export function postIdOf(ref: string): string | null {
  const trimmed = ref.trim().replace(/^~/, "");
  if (isMattermostId(trimmed)) return trimmed;
  const m = /^\d+\.\d{3}(\d{41})$/.exec(trimmed);
  if (!m) return null;
  let value = BigInt(m[1]!);
  let out = "";
  while (value > 0n) {
    out = (value % 36n).toString(36) + out;
    value /= 36n;
  }
  const id = out.padStart(26, "0");
  return isMattermostId(id) ? id : null;
}

export function shortId(postId: string): string {
  return `~${postId}`;
}

const jsonString = <T extends z.ZodTypeAny>(schema: T) =>
  z.string().transform((raw, ctx) => {
    try {
      return schema.parse(JSON.parse(raw)) as z.infer<T>;
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid embedded JSON" });
      return z.NEVER;
    }
  });

export const fileInfoSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  extension: z.string().optional(),
  size: z.number().default(0),
  mime_type: z.string().optional(),
  user_id: z.string().optional(),
});

export type MattermostFileInfo = z.infer<typeof fileInfoSchema>;

export const postSchema = z.object({
  id: z.string(),
  create_at: z.number(),
  update_at: z.number().optional(),
  edit_at: z.number().optional(),
  delete_at: z.number().optional(),
  user_id: z.string(),
  channel_id: z.string(),
  root_id: z.string().optional().default(""),
  message: z.string().default(""),
  type: z.string().optional().default(""),
  props: z.record(z.string(), z.unknown()).optional(),
  file_ids: z.array(z.string()).nullish(),
  metadata: z
    .object({
      files: z.array(fileInfoSchema).nullish(),
      reactions: z.array(z.object({ user_id: z.string(), emoji_name: z.string() })).nullish(),
    })
    .partial()
    .optional(),
});

export type MattermostPost = z.infer<typeof postSchema>;

export const reactionSchema = z.object({
  user_id: z.string(),
  post_id: z.string(),
  emoji_name: z.string(),
  create_at: z.number().optional(),
});

export const postedEventData = z.object({
  channel_type: z.string().optional(),
  channel_display_name: z.string().optional(),
  channel_name: z.string().optional(),
  sender_name: z.string().optional(),
  team_id: z.string().optional(),
  post: jsonString(postSchema),
  mentions: jsonString(z.array(z.string())).optional(),
});

export const editedEventData = z.object({ post: jsonString(postSchema) });

export const reactionEventData = z.object({ reaction: jsonString(reactionSchema) });

export const wsEventSchema = z.object({
  event: z.string(),
  data: z.record(z.string(), z.unknown()).default({}),
  broadcast: z
    .object({ channel_id: z.string().optional(), user_id: z.string().optional(), team_id: z.string().optional() })
    .partial()
    .default({}),
  seq: z.number().optional(),
});

export type WsEvent = z.infer<typeof wsEventSchema>;

export const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string().optional().default(""),
  first_name: z.string().optional().default(""),
  last_name: z.string().optional().default(""),
  nickname: z.string().optional().default(""),
  is_bot: z.boolean().optional().default(false),
  delete_at: z.number().optional().default(0),
  roles: z.string().optional().default(""),
  timezone: z
    .object({
      useAutomaticTimezone: z.union([z.string(), z.boolean()]).optional(),
      automaticTimezone: z.string().optional(),
      manualTimezone: z.string().optional(),
    })
    .partial()
    .optional(),
  email_verified: z.boolean().optional(),
});

export type MattermostUser = z.infer<typeof userSchema>;

export const channelSchema = z.object({
  id: z.string(),
  team_id: z.string().optional().default(""),
  type: z.string(),
  display_name: z.string().optional().default(""),
  name: z.string().optional().default(""),
  delete_at: z.number().optional().default(0),
});

export type MattermostChannel = z.infer<typeof channelSchema>;

export function displayNameOf(user: Pick<MattermostUser, "first_name" | "last_name" | "nickname" | "username">) {
  const full = `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim();
  return full || user.nickname?.trim() || user.username;
}

export function timezoneOf(user: MattermostUser): string | undefined {
  const tz = user.timezone;
  if (!tz) return undefined;
  const automatic = tz.useAutomaticTimezone === true || tz.useAutomaticTimezone === "true";
  const zone = (automatic ? tz.automaticTimezone : tz.manualTimezone)?.trim();
  return zone || undefined;
}
