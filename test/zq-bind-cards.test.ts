import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBindCards, parseCandidates, type BindCandidate } from "../src/zq/bind-cards.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createZqIdentityMap, type ZqIdentityLink } from "../src/zq/identity-map.ts";
import { createZqRuntime, type ZqChat } from "../src/zq/runtime.ts";
import type { LeaderLease } from "../src/persistence/leader-lease.ts";
import { testMap } from "./support/test-database.ts";

const JELLY: BindCandidate = {
  mmUserId: "mm-jelly",
  opUserId: "5",
  opLogin: "jelly",
  opName: "Jelly Huang",
  mmName: "jelly.huang",
};
const BOB: BindCandidate = { mmUserId: "mm-bob", opUserId: "12", opLogin: "bob", opName: "Bob B" };

test("a candidates file is checked, and a person or account listed twice is refused", () => {
  assert.deepEqual(parseCandidates(JSON.stringify([JELLY])), [JELLY]);
  assert.throws(() => parseCandidates("{}"), /JSON array/);
  assert.throws(() => parseCandidates(JSON.stringify([{ ...JELLY, opLogin: "" }])), /opLogin is required/);
  assert.throws(() => parseCandidates(JSON.stringify([JELLY, { ...BOB, opUserId: "5" }])), /twice/);
  assert.throws(() => parseCandidates(JSON.stringify([JELLY, { ...BOB, mmUserId: "mm-jelly" }])), /twice/);
});

function harness(allowed: (mm: string) => boolean = () => true) {
  const identity = createZqIdentityMap({ map: testMap<ZqIdentityLink>(), enabled: true });
  const cards: Array<{ to: string; text: string }> = [];
  const notes: string[] = [];
  let candidates = [JELLY, BOB];
  let failing = false;
  const bind = createBindCards({
    identity,
    candidates: async () => candidates,
    isAllowed: allowed,
    sendCard: async (c, text) => {
      if (failing) throw new Error("mattermost down");
      cards.push({ to: c.mmUserId, text });
    },
    notify: async (text) => void notes.push(text),
  });
  return {
    identity,
    cards,
    notes,
    bind,
    set: (c: BindCandidate[]) => (candidates = c),
    fail: (v: boolean) => (failing = v),
  };
}

test("each person is sent one card naming both accounts, and a second round sends nothing", async () => {
  const h = harness();
  assert.equal(await h.bind.tick(), 2);
  assert.deepEqual(h.cards.map((c) => c.to).sort(), ["mm-bob", "mm-jelly"]);
  assert.match(
    h.cards.find((c) => c.to === "mm-jelly")!.text,
    /OpenProject 用户「Jelly Huang」\(账号 jelly\)[\s\S]*@jelly\.huang/,
  );
  assert.match(h.cards.find((c) => c.to === "mm-bob")!.text, /mm-bob/);
  assert.equal((await h.identity.get("mm-jelly"))?.status, "pending");
  assert.equal(await h.bind.tick(), 0);
  assert.equal(h.cards.length, 2);
});

test("only people the allowlist permits are asked, and the others are asked once it widens", async () => {
  let open = new Set(["mm-jelly"]);
  const h = harness((mm) => open.has(mm));
  assert.equal(await h.bind.tick(), 1);
  assert.deepEqual(
    h.cards.map((c) => c.to),
    ["mm-jelly"],
  );
  assert.equal(await h.identity.get("mm-bob"), undefined, "no record is kept for someone who was not asked");
  open = new Set(["mm-jelly", "mm-bob"]);
  assert.equal(await h.bind.tick(), 1);
  assert.deepEqual(
    h.cards.map((c) => c.to),
    ["mm-jelly", "mm-bob"],
  );
});

test("a failed send leaves no record, so the card is tried again", async () => {
  const h = harness();
  h.fail(true);
  assert.equal(await h.bind.tick(), 0);
  assert.equal(await h.identity.get("mm-jelly"), undefined);
  h.fail(false);
  assert.equal(await h.bind.tick(), 2);
});

test("a person who said it is not them is not asked again until the card is resent, and the owner hears of it", async () => {
  const h = harness();
  await h.bind.tick();
  await h.identity.decline("mm-bob");
  await h.bind.declined("mm-bob");
  assert.match(h.notes[0]!, /Bob B.*账号 bob.*不是我/);
  assert.equal(await h.bind.tick(), 0, "a declined person is not asked again by the sweep");
  assert.equal(await h.bind.resend("mm-bob"), true);
  assert.equal(h.cards.filter((c) => c.to === "mm-bob").length, 2);
  assert.equal((await h.identity.get("mm-bob"))?.status, "pending");
  assert.equal(await h.bind.resend("mm-nobody"), false);
});

test("from the runtime, a card goes only to an allowed person, only that person can answer, yes links and no tells the owner", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "zq-bind-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "candidates.json");
  await writeFile(file, JSON.stringify([JELLY, BOB]));
  const buttons: Array<{ to: string; text: string; refs: string[] }> = [];
  const dms: Array<{ to: string; text: string }> = [];
  const chat: ZqChat = {
    sendDm: async (to, text) => void dms.push({ to, text }),
    sendButtons: async (to, text, b) =>
      void buttons.push({ to, text, refs: b.map((x) => `${x.name}:${x.op}:${x.ref}:${x.approve}`) }),
    mmUserIdOf: async () => undefined,
    principalOf: async () => undefined,
  };
  const works: Array<() => unknown> = [];
  const lease: LeaderLease = { hold: async (_k, fn) => fn(new Promise<void>(() => {})) };
  const runtime = createZqRuntime({
    config: zqConfigFromEnv({
      ZQ_IDENTITY_MAP: "1",
      ZQ_BIND_CARDS: "1",
      ZQ_BIND_CANDIDATES_FILE: file,
      ZQ_BIND_NOTIFY_MM_USER: "mm-jelly",
      ZQ_RECIPIENT_ALLOWLIST: "mm-jelly",
    }),
    call: async () => "{}",
    chat,
    map: () => testMap(),
    leaderLease: lease,
    createSweeper: (work) => {
      works.push(work);
      return { start() {}, stop: async () => {} };
    },
  });
  runtime.start();
  await works[0]!();
  assert.deepEqual(
    buttons.map((b) => b.to),
    ["mm-jelly"],
  );
  assert.deepEqual(buttons[0]!.refs, ["是我:link:mm-jelly:true", "不是我:link:mm-jelly:false"]);
  await assert.rejects(runtime.decide("link", "mm-jelly", true, "mm-bob"), /只有被关联的本人/);
  assert.equal((await runtime.identityAdmin.list())[0]?.status, "pending");
  assert.equal(await runtime.decide("link", "mm-jelly", true, "mm-jelly"), "已关联 OpenProject 账号。");
  assert.equal((await runtime.identityAdmin.list())[0]?.status, "confirmed");
  await runtime.identityAdmin.unlink("mm-jelly");
  assert.equal(await runtime.identityAdmin.resend!("mm-jelly"), true);
  assert.equal(buttons.length, 2);
  assert.match(await runtime.decide("link", "mm-jelly", false, "mm-jelly"), /没有关联。管理员会收到通知/);
  assert.equal((await runtime.identityAdmin.list())[0]?.status, "declined");
  assert.match(dms.find((d) => d.to === "mm-jelly")!.text, /Jelly Huang.*不是我/);
  assert.equal(
    await runtime.identityAdmin.resend!("mm-bob"),
    false,
    "bob may not be asked while the allowlist is only jelly",
  );
});

test("bind cards need identity mapping and a candidates file, and are off by default", () => {
  assert.equal(zqConfigFromEnv({}).bindCards, false);
  assert.throws(() => zqConfigFromEnv({ ZQ_BIND_CARDS: "1" }), /ZQ_IDENTITY_MAP/);
  assert.throws(() => zqConfigFromEnv({ ZQ_BIND_CARDS: "1", ZQ_IDENTITY_MAP: "1" }), /ZQ_BIND_CANDIDATES_FILE/);
  assert.equal(
    zqConfigFromEnv({ ZQ_BIND_CARDS: "1", ZQ_IDENTITY_MAP: "1", ZQ_BIND_CANDIDATES_FILE: "/x" }).bindCards,
    true,
  );
});
