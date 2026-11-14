import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createZqIdentityMap, type ZqIdentityLink } from "../src/zq/identity-map.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testMap } from "./support/test-database.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const PROPOSAL = {
  mmUserId: "mm1",
  opUserId: "42",
  opLogin: "alice",
  source: "signin" as const,
  proposedBy: "internal:alice",
};

async function start(t: { after(fn: () => Promise<void>): void }, enabled: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "zq-identity-"));
  const built = buildApp(testConfig({ dataDir: dir }));
  const zqIdentity = createZqIdentityMap({ map: testMap<ZqIdentityLink>(), enabled });
  const server = createInsecureTestServer(built.app, { admin: built.admin, auditLog: built.auditLog, zqIdentity });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/zq/identity-links`;
  return { base, zqIdentity };
}

test("an administrator lists, confirms and unlinks identity links; others cannot", async (t) => {
  const { base, zqIdentity } = await start(t, true);
  await zqIdentity.propose(PROPOSAL);
  const stranger = { ...ADMIN, "x-admin-actor": "nobody@default-org" };
  assert.equal((await fetch(base, { headers: stranger })).status, 403);
  assert.equal((await fetch(`${base}/mm1`, { method: "PUT", headers: stranger })).status, 403);
  assert.equal((await zqIdentity.list())[0]?.status, "pending");

  const listed = (await (await fetch(base, { headers: ADMIN })).json()) as { links: ZqIdentityLink[] };
  assert.deepEqual(
    listed.links.map((l) => [l.mmUserId, l.status]),
    [["mm1", "pending"]],
  );

  assert.equal((await fetch(`${base}/nobody`, { method: "PUT", headers: ADMIN })).status, 404);
  const confirmed = await fetch(`${base}/mm1`, { method: "PUT", headers: ADMIN });
  assert.equal(confirmed.status, 200);
  assert.equal((await zqIdentity.byMattermost("mm1"))?.confirmedBy, "admin-alice");

  assert.equal((await fetch(`${base}/mm1`, { method: "DELETE", headers: ADMIN })).status, 200);
  assert.deepEqual(await zqIdentity.list(), []);
});

test("the routes do not exist while identity mapping is off", async (t) => {
  const { base } = await start(t, false);
  assert.equal((await fetch(base, { headers: ADMIN })).status, 404);
  assert.equal((await fetch(`${base}/mm1`, { method: "DELETE", headers: ADMIN })).status, 404);
});
