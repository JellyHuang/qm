import assert from "node:assert/strict";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createJenkinsClient, JENKINS_JOBS } from "../src/zq/jenkins/client.ts";
import { createRecordingSink } from "../src/zq/jenkins/notices.ts";
import { createJenkinsPoller } from "../src/zq/jenkins/poller.ts";
import {
  createJenkinsStore,
  type JenkinsAuditRow,
  type JenkinsBuildRecord,
  type JenkinsNotice,
} from "../src/zq/jenkins/store.ts";
import { CAUSES, FAKE_SECRET, FAKE_USER, startFakeJenkins, type FakeJenkins } from "./support/fake-jenkins.ts";
import { tenantMap } from "./support/tenant-map.ts";
import { tenantTest as scenario } from "./support/tenant-test.ts";

const NOW = 10_000_000_000;
const PLAIN = ["BRANCH", "MODE"];
const plain = (branch = "main") => [
  { name: "BRANCH", value: branch },
  { name: "MODE", value: "" },
];
const RUN_PARAMS = [
  { name: "DROP_DATABASE", value: "false" },
  { name: "CONFIG", value: "" },
  { name: "BUILD", value: "" },
];
const PACKAGE_PARAMS = [
  { name: "TARGET_SERVER", value: "host-a" },
  { name: "SOURCE", value: "dir-a" },
  { name: "VERSION", value: "1" },
];

async function realShape(): Promise<FakeJenkins> {
  const fake = await startFakeJenkins({ now: () => NOW });
  for (const job of JENKINS_JOBS) fake.addJob(job, PLAIN);
  fake.addJob(
    "Server-Run",
    RUN_PARAMS.map((p) => p.name),
  );
  fake.addJob(
    "PackageSent",
    PACKAGE_PARAMS.map((p) => p.name),
  );
  const upstream = [CAUSES.upstreamOf(CAUSES.timer)];
  const add = (
    job: string,
    number: number,
    result: string | null,
    extra: Parameters<FakeJenkins["addBuild"]>[1] = {},
  ) => fake.addBuild(job, { number, result, params: plain(), causes: upstream, ...extra });

  for (let n = 13136; n <= 13139; n++) add("Server-Build", n, "SUCCESS");
  add("Server-Build", 13140, "FAILURE", { log: "console text that must never be stored" });
  add("Server-Build", 13141, "FAILURE");
  for (let n = 18845; n <= 18848; n++) add("Server-Config", n, "SUCCESS");
  add("Server-Config", 18849, "FAILURE");
  for (let n = 301; n <= 304; n++) add("CheckServerConfig", n, "SUCCESS");
  for (let n = 401; n <= 404; n++) add("Server-Clang-Tidy", n, "SUCCESS");
  for (let n = 501; n <= 503; n++) add("Server-CodeReview", n, "UNSTABLE");
  for (let n = 504; n <= 506; n++) add("Server-CodeReview", n, "SUCCESS");
  for (let n = 762; n <= 765; n++) add("LLM-Wiki", n, "SUCCESS", { causes: [CAUSES.timer] });
  add("LLM-Wiki", 766, "SUCCESS", { causes: [CAUSES.user(FAKE_USER)] });
  for (let n = 6; n <= 10; n++)
    add("PackageSent", n, "SUCCESS", { params: PACKAGE_PARAMS, causes: [CAUSES.user("alice")] });
  const human = { params: RUN_PARAMS, causes: [CAUSES.user("alice")] };
  add("Server-Run", 6230, "SUCCESS", human);
  add("Server-Run", 6231, "SUCCESS", human);
  add("Server-Run", 6233, "FAILURE", human);
  add("Server-Run", 6234, null, { ...human, building: true });
  add("Server-Run", 6235, null, { ...human, building: true });
  return fake;
}

async function run(env: NodeJS.ProcessEnv, live: boolean) {
  const fake = await realShape();
  const { jenkins } = zqConfigFromEnv({
    ZQ_JENKINS_URL: fake.url,
    ZQ_JENKINS_POLL: "1",
    JENKINS_QM_BOT_USER: FAKE_USER,
    JENKINS_QM_BOT_TOKEN: FAKE_SECRET,
    ZQ_JENKINS_OWNERS: "Server-Build=alice",
    ...env,
  });
  const store = createJenkinsStore({
    builds: tenantMap<JenkinsBuildRecord>(),
    audits: tenantMap<JenkinsAuditRow>(),
    noticeMap: tenantMap<JenkinsNotice>(),
    now: () => NOW,
  });
  const sink = createRecordingSink();
  const poller = createJenkinsPoller({
    client: createJenkinsClient({
      baseUrl: fake.url,
      user: FAKE_USER,
      password: FAKE_SECRET,
      jobs: jenkins.jobs,
    }),
    store,
    policy: {
      failureResults: jenkins.failureResults,
      rerunJobs: jenkins.rerunJobs,
      causes: jenkins.causes,
      maxAgeMs: jenkins.maxAgeMs,
      hourlyCap: jenkins.hourlyCap,
      botUsers: [FAKE_USER, ...jenkins.botIds],
      dangerParams: jenkins.dangerParams,
      dangerAckJobs: jenkins.dangerAckJobs,
    },
    jobs: jenkins.jobs,
    live,
    noticeMode: "dry-run",
    channelId: "backend-group",
    sink,
    owner: (job) => jenkins.owners[job],
    onError: (e) => assert.fail(`unexpected poll error ${e.kind}: ${e.message}`),
    createSweeper: () => ({ start() {}, stop: async () => {} }),
    intervalMs: 120_000,
    now: () => NOW,
    wait: async () => {},
  });
  const rows = async () =>
    (await store.records()).map((r) => `${r.job}#${r.number} ${r.state}${r.reason ? ` ${r.reason}` : ""}`).sort();
  return { fake, poller, store, sink, rows, jenkins };
}

scenario("the fixture has the real cause distribution over the eight real job names", async () => {
  const fake = await realShape();
  const client = createJenkinsClient({ baseUrl: fake.url, user: FAKE_USER, password: FAKE_SECRET, jobs: JENKINS_JOBS });
  const counts: Record<string, number> = {};
  for (const job of JENKINS_JOBS)
    for (const build of (await client.recentBuilds(job)) ?? []) {
      const [cause] = build.causes;
      const kind = cause?.kind === "user" && cause.userId === FAKE_USER ? "bot" : (cause?.kind ?? "none");
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
  assert.deepEqual(counts, { upstream: 25, user: 10, timer: 4, bot: 1 });
  assert.deepEqual(
    [...JENKINS_JOBS],
    [
      "CheckServerConfig",
      "LLM-Wiki",
      "PackageSent",
      "Server-Build",
      "Server-Clang-Tidy",
      "Server-CodeReview",
      "Server-Config",
      "Server-Run",
    ],
  );
  await fake.close();
});

scenario(
  "dry-run on the real shape: upstream failures become eligible, nothing is posted, excluded jobs are only read",
  async () => {
    const h = await run({}, false);
    await h.poller.tick();
    assert.deepEqual(await h.rows(), [
      "Server-Build#13140 eligible",
      "Server-Build#13141 eligible",
      "Server-Config#18849 eligible",
      "Server-Run#6233 skipped job_not_enabled",
    ]);
    assert.deepEqual(h.fake.posts, []);
    assert.deepEqual(h.sink.sent, []);
    assert.ok(h.fake.requests.every((r) => r.startsWith("GET ")));
    assert.ok(!h.fake.requests.some((r) => /PackageSent/.test(r) && !r.endsWith("/api/json")));
    const audits = (await h.store.auditRows()).filter((r) => r.event === "dry_run_would_rerun").map((r) => r.id);
    assert.deepEqual(audits.sort(), [
      "Server-Build:13140:dry_run_would_rerun",
      "Server-Build:13141:dry_run_would_rerun",
      "Server-Config:18849:dry_run_would_rerun",
    ]);
    await h.fake.close();
  },
);

scenario(
  "rerun mode on the real shape: exactly the three upstream failures are rerun once with their parameters",
  async () => {
    const h = await run({ ZQ_JENKINS_RERUN: "1" }, true);
    await h.poller.tick();
    const posted = h.fake.posts.map((p) => p.path).sort();
    assert.deepEqual(posted, [
      "/job/Server-Build/buildWithParameters",
      "/job/Server-Build/buildWithParameters",
      "/job/Server-Config/buildWithParameters",
    ]);
    for (const post of h.fake.posts)
      assert.deepEqual(
        [...new URLSearchParams(post.body)],
        plain().map((p) => [p.name, p.value]),
      );
    assert.ok(h.fake.posts.every((p) => p.crumb === "crumb-1"));
    assert.deepEqual(await h.rows(), [
      "Server-Build#13140 rerun_running",
      "Server-Build#13141 rerun_running",
      "Server-Config#18849 rerun_running",
      "Server-Run#6233 skipped job_not_enabled",
    ]);
    assert.ok(h.fake.requests.filter((r) => /Server-Run|PackageSent/.test(r)).every((r) => r.startsWith("GET ")));

    h.fake.finish("Server-Build", 13142, "FAILURE");
    h.fake.finish("Server-Build", 13143, "SUCCESS");
    h.fake.finish("Server-Config", 18850, "SUCCESS");
    for (let i = 0; i < 4; i++) await h.poller.tick();
    assert.equal(h.fake.posts.length, 3);
    assert.deepEqual(await h.rows(), [
      "Server-Build#13140 notified",
      "Server-Build#13141 rerun_succeeded",
      "Server-Build#13142 skipped is_rerun",
      "Server-Config#18849 rerun_succeeded",
      "Server-Run#6233 skipped job_not_enabled",
    ]);
    assert.equal(h.sink.sent.length, 1);
    assert.match(h.sink.sent[0]?.text ?? "", /Server-Build #13140.*重跑 #13142.*@alice/);
    assert.doesNotMatch(
      JSON.stringify([await h.store.records(), await h.store.auditRows(), h.sink.sent]),
      /must never be stored/,
    );
    await h.fake.close();
  },
);

scenario(
  "Server-Run on the list needs the explicit acknowledgement, and then a newer running build supersedes the failure",
  async () => {
    const wide = {
      ZQ_JENKINS_RERUN: "1",
      ZQ_JENKINS_RERUN_JOBS: "Server-Build,Server-Config,Server-Run",
      ZQ_JENKINS_RERUN_CAUSES: "upstream,user",
    };
    const blocked = await run(wide, true);
    await blocked.poller.tick();
    assert.ok((await blocked.rows()).includes("Server-Run#6233 skipped dangerous_parameters"));
    assert.ok(!blocked.fake.posts.some((p) => /Server-Run/.test(p.path)));
    assert.equal(
      blocked.sink.sent.filter((m) => /Server-Run #6233/.test(m.text) && /dangerous_parameters/.test(m.text)).length,
      1,
    );
    await blocked.fake.close();

    const acknowledged = await run({ ...wide, ZQ_JENKINS_DANGER_ACK_JOBS: "Server-Run" }, true);
    await acknowledged.poller.tick();
    await acknowledged.poller.tick();
    assert.ok((await acknowledged.rows()).includes("Server-Run#6233 skipped superseded"));
    assert.ok(!acknowledged.fake.posts.some((p) => /Server-Run/.test(p.path)));
    await acknowledged.fake.close();
  },
);

scenario("a Server-Run failure with no newer build is still refused for its dangerous parameters", async () => {
  const h = await run(
    { ZQ_JENKINS_RERUN: "1", ZQ_JENKINS_RERUN_JOBS: "Server-Run", ZQ_JENKINS_RERUN_CAUSES: "user" },
    true,
  );
  h.fake.finish("Server-Run", 6234, "SUCCESS");
  h.fake.finish("Server-Run", 6235, "SUCCESS");
  await h.poller.tick();
  assert.deepEqual(h.fake.posts, []);
  assert.deepEqual(
    (await h.rows()).filter((r) => r.startsWith("Server-Run")),
    ["Server-Run#6233 skipped dangerous_parameters"],
  );
  await h.fake.close();
});
