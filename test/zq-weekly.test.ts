import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseContract } from "../src/zq/contract.ts";
import type { FeatureFacts, WorkView } from "../src/zq/rules.ts";
import { composeWeeklyBriefs } from "../src/zq/weekly.ts";

const contract = parseContract(
  JSON.parse(readFileSync(new URL("./fixtures/zq-contract-keys.json", import.meta.url), "utf8")),
);
const order = (id: number, typeKey: string, over: Partial<WorkView> = {}): WorkView => ({
  id,
  subject: `单${id}`,
  typeKey,
  statusKey: "execution.active",
  ...over,
});
const facts = (children: WorkView[]): FeatureFacts[] => [
  { feature: { id: 1, subject: "功能", typeKey: "feature", statusKey: "feature.development" }, children },
];
const WEDNESDAY = Date.UTC(2026, 10, 18, 1, 0);
const brief = (children: WorkView[]) =>
  composeWeeklyBriefs({ facts: facts(children), contract, now: WEDNESDAY, timezone: "Asia/Shanghai" });

test("a Wednesday brief covers the Friday-to-Thursday week that contains it", () => {
  const [one] = brief([order(2, "frontend", { percent: 30 })]);
  assert.equal(one!.text.split("\n")[0], "2026.11.13-2026.11.19");
  const thursday = composeWeeklyBriefs({
    facts: facts([order(2, "frontend")]),
    contract,
    now: Date.UTC(2026, 10, 19, 1, 0),
    timezone: "Asia/Shanghai",
  });
  assert.equal(thursday[0]!.text.split("\n")[0], "2026.11.13-2026.11.19");
  const friday = composeWeeklyBriefs({
    facts: facts([order(2, "frontend")]),
    contract,
    now: Date.UTC(2026, 10, 20, 1, 0),
    timezone: "Asia/Shanghai",
  });
  assert.equal(friday[0]!.text.split("\n")[0], "2026.11.20-2026.11.26");
});

test("each order goes under its trade's section to that trade's lead, numbered, with percent and status", () => {
  const briefs = brief([
    order(3, "frontend", { percent: 50, subject: "登录页" }),
    order(2, "frontend", { subject: "排行榜", delayMarked: true }),
    order(4, "backend", { percent: 100, statusKey: "execution.waiting", subject: "接口" }),
    order(5, "character_model", { percent: 20, subject: "角色" }),
    order(6, "scene_model", { percent: 40, subject: "场景" }),
  ]);
  const of = (id: string) => briefs.find((b) => b.leadOpUserId === id)!.text;
  assert.equal(
    of("35"),
    "2026.11.13-2026.11.19\n\n前端内容:\n1. 排行榜 进行中(未取到完成百分比)(备注:已延期)\n2. 登录页 50% 进行中",
  );
  assert.equal(of("5"), "2026.11.13-2026.11.19\n\n后台内容:\n1. 接口 100% 等待开发");
  assert.equal(of("45"), "2026.11.13-2026.11.19\n\n美术内容:\n1. 角色 20% 进行中\n2. 场景 40% 进行中");
  assert.deepEqual(briefs.map((b) => b.leadOpUserId).sort(), ["35", "45", "5"]);
});

test("planning orders have no lead of their own yet and go to the default lead, and done, paused or unlabelled orders are left out", () => {
  const briefs = brief([
    order(2, "planning", { percent: 30, subject: "礼包规划" }),
    order(3, "frontend", { statusKey: "execution.done" }),
    order(4, "frontend", { lifecycle: "suspended" }),
    order(5, "mystery"),
    order(6, "frontend", { closed: true }),
  ]);
  assert.deepEqual(
    briefs.map((b) => [b.leadOpUserId, b.text.includes("策划内容:\n1. 礼包规划 30% 进行中")]),
    [["5", true]],
  );
});

test("an order that leads and the default lead share are listed under its own section, ordered by the first order number, and nothing means no brief", () => {
  const both = brief([order(2, "backend"), order(3, "planning")]);
  assert.equal(both.length, 1);
  assert.match(both[0]!.text, /后台内容:\n1\. 单2[\s\S]*策划内容:\n1\. 单3/);
  assert.deepEqual(brief([]), []);
});
