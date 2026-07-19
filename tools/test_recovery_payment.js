#!/usr/bin/env node
/* 離線測試 lib/recovery_payment.js 純函式（不碰網路）。 */
"use strict";
const assert = require("assert");
const {
  recoveryView,
  buildRecoveryPaidEvent,
  buildRecoveryPaidLineText,
  buildRecoveryPaidPush,
} = require("../lib/recovery_payment.js");
const {
  buildRecoveryCustomerEmail,
  buildRecoveryOwnerEmail,
  sendRecoveryEmails,
} = require("../lib/mailer.js");

let n = 0;
function t(name, fn) { fn(); n++; console.log("  ✓ " + name); }

const meta = {
  kumago_recovery: "1",
  customer_name: "王小明",
  customer_phone: "09012345678",
  recovery_date: "2026-07-23",
  address: "大阪府大阪市中央区テスト町1-2-3 999",
  items_note: "洗衣機、冰箱、床墊、桌子、椅子×2",
  elevator: "yes",
  line_display_name: "小明",
  line_user_id: "",
  note: "",
  lang: "zh",
};

t("recoveryView 映射欄位", () => {
  const v = recoveryView(meta, 35000);
  assert.strictEqual(v.name, "王小明");
  assert.strictEqual(v.recoveryDate, "2026-07-23");
  assert.strictEqual(v.amount, 35000);
  assert.strictEqual(v.elevator, "yes");
});

t("buildRecoveryPaidEvent 全天事件、標題含「回收」", () => {
  const v = recoveryView(meta, 35000);
  const ev = buildRecoveryPaidEvent(v);
  assert.ok(ev, "event 應存在");
  assert.ok(ev.summary.includes("回收"), "標題要含「回收」供防漏報表歸類");
  assert.ok(!ev.summary.includes("回收完畢"), "新事件不可含「回收完畢」（會被當已結案）");
  assert.strictEqual(ev.start.date, "2026-07-23");
  assert.strictEqual(ev.end.date, "2026-07-24");
  assert.ok(ev.description.includes("¥35,000"));
  assert.ok(ev.description.includes("有電梯"));
  assert.ok(ev.description.includes("洗衣機"));
  assert.strictEqual(ev.location, meta.address);
});

t("buildRecoveryPaidEvent 無效日期回 null", () => {
  const v = recoveryView({ ...meta, recovery_date: "2026-02-30" }, 35000);
  assert.strictEqual(buildRecoveryPaidEvent(v), null);
  const v2 = recoveryView({ ...meta, recovery_date: "" }, 35000);
  assert.strictEqual(buildRecoveryPaidEvent(v2), null);
});

t("LINE 文字含金額與日期", () => {
  const v = recoveryView(meta, 35000);
  const txt = buildRecoveryPaidLineText(v);
  assert.ok(txt.includes("¥35,000"));
  assert.ok(txt.includes("2026-07-23"));
});

t("Telegram 推播 HTML 轉義＋警告行", () => {
  const v = recoveryView({ ...meta, customer_name: "A<b>&c" }, 35000);
  const html = buildRecoveryPaidPush(v, ["回收事件未建立（x），請手動加到行事曆"]);
  assert.ok(html.includes("A&lt;b&gt;&amp;c"));
  assert.ok(html.includes("⚠️"));
  assert.ok(html.includes("電梯：有"));
});

t("recoveryView：customer_email 映射進 email", () => {
  const v = recoveryView({ ...meta, customer_email: "taro@example.com" }, 35000);
  assert.strictEqual(v.email, "taro@example.com");
  assert.strictEqual(recoveryView(meta, 35000).email, "");
});

t("回收確認信 builder：客人信含金額/回收日/地址、老闆信含客資", () => {
  const v = recoveryView({ ...meta, customer_email: "taro@example.com" }, 35000);
  const cust = buildRecoveryCustomerEmail(v);
  assert.ok(cust.subject.includes("回收處理費"), cust.subject);
  assert.ok(cust.text.includes("¥35,000"));
  assert.ok(cust.text.includes("2026-07-23"));
  assert.ok(cust.text.includes(meta.address));
  assert.ok(cust.text.includes("回收當天若時間有異動會再與您聯繫"));
  assert.ok(cust.html.includes("¥35,000"));
  const owner = buildRecoveryOwnerEmail(v);
  assert.ok(owner.text.includes("王小明"));
  assert.ok(owner.text.includes("¥35,000"));
  assert.ok(owner.text.includes("taro@example.com"));
});

t("webhook 分支載入不炸（require api/stripe-webhook.js）", () => {
  const h = require("../api/stripe-webhook.js");
  assert.strictEqual(typeof h, "function");
});

(async () => {
  // sendRecoveryEmails：SMTP 未設定 → skipped、不炸（async，放尾端逐一 await）
  const su = process.env.SMTP_USER, sp = process.env.SMTP_APP_PASSWORD;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_APP_PASSWORD;
  const v = recoveryView(meta, 35000);
  const rep = await sendRecoveryEmails(v, "");
  assert.strictEqual(rep.skipped, true);
  assert.deepStrictEqual(rep.errors, []);
  if (su !== undefined) process.env.SMTP_USER = su;
  if (sp !== undefined) process.env.SMTP_APP_PASSWORD = sp;
  n++;
  console.log("  ✓ sendRecoveryEmails：SMTP 未設定 → skipped、不炸");

  console.log(`\n${n} tests passed ✅`);
})().catch((e) => {
  console.error("  ✗ " + e.message);
  process.exit(1);
});
