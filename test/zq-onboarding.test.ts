import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createZqIdentityMap, type ZqIdentityLink } from "../src/zq/identity-map.ts";
import {
  BLOCKED_TEXT,
  createOnboarding,
  gitlabUserCheck,
  type GitlabCheck,
  type OnboardingButton,
  type OnboardingRecord,
} from "../src/zq/onboarding.ts";
import { createZqRuntime, type ZqChat } from "../src/zq/runtime.ts";
import type { LeaderLease } from "../src/persistence/leader-lease.ts";
import { testMap } from "./support/test-database.ts";

const PROPOSAL = {
  mmUserId: "mm-ann",
  opUserId: "7",
  opLogin: "ann",
  opName: "Ann A",
  source: "card" as const,
  proposedBy: "t",
};

function harness(
  over: { gitlab?: (u: string) => Promise<GitlabCheck>; email?: () => string; allowed?: (mm: string) => boolean } = {},
) {
  const identity = createZqIdentityMap({ map: testMap<ZqIdentityLink>(), enabled: true });
  const texts: string[] = [];
  const cards: Array<{ text: string; buttons: OnboardingButton[] }> = [];
  const opCards: string[] = [];
  let email = "ann@igg.com";
  const onboarding = createOnboarding({
    map: testMap<OnboardingRecord>(),
    identity,
    emailOf: async () => (over.email ? over.email() : email),
    ...(over.gitlab ? { checkGitlab: over.gitlab } : {}),
    isAllowed: over.allowed ?? (() => true),
    candidates: async () => [{ mmUserId: "mm-ann" }, { mmUserId: "mm-bob" }],
    sendText: async (_mm, text) => void texts.push(text),
    sendCard: async (_mm, text, buttons) => void cards.push({ text, buttons }),
    opCard: async (mm) => {
      opCards.push(mm);
      return true;
    },
  });
  return { identity, texts, cards, opCards, onboarding, setEmail: (e: string) => (email = e) };
}

test("until every step is done, a message is answered with the unfinished cards and nothing else", async () => {
  const h = harness({ gitlab: async () => "found" });
  assert.equal(await h.onboarding.gate("mm-ann", "帮我查个单子"), true);
  assert.equal(h.texts[0], BLOCKED_TEXT);
  assert.deepEqual(h.opCards, ["mm-ann"]);
  assert.match(h.cards[0]!.text, /ann@igg\.com/);
  assert.deepEqual(
    h.cards[0]!.buttons.map((b) => b.name),
    ["是这个", "我要改"],
  );
  assert.match(h.texts.join("\n"), /GitLab 账号:请直接回复/);
  const s = await h.onboarding.status("mm-ann");
  assert.deepEqual([s.op, s.email, s.gitlab, s.complete], [false, false, false, false]);
});

test("the email step needs the person's own confirmation, an empty profile must be filled first, and nobody else may answer", async () => {
  const h = harness();
  await h.identity.propose(PROPOSAL);
  await h.identity.confirm("mm-ann", "mm-ann");
  h.setEmail("");
  await h.onboarding.gate("mm-ann", "hi");
  assert.match(h.cards.at(-1)!.text, /还没有邮箱/);
  assert.deepEqual(
    h.cards.at(-1)!.buttons.map((b) => b.name),
    ["已填好"],
  );
  await assert.rejects(h.onboarding.decide("email:mm-ann", true, "mm-bob"), /只有本人/);
  assert.match(await h.onboarding.decide("email:mm-ann", true, "mm-ann"), /还没有邮箱/);
  assert.equal((await h.onboarding.status("mm-ann")).email, false);
  h.setEmail("ann@igg.com");
  await h.onboarding.decide("email-recheck:mm-ann", true, "mm-ann");
  assert.match(h.cards.at(-1)!.text, /请确认你的邮箱:ann@igg\.com/);
  assert.match(await h.onboarding.decide("email:mm-ann", false, "mm-ann"), /个人资料/);
  assert.equal((await h.onboarding.status("mm-ann")).email, false);
  assert.match(await h.onboarding.decide("email:mm-ann", true, "mm-ann"), /已确认邮箱:ann@igg\.com/);
  const s = await h.onboarding.status("mm-ann");
  assert.deepEqual([s.op, s.email, s.complete], [true, true, false], "the GitLab step is still open");
});

test("a GitLab user name is checked, a missing one is asked for again, an unreachable GitLab records nothing, and a found one is kept", async () => {
  const known = new Set(["ann.zhang"]);
  let down = false;
  const h = harness({
    gitlab: async (u) => {
      if (down) return "unavailable";
      return known.has(u) ? "found" : "missing";
    },
  });
  await h.identity.propose(PROPOSAL);
  await h.identity.confirm("mm-ann", "mm-ann");
  await h.onboarding.decide("email:mm-ann", true, "mm-ann");
  await h.onboarding.gate("mm-ann", "hi");
  await h.onboarding.gate("mm-ann", "nobody");
  assert.match(h.texts.at(-1)!, /查不到用户名「nobody」/);
  await h.onboarding.gate("mm-ann", "not a name!");
  assert.match(h.texts.at(-1)!, /不像 GitLab 用户名/);
  down = true;
  await h.onboarding.gate("mm-ann", "ann.zhang");
  assert.match(h.texts.at(-1)!, /现在查不了 GitLab/);
  assert.equal((await h.onboarding.status("mm-ann")).gitlab, false);
  down = false;
  await h.onboarding.gate("mm-ann", "@ann.zhang");
  assert.match(h.texts.at(-1)!, /三项绑定都完成了/);
  assert.equal((await h.onboarding.status("mm-ann")).complete, true);
  assert.equal(await h.onboarding.mmUserOfGitlab("Ann.Zhang"), "mm-ann");
  assert.equal(await h.onboarding.gate("mm-ann", "now a normal message"), false, "a finished person is no longer held");
});

test("with no way to check GitLab the user name is recorded as given and marked unverified, and an administrator can reset one step without touching the others", async () => {
  const h = harness();
  await h.identity.propose(PROPOSAL);
  await h.identity.confirm("mm-ann", "mm-ann");
  await h.onboarding.decide("email:mm-ann", true, "mm-ann");
  assert.equal((await h.onboarding.status("mm-ann")).complete, false, "the GitLab step is still required");
  await h.onboarding.gate("mm-ann", "hi");
  await h.onboarding.gate("mm-ann", "ann.zhang");
  const done = await h.onboarding.status("mm-ann");
  assert.deepEqual([done.gitlabRequired, done.gitlab, done.complete], [true, true, true]);
  assert.equal(await h.onboarding.mmUserOfGitlab("ann.zhang"), "mm-ann");
  await h.onboarding.reset("mm-ann", "gitlab");
  const afterGitlab = await h.onboarding.status("mm-ann");
  assert.deepEqual([afterGitlab.op, afterGitlab.email, afterGitlab.gitlab], [true, true, false]);
  await h.onboarding.reset("mm-ann", "email");
  assert.deepEqual(
    [(await h.onboarding.status("mm-ann")).op, (await h.onboarding.status("mm-ann")).email],
    [true, false],
  );
  await h.onboarding.reset("mm-ann", "op");
  assert.equal((await h.onboarding.status("mm-ann")).op, false);
  assert.equal((await h.onboarding.list()).length, 1);
});

test("only people the allowlist permits are guided, and a sweep guides each candidate once", async () => {
  const h = harness({ allowed: (mm) => mm === "mm-ann" });
  assert.equal(await h.onboarding.gate("mm-bob", "hi"), false, "someone outside the allowlist is never held");
  assert.equal(await h.onboarding.tick(), 1);
  assert.equal(await h.onboarding.tick(), 0);
  assert.equal(h.texts.filter((t) => t === BLOCKED_TEXT).length, 1);
  assert.deepEqual(h.opCards, ["mm-ann"]);
});

test("the GitLab check reads the user list read-only and treats errors as unavailable", async () => {
  const calls: Array<{ url: string; method?: string; token?: string }> = [];
  const respond = (status: number, body: unknown) =>
    (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        ...(init?.method ? { method: init.method } : {}),
        ...(init?.headers ? { token: (init.headers as Record<string, string>)["private-token"] } : {}),
      } as never);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  const check = (status: number, body: unknown, token?: string) =>
    gitlabUserCheck({ baseUrl: "https://git.example/", fetch: respond(status, body), ...(token ? { token } : {}) });
  assert.equal(await check(200, [{ username: "Ann.Zhang" }], "tok")("ann.zhang"), "found");
  assert.equal(calls[0]!.url, "https://git.example/api/v4/users?username=ann.zhang");
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.token, "tok");
  assert.equal(await check(200, [])("ann.zhang"), "missing");
  assert.equal(await check(200, [{ username: "other" }])("ann.zhang"), "missing");
  assert.equal(await check(401, {})("ann.zhang"), "unavailable");
  assert.equal(await check(200, { not: "a list" })("ann.zhang"), "unavailable");
});

test("onboarding needs identity mapping and is off by default", () => {
  assert.equal(zqConfigFromEnv({}).onboarding, false);
  assert.throws(() => zqConfigFromEnv({ ZQ_ONBOARDING: "1" }), /ZQ_IDENTITY_MAP/);
  assert.throws(() => zqConfigFromEnv({ ZQ_GITLAB_URL: "git.example" }), /http\(s\)/);
  const on = zqConfigFromEnv({ ZQ_ONBOARDING: "1", ZQ_IDENTITY_MAP: "1", ZQ_GITLAB_URL: "https://git.example/" });
  assert.deepEqual([on.onboarding, on.gitlabUrl], [true, "https://git.example"]);
});

test("from the runtime, a message from an allowed unfinished person gets cards and reaches nothing else, and reminders skip them until they finish", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "zq-onb-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "candidates.json");
  await writeFile(
    file,
    JSON.stringify([{ mmUserId: "mm-jelly", opUserId: "5", opLogin: "jelly", opName: "Jelly Huang" }]),
  );
  const sent: Array<{ to: string; text: string; kind: string }> = [];
  const chat: ZqChat = {
    sendDm: async (to, text) => void sent.push({ to, text, kind: "dm" }),
    sendButtons: async (to, text, b) =>
      void sent.push({ to, text, kind: `card:${b.map((x) => `${x.op}/${x.name}`).join(",")}` }),
    mmUserIdOf: async () => undefined,
    principalOf: async () => undefined,
    emailOf: async () => "jelly@igg.com",
  };
  const works: Array<() => unknown> = [];
  const lease: LeaderLease = { hold: async (_k, fn) => fn(new Promise<void>(() => {})) };
  const runtime = createZqRuntime({
    config: zqConfigFromEnv({
      ZQ_IDENTITY_MAP: "1",
      ZQ_BIND_CARDS: "1",
      ZQ_BIND_CANDIDATES_FILE: file,
      ZQ_ONBOARDING: "1",
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
  assert.equal(await runtime.onboardingGate!("mm-bob", "hi"), false);
  assert.equal(await runtime.onboardingGate!("mm-jelly", "hello"), true);
  assert.equal(sent[0]!.text, BLOCKED_TEXT);
  assert.ok(
    sent.some((m) => m.kind === "card:link/是我,link/不是我"),
    "the OpenProject card is sent",
  );
  assert.ok(sent.some((m) => m.kind === "card:onboard/是这个,onboard/我要改" && /jelly@igg\.com/.test(m.text)));
  assert.equal(await runtime.decide("link", "mm-jelly", true, "mm-jelly"), "已关联 OpenProject 账号。");
  assert.match(await runtime.decide("onboard", "email:mm-jelly", true, "mm-jelly"), /已确认邮箱/);
  assert.equal(await runtime.onboardingGate!("mm-jelly", "hello again"), true);
  const people = await runtime.identityAdmin.onboardingList!();
  assert.deepEqual(
    people.map((p) => [p.mmUserId, p.op, p.email, p.gitlab, p.complete]),
    [["mm-jelly", true, true, false, false]],
  );
  assert.equal(await runtime.onboardingGate!("mm-jelly", "jelly.huang"), true);
  assert.deepEqual(
    (await runtime.identityAdmin.onboardingList!()).map((p) => p.complete),
    [true],
  );
  await runtime.identityAdmin.onboardingReset!("mm-jelly", "email");
  assert.equal(await runtime.onboardingGate!("mm-jelly", "again"), true);
});
