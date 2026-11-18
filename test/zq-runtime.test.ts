import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { type LeaderLease } from "../src/persistence/leader-lease.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createZqRuntime, type ZqChat } from "../src/zq/runtime.ts";
import { testMap } from "./support/test-database.ts";

function leaseOf(): LeaderLease {
  return { hold: async (_key, fn) => fn(new Promise<void>(() => {})) };
}

function setup(env: NodeJS.ProcessEnv) {
  const buttons: Array<{ to: string; text: string; refs: string[] }> = [];
  const calls: string[] = [];
  const chat: ZqChat = {
    sendDm: async () => {},
    sendButtons: async (to, text, b) =>
      void buttons.push({ to, text, refs: b.map((x) => `${x.op}:${x.ref}:${x.approve}`) }),
    mmUserIdOf: async (principalId) => (principalId === "internal:alice" ? "mm-alice" : undefined),
    principalOf: async (mmUserId) => (mmUserId === "mm-alice" ? "internal:alice" : undefined),
  };
  const runtime = createZqRuntime({
    config: zqConfigFromEnv(env),
    call: async (name, _args, principalId) => {
      calls.push(`${name}@${principalId}`);
      return JSON.stringify({ id: 42, login: "alice", name: "Alice A" });
    },
    chat,
    map: () => testMap(),
    leaderLease: leaseOf(),
    createSweeper: () => ({ start() {}, stop: async () => {} }),
  });
  return { runtime, buttons, calls };
}

test("nothing happens on sign-in while identity mapping is off", async () => {
  const { runtime, buttons, calls } = setup({});
  await runtime.connectorConnected("openproject", "internal:alice");
  assert.deepEqual([buttons, calls], [[], []]);
});

test("signing in to OpenProject proposes a link that only its owner can confirm", async () => {
  const { runtime, buttons, calls } = setup({ ZQ_IDENTITY_MAP: "1" });
  await runtime.connectorConnected("other-server", "internal:alice");
  await runtime.connectorConnected("openproject", "internal:nobody");
  assert.deepEqual(calls, []);
  await runtime.connectorConnected("openproject", "internal:alice");
  assert.deepEqual(calls, ["openproject_get_current_user@internal:alice"]);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0]!.to, "mm-alice");
  assert.match(buttons[0]!.text, /OpenProject 用户 alice/);
  assert.deepEqual(buttons[0]!.refs, ["link:mm-alice:true", "link:mm-alice:false"]);
  await assert.rejects(runtime.decide("link", "mm-alice", true, "mm-bob"), /只有被关联的本人/);
  assert.equal(await runtime.decide("link", "mm-alice", true, "mm-alice"), "已关联 OpenProject 账号。");
  await runtime.connectorConnected("openproject", "internal:alice");
  assert.equal(buttons.length, 1, "a confirmed link is not proposed again");
});

test("answering 不是我 removes the proposal", async () => {
  const { runtime } = setup({ ZQ_IDENTITY_MAP: "1" });
  await runtime.connectorConnected("openproject", "internal:alice");
  assert.equal(await runtime.decide("link", "mm-alice", false, "mm-alice"), "已取消,没有关联 OpenProject 账号。");
  await assert.rejects(runtime.decide("link", "mm-alice", true, "mm-alice"), /no proposed link/);
});

test("a duty the configuration names but the contract key table lacks refuses startup", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseContract } = await import("../src/zq/contract.ts");
  const contract = parseContract(
    JSON.parse(readFileSync(new URL("./fixtures/zq-contract-keys.json", import.meta.url), "utf8")),
  );
  const build = (env: NodeJS.ProcessEnv) =>
    createZqRuntime({
      config: zqConfigFromEnv(env),
      contract,
      call: async () => "{}",
      chat: {
        sendDm: async () => {},
        sendButtons: async () => {},
        mmUserIdOf: async () => undefined,
        principalOf: async () => undefined,
      },
      map: () => testMap(),
      leaderLease: leaseOf(),
      createSweeper: () => ({ start() {}, stop: async () => {} }),
    });
  assert.doesNotThrow(() => build({ ZQ_ESCALATION_DUTIES: "pm" }));
  assert.throws(
    () => build({ ZQ_ESCALATION_DUTIES: "lead_ui" }),
    /ZQ_ESCALATION_DUTIES names a duty the contract key table does not have: lead_ui/,
  );
});

test("adding orders is off by default, and when on the card click goes through the runtime to OpenProject as the requester", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseContract } = await import("../src/zq/contract.ts");
  const contract = parseContract(
    JSON.parse(readFileSync(new URL("./fixtures/zq-contract-keys.json", import.meta.url), "utf8")),
  );
  const calls: string[] = [];
  const cards: Array<{ to: string; refs: string[]; ref: string }> = [];
  const build = (env: NodeJS.ProcessEnv) =>
    createZqRuntime({
      config: zqConfigFromEnv(env),
      contract,
      call: async (name, args, principalId) => {
        calls.push(`${name}:${String(args["confirm"])}@${principalId}`);
        return "{}";
      },
      chat: {
        sendDm: async () => {},
        sendButtons: async (to, _text, b) =>
          void cards.push({ to, ref: b[0]!.ref, refs: b.map((x) => `${x.op}:${x.approve}`) }),
        mmUserIdOf: async (principalId) => (principalId === "internal:alice" ? "mm-alice" : undefined),
        principalOf: async () => undefined,
      },
      map: () => testMap(),
      leaderLease: leaseOf(),
      createSweeper: () => ({ start() {}, stop: async () => {} }),
    });
  assert.equal(build({}).children, undefined);
  const runtime = build({ ZQ_CHILD_ORDERS: "1" });
  await runtime.children!.propose(
    {
      featureId: 40,
      lockVersion: 1,
      reason: "补单",
      children: [{ typeKey: "frontend", subject: "联调", description: "登录页" }],
    },
    "internal:alice",
  );
  assert.deepEqual([cards[0]!.to, cards[0]!.refs], ["mm-alice", ["children:true", "children:false"]]);
  assert.deepEqual(calls, ["openproject_zq_create_child_orders:false@internal:alice"]);
  await assert.rejects(runtime.decide("children", cards[0]!.ref, true, "mm-bob"), /只有提出请求的人/);
  assert.match(await runtime.decide("children", cards[0]!.ref, true, "mm-alice"), /已创建子单/);
  assert.deepEqual(calls, [
    "openproject_zq_create_child_orders:false@internal:alice",
    "openproject_zq_create_child_orders:true@internal:alice",
  ]);
  await assert.rejects(build({}).decide("children", "x", true, "mm-alice"), /没有开启/);
});

test("with a recipient allowlist, nobody else is sent a card, and an empty allowlist limits no one", async () => {
  const outside = setup({ ZQ_IDENTITY_MAP: "1", ZQ_RECIPIENT_ALLOWLIST: "mm-bob" });
  await outside.runtime.connectorConnected("openproject", "internal:alice").catch(() => {});
  assert.deepEqual(outside.buttons, []);
  const inside = setup({ ZQ_IDENTITY_MAP: "1", ZQ_RECIPIENT_ALLOWLIST: " mm-bob , mm-alice " });
  await inside.runtime.connectorConnected("openproject", "internal:alice");
  assert.deepEqual(
    inside.buttons.map((b) => b.to),
    ["mm-alice"],
  );
  const open = setup({ ZQ_IDENTITY_MAP: "1", ZQ_RECIPIENT_ALLOWLIST: "" });
  await open.runtime.connectorConnected("openproject", "internal:alice");
  assert.equal(open.buttons.length, 1);
});
