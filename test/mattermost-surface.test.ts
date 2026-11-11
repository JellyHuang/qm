import { test } from "node:test";
import assert from "node:assert/strict";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import {
  containerOf,
  encodeTarget,
  parseTarget,
  postIdOf,
  postTs,
  threadRefFor,
  type MattermostUser,
} from "../src/surfaces/mattermost/protocol.ts";
import { createActionSigner, approvalCard, cardProps } from "../src/surfaces/mattermost/cards.ts";
import { createLinkRegistry, verifiedEmail, type IdentityStores } from "../src/surfaces/mattermost/identity.ts";
import { cleanReply, normalizeEmoji, reactionTargets } from "../src/surfaces/mattermost/format.ts";
import { mattermostConfigFromEnv } from "../src/surfaces/mattermost/config.ts";
import { createMattermostSurface } from "../src/surfaces/mattermost/surface.ts";

const A = "abcdefghijkmnopqrstuwxyz13";
const B = "zyxwutsrqponmkjihgfedcba45";

function memoryMap<T>(): DurableMap<T> {
  const rows = new Map<string, T>();
  const partial = {
    async all() {
      return [...rows.values()];
    },
    async entries() {
      return [...rows.entries()];
    },
    async get(id: string) {
      return rows.get(id) ?? null;
    },
    async put(id: string, value: T) {
      rows.set(id, value);
    },
    async take(id: string) {
      const v = rows.get(id) ?? null;
      rows.delete(id);
      return v;
    },
    async delete(id: string) {
      rows.delete(id);
    },
    async merge(id: string, patch: Partial<T>) {
      const v = rows.get(id);
      if (!v) return null;
      const next = { ...v, ...patch };
      rows.set(id, next);
      return next;
    },
    async update(id: string, fn: (value: T) => T) {
      const v = rows.get(id);
      if (!v) return null;
      const next = fn(v);
      rows.set(id, next);
      return next;
    },
  };
  return partial as unknown as DurableMap<T>;
}

function stores(): IdentityStores {
  return { links: memoryMap(), tokens: memoryMap(), access: memoryMap(), pending: memoryMap() };
}

function user(overrides: Partial<MattermostUser> = {}): MattermostUser {
  return {
    id: A,
    username: "alice",
    email: "Alice@Example.com",
    first_name: "Alice",
    last_name: "Liddell",
    nickname: "",
    is_bot: false,
    delete_at: 0,
    roles: "system_user",
    ...overrides,
  };
}

test("post timestamps encode the Mattermost post id and decode back to it", () => {
  const ts = postTs(A, 1_731_300_000_123);
  assert.match(ts, /^1731300000\.123\d{41}$/);
  assert.equal(postIdOf(ts), A);
  assert.equal(postIdOf(`~${A}`), A);
  assert.equal(postIdOf(A), A);
  assert.equal(postIdOf("1731300000.123456"), null);
  assert.ok(postTs(A, 1_731_300_000_123) < postTs(B, 1_731_300_000_124), "later posts sort after earlier ones");
});

test("delivery targets round-trip and reject malformed ids", () => {
  assert.equal(encodeTarget({ channel: A }), A);
  assert.equal(encodeTarget({ channel: A, root: B }), `${A}:${B}`);
  assert.deepEqual(parseTarget(`${A}:${B}`), { channel: A, root: B });
  assert.equal(parseTarget("C123:456"), null);
  assert.equal(parseTarget(`${A}:${B}:x`), null);
  assert.equal(containerOf(`${A}:${B}`), A);
  assert.equal(threadRefFor("dm", A), `mm:dm:${A}`);
  assert.equal(threadRefFor("channel", A, B), `mm:ch:${A}:${B}`);
  assert.equal(threadRefFor("group", A, B), `mm:grp:${A}:${B}`);
});

test("signed button context opens only untampered and unexpired", () => {
  const signer = createActionSigner("s".repeat(40));
  const ctx = signer.sign({ k: "approval", requestId: "r1", choice: "once" });
  assert.deepEqual(signer.open(ctx), { k: "approval", requestId: "r1", choice: "once" });
  assert.equal(signer.open({ ...ctx, p: ctx.p.replace("once", "always") }), null);
  assert.equal(signer.open(ctx, ctx.exp + 1), null);
  assert.equal(createActionSigner("t".repeat(40)).open(ctx), null);
  assert.equal(signer.open("nope"), null);
});

test("approval cards carry one signed button per grant mode", () => {
  const signer = createActionSigner("s".repeat(40));
  const card = approvalCard({
    requestId: "r1",
    command: "rm -rf /tmp/x",
    reason: "rule",
    grantModes: { session: false, always: true },
  });
  const props = cardProps(card, signer, "https://qm.example/v1/surfaces/mattermost/actions") as {
    attachments: Array<{ actions: Array<{ id: string; integration: { url: string; context: unknown } }> }>;
  };
  const ids = props.attachments[0]!.actions.map((a) => a.id);
  assert.deepEqual(ids, ["allowonce", "allowalways", "deny"]);
  for (const a of props.attachments[0]!.actions) {
    assert.match(a.id, /^[a-z]+$/);
    assert.equal(a.integration.url, "https://qm.example/v1/surfaces/mattermost/actions");
    assert.ok(signer.open(a.integration.context));
  }
});

test("link tokens are single use and bound to the matching QM email", async () => {
  const links = createLinkRegistry(stores());
  const u = user();
  const email = verifiedEmail(u)!;
  assert.equal(email, "alice@example.com");
  const token = await links.issueToken(u, email);
  assert.equal(await links.redeemToken(token, "mallory@example.com"), "mismatch");
  const linked = await links.redeemToken(token, "ALICE@example.com");
  assert.ok(linked && linked !== "mismatch");
  assert.equal(linked.mmUserId, A);
  assert.equal(await links.redeemToken(token, "alice@example.com"), null, "a token works once");
  assert.equal((await links.linkFor(u))?.email, "alice@example.com");
});

test("a link is dropped when the Mattermost email changes", async () => {
  const links = createLinkRegistry(stores());
  const u = user();
  const token = await links.issueToken(u, "alice@example.com");
  await links.redeemToken(token, "alice@example.com");
  assert.equal(await links.linkFor(user({ email: "someone-else@example.com" })), null);
  assert.equal(await links.linkFor(u), null, "the stale link is gone even after the email changes back");
});

test("link tokens expire", async () => {
  let now = 1_000_000;
  const links = createLinkRegistry(stores(), () => now);
  const token = await links.issueToken(user(), "alice@example.com");
  now += 16 * 60_000;
  assert.equal(await links.peekToken(token), null);
  assert.equal(await links.redeemToken(token, "alice@example.com"), null);
});

test("access requests are decided once", async () => {
  const links = createLinkRegistry(stores());
  const { request, notify } = await links.requestAccess(user(), "alice@example.com");
  assert.equal(request.status, "pending");
  assert.equal(notify, true);
  assert.equal((await links.requestAccess(user(), "alice@example.com")).notify, false, "no repeat notification");
  const decided = await links.decideAccess("alice@example.com", true, "admin@example.com");
  assert.equal(decided?.status, "approved");
  assert.equal(await links.decideAccess("alice@example.com", false, "admin@example.com"), null);
});

test("held messages replay once and expire", async () => {
  let now = 0;
  const links = createLinkRegistry(stores(), () => now);
  await links.holdTurn(A, { event: "posted" });
  assert.deepEqual(await links.releaseTurn(A), { event: "posted" });
  assert.equal(await links.releaseTurn(A), null);
  await links.holdTurn(A, { event: "posted" });
  now += 31 * 60_000;
  assert.equal(await links.releaseTurn(A), null);
});

test("unverified, bot and deactivated users have no usable email", () => {
  assert.equal(verifiedEmail(user({ email_verified: false })), null);
  assert.equal(verifiedEmail(user({ is_bot: true })), null);
  assert.equal(verifiedEmail(user({ delete_at: 5 })), null);
  assert.equal(verifiedEmail(user({ email: "" })), null);
});

test("reaction directives are stripped and only target posts the agent saw", () => {
  const { text, reactions } = cleanReply(`Done! [[react: white_check_mark]] [[react: tada @ ~${B}]]`);
  assert.equal(text, "Done!");
  assert.deepEqual(reactionTargets(reactions, A, new Set([A])), [{ postId: A, names: ["white_check_mark"] }]);
  assert.deepEqual(reactionTargets(reactions, A, new Set([A, B])), [
    { postId: A, names: ["white_check_mark"] },
    { postId: B, names: ["tada"] },
  ]);
  assert.equal(normalizeEmoji("👍"), "+1");
  assert.equal(normalizeEmoji(":eyes:"), "eyes");
  assert.equal(normalizeEmoji("not an emoji!"), null);
});

test("config needs url, token, team and a public URL", () => {
  assert.equal(mattermostConfigFromEnv({}, { publicUrl: "https://qm" }), undefined);
  const env = { MATTERMOST_URL: "https://mm/", MATTERMOST_BOT_TOKEN: "tok", MATTERMOST_TEAM: "zq" };
  assert.throws(() => mattermostConfigFromEnv(env, { signingSecret: "x".repeat(40) }), /public URL/);
  assert.throws(() => mattermostConfigFromEnv(env, { publicUrl: "https://qm" }), /ACTION_SECRET/);
  const cfg = mattermostConfigFromEnv(env, { publicUrl: "https://qm/", signingSecret: "x".repeat(40) })!;
  assert.equal(cfg.url, "https://mm");
  assert.equal(cfg.actionUrl, "https://qm/v1/surfaces/mattermost/actions");
  assert.equal(cfg.linkUrl, "https://qm/api/mattermost/link");
  assert.equal(cfg.ownsDirectMessages, true);
  assert.equal(
    mattermostConfigFromEnv(
      { ...env, MATTERMOST_ACTION_URL: "http://qm-zq-core:8000/" },
      { publicUrl: "https://qm", signingSecret: "x".repeat(40) },
    )!.actionUrl,
    "http://qm-zq-core:8000/v1/surfaces/mattermost/actions",
  );
  assert.equal(cfg.actionSecret.length, 64);
  assert.equal(
    mattermostConfigFromEnv(
      { ...env, MATTERMOST_OWNS_DIRECT_MESSAGES: "0" },
      { publicUrl: "https://qm", signingSecret: "x".repeat(40) },
    )!.ownsDirectMessages,
    false,
  );
});

test("surface threads replies under the given post and lists revision candidates", async () => {
  const surface = createMattermostSurface({
    deliveries: {} as never,
    usernameOf: (id) => (id === A ? "alice" : undefined),
  });
  assert.equal(await surface.threadTarget!(A, postTs(B, 1000)), `${A}:${B}`);
  await assert.rejects(surface.threadTarget!("bad", B));
  assert.deepEqual(surface.threadRefCandidates!(A, postTs(B, 1000)), [
    `mm:dm:${A}`,
    `mm:dm:${A}:${B}`,
    `mm:ch:${A}:${B}`,
    `mm:grp:${A}:${B}`,
  ]);
  assert.equal(
    surface.mention({ surface: "mattermost", account: "default", id: A, principal: { externalId: "a@x" } }),
    "@alice",
  );
});
