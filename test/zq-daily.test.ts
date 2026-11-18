import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { createZqDaily, matchOrders, type ZqDailyEntry } from "../src/zq/daily.ts";
import type { WorkView } from "../src/zq/rules.ts";
import { testMap } from "./support/test-database.ts";

const order = (id: number, subject: string): WorkView => ({
  id,
  subject,
  typeKey: "backend",
  statusKey: "execution.active",
});
const ORDERS = [order(12, "登录页联调"), order(15, "排行榜接口"), order(120, "ab")];

test("a reply names an order by its number or by its title, and short titles never match by accident", () => {
  const ids = (text: string) => matchOrders(text, ORDERS).map((w) => w.id);
  assert.deepEqual(ids("今天做完了 #12"), [12]);
  assert.deepEqual(ids("OP15 已经联调完"), [15]);
  assert.deepEqual(ids("op 15 ok"), [15]);
  assert.deepEqual(ids("把登录页联调收尾了,还看了排行榜接口"), [12, 15]);
  assert.deepEqual(ids("开会一整天 ab"), []);
  assert.deepEqual(ids("#1 和 #1200"), []);
});

test("a question is asked once a day, the first reply is kept, and only a matched order can be answered", async () => {
  let at = 1_000;
  const daily = createZqDaily({ map: testMap<ZqDailyEntry>(), now: () => at });
  assert.equal(await daily.ask("mm-1", "2026-11-18"), true);
  assert.equal(await daily.ask("mm-1", "2026-11-18"), false, "not asked twice the same day");
  const open = (await daily.openFor("mm-1"))!;
  await daily.record(open.id, "做了 #12", [12]);
  assert.equal(await daily.openFor("mm-1"), undefined, "a second message is an ordinary message");
  assert.equal(await daily.answer(open.id, 99, true), undefined);
  assert.deepEqual((await daily.answer(open.id, 12, true))!.answers, { "12": "done" });
  assert.deepEqual((await daily.answer(open.id, 12, false))!.answers, { "12": "open" });
  assert.equal(await daily.openFor("mm-2"), undefined);
  assert.equal(await daily.ask("mm-2", "2026-11-18"), true);
  at += 21 * 3_600_000;
  assert.equal(await daily.openFor("mm-2"), undefined, "an old question no longer captures a message");
});
