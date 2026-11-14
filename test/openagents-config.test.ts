import { test } from "node:test";
import assert from "node:assert/strict";
import { openAgentsConfigFromEnv } from "../src/integrations/openagents/config.ts";

const required = { OA_URL: "http://oa:8000", OA_WORKSPACE: "ws", OA_TOKEN: "tok" };

function parse(extra: NodeJS.ProcessEnv = {}) {
  const config = openAgentsConfigFromEnv({ ...required, ...extra });
  assert.ok(config);
  return config;
}

test("empty env disables the connector", () => {
  assert.equal(openAgentsConfigFromEnv({}), undefined);
});

test("defaults apply when only the required settings are present", () => {
  const config = parse();
  assert.equal(config.agentName, "qm-master");
  assert.equal(config.pollMs, 3_000);
  assert.deepEqual(config.workers, []);
  assert.deepEqual(config.allowedPrincipals, []);
  assert.equal(config.publicUrl, undefined);
});

test("agent name must be a lowercase slug", () => {
  for (const name of ["QM-Master", "-qm", "q", "qm master", "qm_master"]) {
    assert.throws(() => openAgentsConfigFromEnv({ ...required, OA_AGENT_NAME: name }), /lowercase slug/, name);
  }
  assert.equal(parse({ OA_AGENT_NAME: "qm-prod-1" }).agentName, "qm-prod-1");
});

test("poll interval must be an integer from 500 through 60000", () => {
  for (const ms of ["499", "60001", "1.5", "abc", "-1"]) {
    assert.throws(() => openAgentsConfigFromEnv({ ...required, OA_POLL_MS: ms }), /OA_POLL_MS/, ms);
  }
  assert.equal(parse({ OA_POLL_MS: "500" }).pollMs, 500);
  assert.equal(parse({ OA_POLL_MS: "60000" }).pollMs, 60_000);
});

test("trailing slashes are stripped from the URL and public URL", () => {
  const config = parse({ OA_URL: "http://oa:8000//", OA_PUBLIC_URL: " https://oa.example.com/ " });
  assert.equal(config.url, "http://oa:8000");
  assert.equal(config.publicUrl, "https://oa.example.com");
});

test("workers drop invalid names and the agent's own name", () => {
  const config = parse({ OA_WORKERS: " qm-dev-worker, Bad Name,,qm-master , w_2,-x " });
  assert.deepEqual(config.workers, ["qm-dev-worker", "w_2"]);
  assert.deepEqual(parse({ OA_AGENT_NAME: "boss", OA_WORKERS: "boss,qm-master" }).workers, ["qm-master"]);
});

test("allowed principals are trimmed and lowercased", () => {
  const config = parse({ OA_ALLOWED_PRINCIPALS: " Jelly.Huang@IGG.com ,,Bob@X.io" });
  assert.deepEqual(config.allowedPrincipals, ["jelly.huang@igg.com", "bob@x.io"]);
});

test("inbound limit defaults to 200 and falls back on invalid values", () => {
  assert.equal(parse().inboundPerHour, 200);
  assert.equal(parse({ OA_INBOUND_PER_HOUR: " 500 " }).inboundPerHour, 500);
  for (const v of ["0", "-3", "1.5", "abc", "", "1e400"])
    assert.equal(parse({ OA_INBOUND_PER_HOUR: v }).inboundPerHour, 200, v);
});
