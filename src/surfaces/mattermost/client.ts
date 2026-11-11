import { z } from "zod";
import { errMessage } from "../../util/errors.ts";
import { sleep } from "../../util/async.ts";
import { trimTrailingSlashes } from "../../util/text.ts";
import {
  channelSchema,
  fileInfoSchema,
  postSchema,
  userSchema,
  wsEventSchema,
  type MattermostChannel,
  type MattermostFileInfo,
  type MattermostPost,
  type MattermostUser,
  type WsEvent,
} from "./protocol.ts";

const REQUEST_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const PAGE_SIZE = 200;
const MAX_PAGES = 50;
const PING_INTERVAL_MS = 30_000;
const PONG_DEADLINE_MS = 75_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export class MattermostHttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(`mattermost ${status}${code ? ` ${code}` : ""}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

const postListSchema = z.object({
  order: z.array(z.string()).default([]),
  posts: z.record(z.string(), postSchema).default({}),
});

export interface PostInput {
  channel_id: string;
  message: string;
  root_id?: string;
  file_ids?: string[];
  props?: Record<string, unknown>;
}

export interface PostPatch {
  message?: string;
  file_ids?: string[];
  props?: Record<string, unknown>;
}

export interface MattermostClient {
  readonly baseUrl: string;
  me(): Promise<MattermostUser>;
  user(id: string): Promise<MattermostUser>;
  users(ids: readonly string[]): Promise<MattermostUser[]>;
  allUsers(): Promise<MattermostUser[]>;
  team(name: string): Promise<{ id: string; name: string; display_name: string }>;
  channel(id: string): Promise<MattermostChannel>;
  myChannels(teamId: string): Promise<MattermostChannel[]>;
  channelMemberIds(channelId: string): Promise<string[]>;
  directChannel(a: string, b: string): Promise<MattermostChannel>;
  groupChannel(userIds: readonly string[]): Promise<MattermostChannel>;
  createPost(post: PostInput): Promise<MattermostPost>;
  patchPost(id: string, patch: PostPatch): Promise<MattermostPost>;
  deletePost(id: string): Promise<void>;
  post(id: string): Promise<MattermostPost>;
  thread(rootId: string): Promise<MattermostPost[]>;
  channelPosts(
    channelId: string,
    opts?: { before?: string; since?: number; perPage?: number },
  ): Promise<MattermostPost[]>;
  ephemeral(userId: string, post: PostInput): Promise<void>;
  addReaction(userId: string, postId: string, emoji: string): Promise<void>;
  removeReaction(userId: string, postId: string, emoji: string): Promise<void>;
  pin(postId: string, remove?: boolean): Promise<void>;
  upload(channelId: string, name: string, bytes: Uint8Array, mimetype?: string): Promise<string>;
  fileInfo(id: string): Promise<MattermostFileInfo>;
  download(id: string, maxBytes: number): Promise<Uint8Array>;
  typing(userId: string, channelId: string, parentId?: string): Promise<void>;
}

export function createMattermostClient(opts: { url: string; token: string; fetch?: typeof fetch }): MattermostClient {
  const baseUrl = trimTrailingSlashes(opts.url);
  const api = `${baseUrl}/api/v4`;
  const send = opts.fetch ?? fetch;
  const auth = { authorization: `Bearer ${opts.token}` };

  async function call(method: string, path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS) {
    const res = await send(`${api}${path}`, {
      method,
      headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw await httpError(res);
    return res;
  }

  async function json<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown): Promise<T> {
    const res = await call(method, path, body);
    return schema.parse(await res.json());
  }

  async function paged<T>(schema: z.ZodType<T>, path: string): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await json(z.array(schema), "GET", `${path}${sep}page=${page}&per_page=${PAGE_SIZE}`);
      out.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return out;
  }

  function ordered(list: z.infer<typeof postListSchema>): MattermostPost[] {
    return list.order.map((id) => list.posts[id]).filter((p): p is MattermostPost => p !== undefined);
  }

  return {
    baseUrl,
    me: () => json(userSchema, "GET", "/users/me"),
    user: (id) => json(userSchema, "GET", `/users/${encodeURIComponent(id)}`),
    users: async (ids) => (ids.length ? json(z.array(userSchema), "POST", "/users/ids", [...new Set(ids)]) : []),
    allUsers: () => paged(userSchema, "/users?active=true"),
    team: (name) =>
      json(
        z.object({ id: z.string(), name: z.string(), display_name: z.string().default("") }),
        "GET",
        `/teams/name/${encodeURIComponent(name)}`,
      ),
    channel: (id) => json(channelSchema, "GET", `/channels/${encodeURIComponent(id)}`),
    myChannels: (teamId) =>
      json(z.array(channelSchema), "GET", `/users/me/teams/${encodeURIComponent(teamId)}/channels`),
    channelMemberIds: async (channelId) =>
      (await paged(z.object({ user_id: z.string() }), `/channels/${encodeURIComponent(channelId)}/members`)).map(
        (m) => m.user_id,
      ),
    directChannel: (a, b) => json(channelSchema, "POST", "/channels/direct", [a, b]),
    groupChannel: (ids) => json(channelSchema, "POST", "/channels/group", [...new Set(ids)]),
    createPost: (post) => json(postSchema, "POST", "/posts", post),
    patchPost: (id, patch) => json(postSchema, "PUT", `/posts/${encodeURIComponent(id)}/patch`, patch),
    async deletePost(id) {
      await call("DELETE", `/posts/${encodeURIComponent(id)}`);
    },
    post: (id) => json(postSchema, "GET", `/posts/${encodeURIComponent(id)}`),
    thread: async (rootId) =>
      ordered(await json(postListSchema, "GET", `/posts/${encodeURIComponent(rootId)}/thread?skipFetchThreads=false`)),
    channelPosts: async (channelId, o = {}) => {
      const q = new URLSearchParams({ per_page: String(o.perPage ?? 60) });
      if (o.before) q.set("before", o.before);
      if (o.since !== undefined) q.set("since", String(o.since));
      return ordered(await json(postListSchema, "GET", `/channels/${encodeURIComponent(channelId)}/posts?${q}`));
    },
    async ephemeral(userId, post) {
      await call("POST", "/posts/ephemeral", { user_id: userId, post });
    },
    async addReaction(userId, postId, emoji) {
      await call("POST", "/reactions", { user_id: userId, post_id: postId, emoji_name: emoji });
    },
    async removeReaction(userId, postId, emoji) {
      await call(
        "DELETE",
        `/users/${encodeURIComponent(userId)}/posts/${encodeURIComponent(postId)}/reactions/${encodeURIComponent(emoji)}`,
      );
    },
    async pin(postId, remove) {
      await call("POST", `/posts/${encodeURIComponent(postId)}/${remove ? "unpin" : "pin"}`);
    },
    async upload(channelId, name, bytes, mimetype) {
      const form = new FormData();
      form.set("channel_id", channelId);
      form.set("files", new Blob([bytes], mimetype ? { type: mimetype } : {}), name);
      const res = await send(`${api}/files`, {
        method: "POST",
        headers: auth,
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw await httpError(res);
      const parsed = z.object({ file_infos: z.array(fileInfoSchema).min(1) }).parse(await res.json());
      return parsed.file_infos[0]!.id;
    },
    fileInfo: (id) => json(fileInfoSchema, "GET", `/files/${encodeURIComponent(id)}/info`),
    async download(id, maxBytes) {
      const res = await call("GET", `/files/${encodeURIComponent(id)}`, undefined, UPLOAD_TIMEOUT_MS);
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > maxBytes) {
        await res.body?.cancel();
        throw new Error(`file ${id} is larger than ${maxBytes} bytes`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new Error(`file ${id} is larger than ${maxBytes} bytes`);
      return bytes;
    },
    async typing(userId, channelId, parentId) {
      await call("POST", `/users/${encodeURIComponent(userId)}/typing`, {
        channel_id: channelId,
        ...(parentId ? { parent_id: parentId } : {}),
      });
    },
  };
}

async function httpError(res: Response): Promise<MattermostHttpError> {
  const text = await res.text().catch(() => "");
  let code: string | undefined;
  let message = text.slice(0, 300) || res.statusText;
  try {
    const parsed = JSON.parse(text) as { id?: unknown; message?: unknown };
    if (typeof parsed.id === "string") code = parsed.id;
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    code = undefined;
  }
  return new MattermostHttpError(res.status, code, message);
}

export interface MattermostSocket {
  start(): void;
  stop(): Promise<void>;
}

export function createMattermostSocket(opts: {
  url: string;
  token: string;
  onEvent: (event: WsEvent) => void | Promise<void>;
  onConnected?: (reconnected: boolean) => void | Promise<void>;
  createSocket?: (url: string) => WebSocket;
}): MattermostSocket {
  const wsUrl = `${trimTrailingSlashes(opts.url).replace(/^http/, "ws")}/api/v4/websocket`;
  const create = opts.createSocket ?? ((url: string) => new WebSocket(url));
  let stopped = true;
  let socket: WebSocket | undefined;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  async function session(reconnected: boolean): Promise<boolean> {
    const ws = create(wsUrl);
    socket = ws;
    let seq = 1;
    let lastPong = Date.now();
    let authed = false;
    let pinger: ReturnType<typeof setInterval> | undefined;
    const closed = new Promise<boolean>((resolve) => {
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ seq: seq++, action: "authentication_challenge", data: { token: opts.token } }));
        pinger = setInterval(() => {
          if (Date.now() - lastPong > PONG_DEADLINE_MS) {
            console.error("[mattermost] websocket went quiet — reconnecting");
            ws.close();
            return;
          }
          ws.send(JSON.stringify({ seq: seq++, action: "ping" }));
        }, PING_INTERVAL_MS);
      });
      ws.addEventListener("message", (msg) => {
        lastPong = Date.now();
        let raw: unknown;
        try {
          raw = JSON.parse(String(msg.data));
        } catch {
          return;
        }
        if (raw && typeof raw === "object" && "status" in raw && !("event" in raw)) {
          const reply = raw as { status?: unknown; error?: { message?: unknown } };
          if (reply.status === "FAIL")
            console.error(`[mattermost] websocket request failed: ${String(reply.error?.message ?? "unknown")}`);
          return;
        }
        const parsed = wsEventSchema.safeParse(raw);
        if (!parsed.success) return;
        if (parsed.data.event === "hello") {
          authed = true;
          void Promise.resolve(opts.onConnected?.(reconnected)).catch((e) =>
            console.error(`[mattermost] connect hook failed: ${errMessage(e)}`),
          );
          return;
        }
        void Promise.resolve(opts.onEvent(parsed.data)).catch((e) =>
          console.error(`[mattermost] event ${parsed.data.event} failed: ${errMessage(e)}`),
        );
      });
      ws.addEventListener("error", (e) => {
        console.error(`[mattermost] websocket error: ${errMessage((e as { error?: unknown }).error ?? e)}`);
      });
      ws.addEventListener("close", () => resolve(authed));
    });
    const ok = await closed;
    if (pinger) clearInterval(pinger);
    socket = undefined;
    return ok;
  }

  async function run(): Promise<void> {
    let attempt = 0;
    let everConnected = false;
    while (!stopped) {
      const authed = await session(everConnected).catch((e) => {
        console.error(`[mattermost] websocket session failed: ${errMessage(e)}`);
        return false;
      });
      if (authed) {
        everConnected = true;
        attempt = 0;
      }
      if (stopped) return;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt++);
      await Promise.race([sleep(delay), new Promise<void>((r) => (wake = r))]);
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      loop = run();
    },
    async stop() {
      stopped = true;
      socket?.close();
      wake?.();
      await loop;
    },
  };
}
