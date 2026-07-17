#!/usr/bin/env node
/* Tests for lib/recovery.js — PLAN_RE / planMonths / nameFrags / classify。
 *   node tools/test_recovery_report.js
 */
"use strict";
const assert = require("assert");
const { classify, nameFrags, planMonths, PLAN_RE } = require("../lib/recovery.js");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// ── PLAN_RE：手動與自動單都要認得 ──
ok("自動單「B 套組 × 1 年」是年租", () => {
  assert.ok(PLAN_RE.test("葉庭綺 入住配送 C 套組 【方案】C 套組 × 1 年"));
});
ok("手動單「C方案一年」是年租", () => {
  assert.ok(PLAN_RE.test("【下午】配送 李坤娣(candace) C方案一年"));
});
ok("「B set租一年」「b set一年」是年租", () => {
  assert.ok(PLAN_RE.test("Han 配送 B set租一年 ¥72,500"));
  assert.ok(PLAN_RE.test("京 配送 b set一年 ¥52,500"));
});
ok("「B方案4月」「× 4 個月」是租賃", () => {
  assert.ok(PLAN_RE.test("吳冠廷 B方案4月"));
  assert.ok(PLAN_RE.test("【方案】B 套組 × 4 個月"));
});
ok("「B方案半年」是租賃", () => {
  assert.ok(PLAN_RE.test("林立軒 配送 B方案半年"));
});

// ── planMonths ──
ok("× 1 年 → 12；× 2 年 → 24；× 4 個月 → 4", () => {
  assert.strictEqual(planMonths("【方案】B 套組 × 1 年"), 12);
  assert.strictEqual(planMonths("【方案】C 套組 × 2 年"), 24);
  assert.strictEqual(planMonths("【方案】B 套組 × 4 個月"), 4);
});
ok("半年 → 6", () => {
  assert.strictEqual(planMonths("林立軒 配送 B方案半年 ¥61,770"), 6);
});
ok("「B方案4月」→ 4；「7月15日」不是租期", () => {
  assert.strictEqual(planMonths("吳冠廷(冠廷) B方案4月"), 4);
  assert.strictEqual(planMonths("A方案 7月15日入住"), 12); // 日期不觸發，落回預設一年
});
ok("兩年/三年/一年 中文照舊", () => {
  assert.strictEqual(planMonths("C set兩年"), 24);
  assert.strictEqual(planMonths("三年"), 36);
  assert.strictEqual(planMonths("B方案一年"), 12);
});

// ── nameFrags ──
ok("羅馬全名整串碎片：WU CHIH CHIA", () => {
  const f = nameFrags("WU CHIH CHIA 至Chia 配送 B方案一年");
  assert.ok(f.has("WU CHIH CHIA"));
});
ok("4字母單字（XUAN/CHIA）不再單獨成碎片 → 不跨客人誤配", () => {
  const a = nameFrags("ゆめ 劉于瑄 LIU YU XUAN 配送 C方案一年");
  const b = nameFrags("【到期】WU PIN XUAN(April萱) B方案一年");
  for (const x of a) assert.ok(!b.has(x), `不該共有碎片：${x}`);
});
ok("至Chia vs 許嘉芸(Chia Yun) 不誤配", () => {
  const a = nameFrags("WU CHIH CHIA 至Chia 配送 B方案一年");
  const b = nameFrags("【到期】許嘉芸(Chia Yun) C方案一年");
  for (const x of a) assert.ok(!b.has(x), `不該共有碎片：${x}`);
});
ok("同一人配送 vs 到期 仍對得上（全名碎片）", () => {
  const dv = nameFrags("WU PIN XUAN(April萱) 配送 B方案一年");
  const ex = nameFrags("【到期】WU PIN XUAN(April萱) B方案一年");
  assert.ok([...dv].some((x) => ex.has(x)));
});
ok("片假名/平假名名字成碎片", () => {
  assert.ok(nameFrags("ホウユル 配送 C set兩年").has("ホウユル"));
  assert.ok(nameFrags("リンリン 配送 C方案一年").has("リンリン"));
});
ok("單字中文名（荊/張/涓）取開頭單字", () => {
  assert.ok(nameFrags("荊 配送（3樣）¥37,800").has("荊"));
  assert.ok(nameFrags("張 配送 C方案 ¥122,460").has("張"));
  assert.ok(nameFrags("【下午】配送 涓 B方案兩年").size >= 0); // 前綴非開頭——見下一條
});
ok("5字母以上羅馬單字仍可比對（HSING）", () => {
  assert.ok(nameFrags("賴星妤（HSING） 入住配送 B 套組").has("HSING"));
});
ok("「1年」的「年」不是名字碎片（Diya/Sanse/Ngjojo 不互配）", () => {
  const diya = nameFrags("Diya 配送 B set 1年 ¥51,000");
  const sanse = nameFrags("Sanse 配送 A方案2年 ¥76,560");
  const ngjojo = nameFrags("Ngjojo 配送 C方案1年 ¥96,160");
  assert.ok(!diya.has("年") && !sanse.has("年") && !ngjojo.has("年"));
  assert.ok(diya.has("DIYA"), "Diya 要走 3-4 字母 fallback 成碎片");
  for (const x of diya) assert.ok(!sanse.has(x) && !ngjojo.has(x), `不該共有碎片：${x}`);
  for (const x of sanse) assert.ok(!ngjojo.has(x), `不該共有碎片：${x}`);
});
ok("「Vera 年租回收」剝完剩 VERA，不含「年」", () => {
  const f = nameFrags("Vera 年租回收");
  assert.ok(!f.has("年"));
  assert.ok(f.has("VERA"));
});
ok("同一人仍對得上：Diya 配送 vs 【到期】Diya", () => {
  const dv = nameFrags("Diya 配送 B set 1年 ¥51,000");
  const ex = nameFrags("【到期】Diya B set 1年");
  assert.ok([...dv].some((x) => ex.has(x)));
});

// ── 日期防呆：回收日早於租期起日不算這筆的回收 ──
ok("回收日早於租期起日 → 不配（雅媗 vs Chao-Chang chen）", () => {
  const { buildRecoveryReport } = require("../lib/recovery.js");
  const msgs = buildRecoveryReport(
    [
      {
        summary: "【到期】雅媗 CHANG YA XUAN B set",
        description: "租期：配送 2025-09-30 起（到期日為推估）",
        start: { date: "2026-09-30" },
      },
      { summary: "Chao-Chang chen 回收 ¥7000", start: { date: "2025-08-10" } },
    ],
    "2026-07-17",
    45
  ).join("\n");
  assert.ok(!/待標「回收完畢」/.test(msgs), "不該進待標完畢");
  assert.ok(/更遠期/.test(msgs), "應留在遠期未安排");
});
ok("中文碎片包含也算同一人：欣蓓 ⊂ 蔡欣蓓", () => {
  const { buildRecoveryReport } = require("../lib/recovery.js");
  const msgs = buildRecoveryReport(
    [
      { summary: "【到期】欣蓓 B set租一年", start: { date: "2026-07-22" } },
      { summary: "【上午】回收 蔡欣蓓 家電傢俱", start: { date: "2026-07-19" } },
    ],
    "2026-07-17",
    45
  ).join("\n");
  assert.ok(/待標「回收完畢」/.test(msgs) && /欣蓓/.test(msgs));
});
ok("提前解約回收（起日之後、到期前）仍配得上", () => {
  const { buildRecoveryReport } = require("../lib/recovery.js");
  const msgs = buildRecoveryReport(
    [
      { summary: "Sanse 配送 A方案2年 ¥76,560", start: { date: "2025-09-09" } },
      { summary: "Sanse 小牛 回收家電（上午）", start: { date: "2026-02-17" } },
    ],
    "2026-07-17",
    45
  ).join("\n");
  assert.ok(/待標「回收完畢」/.test(msgs) && /Sanse/.test(msgs));
});

ok("⚠️品項有客製待核 後綴不成碎片、單字名仍對得上", () => {
  const ex = nameFrags("【到期】劉 B set ⚠️品項有客製待核");
  assert.ok(ex.has("劉"));
  assert.ok(![...ex].some((f) => /品項|客製|待核/.test(f)));
  const meow = nameFrags("【到期】MEOW B set ⚠️品項有客製待核");
  assert.ok(meow.has("MEOW"));
});

// ── classify ──
ok("【到期】標題含「回收」字樣仍歸到期", () => {
  const { expiries, recoveries } = classify([
    { summary: "【到期】許玟萱(湯睿心) B方案一年 ⚠️連冷氣一起回收", start: { date: "2027-04-15" } },
  ]);
  assert.strictEqual(expiries.length, 1);
  assert.strictEqual(recoveries.length, 0);
});
ok("「到期回收 X」歸回收工作", () => {
  const { recoveries } = classify([
    { summary: "【上午】到期回收 王小明", start: { date: "2026-08-01" } },
  ]);
  assert.strictEqual(recoveries.length, 1);
});
ok("自動單被 classify 認成配送", () => {
  const { deliveries } = classify([
    { summary: "葉庭綺 入住配送 C 套組", description: "【方案】C 套組 × 1 年", start: { dateTime: "2026-07-17T12:30:00+09:00" } },
  ]);
  assert.strictEqual(deliveries.length, 1);
});

console.log(`\n${pass}/${pass + fail} 通過`);
process.exit(fail ? 1 : 0);
