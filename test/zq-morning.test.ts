import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseContract } from "../src/zq/contract.ts";
import { composeMorning } from "../src/zq/morning.ts";
import type { FeatureFacts, WorkView } from "../src/zq/rules.ts";

const contract = parseContract(
  JSON.parse(readFileSync(new URL("./fixtures/zq-contract-keys.json", import.meta.url), "utf8")),
);
const BOB = { id: "12", name: "Bob B" };
const order = (id: number, over: Partial<WorkView> = {}): WorkView => ({
  id,
  subject: `单${id}`,
  typeKey: "backend",
  statusKey: "execution.waiting",
  assignee: BOB,
  ...over,
});
const facts = (children: WorkView[]): FeatureFacts[] => [
  { feature: { id: 1, subject: "功能", typeKey: "feature", statusKey: "feature.development" }, children },
];

test("the morning message lists what has not started and what is running, and nothing for a person with no orders", () => {
  const text = composeMorning(
    "12",
    facts([
      order(3),
      order(2),
      order(4, { statusKey: "execution.active" }),
      order(5, { assignee: { id: "99", name: "Other" } }),
      order(6, { statusKey: "execution.done" }),
      order(7, { lifecycle: "suspended" }),
    ]),
    contract,
  )!;
  assert.match(text, /还没开始执行\(2\):\n1\. 「单2」\(#2\)\n2\. 「单3」\(#3\)/);
  assert.match(text, /正在执行\(1\):\n1\. 「单4」\(#4\)/);
  assert.doesNotMatch(text, /单5|单6|单7/);
  assert.equal(composeMorning("12", facts([order(5, { assignee: { id: "99", name: "Other" } })]), contract), undefined);
  assert.equal(composeMorning("12", facts([]), contract), undefined);
});

test("once an order is handed in, the next waiting order is suggested, the lowest number first", () => {
  const text = composeMorning(
    "12",
    facts([order(9, { statusKey: "execution.active", completionSubmitted: true }), order(8), order(7)]),
    contract,
  )!;
  assert.match(text, /已提交完成、等待确认:「单9」\(#9\)。可以接着安排:「单7」\(#7\)/);
  assert.match(text, /正在执行\(0\):\n无/);
  const none = composeMorning("12", facts([order(9, { completionSubmitted: true })]), contract)!;
  assert.doesNotMatch(none, /可以接着安排/);
});
