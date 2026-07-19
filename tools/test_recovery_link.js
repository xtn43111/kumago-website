#!/usr/bin/env node
/* 離線測試 lib/recovery_link.js 純函式（不碰網路）。 */
"use strict";
const assert = require("assert");
const {
  buildRecoveryMeta,
  parseRecoveryLinkCommand,
  parseCmdDate,
  parseCmdExpires,
  buildCustomerMessage,
  mdLabel,
} = require("../lib/recovery_link.js");

let n = 0;
function t(name, fn) { fn(); n++; console.log("  ✓ " + name); }

const TODAY = "2026-07-19"; // JST 基準（測試固定）
const NOW = Date.parse("2026-07-19T00:30:00+09:00");

t("parseCmdDate：M/D、YYYY-MM-DD、無效值", () => {
  assert.strictEqual(parseCmdDate("7/23", TODAY), "2026-07-23");
  assert.strictEqual(parseCmdDate("2026-07-23", TODAY), "2026-07-23");
  assert.strictEqual(parseCmdDate("7月23日", TODAY), "2026-07-23");
  assert.strictEqual(parseCmdDate("1/5", TODAY), "2027-01-05"); // 過去太多 → 明年
  assert.strictEqual(parseCmdDate("2/30", TODAY), null);
  assert.strictEqual(parseCmdDate("abc", TODAY), null);
});

t("parseCmdExpires：日期+時刻、只時刻、無效值", () => {
  assert.strictEqual(
    parseCmdExpires("7/19 12:00", TODAY),
    Math.floor(Date.parse("2026-07-19T12:00:00+09:00") / 1000)
  );
  assert.strictEqual(
    parseCmdExpires("12:00", TODAY),
    Math.floor(Date.parse("2026-07-19T12:00:00+09:00") / 1000)
  );
  assert.strictEqual(parseCmdExpires("25:00", TODAY), null);
  assert.strictEqual(parseCmdExpires("garbage", TODAY), null);
});

t("指令解析：完整欄位", () => {
  const text = [
    "/回收連結",
    "姓名：王小明",
    "金額：34,000",
    "回收日：7/23",
    "地址：大阪府大阪市中央区テスト町1-2-3 999",
    "品項：洗衣機、冰箱",
    "電梯：有",
    "期限：7/19 12:00",
  ].join("\n");
  const r = parseRecoveryLinkCommand(text, TODAY, NOW);
  assert.ok(r && r.ok, JSON.stringify(r));
  assert.strictEqual(r.value.name, "王小明");
  assert.strictEqual(r.value.amount, 34000);
  assert.strictEqual(r.value.date, "2026-07-23");
  assert.strictEqual(r.value.elevator, "yes");
  assert.ok(r.expiresAt > 0);
});

t("指令解析：非本指令回 null、空內容回 template", () => {
  assert.strictEqual(parseRecoveryLinkCommand("/行程", TODAY, NOW), null);
  assert.strictEqual(parseRecoveryLinkCommand("隨便聊天", TODAY, NOW), null);
  const r = parseRecoveryLinkCommand("/回收連結", TODAY, NOW);
  assert.deepStrictEqual(r, { ok: false, error: "template" });
});

t("指令解析：缺欄位、壞金額、壞期限", () => {
  let r = parseRecoveryLinkCommand("/回收連結\n姓名：A", TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("缺欄位"));
  r = parseRecoveryLinkCommand("/回收連結\n姓名：A\n金額：abc\n回收日：7/23\n地址：X", TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("金額"));
  // 期限已過 → 至少 30 分鐘的擋
  r = parseRecoveryLinkCommand("/回收連結\n姓名：A\n金額：100\n回收日：7/23\n地址：X\n期限：0:40", TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("30 分鐘"), r.error);
  // 超過 24h
  r = parseRecoveryLinkCommand("/回收連結\n姓名：A\n金額：100\n回收日：7/23\n地址：X\n期限：7/21 12:00", TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("24 小時"), r.error);
});

t("buildRecoveryMeta：flag 與欄位齊", () => {
  const m = buildRecoveryMeta({
    name: "A", amount: 100, date: "2026-07-23", address: "X",
    elevator: "yes", lineUserId: "bad-id",
  });
  assert.strictEqual(m.kumago_recovery, "1");
  assert.strictEqual(m.elevator, "yes");
  assert.strictEqual(m.line_user_id, ""); // 格式不對 → 丟棄
  assert.strictEqual(m.customer_email, ""); // 沒給 email → 空字串
});

t("email 欄位：解析進 value、進 meta、壞格式擋下", () => {
  const base = "/回收連結\n姓名：A\n金額：100\n回收日：7/23\n地址：X";
  let r = parseRecoveryLinkCommand(base + "\nemail：taro@example.com", TODAY, NOW);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.value.email, "taro@example.com");
  const m = buildRecoveryMeta(r.value);
  assert.strictEqual(m.customer_email, "taro@example.com");
  // 大寫標籤也吃（Email：）
  r = parseRecoveryLinkCommand(base + "\nEmail：taro@example.com", TODAY, NOW);
  assert.ok(r.ok && r.value.email === "taro@example.com");
  // 沒給 → 空字串，照樣 ok
  r = parseRecoveryLinkCommand(base, TODAY, NOW);
  assert.ok(r.ok && r.value.email === "");
  // 壞格式 → 明確錯誤
  r = parseRecoveryLinkCommand(base + "\nemail：not-an-email", TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("email"), JSON.stringify(r));
  // meta 端也擋壞格式（防呆雙保險）
  assert.strictEqual(
    buildRecoveryMeta({ name: "A", amount: 100, date: "2026-07-23", address: "X", email: "bad" }).customer_email,
    ""
  );
});

t("mdLabel 星期正確", () => {
  assert.strictEqual(mdLabel("2026-07-23"), "7/23（四）");
  assert.strictEqual(mdLabel("2026-07-19"), "7/19（日）");
});

t("buildCustomerMessage：含金額/期限/連結", () => {
  const v = { name: "A", amount: 34000, date: "2026-07-23", address: "X", items: "冰箱" };
  const exp = Math.floor(Date.parse("2026-07-19T12:00:00+09:00") / 1000);
  const msg = buildCustomerMessage(v, "https://example.test/pay", exp);
  assert.ok(msg.includes("¥34,000"));
  assert.ok(msg.includes("7/23（四）"));
  assert.ok(msg.includes("7/19（日） 12:00"));
  assert.ok(msg.includes("https://example.test/pay"));
  const noExp = buildCustomerMessage(v, "u", null);
  assert.ok(!noExp.includes("付款期限"));
});

t("webhook 載入不炸（require api/telegram-webhook.js）", () => {
  const h = require("../api/telegram-webhook.js");
  assert.strictEqual(typeof h, "function");
});

console.log(`\n${n} tests passed ✅`);
