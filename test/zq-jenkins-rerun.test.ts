import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createJenkinsClient, JenkinsRefused } from "../src/zq/jenkins/client.ts";
import { createJenkinsRerunner, type JenkinsRerunRow } from "../src/zq/jenkins/rerun.ts";
import { testMap } from "./support/test-database.ts";

interface FakeBuild {
  building?: boolean;
  result?: string | null;
  params: Array<{ name: string; value?: string; cls?: string }>;
}

interface Fake {
  url: string;
  posts: Array<{ path: string; body: string; crumb: string | undefined; auth: string | undefined }>;
  builds: Map<string, FakeBuild>;
  defined: string[];
  queuedStarts: boolean;
  close(): Promise<void>;
}

const JOB = "Sandbox";

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString();
}

async function fakeJenkins(): Promise<Fake> {
  const fake: Omit<Fake, "url" | "close"> = { posts: [], builds: new Map(), defined: [], queuedStarts: true };
  let next = 100;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST") {
      fake.posts.push({
        path: url.pathname,
        body: await body(req),
        crumb: req.headers["jenkins-crumb"] as string | undefined,
        auth: req.headers.authorization,
      });
      const id = next++;
      fake.builds.set(`${JOB}/${id}`, { params: [], result: null, building: true });
      res.writeHead(201, { location: `http://x/queue/item/${id}/` });
      res.end();
      return;
    }
    if (url.pathname === "/crumbIssuer/api/json") return json({ crumbRequestField: "Jenkins-Crumb", crumb: "c1" });
    const queue = /^\/queue\/item\/(\d+)\/api\/json$/.exec(url.pathname);
    if (queue) return json(fake.queuedStarts ? { executable: { number: Number(queue[1]) } } : {});
    if (url.pathname === "/queue/api/json") return json({ items: [] });
    if (url.pathname === `/job/${JOB}/api/json`) {
      if (url.searchParams.get("tree")?.startsWith("builds"))
        return json({ builds: [...fake.builds].map(([k, b]) => rawBuild(Number(k.split("/")[1]), b)) });
      return json({ property: [{ parameterDefinitions: fake.defined.map((name) => ({ name })) }] });
    }
    const one = new RegExp(`^/job/${JOB}/(\\d+)/api/json$`).exec(url.pathname);
    const build = one ? fake.builds.get(`${JOB}/${one[1]}`) : undefined;
    if (one && build) return json(rawBuild(Number(one[1]), build));
    json({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fake, { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
}

function rawBuild(number: number, b: FakeBuild) {
  return {
    number,
    building: b.building ?? false,
    result: b.result ?? null,
    actions: [
      {},
      { parameters: b.params.map((p) => ({ _class: p.cls ?? "StringParameterValue", name: p.name, value: p.value })) },
    ],
  };
}

async function setup(opts: { enabled?: boolean; defined?: string[]; cap?: number } = {}) {
  const fake = await fakeJenkins();
  fake.defined = opts.defined ?? ["CONFIG", "BUILD"];
  const client = createJenkinsClient({ baseUrl: fake.url, user: "bot", password: "pw", jobs: [JOB] });
  const map = testMap<JenkinsRerunRow>();
  let clock = 1_000_000;
  const rerunner = createJenkinsRerunner({
    client,
    map,
    enabled: opts.enabled ?? true,
    jobs: [JOB],
    hourlyCap: opts.cap ?? 3,
    now: () => clock,
    wait: async () => {},
  });
  return { fake, client, map, rerunner, tick: (ms: number) => (clock += ms) };
}

const failed = (params: FakeBuild["params"]): FakeBuild => ({ result: "FAILURE", params });

test("a failed build is rerun once with every original parameter, empty strings included", async () => {
  const { fake, rerunner, map } = await setup();
  fake.builds.set(
    `${JOB}/7`,
    failed([
      { name: "CONFIG", value: "" },
      { name: "BUILD", value: "debug build" },
    ]),
  );
  const result = await rerunner.rerun(JOB, 7);
  assert.equal(result.status, "started");
  assert.equal(fake.posts.length, 1);
  assert.equal(fake.posts[0]?.path, `/job/${JOB}/buildWithParameters`);
  assert.equal(fake.posts[0]?.body, "CONFIG=&BUILD=debug+build");
  assert.equal(fake.posts[0]?.crumb, "c1");
  assert.equal(fake.posts[0]?.auth, `Basic ${Buffer.from("bot:pw").toString("base64")}`);
  const row = await map.get(`${JOB}:7`);
  assert.equal(row?.outcome, "started");
  assert.equal(row?.newBuildNumber, 100);
  assert.deepEqual(row?.parameterDifferences, ["CONFIG", "BUILD"]);
  await fake.close();
});

test("the same failed build is never rerun twice, and a rerun is never rerun", async () => {
  const { fake, rerunner } = await setup();
  fake.builds.set(
    `${JOB}/7`,
    failed([
      { name: "CONFIG", value: "" },
      { name: "BUILD", value: "" },
    ]),
  );
  assert.equal((await rerunner.rerun(JOB, 7)).status, "started");
  assert.deepEqual(await rerunner.rerun(JOB, 7), { status: "skipped", reason: "duplicate" });
  fake.builds.set(
    `${JOB}/100`,
    failed([
      { name: "CONFIG", value: "" },
      { name: "BUILD", value: "" },
    ]),
  );
  assert.deepEqual(await rerunner.rerun(JOB, 100), { status: "skipped", reason: "is_rerun" });
  assert.equal(fake.posts.length, 1);
  await fake.close();
});

test("a build waiting for input, still running, or not a failure sends nothing and consumes nothing", async () => {
  const { fake, rerunner, map } = await setup();
  const params = [
    { name: "CONFIG", value: "" },
    { name: "BUILD", value: "" },
  ];
  fake.builds.set(`${JOB}/1`, { building: true, result: null, params });
  fake.builds.set(`${JOB}/2`, { result: "ABORTED", params });
  fake.builds.set(`${JOB}/3`, { result: "SUCCESS", params });
  assert.deepEqual(await rerunner.rerun(JOB, 1), { status: "skipped", reason: "still_running" });
  assert.deepEqual(await rerunner.rerun(JOB, 2), { status: "skipped", reason: "not_failure" });
  assert.deepEqual(await rerunner.rerun(JOB, 3), { status: "skipped", reason: "not_failure" });
  assert.deepEqual(await rerunner.rerun(JOB, 99), { status: "skipped", reason: "not_found" });
  assert.equal(fake.posts.length, 0);
  assert.deepEqual(await map.all(), []);
  await fake.close();
});

test("masked or incomplete parameters are refused, recorded and not retried", async () => {
  const { fake, rerunner, map } = await setup();
  fake.builds.set(
    `${JOB}/4`,
    failed([
      { name: "CONFIG", value: "" },
      { name: "BUILD", cls: "PasswordParameterValue" },
    ]),
  );
  fake.builds.set(`${JOB}/5`, failed([{ name: "CONFIG", value: "" }]));
  const masked = await rerunner.rerun(JOB, 4);
  const missing = await rerunner.rerun(JOB, 5);
  assert.deepEqual([masked.status, missing.status], ["refused", "refused"]);
  assert.equal((await map.get(`${JOB}:4`))?.reason, "parameters masked or unreadable");
  assert.equal((await map.get(`${JOB}:5`))?.reason, "parameters incomplete");
  assert.deepEqual(await rerunner.rerun(JOB, 4), { status: "skipped", reason: "duplicate" });
  assert.equal(fake.posts.length, 0);
  await fake.close();
});

test("a job without parameters starts with /build", async () => {
  const { fake, rerunner } = await setup({ defined: [] });
  fake.builds.set(`${JOB}/8`, failed([]));
  assert.equal((await rerunner.rerun(JOB, 8)).status, "started");
  assert.equal(fake.posts[0]?.path, `/job/${JOB}/build`);
  await fake.close();
});

test("the kill switch, the job list and the hourly cap stop a rerun before any request", async () => {
  const off = await setup({ enabled: false });
  off.fake.builds.set(
    `${JOB}/1`,
    failed([
      { name: "CONFIG", value: "" },
      { name: "BUILD", value: "" },
    ]),
  );
  assert.deepEqual(await off.rerunner.rerun(JOB, 1), { status: "skipped", reason: "disabled" });
  assert.equal(off.fake.posts.length, 0);
  await off.fake.close();

  const capped = await setup({ cap: 1 });
  const params = [
    { name: "CONFIG", value: "" },
    { name: "BUILD", value: "" },
  ];
  capped.fake.builds.set(`${JOB}/1`, failed(params));
  capped.fake.builds.set(`${JOB}/2`, failed(params));
  assert.equal((await capped.rerunner.rerun(JOB, 1)).status, "started");
  assert.deepEqual(await capped.rerunner.rerun(JOB, 2), { status: "skipped", reason: "capped" });
  capped.tick(3_600_001);
  assert.equal((await capped.rerunner.rerun(JOB, 2)).status, "started");
  assert.deepEqual(await capped.rerunner.rerun("Other", 1), { status: "skipped", reason: "job_not_enabled" });
  await capped.fake.close();
});

test("the client refuses any job outside its whitelist before a request is made", async () => {
  const { fake, client } = await setup();
  await assert.rejects(client.rerun("Server-Run", []), JenkinsRefused);
  await assert.rejects(client.build("Trigger-Server", 1), JenkinsRefused);
  assert.equal(fake.posts.length, 0);
  await fake.close();
});

test("a claim left behind by a crash is matched to a build that exists, or reported, never called again", async () => {
  const { fake, rerunner, map, tick } = await setup();
  const params = [
    { name: "CONFIG", value: "a" },
    { name: "BUILD", value: "b" },
  ];
  fake.builds.set(`${JOB}/7`, failed(params));
  fake.builds.set(`${JOB}/9`, { result: "SUCCESS", params });
  await map.put(`${JOB}:7`, { job: JOB, number: 7, claimedAt: 1_000_000, outcome: "claimed" });
  assert.equal((await rerunner.reconcile(JOB, 7))?.outcome, "claimed");
  tick(6 * 60_000);
  const row = await rerunner.reconcile(JOB, 7);
  assert.equal(row?.outcome, "started");
  assert.equal(row?.newBuildNumber, 9);
  assert.equal(fake.posts.length, 0);

  fake.builds.set(`${JOB}/20`, failed(params));
  await map.put(`${JOB}:20`, { job: JOB, number: 20, claimedAt: 1_000_000, outcome: "claimed" });
  assert.equal((await rerunner.reconcile(JOB, 20))?.outcome, "unresolved");
  assert.equal(fake.posts.length, 0);
  await fake.close();
});

test("Jenkins config is off by default; rerun needs a URL and only jobs the client may reach", () => {
  const c = zqConfigFromEnv({});
  assert.deepEqual(
    [c.jenkins.rerun, c.jenkins.url, c.jenkins.rerunJobs, c.jenkins.jobs.length],
    [false, undefined, [], 8],
  );
  assert.throws(() => zqConfigFromEnv({ ZQ_JENKINS_RERUN: "1" }), /ZQ_JENKINS_URL/);
  assert.throws(() => zqConfigFromEnv({ ZQ_JENKINS_URL: "jenkins.example.com" }), /http\(s\)/);
  assert.throws(
    () => zqConfigFromEnv({ ZQ_JENKINS_URL: "https://j", ZQ_JENKINS_RERUN_JOBS: "Nope" }),
    /outside ZQ_JENKINS_JOBS/,
  );
  const ok = zqConfigFromEnv({
    ZQ_JENKINS_URL: "https://j/",
    ZQ_JENKINS_JOBS: "qm-rerun-sandbox",
    ZQ_JENKINS_RERUN_JOBS: "qm-rerun-sandbox",
    ZQ_JENKINS_RERUN: "1",
  });
  assert.deepEqual(
    [ok.jenkins.url, ok.jenkins.jobs, ok.jenkins.rerunJobs],
    ["https://j", ["qm-rerun-sandbox"], ["qm-rerun-sandbox"]],
  );
});
