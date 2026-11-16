import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { createZqChildren, type ProposeInput, type ZqChildDraft } from "../src/zq/children.ts";
import { testMap } from "./support/test-database.ts";

const INPUT: ProposeInput = {
  featureId: 40,
  lockVersion: 7,
  reason: "补一张前端联调单",
  children: [{ typeKey: "frontend", subject: "联调", description: "负责登录页联调", assigneeId: "12" }],
};

function harness(opts: { fail?: boolean } = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown>; principal: string }> = [];
  const cards: Array<{ to: string; id: string; text: string }> = [];
  const clock = { now: 1_000_000 };
  const children = createZqChildren({
    map: testMap<ZqChildDraft>(),
    call: async (tool, args, principal) => {
      calls.push({ tool, args, principal });
      if (args["confirm"] === true && opts.fail) throw new Error("[DUPLICATE_ASSIGNEE] 已有同类型执行单");
      return JSON.stringify({ preview: args["confirm"] !== true });
    },
    mmUserIdOf: async (principal) => (principal === "internal:alice" ? "mm-alice" : undefined),
    sendCard: async (to, id, text) => void cards.push({ to, id, text }),
    now: () => clock.now,
  });
  return { children, calls, cards, clock };
}

test("a request only previews with OpenProject and sends the requester a card; nothing is written", async () => {
  const h = harness();
  const answer = await h.children.propose(INPUT, "internal:alice");
  assert.match(answer, /还没有创建任何东西/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.tool, "zq_create_child_orders");
  assert.equal(h.calls[0]!.principal, "internal:alice");
  assert.deepEqual(h.calls[0]!.args, {
    id: 40,
    lockVersion: 7,
    idempotency_key: h.calls[0]!.args["idempotency_key"],
    reason: "补一张前端联调单",
    source: { kind: "qm", ref: "mattermost" },
    children: [{ type_key: "frontend", subject: "联调", description: "负责登录页联调", assignee_id: "12" }],
    confirm: false,
  });
  assert.equal(h.cards.length, 1);
  assert.equal(h.cards[0]!.to, "mm-alice");
  assert.match(h.cards[0]!.text, /功能 #40 增加 1 张执行单/);
  assert.match(h.cards[0]!.text, /负责登录页联调/);
});

test("asking again for the same thing does not send a second card, and an incomplete request never reaches OpenProject", async () => {
  const h = harness();
  await h.children.propose(INPUT, "internal:alice");
  assert.match(await h.children.propose(INPUT, "internal:alice"), /已经发给提问者/);
  assert.equal(h.cards.length, 1);
  assert.equal(h.calls.length, 1);
  await assert.rejects(
    h.children.propose(
      { ...INPUT, children: [{ typeKey: "frontend", subject: "x", description: " " }] },
      "internal:alice",
    ),
    /description is required/,
  );
  await assert.rejects(h.children.propose({ ...INPUT, children: [] }, "internal:alice"), /1 to 50/);
  await assert.rejects(h.children.propose(INPUT, "internal:nobody"), /Mattermost account/);
  assert.equal(h.calls.length, 1);
});

test("only the requester's click creates the orders, with the same idempotency key, and a double click writes once", async () => {
  const h = harness();
  await h.children.propose(INPUT, "internal:alice");
  const id = h.cards[0]!.id;
  await assert.rejects(h.children.decide(id, true, "mm-mallory"), /只有提出请求的人/);
  assert.equal(h.calls.length, 1);

  const [first, second] = await Promise.all([
    h.children.decide(id, true, "mm-alice"),
    h.children.decide(id, true, "mm-alice"),
  ]);
  const writes = h.calls.filter((c) => c.args["confirm"] === true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.principal, "internal:alice");
  assert.equal(writes[0]!.args["idempotency_key"], h.calls[0]!.args["idempotency_key"]);
  assert.equal([first, second].filter((t) => t.startsWith("已创建子单")).length, 1);
  assert.match(await h.children.decide(id, true, "mm-alice"), /已经创建过/);
  assert.equal(h.calls.filter((c) => c.args["confirm"] === true).length, 1);
});

test("a card that is discarded or has expired creates nothing", async () => {
  const discarded = harness();
  await discarded.children.propose(INPUT, "internal:alice");
  assert.match(await discarded.children.decide(discarded.cards[0]!.id, false, "mm-alice"), /已放弃/);
  assert.equal(discarded.calls.filter((c) => c.args["confirm"] === true).length, 0);
  assert.match(await discarded.children.decide(discarded.cards[0]!.id, true, "mm-alice"), /已经结束/);

  const expired = harness();
  await expired.children.propose(INPUT, "internal:alice");
  expired.clock.now += 16 * 60_000;
  assert.match(await expired.children.decide(expired.cards[0]!.id, true, "mm-alice"), /已过期/);
  assert.equal(expired.calls.filter((c) => c.args["confirm"] === true).length, 0);
  await expired.children.propose(INPUT, "internal:alice");
  assert.equal(expired.cards.length, 2, "an expired request can be asked for again");
  assert.equal(expired.cards[1]!.id, expired.cards[0]!.id);
});

test("OpenProject's refusal is shown as it came and ends the request without a retry", async () => {
  const h = harness({ fail: true });
  await h.children.propose(INPUT, "internal:alice");
  const text = await h.children.decide(h.cards[0]!.id, true, "mm-alice");
  assert.match(text, /创建失败,没有写入:.*DUPLICATE_ASSIGNEE/);
  assert.match(await h.children.decide(h.cards[0]!.id, true, "mm-alice"), /已经结束/);
  assert.equal(h.calls.filter((c) => c.args["confirm"] === true).length, 1);
});

test("a different lock version or reason is a different request with its own key", async () => {
  const h = harness();
  await h.children.propose(INPUT, "internal:alice");
  await h.children.propose({ ...INPUT, lockVersion: 8 }, "internal:alice");
  assert.equal(h.cards.length, 2);
  assert.notEqual(h.cards[0]!.id, h.cards[1]!.id);
  assert.notEqual(h.calls[0]!.args["idempotency_key"], h.calls[1]!.args["idempotency_key"]);
});
