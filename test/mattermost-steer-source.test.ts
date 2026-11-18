import { test } from "node:test";
import assert from "node:assert/strict";
import { createInbound } from "../src/surfaces/mattermost/inbound.ts";
import type { LivePresenter } from "../src/surfaces/mattermost/live.ts";
import type { Runtime } from "../src/surfaces/mattermost/runtime.ts";
import type { MattermostPost } from "../src/surfaces/mattermost/protocol.ts";

const pad = (n: number) => `p${String(n).padStart(25, "0")}`;
const CHANNEL = pad(9000);
const BOT = pad(9001);
const HUMAN = pad(1);
const RUN = "r1";

function noop(): unknown {
  return new Proxy(async () => undefined, { get: (_t, key) => (key === "then" ? undefined : noop()) });
}

function setup() {
  const posts = new Map<string, MattermostPost>();
  const add = (id: string, userId: string, message: string, extra: Partial<MattermostPost> = {}) => {
    const post = { id, user_id: userId, channel_id: CHANNEL, message, create_at: 1_000, ...extra } as MattermostPost;
    posts.set(id, post);
    return post;
  };
  const human = { id: HUMAN, username: "jelly", email: "jelly@example.com", email_verified: true, delete_at: 0 };
  const known: Record<string, unknown> = {
    config: {},
    bot: () => ({ id: BOT, username: "bot", teamId: "team" }),
    client: new Proxy(
      { post: async (id: string) => posts.get(id)! },
      {
        get: (t, key) => (key in t ? t[key as keyof typeof t] : noop()),
      },
    ),
    channel: async () => ({
      channel: { id: CHANNEL, type: "D", name: "dm" },
      kind: "dm",
      name: "dm",
      memberIds: [HUMAN, BOT],
      fetchedAt: 0,
    }),
    user: async (id: string) => (id === BOT ? { id: BOT, is_bot: true, delete_at: 0 } : human),
    actorFor: async () => ({ id: "actor", externalId: "jelly@example.com", displayName: "Jelly" }),
    app: { turn: async () => ({ status: "queued", runId: RUN, steered: true }), ingestSurfaceEvents: async () => {} },
  };
  const rt = new Proxy(known, { get: (t, key) => (key in t ? t[key as string] : noop()) }) as unknown as Runtime;
  const steered: string[] = [];
  const live = new Proxy(
    { steer: (id: string) => void steered.push(id) },
    {
      get: (t, key) => (key in t ? t[key as keyof typeof t] : noop()),
    },
  ) as unknown as LivePresenter;
  const inbound = createInbound({
    rt,
    live,
    onboarding: noop() as never,
    blobs: { put: async () => "" } as never,
  });
  return { inbound, add, steered };
}

test("a message relayed into the conversation from outside Mattermost does not mark the running turn as joined", async () => {
  const { inbound, add, steered } = setup();
  add(pad(2), HUMAN, "anchor");
  await inbound.inject(pad(2), "[OpenAgents] worker update", "oa:1");
  assert.deepEqual(steered, []);
});

test("a reaction on a bot message does not mark the running turn as joined", async () => {
  const { inbound, add, steered } = setup();
  add(pad(3), BOT, "earlier reply");
  await inbound.handle({
    event: "reaction_added",
    data: { reaction: JSON.stringify({ user_id: HUMAN, post_id: pad(3), emoji_name: "thumbsup", create_at: 1 }) },
    broadcast: { channel_id: CHANNEL },
  } as never);
  assert.deepEqual(steered, []);
});

test("a person's new message that joins a running turn marks it as joined", async () => {
  const { inbound, add, steered } = setup();
  const post = add(pad(4), HUMAN, "and another thing");
  await inbound.handle({
    event: "posted",
    data: { channel_type: "D", post: JSON.stringify(post) },
    broadcast: { channel_id: CHANNEL },
  } as never);
  assert.deepEqual(steered, [RUN]);
});
