import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "./support/build-app.ts";
import { createServer } from "../src/api/server.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { loadConfig } from "../src/config.ts";

const SECRET = "build-info-route-secret".repeat(2);

test("GET /v1/build-info serves only commit, build time and health to a control-plane token", async (t) => {
  const built = buildApp(testConfig({ signingSecret: SECRET }));
  let ready = true;
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    sessions: built.sessions,
    memory: built.memory,
    config: built.config,
    buildInfo: { commit: "3c1c73b9f", builtAt: "2026-11-13T10:18:00.000Z" },
    checkReadiness: async () => {
      if (!ready) throw new Error("db down");
    },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://localhost:${(server.address() as AddressInfo).port}/v1/build-info`;
  const token = await mintCapabilityToken(
    {
      actorId: "U1",
      scopeId: scopeId("personal", "U1"),
      aud: CONTROL_PLANE_AUD,
      exp: Date.now() + CAPABILITY_TTL_MS,
      liveActor: true,
    },
    SECRET,
  );
  assert.equal((await fetch(url)).status, 401, "no credential");
  const res = await fetch(url, { headers: { "x-agent-capability": token } });
  if (res.status !== 200) assert.fail(`status ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["builtAt", "commit", "health", "startedAt", "uptimeSeconds"]);
  assert.equal(body.commit, "3c1c73b9f");
  assert.equal(body.builtAt, "2026-11-13T10:18:00.000Z");
  assert.equal(body.health, "ok");
  ready = false;
  assert.equal(
    ((await (await fetch(url, { headers: { "x-agent-capability": token } })).json()) as { health: string }).health,
    "degraded",
  );
});

test("build metadata env is validated and never echoes junk", () => {
  const base = { ...process.env };
  const c1 = loadConfig({ ...base, QM_BUILD_COMMIT: "3c1c73b9f", QM_BUILD_TIME: "2026-11-13T10:18:00Z" });
  assert.equal(c1.buildCommit, "3c1c73b9f");
  assert.equal(c1.buildTime, "2026-11-13T10:18:00.000Z");
  const c2 = loadConfig({ ...base, QM_BUILD_COMMIT: "not a sha; rm -rf", QM_BUILD_TIME: "yesterday" });
  assert.equal(c2.buildCommit, undefined);
  assert.equal(c2.buildTime, undefined);
});
