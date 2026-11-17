import assert from "node:assert/strict";
import { test } from "node:test";
import { tenantTest as scenario } from "./support/tenant-test.ts";
import { withTenant } from "../src/tenants/context.ts";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { createJenkinsClient } from "../src/zq/jenkins/client.ts";
import type { DecisionPolicy } from "../src/zq/jenkins/decision.ts";
import { createRecordingSink } from "../src/zq/jenkins/notices.ts";
import { createJenkinsPoller, type PollError } from "../src/zq/jenkins/poller.ts";
import {
  createJenkinsStore,
  type JenkinsAuditRow,
  type JenkinsBuildRecord,
  type JenkinsNotice,
} from "../src/zq/jenkins/store.ts";
import { CAUSES, FAKE_SECRET, FAKE_USER, startFakeJenkins, type FakeParam } from "./support/fake-jenkins.ts";
import { tenantMap } from "./support/tenant-map.ts";
import { testMap } from "./support/test-database.ts";
import { TEST_TENANT } from "./support/test-tenant.ts";

const NOW = 10_000_000_000;
const JOB = "Server-Build";
const PARAMS: FakeParam[] = [
  { name: "CONFIG", value: "" },
  { name: "NOTE", value: "a&b=c d%é+x" },
  { name: "TAGS", value: "x,y,z" },
  { name: "TAGS", value: "w" },
];
const DEFINED = ["CONFIG", "NOTE", "TAGS"];
const CONSOLE_TEXT = "TOP-SECRET-LOG-LINE";

type MapOf = <T>() => DurableMap<T>;

interface Options {
  live?: boolean;
  policy?: Partial<DecisionPolicy>;
  secret?: string;
  mapOf?: MapOf;
  jobs?: string[];
}

async function harness(opts: Options = {}) {
  let clock = NOW;
  const fake = await startFakeJenkins({ now: () => clock });
  fake.addJob(JOB, DEFINED);
  const jobs = opts.jobs ?? [JOB];
  const mapOf = opts.mapOf ?? (<T>() => tenantMap<T>());
  const maps = {
    builds: mapOf<JenkinsBuildRecord>(),
    audits: mapOf<JenkinsAuditRow>(),
    notices: mapOf<JenkinsNotice>(),
  };
  const sink = createRecordingSink();
  const errors: PollError[] = [];
  const policy: DecisionPolicy = {
    failureResults: ["FAILURE"],
    rerunJobs: jobs,
    causes: ["timer", "scm", "upstream"],
    maxAgeMs: 30 * 60_000,
    hourlyCap: 3,
    botUser: FAKE_USER,
    ...opts.policy,
  };
  const newStore = () =>
    createJenkinsStore({ builds: maps.builds, audits: maps.audits, noticeMap: maps.notices, now: () => clock });
  const newPoller = (live = opts.live ?? true) =>
    createJenkinsPoller({
      client: createJenkinsClient({
        baseUrl: fake.url,
        user: FAKE_USER,
        password: opts.secret ?? FAKE_SECRET,
        jobs,
      }),
      store: newStore(),
      policy,
      jobs,
      live,
      noticeMode: "dry-run",
      channelId: "backend-group",
      sink,
      owner: (job) => (job === JOB ? "alice" : undefined),
      onError: (error) => errors.push(error),
      createSweeper: () => ({ start() {}, stop: async () => {} }),
      intervalMs: 120_000,
      now: () => clock,
      wait: async () => {},
    });
  const poller = newPoller();
  const rows = async () => (await newStore().records()).sort((a, b) => a.number - b.number);
  const state = async (number: number) => (await rows()).find((r) => r.number === number);
  const everything = async () =>
    JSON.stringify({
      rows: await rows(),
      audit: await newStore().auditRows(),
      notices: await newStore().notices(),
      sent: sink.sent,
      errors,
    });
  return {
    fake,
    poller,
    newPoller,
    newStore,
    sink,
    errors,
    rows,
    state,
    everything,
    advance: (ms: number) => (clock += ms),
    failed: (number: number, extra: Partial<Parameters<typeof fake.addBuild>[1]> = {}) =>
      fake.addBuild(JOB, { number, result: "FAILURE", params: PARAMS, log: CONSOLE_TEXT, ...extra }),
  };
}

scenario(
  "by default (dry-run) a failed build is only observed: nothing is posted or sent, and the audit says what would happen once",
  async () => {
    const h = await harness({ live: false });
    h.failed(10);
    for (let i = 0; i < 3; i++) await h.poller.tick();
    assert.equal((await h.state(10))?.state, "eligible");
    assert.deepEqual(h.fake.posts, []);
    assert.deepEqual(h.sink.sent, []);
    const events = (await h.newStore().auditRows()).map((r) => r.event);
    assert.deepEqual(events.sort(), ["dry_run_would_rerun", "eligible", "observed"]);
    await h.fake.close();
  },
);

scenario("a failed build is rerun once with every parameter verbatim and followed to its end", async () => {
  const h = await harness();
  h.failed(10);
  const summary = await h.poller.tick();
  assert.equal(summary.requested, 1);
  assert.deepEqual(
    [...new URLSearchParams(h.fake.posts[0]?.body)],
    PARAMS.map((p) => [p.name, p.value]),
  );
  const row = await h.state(10);
  assert.equal(row?.state, "rerun_running");
  assert.equal(row?.rerunNumber, 11);
  assert.deepEqual(row?.parameterDifferences, []);
  assert.match(row?.consoleTailHash ?? "", /^[0-9a-f]{64}$/);
  h.fake.finish(JOB, 11, "SUCCESS");
  await h.poller.tick();
  assert.equal((await h.state(10))?.state, "rerun_succeeded");
  assert.equal(await h.state(11), undefined);
  for (let i = 0; i < 3; i++) await h.poller.tick();
  assert.equal(h.fake.posts.length, 1);
  assert.deepEqual(h.sink.sent, []);
  await h.fake.close();
});

scenario(
  "a rerun that fails is announced to the group once, mentioning the owner, and is never rerun again",
  async () => {
    const h = await harness();
    h.failed(10);
    await h.poller.tick();
    h.fake.finish(JOB, 11, "FAILURE");
    await h.poller.tick();
    for (let i = 0; i < 4; i++) await h.poller.tick();
    assert.equal(h.fake.posts.length, 1);
    assert.equal(h.sink.sent.length, 1);
    const [message] = h.sink.sent;
    assert.equal(message?.channelId, "backend-group");
    assert.match(message?.text ?? "", /Server-Build #10\(FAILURE\)/);
    assert.match(message?.text ?? "", /重跑 #11\(FAILURE\)/);
    assert.match(message?.text ?? "", /http:\/\/127\.0\.0\.1:\d+\/job\/Server-Build\/10\//);
    assert.match(message?.text ?? "", /@alice/);
    assert.equal((await h.state(10))?.state, "notified");
    assert.equal((await h.state(11))?.state, "skipped");
    const rerunFailed = (await h.newStore().notices()).filter((n) => n.kind === "rerun_failed");
    assert.equal(rerunFailed.length, 1);
    await h.fake.close();
  },
);

scenario("a restart with the same durable tables does not rerun or notify again", async () => {
  const h = await harness();
  h.failed(10);
  await h.poller.tick();
  const restarted = h.newPoller();
  await restarted.tick();
  h.fake.finish(JOB, 11, "FAILURE");
  await restarted.tick();
  const again = h.newPoller();
  await again.tick();
  await again.tick();
  assert.equal(h.fake.posts.length, 1);
  assert.equal(h.sink.sent.length, 1);
  await h.fake.close();
});

scenario("two pollers at the same moment send exactly one rerun and one notice", async () => {
  const h = await harness();
  h.failed(10);
  const other = h.newPoller();
  await Promise.all([h.poller.tick(), other.tick()]);
  assert.equal(h.fake.posts.length, 1);
  h.fake.finish(JOB, 11, "FAILURE");
  await Promise.all([h.poller.tick(), other.tick()]);
  await Promise.all([h.poller.tick(), other.tick()]);
  assert.equal(h.fake.posts.length, 1);
  assert.equal(h.sink.sent.length, 1);
  await h.fake.close();
});

scenario("two live pollers that find the same waiting row claim it once", async () => {
  const h = await harness({ live: false });
  h.failed(10);
  await h.poller.tick();
  assert.equal((await h.state(10))?.state, "eligible");
  await Promise.all([h.newPoller(true).tick(), h.newPoller(true).tick(), h.newPoller(true).tick()]);
  assert.equal(h.fake.posts.length, 1);
  await h.fake.close();
});

scenario(
  "the circuit breaker stops reruns at the cap, notifies once per hour, and two pollers cannot exceed it together",
  async () => {
    const h = await harness({ policy: { hourlyCap: 2 } });
    for (const n of [10, 12, 14, 16]) h.failed(n);
    const other = h.newPoller();
    await Promise.all([h.poller.tick(), other.tick()]);
    assert.equal(h.fake.posts.length, 2);
    const breaker = (await h.newStore().notices()).filter((n) => n.kind === "circuit_open");
    assert.equal(breaker.length, 1);
    assert.equal(h.sink.sent.filter((m) => /已暂停/.test(m.text)).length, 1);
    const skipped = (await h.rows()).filter((r) => r.reason === "circuit_open").map((r) => r.number);
    assert.deepEqual(skipped.length, 2);
    await h.poller.tick();
    await other.tick();
    assert.equal(h.fake.posts.length, 2);
    assert.equal(h.sink.sent.filter((m) => /已暂停/.test(m.text)).length, 1);
    await h.fake.close();
  },
);

scenario("a build that a newer build already replaced is skipped as superseded", async () => {
  const h = await harness();
  h.failed(10);
  h.fake.addBuild(JOB, { number: 11, result: "SUCCESS", params: PARAMS });
  h.failed(20);
  h.fake.addBuild(JOB, { number: 21, result: null, building: true, params: PARAMS });
  await h.poller.tick();
  assert.equal((await h.state(10))?.reason, "superseded");
  assert.equal((await h.state(20))?.reason, "superseded");
  assert.deepEqual(h.fake.posts, []);
  await h.fake.close();
});

scenario(
  "a build that is still running is not recorded until it ends, and aborted or unstable builds are ignored",
  async () => {
    const h = await harness();
    h.fake.addBuild(JOB, { number: 10, result: null, building: true, params: PARAMS });
    h.fake.addBuild(JOB, { number: 11, result: "ABORTED", params: PARAMS });
    h.fake.addBuild(JOB, { number: 12, result: "UNSTABLE", params: PARAMS });
    await h.poller.tick();
    assert.deepEqual(await h.rows(), []);
    assert.deepEqual(h.fake.posts, []);
    h.fake.finish(JOB, 10, "FAILURE");
    await h.poller.tick();
    assert.equal((await h.state(10))?.state, "rerun_running");
    await h.fake.close();
  },
);

scenario("unstable builds are rerun when the configuration counts them as failures", async () => {
  const h = await harness({ policy: { failureResults: ["FAILURE", "UNSTABLE"] } });
  h.fake.addBuild(JOB, { number: 12, result: "UNSTABLE", params: PARAMS });
  await h.poller.tick();
  assert.equal(h.fake.posts.length, 1);
  await h.fake.close();
});

scenario(
  "old failures are ignored at the first start, and an old waiting row is dropped when it is later looked at",
  async () => {
    const h = await harness({ live: false });
    h.failed(10, { timestamp: NOW - 3 * 3_600_000 });
    h.failed(11);
    await h.poller.tick();
    assert.deepEqual(
      (await h.rows()).map((r) => r.number),
      [11],
    );
    h.advance(31 * 60_000);
    const live = h.newPoller(true);
    await live.tick();
    assert.equal((await h.state(11))?.reason, "too_old");
    assert.deepEqual(h.fake.posts, []);
    await h.fake.close();
  },
);

scenario(
  "manual triggers are not rerun, a build by the bot is never rerun, and a human retry of a rerun chain is not rerun twice",
  async () => {
    const h = await harness();
    h.failed(10, { causes: [CAUSES.user("alice")] });
    h.failed(11, { causes: [CAUSES.rebuild("alice")] });
    h.failed(12, { causes: [CAUSES.user(FAKE_USER)] });
    h.failed(13, { causes: [CAUSES.remote] });
    h.failed(14, { causes: [CAUSES.unknown] });
    await h.poller.tick();
    assert.deepEqual(
      (await h.rows()).map((r) => [r.number, r.reason]),
      [
        [10, "manual_trigger"],
        [11, "manual_trigger"],
        [12, "bot_triggered"],
        [13, "cause_not_allowed"],
        [14, "cause_not_allowed"],
      ],
    );
    assert.deepEqual(h.fake.posts, []);
    await h.fake.close();

    const wide = await harness({ policy: { causes: ["timer", "user"] } });
    wide.failed(20);
    await wide.poller.tick();
    wide.fake.finish(JOB, 21, "FAILURE");
    wide.failed(22, { causes: [CAUSES.user("alice")] });
    await wide.poller.tick();
    assert.equal((await wide.state(22))?.reason, "chain_rerun");
    assert.equal(wide.fake.posts.length, 1);
    await wide.fake.close();
  },
);

scenario("a build with unreadable or incomplete parameters is not rerun and is reported once", async () => {
  const h = await harness();
  h.failed(10, { params: [...PARAMS, { name: "PASS", value: "hunter2", cls: "hudson.model.PasswordParameterValue" }] });
  h.failed(11, { params: PARAMS.slice(0, 2) });
  await h.poller.tick();
  await h.poller.tick();
  assert.deepEqual(h.fake.posts, []);
  assert.deepEqual(
    (await h.rows()).map((r) => r.reason),
    ["parameters_unreadable", "parameters_incomplete"],
  );
  assert.equal(h.sink.sent.length, 2);
  assert.match(h.sink.sent[0]?.text ?? "", /需要人工处理/);
  assert.doesNotMatch(await h.everything(), /hunter2/);
  await h.fake.close();
});

scenario("a request Jenkins rejects is reported once and never retried", async () => {
  const h = await harness();
  h.fake.options.rejectPosts = 403;
  h.failed(10);
  await h.poller.tick();
  assert.equal((await h.state(10))?.reason, "request_rejected");
  await h.poller.tick();
  assert.equal(h.fake.posts.length, 1);
  assert.equal(h.sink.sent.length, 1);
  await h.fake.close();
});

scenario("a claim whose response was lost is matched to the build that exists and never posted again", async () => {
  const h = await harness();
  h.fake.options.dropPostResponse = true;
  h.failed(10);
  await h.poller.tick();
  assert.equal((await h.state(10))?.state, "rerun_requested");
  assert.equal(h.errors[0]?.kind, "unreachable");
  await h.poller.tick();
  assert.equal((await h.state(10))?.state, "rerun_requested");
  h.advance(6 * 60_000);
  await h.poller.tick();
  const row = await h.state(10);
  assert.equal(row?.state, "rerun_running");
  assert.equal(row?.rerunNumber, 11);
  assert.equal(h.fake.posts.length, 1);
  await h.fake.close();
});

scenario("a claim with no matching build is reported as uncertain and never posted again", async () => {
  const h = await harness();
  h.failed(10);
  await h.newStore().observe({
    job: JOB,
    number: 10,
    state: "rerun_requested",
    url: "",
    result: "FAILURE",
    finishedAt: NOW,
    observedAt: NOW,
    updatedAt: NOW,
    causes: ["timer"],
    fingerprint: "none",
    parameterCount: 4,
    claimedAt: NOW,
  });
  h.advance(6 * 60_000);
  await h.poller.tick();
  assert.equal((await h.state(10))?.reason, "claim_uncertain");
  assert.equal(h.sink.sent.length, 1);
  await h.poller.tick();
  assert.deepEqual(h.fake.posts, []);
  assert.equal(h.sink.sent.length, 1);
  await h.fake.close();
});

scenario("a rerun still waiting in the queue is linked once it starts", async () => {
  const h = await harness();
  h.fake.options.holdQueue = true;
  h.failed(10);
  await h.poller.tick();
  assert.equal((await h.state(10))?.state, "rerun_requested");
  h.fake.releaseQueue();
  await h.poller.tick();
  assert.equal((await h.state(10))?.state, "rerun_running");
  assert.equal(h.fake.posts.length, 1);
  await h.fake.close();
});

scenario(
  "a rejected credential or a missing job is reported, changes nothing, and is audited once per hour",
  async () => {
    const h = await harness({ secret: "wrong-secret-value" });
    h.failed(10);
    await h.poller.tick();
    await h.poller.tick();
    assert.deepEqual(
      h.errors.map((e) => e.kind),
      ["auth", "auth"],
    );
    assert.deepEqual(await h.rows(), []);
    const audit = (await h.newStore().auditRows()).filter((r) => r.event === "poll_error");
    assert.equal(audit.length, 1);
    assert.doesNotMatch(await h.everything(), /wrong-secret-value/);
    await h.fake.close();

    const missing = await harness({ jobs: [JOB, "Ghost"] });
    await missing.poller.tick();
    assert.equal(missing.errors[0]?.kind, "job_not_found");
    assert.equal(missing.errors[0]?.job, "Ghost");
    await missing.fake.close();
  },
);

scenario(
  "the credential, the parameter values and the console text appear in no row, audit, notice, message or error",
  async () => {
    const h = await harness();
    h.failed(10);
    h.failed(12, {
      params: [...PARAMS, { name: "PASS", value: "hunter2", cls: "hudson.model.PasswordParameterValue" }],
    });
    await h.poller.tick();
    h.fake.finish(JOB, 13, "FAILURE");
    await h.poller.tick();
    await h.poller.tick();
    const text = await h.everything();
    const basic = Buffer.from(`${FAKE_USER}:${FAKE_SECRET}`).toString("base64");
    for (const forbidden of [FAKE_SECRET, basic, "hunter2", CONSOLE_TEXT, "a&b=c d%é+x", "x,y,z"])
      assert.ok(!text.includes(forbidden), `leaked ${forbidden}`);
    assert.ok(h.sink.sent.length > 0);
    await h.fake.close();
  },
);

scenario("every decision is audited with the actor, the state change and the reason", async () => {
  const h = await harness();
  h.failed(10);
  h.failed(12, { causes: [CAUSES.user("alice")] });
  await h.poller.tick();
  const audit = await h.newStore().auditRows();
  const by = (id: string) => audit.find((r) => r.id === id);
  assert.deepEqual(
    [by("Server-Build:10:rerun_requested")?.from, by("Server-Build:10:rerun_requested")?.to],
    ["eligible", "rerun_requested"],
  );
  assert.equal(by("Server-Build:12:skipped")?.reason, "manual_trigger");
  assert.ok(audit.every((r) => r.actor === "poller" && r.at === NOW));
  await h.fake.close();
});

void test("the same scenario holds on Postgres", { skip: !process.env.DATABASE_URL }, () =>
  withTenant(TEST_TENANT, async () => {
    const h = await harness({ mapOf: <T>() => testMap<T>() });
    h.failed(10);
    const other = h.newPoller();
    await Promise.all([h.poller.tick(), other.tick()]);
    h.fake.finish(JOB, 11, "FAILURE");
    await Promise.all([h.poller.tick(), other.tick()]);
    await h.poller.tick();
    assert.equal(h.fake.posts.length, 1);
    assert.equal(h.sink.sent.length, 1);
    assert.equal((await h.state(10))?.state, "notified");
    await h.fake.close();
  }),
);
