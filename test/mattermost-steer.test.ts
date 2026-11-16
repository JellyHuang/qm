import { test } from "node:test";
import assert from "node:assert/strict";
import type { Delivery } from "../src/types.ts";
import { createLivePresenter } from "../src/surfaces/mattermost/live.ts";
import { createMattermostSender } from "../src/surfaces/mattermost/outbound.ts";
import type { Runtime } from "../src/surfaces/mattermost/runtime.ts";
import type { MattermostPost } from "../src/surfaces/mattermost/protocol.ts";

const pad = (n: number) => `p${String(n).padStart(25, "0")}`;
const CHANNEL = pad(9000);
const BOT = pad(9001);
const RUN = "r1";

function chat() {
  let clock = 1_000;
  let ids = 0;
  const posts = new Map<string, MattermostPost>();
  const calls: string[] = [];
  const post = (userId: string, message: string, extra: Partial<MattermostPost> = {}): MattermostPost => {
    const created = {
      id: pad(++ids),
      user_id: userId,
      channel_id: CHANNEL,
      message,
      create_at: (clock += 1_000),
      ...extra,
    };
    posts.set(created.id, created as MattermostPost);
    return created as MattermostPost;
  };
  const client = {
    async createPost(input: { message: string; props?: Record<string, unknown> }) {
      calls.push("create");
      return post(BOT, input.message, { props: input.props } as Partial<MattermostPost>);
    },
    async patchPost(id: string, patch: { message?: string }) {
      calls.push(`patch:${id}`);
      const existing = posts.get(id)!;
      const next = { ...existing, message: patch.message ?? existing.message, edit_at: (clock += 1_000) };
      posts.set(id, next);
      return next;
    },
    async deletePost(id: string) {
      calls.push(`delete:${id}`);
      posts.delete(id);
    },
    async post(id: string) {
      return posts.get(id)!;
    },
    async addReaction() {},
    async removeReaction() {},
    async typing() {},
    async channelPosts() {
      return [];
    },
  };
  const rt = {
    config: {},
    client,
    app: { setRunDeliveryState: async () => true },
    bot: () => ({ id: BOT }),
  } as unknown as Runtime;
  return { rt, posts, calls, post };
}

async function setup() {
  const world = chat();
  const live = createLivePresenter({
    rt: world.rt,
    runs: { get: async () => ({ status: "running" }) as never },
    turnStream: { snapshot: () => "" },
  });
  const sender = createMattermostSender({
    rt: world.rt,
    live,
    blobs: { open: async () => null },
    openArtifact: async () => null,
  });
  const first = world.post(pad(1), "first question");
  await live.begin(RUN, { channel: CHANNEL, triggerPostId: first.id }, { placeholder: true });
  const placeholder = [...world.posts.values()].find((p) => p.user_id === BOT)!;
  const delivery = (editRef: string): Delivery => ({
    id: "d1",
    destination: { type: "mattermost", target: CHANNEL, editRef } as Delivery["destination"],
    text: "final answer",
    idempotencyKey: `run:${RUN}`,
    createdAt: 0,
    deliveredAt: null,
  });
  return { world, live, sender, placeholder, delivery };
}

test("a reply to a message that joined a running turn is a new post after that message, not an edit of the older placeholder", async () => {
  const { world, live, sender, placeholder, delivery } = await setup();
  const followUp = world.post(pad(1), "second message while the turn runs");
  live.steer(RUN);
  await sender(delivery(placeholder.id));
  const replies = [...world.posts.values()].filter((p) => p.user_id === BOT);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message, "final answer");
  assert.ok((replies[0]?.create_at ?? 0) > followUp.create_at);
  assert.equal(replies[0]?.edit_at, undefined);
  assert.equal(world.posts.has(placeholder.id), false);
  assert.equal(
    world.calls.some((c) => c.startsWith("patch:")),
    false,
  );
});

test("a turn that nobody joined still finishes by editing its placeholder in place", async () => {
  const { world, sender, placeholder, delivery } = await setup();
  await sender(delivery(placeholder.id));
  const replies = [...world.posts.values()].filter((p) => p.user_id === BOT);
  assert.deepEqual(
    replies.map((p) => [p.id, p.message]),
    [[placeholder.id, "final answer"]],
  );
});
