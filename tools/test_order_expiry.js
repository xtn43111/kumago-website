#!/usr/bin/env node
/* Tests for lib/gcal.js buildExpiryEvent — 訂單自動建到期事件。
 *   node tools/test_order_expiry.js
 */
"use strict";
const assert = require("assert");
const { buildExpiryEvent } = require("../lib/gcal.js");
const { classify, nameFrags } = require("../lib/recovery.js");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const V = {
  name: "王小明", lineName: "小明", planName: "B 套組", duration: "1 年",
  addonNames: ["電風扇", "桌椅組"], moveInDate: "2026-08-01",
  postal: "5370022", address: "大阪府大阪市東成区中本 2丁目3-18", building: "レアレア緑橋",
  contact: "08012345678", mapUrl: "", note: "",
};

ok("一年租：8/1 起租 → 隔年 7/31 到期（全天）", () => {
  const e = buildExpiryEvent(V, "B");
  assert.strictEqual(e.start.date, "2027-07-31");
  assert.strictEqual(e.end.date, "2027-08-01");
  assert.ok(e.summary.startsWith("【到期】王小明（小明） B 套組×1年"));
});
ok("品項＝套組基底＋加購", () => {
  const e = buildExpiryEvent(V, "B");
  assert.ok(e.description.includes("品項：冰箱、洗衣機、微波爐、單人床架、床墊（寬100cm）、電風扇、桌椅組"));
  assert.ok(e.description.includes("租期：2026/08/01 - 2027/07/31"));
});
ok("4 個月：8/1 → 11/30 到期", () => {
  const e = buildExpiryEvent({ ...V, duration: "4 個月" }, "B");
  assert.strictEqual(e.start.date, "2026-11-30");
});
ok("半年：8/1 → 隔年 1/31 到期", () => {
  const e = buildExpiryEvent({ ...V, duration: "半年" }, "C");
  assert.strictEqual(e.start.date, "2027-01-31");
  assert.ok(e.description.includes("寬120cm"));
});
ok("2 年 → 24 個月", () => {
  const e = buildExpiryEvent({ ...V, duration: "2 年" }, "A");
  assert.strictEqual(e.start.date, "2028-07-31");
});
ok("備註有客製字樣 → 標題標 ⚠️", () => {
  const e = buildExpiryEvent({ ...V, note: "不要床架，換成瓦斯爐" }, "B");
  assert.ok(e.summary.includes("⚠️品項有客製待核"));
  assert.ok(e.description.includes("備註（回收前核對品項）"));
});
ok("普通備註不標 ⚠️ 但仍寫進內文", () => {
  const e = buildExpiryEvent({ ...V, note: "請按門鈴" }, "B");
  assert.ok(!e.summary.includes("⚠️"));
  assert.ok(e.description.includes("請按門鈴"));
});
ok("標題不含「回收」；classify 歸到期；名字碎片對得上配送事件", () => {
  const e = buildExpiryEvent(V, "B");
  assert.ok(!e.summary.includes("回收"));
  const { expiries } = classify([{ summary: e.summary, start: e.start, description: e.description }]);
  assert.strictEqual(expiries.length, 1);
  const dv = nameFrags("王小明（小明） 入住配送 B 套組");
  assert.ok([...expiries[0].names].some((x) => dv.has(x)));
});
ok("無 LINE 名：標題只有本名", () => {
  const e = buildExpiryEvent({ ...V, lineName: "" }, "B");
  assert.ok(e.summary.startsWith("【到期】王小明 B 套組"));
});
ok("壞日期 → null", () => {
  assert.strictEqual(buildExpiryEvent({ ...V, moveInDate: "2026-13-45" }, "B"), null);
});

console.log(`\n${pass}/${pass + fail} 通過`);
process.exit(fail ? 1 : 0);
