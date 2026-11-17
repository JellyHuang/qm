import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { JenkinsHttpError, JenkinsRefused, createJenkinsClient } from "../src/zq/jenkins/client.ts";
import { CAUSES, FAKE_SECRET, FAKE_USER, startFakeJenkins } from "./support/fake-jenkins.ts";

const NOW = 10_000_000_000;
const JOB = "Server-Build";

async function setup(secret = FAKE_SECRET) {
  const fake = await startFakeJenkins({ now: () => NOW });
  fake.addJob(JOB, ["A"]);
  const client = createJenkinsClient({ baseUrl: fake.url, user: FAKE_USER, password: secret, jobs: [JOB] });
  return { fake, client };
}

test("builds are read with result, time, cause class and parameters", async () => {
  const { fake, client } = await setup();
  fake.addBuild(JOB, {
    number: 4,
    result: "FAILURE",
    causes: [CAUSES.user("alice"), CAUSES.upstream],
    params: [{ name: "A", value: "x" }],
  });
  const build = await client.build(JOB, 4);
  assert.equal(build?.result, "FAILURE");
  assert.equal(build?.timestamp, NOW - 120_000);
  assert.deepEqual(build?.causes, [{ kind: "user", userId: "alice" }, { kind: "upstream" }]);
  assert.deepEqual(build?.params, [{ name: "A", value: "x" }]);
  assert.equal((await client.recentBuilds(JOB))?.length, 1);
  await fake.close();
});

test("a missing job or build reads as null, not as an error", async () => {
  const { fake, client } = await setup();
  const other = createJenkinsClient({ baseUrl: fake.url, user: FAKE_USER, password: FAKE_SECRET, jobs: ["Ghost"] });
  assert.equal(await other.recentBuilds("Ghost"), null);
  assert.equal(await client.build(JOB, 99), null);
  await fake.close();
});

test("a rejected credential is an error carrying the status and never the secret", async () => {
  const { fake, client } = await setup("wrong-secret-value");
  const error = await client.recentBuilds(JOB).catch((e: unknown) => e);
  assert.ok(error instanceof JenkinsHttpError);
  assert.equal(error.status, 401);
  assert.doesNotMatch(String(error.message), /wrong-secret-value/);
  await fake.close();
});

test("every request authenticates with Basic and the secret never appears in a URL", async () => {
  const { fake, client } = await setup();
  fake.addBuild(JOB, { number: 1, result: "FAILURE", params: [{ name: "A", value: "x" }] });
  await client.recentBuilds(JOB);
  await client.rerun(JOB, [{ name: "A", value: "x" }]);
  const expected = `Basic ${Buffer.from(`${FAKE_USER}:${FAKE_SECRET}`).toString("base64")}`;
  assert.ok(fake.authorizations.every((a) => a === expected));
  assert.ok(fake.requests.every((r) => !r.includes(FAKE_SECRET)));
  await fake.close();
});

test("a rerun posts every parameter verbatim with a fresh crumb and the session cookie", async () => {
  const { fake, client } = await setup();
  const params = [
    { name: "A", value: "" },
    { name: "NOTE", value: "a&b=c d%é+x\nline" },
    { name: "TAGS", value: "x,y,z" },
    { name: "TAGS", value: "w" },
  ];
  const { queueId } = await client.rerun(JOB, params);
  assert.equal(fake.posts[0]?.path, `/job/${JOB}/buildWithParameters`);
  assert.equal(fake.posts[0]?.crumb, "crumb-1");
  assert.equal(fake.posts[0]?.cookie, "JSESSIONID=abc");
  assert.deepEqual(
    [...new URLSearchParams(fake.posts[0]?.body)],
    params.map((p) => [p.name, p.value]),
  );
  assert.equal(await client.startedNumber(queueId), 1);
  await client.rerun(JOB, []);
  assert.equal(fake.posts[1]?.path, `/job/${JOB}/build`);
  assert.equal(fake.requests.filter((r) => r === "GET /crumbIssuer/api/json").length, 2);
  await fake.close();
});

test("a missing crumb or a rejected post is an http error", async () => {
  const { fake, client } = await setup();
  fake.options.rejectPosts = 403;
  const error = await client.rerun(JOB, []).catch((e: unknown) => e);
  assert.ok(error instanceof JenkinsHttpError);
  assert.equal(error.status, 403);
  await fake.close();
});

test("password and file parameters are reported by name only and their values are never kept", async () => {
  const { fake, client } = await setup();
  fake.addBuild(JOB, {
    number: 1,
    result: "FAILURE",
    params: [
      { name: "A", value: "plain" },
      { name: "PASS", value: "hunter2", cls: "hudson.model.PasswordParameterValue" },
      { name: "UPLOAD", value: "blob", cls: "hudson.model.FileParameterValue" },
      { name: "HIDDEN" },
      { name: "FLAG", value: true },
    ],
  });
  const build = await client.build(JOB, 1);
  assert.deepEqual(build?.maskedParams, ["PASS", "UPLOAD", "HIDDEN"]);
  assert.deepEqual(build?.params, [
    { name: "A", value: "plain" },
    { name: "FLAG", value: "true" },
  ]);
  assert.doesNotMatch(JSON.stringify(build), /hunter2|blob/);
  await fake.close();
});

test("the console is reduced to the hash of its tail and the text is dropped", async () => {
  const { fake, client } = await setup();
  const log = `${"first line\n".repeat(20_000)}the final lines\n`;
  fake.addBuild(JOB, { number: 1, result: "FAILURE", log });
  const expected = createHash("sha256").update(Buffer.from(log).subarray(-4096)).digest("hex");
  assert.equal(await client.consoleTailHash(JOB, 1), expected);
  assert.equal(await client.consoleTailHash(JOB, 2), null);
  await fake.close();
});

test("the queue and the started number tell a waiting rerun from a started one", async () => {
  const { fake, client } = await setup();
  fake.options.holdQueue = true;
  const { queueId } = await client.rerun(JOB, [{ name: "A", value: "1" }]);
  assert.equal(await client.startedNumber(queueId), null);
  assert.deepEqual(await client.queued(JOB), [{ params: [{ name: "A", value: "1" }] }]);
  fake.releaseQueue();
  assert.equal(await client.startedNumber(queueId), 1);
  await fake.close();
});

test("a job outside the whitelist is refused before any request is made", async () => {
  const { fake, client } = await setup();
  await assert.rejects(client.rerun("Server-Run", []), JenkinsRefused);
  await assert.rejects(client.build("Trigger-Server", 1), JenkinsRefused);
  assert.deepEqual(fake.requests, []);
  await fake.close();
});

test("a transport error that mentions the credential is redacted", async () => {
  const basic = Buffer.from(`${FAKE_USER}:${FAKE_SECRET}`).toString("base64");
  const client = createJenkinsClient({
    baseUrl: "http://j",
    user: FAKE_USER,
    password: FAKE_SECRET,
    jobs: [JOB],
    fetch: async () => {
      throw new Error(`connect failed for ${FAKE_SECRET} with Basic ${basic}`);
    },
  });
  const error = await client.build(JOB, 1).catch((e: unknown) => e);
  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.message, new RegExp(`${FAKE_SECRET}|${basic}`));
  assert.match(error.message, /redacted/);
});
