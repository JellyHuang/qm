import assert from "node:assert/strict";
import { test } from "node:test";
import { tenantTest } from "./support/tenant-test.ts";
import type { LeaderLease } from "../src/persistence/leader-lease.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createZqRuntime, type ZqChat } from "../src/zq/runtime.ts";
import { FAKE_SECRET, FAKE_USER, startFakeJenkins } from "./support/fake-jenkins.ts";
import { tenantMap } from "./support/tenant-map.ts";

const credential = { JENKINS_QM_BOT_USER: FAKE_USER, JENKINS_QM_BOT_TOKEN: FAKE_SECRET };
const polling = { ZQ_JENKINS_URL: "https://jenkins.example.test", ZQ_JENKINS_POLL: "1", ...credential };

test("every Jenkins switch is off by default and the monitored jobs are the eight confirmed ones", () => {
  const { jenkins } = zqConfigFromEnv({});
  assert.deepEqual(
    [jenkins.poll.enabled, jenkins.rerun, jenkins.notify.live, jenkins.url, jenkins.credential],
    [false, false, false, undefined, undefined],
  );
  assert.equal(jenkins.jobs.length, 8);
  assert.deepEqual(jenkins.rerunJobs, jenkins.jobs);
  assert.deepEqual(
    [jenkins.hourlyCap, jenkins.maxAgeMs, jenkins.poll.intervalMs, jenkins.failureResults, jenkins.causes],
    [3, 30 * 60_000, 120_000, ["FAILURE"], ["timer", "scm", "upstream"]],
  );
});

test("every setting is read from its environment name", () => {
  const { jenkins } = zqConfigFromEnv({
    ...polling,
    JENKINS_QM_BOT_PASSWORD: "pw",
    ZQ_JENKINS_RERUN: "1",
    ZQ_JENKINS_NOTIFY: "1",
    ZQ_JENKINS_NOTIFY_CHANNEL: "chan1",
    ZQ_JENKINS_JOBS: "A,B",
    ZQ_JENKINS_RERUN_JOBS: "B",
    ZQ_JENKINS_RERUN_HOURLY_CAP: "5",
    ZQ_JENKINS_POLL_SECONDS: "60",
    ZQ_JENKINS_MAX_AGE_MINUTES: "10",
    ZQ_JENKINS_FAILURE_RESULTS: "FAILURE,UNSTABLE",
    ZQ_JENKINS_RERUN_CAUSES: "timer,user",
    ZQ_JENKINS_OWNERS: "A=alice, B=bob",
    ZQ_JENKINS_DEFAULT_OWNER: "carol",
  });
  assert.deepEqual(jenkins.credential, { user: FAKE_USER, secret: FAKE_SECRET });
  assert.deepEqual(
    [jenkins.rerun, jenkins.notify, jenkins.jobs, jenkins.rerunJobs, jenkins.hourlyCap, jenkins.poll.intervalMs],
    [true, { live: true, channelId: "chan1" }, ["A", "B"], ["B"], 5, 60_000],
  );
  assert.deepEqual(
    [jenkins.maxAgeMs, jenkins.failureResults, jenkins.causes, jenkins.owners, jenkins.defaultOwner],
    [600_000, ["FAILURE", "UNSTABLE"], ["timer", "user"], { A: "alice", B: "bob" }, "carol"],
  );
});

test("the switches refuse to start without what they need, and bad values are refused", () => {
  assert.throws(() => zqConfigFromEnv({ ZQ_JENKINS_POLL: "1", ...credential }), /ZQ_JENKINS_URL/);
  assert.throws(() => zqConfigFromEnv({ ZQ_JENKINS_POLL: "1", ZQ_JENKINS_URL: "https://j" }), /JENKINS_QM_BOT_USER/);
  assert.throws(() => zqConfigFromEnv({ ZQ_JENKINS_URL: "https://j", ZQ_JENKINS_RERUN: "1" }), /ZQ_JENKINS_POLL/);
  assert.throws(() => zqConfigFromEnv({ ...polling, ZQ_JENKINS_NOTIFY: "1" }), /ZQ_JENKINS_NOTIFY_CHANNEL/);
  assert.throws(() => zqConfigFromEnv({ ZQ_JENKINS_URL: "jenkins.example.com" }), /http\(s\)/);
  assert.throws(
    () => zqConfigFromEnv({ ZQ_JENKINS_URL: "https://j", ZQ_JENKINS_RERUN_JOBS: "Nope" }),
    /outside ZQ_JENKINS_JOBS/,
  );
  assert.throws(() => zqConfigFromEnv({ ZQ_JENKINS_FAILURE_RESULTS: "BROKEN" }), /ZQ_JENKINS_FAILURE_RESULTS/);
  assert.throws(() => zqConfigFromEnv({ ZQ_JENKINS_RERUN_CAUSES: "nobody" }), /ZQ_JENKINS_RERUN_CAUSES/);
  assert.throws(() => zqConfigFromEnv({ ZQ_JENKINS_OWNERS: "alice" }), /ZQ_JENKINS_OWNERS/);
  assert.throws(() => zqConfigFromEnv({ ZQ_JENKINS_POLL_SECONDS: "5" }), /ZQ_JENKINS_POLL_SECONDS/);
});

test("the token wins over the password when both are set", () => {
  const { jenkins } = zqConfigFromEnv({ ...polling, JENKINS_QM_BOT_PASSWORD: "pw" });
  assert.equal(jenkins.credential?.secret, FAKE_SECRET);
});

const noLease: LeaderLease = { hold: async (_key, fn) => fn(new Promise<void>(() => {})) };

const chat = (posts: Array<[string, string]>): ZqChat => ({
  sendDm: async () => {},
  sendButtons: async () => {},
  mmUserIdOf: async () => undefined,
  principalOf: async () => undefined,
  postToChannel: async (channelId, text) => void posts.push([channelId, text]),
});

function runtimeFor(env: NodeJS.ProcessEnv) {
  const sweepers: Array<{ label: string | undefined; started: number; work: () => unknown }> = [];
  const posts: Array<[string, string]> = [];
  const runtime = createZqRuntime({
    config: zqConfigFromEnv(env),
    call: async () => "{}",
    chat: chat(posts),
    map: () => tenantMap(),
    leaderLease: noLease,
    createSweeper: (work, _ms, opts) => {
      const entry = { label: opts?.label, started: 0, work };
      sweepers.push(entry);
      return {
        start() {
          entry.started++;
        },
        stop: async () => {},
      };
    },
  });
  return { runtime, sweepers, posts };
}

tenantTest("with default configuration nothing polls, nothing is requested and nothing is sent", async () => {
  const fake = await startFakeJenkins({ now: () => 0 });
  const { runtime, sweepers, posts } = runtimeFor({ ZQ_JENKINS_URL: fake.url, ...credential });
  runtime.start();
  await runtime.stop();
  assert.deepEqual(
    sweepers.filter((s) => /jenkins/.test(s.label ?? "")),
    [],
  );
  assert.equal(
    sweepers.reduce((sum, s) => sum + s.started, 0),
    0,
  );
  assert.deepEqual(fake.requests, []);
  assert.deepEqual(posts, []);
  await fake.close();
});

tenantTest(
  "with the poll switch on the poller runs in dry-run: it reads Jenkins and never posts or sends",
  async () => {
    const fake = await startFakeJenkins({ now: () => Date.now() });
    fake.addJob("Server-Build", ["A"]);
    fake.addBuild("Server-Build", { number: 3, result: "FAILURE", params: [{ name: "A", value: "1" }] });
    const { runtime, sweepers, posts } = runtimeFor({
      ZQ_JENKINS_URL: fake.url,
      ZQ_JENKINS_POLL: "1",
      ZQ_JENKINS_JOBS: "Server-Build",
      ...credential,
    });
    runtime.start();
    const poller = sweepers.find((s) => s.label === "zq jenkins poller");
    assert.equal(poller?.started, 1);
    await poller?.work();
    assert.ok(fake.requests.some((r) => r === "GET /job/Server-Build/api/json"));
    assert.deepEqual(fake.posts, []);
    assert.deepEqual(posts, []);
    await runtime.stop();
    await fake.close();
  },
);
