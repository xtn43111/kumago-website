#!/usr/bin/env node
/* 離線測試 lib/moving_link.js 純函式（不碰網路）。 */
"use strict";
const assert = require("assert");
const {
  buildMovingMeta,
  movingItemName,
  parseMovingLinkCommand,
  buildMovingCustomerMessage,
  CMD_TEMPLATE,
} = require("../lib/moving_link.js");

let n = 0;
function t(name, fn) { fn(); n++; console.log("  ✓ " + name); }

const TODAY = "2026-07-19"; // JST 基準（測試固定）
const NOW = Date.parse("2026-07-19T00:30:00+09:00");

t("指令解析：完整欄位", () => {
  const text = [
    "/搬家連結",
    "姓名：王小明",
    "金額：15,000",
    "搬家日：8/10",
    "搬出地址：大阪府大阪市中央区テスト町1-2-3 405",
    "搬入地址：大阪府吹田市テスト町4-5-6 202",
    "時間：上午",
    "電梯：有",
    "電話：09000000000",
    "email：taro@example.com",
    "品項：冰箱、洗衣機、床墊",
    "LINE名：小明",
    "LINE ID：U0123456789abcdef0123456789abcdef",
    "備註：測試備註",
    "期限：7/19 12:00",
  ].join("\n");
  const r = parseMovingLinkCommand(text, TODAY, NOW);
  assert.ok(r && r.ok, JSON.stringify(r));
  assert.strictEqual(r.value.name, "王小明");
  assert.strictEqual(r.value.amount, 15000);
  assert.strictEqual(r.value.date, "2026-08-10");
  assert.strictEqual(r.value.addressFrom, "大阪府大阪市中央区テスト町1-2-3 405");
  assert.strictEqual(r.value.addressTo, "大阪府吹田市テスト町4-5-6 202");
  assert.strictEqual(r.value.time, "上午");
  assert.strictEqual(r.value.elevator, "yes");
  assert.strictEqual(r.value.email, "taro@example.com");
  assert.strictEqual(r.value.lineUserId, "U0123456789abcdef0123456789abcdef");
  assert.ok(r.expiresAt > 0);
});

t("指令解析：非本指令回 null、空內容回 template", () => {
  assert.strictEqual(parseMovingLinkCommand("/回收連結", TODAY, NOW), null);
  assert.strictEqual(parseMovingLinkCommand("/續租連結", TODAY, NOW), null);
  assert.strictEqual(parseMovingLinkCommand("隨便聊天", TODAY, NOW), null);
  const r = parseMovingLinkCommand("/搬家連結", TODAY, NOW);
  assert.deepStrictEqual(r, { ok: false, error: "template" });
  assert.ok(CMD_TEMPLATE.includes("/搬家連結"));
});

t("指令解析：缺欄位、壞金額、壞日期、壞 email、壞期限", () => {
  let r = parseMovingLinkCommand("/搬家連結\n姓名：A", TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("缺欄位"), r.error);
  assert.ok(r.error.includes("金額") && r.error.includes("搬家日") && r.error.includes("搬出地址"));
  const base = "/搬家連結\n姓名：A\n金額：100\n搬家日：8/10\n搬出地址：X";
  r = parseMovingLinkCommand(base.replace("金額：100", "金額：abc"), TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("金額"), r.error);
  r = parseMovingLinkCommand(base.replace("搬家日：8/10", "搬家日：2/30"), TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("搬家日"), r.error);
  r = parseMovingLinkCommand(base + "\nemail：bad", TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("email"), r.error);
  r = parseMovingLinkCommand(base + "\n期限：0:40", TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("30 分鐘"), r.error);
  r = parseMovingLinkCommand(base + "\n期限：7/21 12:00", TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("24 小時"), r.error);
});

t("指令解析：選填留空 → 空字串、電梯無、語言 en", () => {
  const r = parseMovingLinkCommand(
    "/搬家連結\n姓名：A\n金額：100\n搬家日：8/10\n搬出地址：X\n電梯：無\n語言：en", TODAY, NOW);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.value.addressTo, "");
  assert.strictEqual(r.value.time, "");
  assert.strictEqual(r.value.email, "");
  assert.strictEqual(r.value.elevator, "no");
  assert.strictEqual(r.value.lang, "en");
  assert.strictEqual(r.expiresAt, null);
});

t("buildMovingMeta：flag 與欄位齊、壞 email/LINE ID 丟棄", () => {
  const m = buildMovingMeta({
    name: "王小明", amount: 15000, date: "2026-08-10",
    addressFrom: "大阪A", addressTo: "大阪B", time: "上午", elevator: "yes",
    phone: "09000000000", email: "taro@example.com", items: "冰箱",
    lineName: "小明", lineUserId: "U0123456789abcdef0123456789abcdef",
    note: "備註", lang: "zh",
  });
  assert.deepStrictEqual(Object.keys(m).sort(), [
    "address_from", "address_to", "customer_email", "customer_name",
    "customer_phone", "elevator", "items_note", "kumago_moving", "lang",
    "line_display_name", "line_user_id", "moving_date", "moving_time", "note",
  ].sort());
  assert.strictEqual(m.kumago_moving, "1");
  assert.strictEqual(m.moving_date, "2026-08-10");
  assert.strictEqual(m.address_from, "大阪A");
  assert.strictEqual(m.customer_email, "taro@example.com");
  const bad = buildMovingMeta({
    name: "A", amount: 100, date: "2026-08-10", addressFrom: "X",
    email: "bad", lineUserId: "bad-id",
  });
  assert.strictEqual(bad.customer_email, "");
  assert.strictEqual(bad.line_user_id, "");
});

t("品名：【搬家服務】姓名 M/D（zh/en）", () => {
  assert.strictEqual(
    movingItemName({ name: "王小明", date: "2026-08-10", lang: "zh" }),
    "【搬家服務】王小明 8/10"
  );
  assert.strictEqual(
    movingItemName({ name: "Taro", date: "2026-12-03", lang: "en" }),
    "[Moving Service] Taro 12/3"
  );
});

t("buildMovingCustomerMessage（zh）：金額/日期/地址/連結/期限/後續說明", () => {
  const v = {
    name: "王小明", amount: 15000, date: "2026-08-10",
    addressFrom: "大阪A", addressTo: "大阪B", time: "上午", items: "冰箱",
  };
  const exp = Math.floor(Date.parse("2026-07-19T12:00:00+09:00") / 1000);
  const msg = buildMovingCustomerMessage(v, "https://example.test/pay", exp);
  assert.ok(msg.includes("¥15,000"));
  assert.ok(msg.includes("8/10（一）"));
  assert.ok(msg.includes("搬出地址：大阪A"));
  assert.ok(msg.includes("搬入地址：大阪B"));
  assert.ok(msg.includes("https://example.test/pay"));
  assert.ok(msg.includes("付款期限"));
  assert.ok(msg.includes("搬家日前與您確認詳細時間"));
  const noExp = buildMovingCustomerMessage(v, "u", null);
  assert.ok(!noExp.includes("付款期限"));
});

t("buildMovingCustomerMessage（en）：英文版", () => {
  const v = { name: "Taro", amount: 15000, date: "2026-08-10", addressFrom: "Osaka A", lang: "en" };
  const msg = buildMovingCustomerMessage(v, "https://example.test/pay", null);
  assert.ok(msg.includes("Moving Service"));
  assert.ok(msg.includes("¥15,000"));
  assert.ok(msg.includes("From: Osaka A"));
  assert.ok(msg.includes("https://example.test/pay"));
});

t("webhook 載入不炸（require api/telegram-webhook.js）", () => {
  const h = require("../api/telegram-webhook.js");
  assert.strictEqual(typeof h, "function");
});

console.log(`\n${n} tests passed ✅`);
