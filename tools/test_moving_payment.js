#!/usr/bin/env node
/* 離線測試 lib/moving_payment.js（不碰網路）。
 *
 * 前半：純函式（view / 事件 / LINE 文字 / Telegram 推播 / 確認信 builder）。
 * 後半：handleMovingPayment 整鏈——把 gcal / line_push / telegram / mailer 的
 * require cache 換成錄音 mock 再載入 moving_payment，驗證通知鏈、警告彙整、
 * 冪等旗標（kumago_notified）。 */
"use strict";
const assert = require("assert");

/* ── 先載入真模組（builder 測試用），再把 cache 換成 mock ── */
const realMailer = require("../lib/mailer.js");
require("../lib/gcal.js");
require("../lib/line_push.js");
require("../lib/telegram.js");

const calls = { insert: [], patch: [], line: [], telegram: [], emails: [] };
let insertImpl = async () => ({ duplicate: false });
let lineImpl = async () => ({ ok: true });
let emailsImpl = async () => ({ owner: true, customer: true, skipped: false, errors: [] });

function mock(path, overrides) {
  const mod = require.cache[require.resolve(path)];
  mod.exports = { ...mod.exports, ...overrides };
}
mock("../lib/gcal.js", {
  insertEvent: async (ev, id) => { calls.insert.push({ ev, id }); return insertImpl(ev, id); },
  patchEvent: async (id, patch) => { calls.patch.push({ id, patch }); return {}; },
  orderEventId: (sid) => (sid ? "eid-" + sid : null),
});
mock("../lib/line_push.js", {
  // 模擬真 sendLinePush 的 skip 行為（userId 格式不對 → skip 不算錯）
  sendLinePush: async (userId, messages) => {
    calls.line.push({ userId, messages });
    if (!/^U[0-9a-f]{32}$/.test(String(userId || ""))) {
      return { skipped: true, reason: "invalid_user_id" };
    }
    return lineImpl(userId);
  },
});
mock("../lib/telegram.js", {
  sendTelegram: async (text) => { calls.telegram.push(text); return {}; },
});
mock("../lib/mailer.js", {
  sendMovingEmails: async (v, fallbackEmail) => { calls.emails.push({ v, fallbackEmail }); return emailsImpl(); },
});

const {
  movingView,
  buildMovingPaidEvent,
  buildMovingPaidLineText,
  buildMovingPaidPush,
  handleMovingPayment,
} = require("../lib/moving_payment.js");
const { classify } = require("../lib/recovery.js");

let n = 0;
function t(name, fn) { fn(); n++; console.log("  ✓ " + name); }

const meta = {
  kumago_moving: "1",
  customer_name: "王小明",
  customer_phone: "09000000000",
  customer_email: "taro@example.com",
  moving_date: "2026-08-10",
  moving_time: "上午",
  address_from: "大阪府大阪市中央区テスト町1-2-3 405",
  address_to: "大阪府吹田市テスト町4-5-6 202",
  elevator: "yes",
  items_note: "冰箱、洗衣機、床墊",
  line_display_name: "小明",
  line_user_id: "U0123456789abcdef0123456789abcdef",
  note: "",
  lang: "zh",
};

t("movingView 映射欄位", () => {
  const v = movingView(meta, 15000);
  assert.strictEqual(v.name, "王小明");
  assert.strictEqual(v.email, "taro@example.com");
  assert.strictEqual(v.movingDate, "2026-08-10");
  assert.strictEqual(v.addressFrom, meta.address_from);
  assert.strictEqual(v.addressTo, meta.address_to);
  assert.strictEqual(v.amount, 15000);
});

t("buildMovingPaidEvent 全天事件、標題不含 回收/到期/配送", () => {
  const v = movingView(meta, 15000);
  const ev = buildMovingPaidEvent(v);
  assert.ok(ev, "event 應存在");
  assert.ok(ev.summary.includes("【搬家（費用已付）】"), ev.summary);
  assert.ok(ev.summary.includes("王小明"));
  assert.ok(!/回收|到期|配送/.test(ev.summary), "標題不可含 classify 關鍵字：" + ev.summary);
  assert.strictEqual(ev.start.date, "2026-08-10");
  assert.strictEqual(ev.end.date, "2026-08-11");
  assert.ok(ev.description.includes("¥15,000"));
  assert.ok(ev.description.includes("有電梯"));
  assert.ok(ev.description.includes("搬出地址"));
  assert.ok(ev.description.includes("搬入地址"));
  assert.ok(ev.description.includes("【LINE 名稱】小明"));
  assert.ok(ev.description.includes("【LINE userId】U0123456789abcdef0123456789abcdef"));
  assert.strictEqual(ev.location, meta.address_from);
});

t("classify：搬家事件不進 到期/回收/配送 任何一類", () => {
  const ev = buildMovingPaidEvent(movingView(meta, 15000));
  const cls = classify([{ id: "x", summary: ev.summary, start: { date: "2026-08-10" }, description: ev.description }]);
  assert.deepStrictEqual(
    { d: cls.deliveries.length, e: cls.expiries.length, r: cls.recoveries.length },
    { d: 0, e: 0, r: 0 }
  );
});

t("buildMovingPaidEvent 無效日期回 null", () => {
  assert.strictEqual(buildMovingPaidEvent(movingView({ ...meta, moving_date: "2026-02-30" }, 1)), null);
  assert.strictEqual(buildMovingPaidEvent(movingView({ ...meta, moving_date: "" }, 1)), null);
});

t("LINE 文字含金額/日期/地址/後續說明（zh、en）", () => {
  const v = movingView(meta, 15000);
  const txt = buildMovingPaidLineText(v);
  assert.ok(txt.includes("¥15,000"));
  assert.ok(txt.includes("2026-08-10"));
  assert.ok(txt.includes("搬出地址"));
  assert.ok(txt.includes("搬家日前與您確認詳細時間"));
  const en = buildMovingPaidLineText({ ...v, lang: "en" });
  assert.ok(en.includes("Moving date: 2026-08-10"));
  assert.ok(en.includes("confirm the schedule"));
});

t("Telegram 推播 HTML 轉義＋警告行", () => {
  const v = movingView({ ...meta, customer_name: "A<b>&c" }, 15000);
  const html = buildMovingPaidPush(v, ["搬家事件未建立（x），請手動加到行事曆"]);
  assert.ok(html.includes("A&lt;b&gt;&amp;c"));
  assert.ok(html.includes("⚠️"));
  assert.ok(html.includes("電梯：有"));
});

t("搬家確認信 builder：客人 zh/en、老闆信含客資", () => {
  const v = movingView(meta, 15000);
  const cust = realMailer.buildMovingCustomerEmail(v);
  assert.ok(cust.subject.includes("搬家服務"), cust.subject);
  assert.ok(cust.text.includes("¥15,000"));
  assert.ok(cust.text.includes("2026-08-10"));
  assert.ok(cust.text.includes("搬出地址"));
  assert.ok(cust.text.includes("搬家日前與您確認詳細時間"));
  const en = realMailer.buildMovingCustomerEmail({ ...v, lang: "en" });
  assert.ok(en.subject.includes("Moving Service"), en.subject);
  assert.ok(en.text.includes("Moving date: 2026-08-10"));
  const owner = realMailer.buildMovingOwnerEmail(v);
  assert.ok(owner.text.includes("王小明"));
  assert.ok(owner.text.includes("¥15,000"));
  assert.ok(owner.text.includes("taro@example.com"));
});

/* ── handleMovingPayment 整鏈（mock）── */
function resetCalls() {
  calls.insert.length = 0; calls.patch.length = 0; calls.line.length = 0;
  calls.telegram.length = 0; calls.emails.length = 0;
  insertImpl = async () => ({ duplicate: false });
  lineImpl = async () => ({ ok: true });
  emailsImpl = async () => ({ owner: true, customer: true, skipped: false, errors: [] });
}

const session = {
  id: "cs_test_moving_1",
  customer_details: { email: "checkout@example.com" },
};

(async () => {
  // 正常鏈：事件＋LINE＋信＋Telegram 全跑、kumago_notified 有標
  resetCalls();
  let rep = await handleMovingPayment(session, meta, 15000);
  assert.strictEqual(rep.record.created, true);
  assert.strictEqual(rep.line.sent, true);
  assert.strictEqual(rep.emails.owner, true);
  assert.strictEqual(rep.telegram.sent, true);
  assert.strictEqual(calls.insert.length, 1);
  assert.strictEqual(calls.insert[0].id, "eid-cs_test_moving_1");
  assert.strictEqual(calls.line[0].userId, meta.line_user_id);
  assert.strictEqual(calls.emails[0].fallbackEmail, "checkout@example.com");
  assert.strictEqual(calls.patch.length, 1); // kumago_notified
  assert.strictEqual(calls.patch[0].patch.extendedProperties.private.kumago_notified, "1");
  assert.ok(!calls.telegram[0].includes("⚠️"), calls.telegram[0]);
  n++; console.log("  ✓ handleMovingPayment：正常鏈全通、冪等旗標有標");

  // 冪等：insertEvent 回 duplicate → 照樣走完、duplicate 有記
  resetCalls();
  insertImpl = async () => ({ duplicate: true });
  rep = await handleMovingPayment(session, meta, 15000);
  assert.strictEqual(rep.record.created, true);
  assert.strictEqual(rep.record.duplicate, true);
  n++; console.log("  ✓ handleMovingPayment：重送（duplicate）不炸、有記");

  // 事件建立失敗 → Telegram 帶 ⚠️ 警告、不 throw、不標 notified
  resetCalls();
  insertImpl = async () => { throw new Error("gcal_down"); };
  rep = await handleMovingPayment(session, meta, 15000);
  assert.deepStrictEqual(rep.record.errors, ["gcal_down"]);
  assert.strictEqual(rep.telegram.sent, true);
  assert.ok(calls.telegram[0].includes("⚠️"));
  assert.ok(calls.telegram[0].includes("搬家事件未建立"));
  assert.strictEqual(calls.patch.length, 0); // 沒建成不標 notified
  n++; console.log("  ✓ handleMovingPayment：事件失敗 → ⚠️ 警告、不標 notified");

  // LINE 失敗＋信失敗 → 警告都進 Telegram
  resetCalls();
  lineImpl = async () => { throw new Error("line_push_failed 400"); };
  emailsImpl = async () => ({ owner: false, customer: false, skipped: false, errors: ["owner: smtp_down"] });
  rep = await handleMovingPayment(session, meta, 15000);
  assert.strictEqual(rep.line.sent, false);
  assert.ok(calls.telegram[0].includes("LINE 付款確認推播失敗"));
  assert.ok(calls.telegram[0].includes("確認信寄送有問題"));
  n++; console.log("  ✓ handleMovingPayment：LINE/信失敗 → 警告彙整進 Telegram");

  // 無 line_user_id → skip 不算錯
  resetCalls();
  rep = await handleMovingPayment(session, { ...meta, line_user_id: "" }, 15000);
  assert.strictEqual(rep.line.sent, false);
  assert.strictEqual(rep.line.skipped, "invalid_user_id");
  assert.deepStrictEqual(rep.line.errors, []);
  assert.ok(!calls.telegram[0].includes("LINE 付款確認推播失敗"));
  n++; console.log("  ✓ handleMovingPayment：無 LINE userId → skip 不警告");

  // 無效搬家日 → 事件不建、警告、其餘照走
  resetCalls();
  rep = await handleMovingPayment(session, { ...meta, moving_date: "bad" }, 15000);
  assert.strictEqual(rep.record.created, false);
  assert.ok(rep.record.errors[0].includes("invalid_moving_date"));
  assert.strictEqual(calls.insert.length, 0);
  assert.strictEqual(rep.telegram.sent, true);
  assert.ok(calls.telegram[0].includes("搬家事件未建立"));
  n++; console.log("  ✓ handleMovingPayment：無效搬家日 → 不建事件、有警告");

  console.log(`\n${n} tests passed ✅`);
})().catch((e) => {
  console.error("  ✗ " + (e && e.stack || e));
  process.exit(1);
});
