import test from "node:test";
import assert from "node:assert/strict";
import { createMattermostClient } from "../src/surfaces/mattermost/client.ts";
import { createFeatureChannel, featureChannelName } from "../src/surfaces/mattermost/feature-channel.ts";

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

function server(opts: { exists?: boolean } = {}) {
  const seen: Seen[] = [];
  const channel = { id: "ch1", team_id: "t1", name: "zq-feature-7", display_name: "x", type: "P" };
  const fetchStub: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ method: init?.method ?? "GET", path: url.pathname.replace("/api/v4", ""), body });
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.pathname.endsWith("/channels") && init?.method === "POST")
      return opts.exists
        ? json(400, {
            id: "store.sql_channel.save_channel.exists.app_error",
            message: "A channel with that name already exists",
          })
        : json(201, channel);
    if (url.pathname.includes("/channels/name/")) return json(200, channel);
    return json(201, { channel_id: "ch1" });
  };
  return { seen, client: createMattermostClient({ url: "http://mm.example", token: "t", fetch: fetchStub }) };
}

test("a feature gets a private channel named from its id, with the OpenProject link in the header and every member added", async () => {
  const s = server();
  const id = await createFeatureChannel(
    s.client,
    "t1",
    { id: 7, subject: "新增英雄", url: "https://op.example.com/work_packages/7" },
    ["u1", "u2", "u1"],
  );
  assert.equal(id, "ch1");
  assert.equal(featureChannelName(7), "zq-feature-7");
  const create = s.seen[0]!;
  assert.deepEqual([create.method, create.path], ["POST", "/channels"]);
  assert.deepEqual(create.body, {
    team_id: "t1",
    name: "zq-feature-7",
    display_name: "功能 #7 新增英雄",
    type: "P",
    purpose: "功能「新增英雄」(#7)的讨论频道",
    header: "OpenProject 工作项:https://op.example.com/work_packages/7",
  });
  assert.deepEqual(
    s.seen.slice(1).map((r) => [r.method, r.path, r.body]),
    [
      ["POST", "/channels/ch1/members", { user_id: "u1" }],
      ["POST", "/channels/ch1/members", { user_id: "u2" }],
    ],
  );
});

test("a retry after a half-finished creation reuses the channel that already has the name", async () => {
  const s = server({ exists: true });
  assert.equal(await createFeatureChannel(s.client, "t1", { id: 7, subject: "新增英雄" }, ["u1"]), "ch1");
  assert.deepEqual(
    s.seen.map((r) => [r.method, r.path]),
    [
      ["POST", "/channels"],
      ["GET", "/teams/t1/channels/name/zq-feature-7"],
      ["POST", "/channels/ch1/members"],
    ],
  );
  assert.equal(s.seen[0]!.body && "header" in (s.seen[0]!.body as object), false, "no link without a base URL");
});

test("a long subject is clipped to the Mattermost display-name limit", async () => {
  const s = server();
  await createFeatureChannel(s.client, "t1", { id: 7, subject: "长".repeat(100) }, []);
  const name = (s.seen[0]!.body as { display_name: string }).display_name;
  assert.equal([...name].length, 64);
  assert.ok(name.endsWith("…"));
});
