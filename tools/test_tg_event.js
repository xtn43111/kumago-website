#!/usr/bin/env node
/* Tests for lib/tg_event.js — 自由格式解析 + 既有標籤格式回歸。
 *   node tools/test_tg_event.js
 */
"use strict";
const assert = require("assert");
const { buildManualEvent, freeFormScan } = require("../lib/tg_event.js");

const TODAY = "2026-07-15"; // 固定今天，測試可重現

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// ── 自由格式 ──
ok("多行自由貼文：抓日期/時間/地址/電話，第一行當標題", () => {
  const r = buildManualEvent(
    "許玟萱 冷氣安裝\n7/17 09:00\n大阪府大阪市住之江区中加賀屋4丁目5-20 303號室\n09045743629\n中古冷氣含安裝55000",
    { todayJst: TODAY }
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.view.summary, "許玟萱 冷氣安裝");
  assert.strictEqual(r.view.date, "2026-07-17");
  assert.strictEqual(r.view.time, "09:00–10:00");
  assert.ok(r.view.address.includes("中加賀屋"));
  assert.strictEqual(r.view.contact, "09045743629");
  assert.ok(r.view.note.includes("中古冷氣含安裝55000"));
  assert.ok(r.event.description.includes("📍 Google 地圖："));
});

ok("單行：7/17 許玟萱 冷氣安裝", () => {
  const r = buildManualEvent("7/17 許玟萱 冷氣安裝", { todayJst: TODAY });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.view.date, "2026-07-17");
  assert.strictEqual(r.view.summary, "許玟萱 冷氣安裝");
  assert.strictEqual(r.view.time, "整天");
});

ok("相對日期＋中文時段：明天 下午2點半 回收冰箱", () => {
  const r = buildManualEvent("明天 下午2點半 回收冰箱", { todayJst: TODAY });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.view.date, "2026-07-16");
  assert.strictEqual(r.view.time, "14:30–15:30");
  assert.strictEqual(r.view.summary, "回收冰箱");
});

ok("時間範圍：7/20 13:00-16:00 配送", () => {
  const r = buildManualEvent("7/20 13:00-16:00 王小明配送", { todayJst: TODAY });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.view.time, "13:00–16:00");
  assert.strictEqual(r.view.summary, "王小明配送");
});

ok("2026年7月20日 中文日期也通", () => {
  const r = buildManualEvent("回收桌椅\n2026年7月20日", { todayJst: TODAY });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.view.date, "2026-07-20");
});

ok("無日期的自由貼文 → 回缺日期", () => {
  const r = buildManualEvent("許玟萱 冷氣安裝\n大阪市住之江区", { todayJst: TODAY });
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.includes("日期"));
});

ok("〒郵遞區號行判定為地址", () => {
  const r = buildManualEvent("回收 8/1\n〒537-0022 大阪府大阪市東成区中本 2丁目3-18", { todayJst: TODAY });
  assert.strictEqual(r.ok, true);
  assert.ok(r.view.address.includes("〒537-0022"));
});

ok("URL 自動當地圖連結", () => {
  const r = buildManualEvent("看房 7/25\nhttps://maps.app.goo.gl/abc123", { todayJst: TODAY });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.view.map, "https://maps.app.goo.gl/abc123");
});

// ── 標籤格式回歸 ──
ok("舊標籤格式照常", () => {
  const r = buildManualEvent(
    "標題：庭綺 回收\n日期：2026-07-20\n時間：14:00-16:00\n地址：大阪市東成区大今里\n聯絡：080-1234-5678\n備註：3樓無電梯",
    { todayJst: TODAY }
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.view.summary, "庭綺 回收");
  assert.strictEqual(r.view.date, "2026-07-20");
  assert.strictEqual(r.view.time, "14:00–16:00");
  assert.strictEqual(r.view.contact, "080-1234-5678");
  assert.strictEqual(r.view.note, "3樓無電梯");
});

ok("姓名：標籤當標題", () => {
  const r = buildManualEvent("姓名：許玟萱\n日期：7/17\n地址：大阪市住之江区中加賀屋4丁目5-20", { todayJst: TODAY });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.view.summary, "許玟萱");
});

ok("標題與姓名同時出現 → 標題贏、姓名進備註", () => {
  const r = buildManualEvent("標題：冷氣安裝\n姓名：許玟萱\n日期：7/17", { todayJst: TODAY });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.view.summary, "冷氣安裝");
  assert.ok(r.view.note.includes("許玟萱"));
});

ok("有標籤但缺日期 → 不會誤走自由格式", () => {
  const r = buildManualEvent("標題：冷氣安裝\n地址：大阪市 7/17", { todayJst: TODAY });
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.includes("日期"));
});

// ── freeFormScan 邊界 ──
ok("只有日期沒內容 → null", () => {
  assert.strictEqual(freeFormScan("7/17", TODAY), null);
});
ok("空字串 → null", () => {
  assert.strictEqual(freeFormScan("", TODAY), null);
});

console.log(`\n${pass}/${pass + fail} 通過`);
process.exit(fail ? 1 : 0);
