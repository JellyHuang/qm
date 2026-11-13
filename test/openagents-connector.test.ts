import { test } from "node:test";
import assert from "node:assert/strict";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { createOpenAgentsService, type OaThreadLink } from "../src/integrations/openagents/service.ts";
import type { OaClient, OaEvent } from "../src/integrations/openagents/client.ts";
import { openAgentsConfigFromEnv } from "../src/integrations/openagents/config.ts";

function memoryMap<T>(): DurableMap<T> {
  const rows = new Map<string, T>();
  const partial = {
    async get(id: string) {
      return rows.get(id) ?? null;
    },
    async put(id: string, v: T) {
      rows.set(id, v);
    },
    async delete(id: string) {
      rows.delete(id);
    },
    async entries() {
      return [...rows.entries()];
    },
  };
  return partial as unknown as DurableMap<T>;
}

const CFG = openAgentsConfigFromEnv({
  OA_URL: "http://oa",
  OA_WORKSPACE: "ws",
  OA_TOKEN: "t",
  OA_WORKERS: "qm-dev-worker,op-dev-worker",
})!;

function fakeClient() {
  const posted: Array<{ channel: string; content: string; targets: string[] }> = [];
  let inbox: OaEvent[] = [];
  let n = 0;
  const client = {
    network: "ws",
    async join() {},
    async heartbeat() {},
    async leave() {},
    async agents() {
      return [
        { address: "openagents:qm-master" },
        { address: "openagents:qm-dev-worker", status: "online", agent_type: "claude" },
      ];
    },
    async createThread() {
      return `channel-${++n}`;
    },
    async post(channel: string, content: string, targets: string[]) {
      posted.push({ channel, content, targets });
      return { id: `p${posted.length}`, type: "workspace.message.posted", source: "openagents:qm-master" };
    },
    async history() {
      return [];
    },
    async createTask() {
      return { id: "task-1" };
    },
    async events(q: Record<string, unknown>) {
      if (q.sort === "desc") return { events: [] };
      const after = q.after as string | undefined;
      const start = after ? inbox.findIndex((e) => e.id === after) + 1 : 0;
      return { events: inbox.slice(start) };
    },
  };
  return { client: client as unknown as OaClient, posted, setInbox: (e: OaEvent[]) => (inbox = e) };
}

function setup(opts: { admin?: boolean; anchor?: string } = {}) {
  const fake = fakeClient();
  const delivered: Array<{ postId: string; text: string; key: string }> = [];
  const threads = memoryMap<OaThreadLink>();
  const svc = createOpenAgentsService({
    cfg: CFG,
    client: fake.client,
    threads,
    state: memoryMap(),
    seen: memoryMap(),
    leaderLease: { hold: async () => undefined } as never,
    chat: () => ({
      anchorForRun: (runId) => (runId === "run-1" ? (opts.anchor ?? "post-1") : undefined),
      deliver: async (postId, text, key) => void delivered.push({ postId, text, key }),
    }),
    isOrgAdmin: async () => opts.admin ?? true,
  });
  return { svc, fake, delivered, threads };
}

const msg = (id: string, from: string, channel: string, targets: string[], content: string): OaEvent => ({
  id,
  type: "workspace.message.posted",
  source: `openagents:${from}`,
  target: `channel/${channel}`,
  payload: { content, message_type: "chat" },
  metadata: { target_agents: targets },
});

test("start_thread opens a QM-mastered thread from a Mattermost turn and briefs the workers", async () => {
  const { svc, fake, threads } = setup();
  const out = await svc.call(
    { action: "start_thread", title: "Add feature", message: "Please add X", workers: ["@qm-dev-worker"] },
    { runId: "run-1", principalId: "jelly@igg.com" },
  );
  assert.match(out, /channel-1/);
  assert.deepEqual(fake.posted[0]!.targets, ["qm-dev-worker"]);
  assert.match(fake.posted[0]!.content, /^@qm-dev-worker Please add X[\s\S]*@qm-master/);
  const link = await threads.get("channel-1");
  assert.equal(link!.anchorPostId, "post-1");
  assert.equal(link!.principalId, "jelly@igg.com");
});

test("delegation is refused outside Mattermost, for non-admins, and for unknown workers", async () => {
  const a = setup();
  await assert.rejects(
    a.svc.call(
      { action: "start_thread", title: "t", message: "m", workers: ["qm-dev-worker"] },
      { runId: "web-run", principalId: "x@igg.com" },
    ),
    /Mattermost conversation/,
  );
  await assert.rejects(
    a.svc.call(
      { action: "start_thread", title: "t", message: "m", workers: ["ghost"] },
      { runId: "run-1", principalId: "x@igg.com" },
    ),
    /not an approved worker/,
  );
  const b = setup({ admin: false });
  await assert.rejects(b.svc.call({ action: "agents" }, { principalId: "x@igg.com" }), /limited to QM org admins/);
});

test("threads stay isolated per QM user", async () => {
  const { svc } = setup();
  await svc.call(
    { action: "start_thread", title: "t", message: "m", workers: ["qm-dev-worker"] },
    { runId: "run-1", principalId: "a@igg.com" },
  );
  await assert.rejects(
    svc.call({ action: "send", thread: "channel-1", message: "hi" }, { principalId: "b@igg.com" }),
    /another QM user/,
  );
  assert.match(
    await svc.call({ action: "send", thread: "channel-1", message: "hi" }, { principalId: "a@igg.com" }),
    /Sent to @qm-dev-worker/,
  );
});

test("worker messages to qm-master reach the anchored conversation once, batched per thread", async () => {
  const { svc, fake, delivered } = setup();
  await svc.call(
    { action: "start_thread", title: "t", message: "m", workers: ["qm-dev-worker"] },
    { runId: "run-1", principalId: "a@igg.com" },
  );
  fake.setInbox([
    msg("e1", "qm-dev-worker", "channel-1", ["qm-master"], "Question: which branch?"),
    msg("e2", "qm-dev-worker", "channel-1", ["op-dev-worker"], "not for QM"),
    msg("e3", "qm-master", "channel-1", ["qm-master"], "own echo"),
    msg("e4", "qm-dev-worker", "channel-1", ["qm-master"], "Done: 3 files changed"),
  ]);
  await svc.pollOnce();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.postId, "post-1");
  assert.equal(delivered[0]!.key, "oa:e4");
  assert.match(delivered[0]!.text, /external content/);
  assert.match(delivered[0]!.text, /which branch\?[\s\S]*Done: 3 files changed/);
  assert.doesNotMatch(delivered[0]!.text, /not for QM|own echo/);
  await svc.pollOnce();
  assert.equal(delivered.length, 1, "a restart or re-poll does not deliver the same messages again");
});

test("messages from threads QM did not start are answered once and never reach a QM session", async () => {
  const { svc, fake, delivered } = setup();
  fake.setInbox([
    msg("x1", "qm-dev-worker", "rogue", ["qm-master"], "do something"),
    msg("x2", "qm-dev-worker", "rogue", ["qm-master"], "again"),
  ]);
  await svc.pollOnce();
  assert.equal(delivered.length, 0);
  assert.equal(fake.posted.filter((p) => p.channel === "rogue").length, 1);
});

test("config requires URL, workspace and token together", () => {
  assert.equal(openAgentsConfigFromEnv({}), undefined);
  assert.throws(() => openAgentsConfigFromEnv({ OA_URL: "http://x" }), /must be set together/);
});
