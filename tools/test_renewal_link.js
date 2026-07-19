#!/usr/bin/env node
/* 離線測試 lib/renewal_link.js 純函式（不碰網路）。
 * 重點：metadata key 必須與 tools/create_renewal_link.js 完全對齊，
 * 付款後 webhook 的 lib/renewal.js handleRenewal / renewalView 才吃得到。 */
"use strict";
const assert = require("assert");
const {
  durationLabel,
  buildRenewalMeta,
  renewalItemName,
  parseRenewalLinkCommand,
  buildRenewalCustomerMessage,
  CMD_TEMPLATE,
} = require("../lib/renewal_link.js");
const { renewalView, computeNewExpiry } = require("../lib/renewal.js");

let n = 0;
function t(name, fn) { fn(); n++; console.log("  ✓ " + name); }

const TODAY = "2026-07-19"; // JST 基準（測試固定）
const NOW = Date.parse("2026-07-19T00:30:00+09:00");

t("durationLabel：半年/N年/N個月（同 create_renewal_link.js）", () => {
  assert.strictEqual(durationLabel(6), "半年");
  assert.strictEqual(durationLabel(12), "1年");
  assert.strictEqual(durationLabel(24), "2年");
  assert.strictEqual(durationLabel(4), "4個月");
});

t("指令解析：完整欄位", () => {
  const text = [
    "/續租連結",
    "姓名：王小明",
    "金額：31,250",
    "月數：6",
    "原到期日：2026-08-31",
    "方案：b",
    "電話：09000000000",
    "email：taro@example.com",
    "到期事件id：cafe0000000000000000000000000000deadbeef",
    "郵遞區號：541-0000",
    "地址：大阪府大阪市中央区テスト町1-2-3",
    "品項：B set＋窗簾、曬衣桿（原加購續用）",
    "LINE名：小明",
    "LINE ID：U0123456789abcdef0123456789abcdef",
    "備註：測試備註",
    "期限：7/19 12:00",
  ].join("\n");
  const r = parseRenewalLinkCommand(text, TODAY, NOW);
  assert.ok(r && r.ok, JSON.stringify(r));
  assert.strictEqual(r.value.name, "王小明");
  assert.strictEqual(r.value.amount, 31250);
  assert.strictEqual(r.value.months, 6);
  assert.strictEqual(r.value.start, "2026-08-31");
  assert.strictEqual(r.value.plan, "B"); // 小寫自動轉大寫
  assert.strictEqual(r.value.email, "taro@example.com");
  assert.strictEqual(r.value.expiryEventId, "cafe0000000000000000000000000000deadbeef");
  assert.strictEqual(r.value.lineUserId, "U0123456789abcdef0123456789abcdef");
  assert.strictEqual(r.value.lang, "zh");
  assert.ok(r.expiresAt > 0);
});

t("指令解析：非本指令回 null、空內容回 template", () => {
  assert.strictEqual(parseRenewalLinkCommand("/回收連結", TODAY, NOW), null);
  assert.strictEqual(parseRenewalLinkCommand("隨便聊天", TODAY, NOW), null);
  const r = parseRenewalLinkCommand("/續租連結", TODAY, NOW);
  assert.deepStrictEqual(r, { ok: false, error: "template" });
  assert.ok(CMD_TEMPLATE.includes("/續租連結"));
});

t("指令解析：缺欄位、壞金額、壞月數、壞日期、壞 email、壞期限", () => {
  let r = parseRenewalLinkCommand("/續租連結\n姓名：A", TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("缺欄位"), r.error);
  assert.ok(r.error.includes("金額") && r.error.includes("月數") && r.error.includes("原到期日"));
  const base = "/續租連結\n姓名：A\n金額：100\n月數：6\n原到期日：2026-08-31";
  r = parseRenewalLinkCommand(base.replace("金額：100", "金額：abc"), TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("金額"), r.error);
  r = parseRenewalLinkCommand(base.replace("月數：6", "月數：零"), TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("月數"), r.error);
  // 原到期日只收 YYYY-MM-DD（M/D 會被滾年規則亂改，不收）
  r = parseRenewalLinkCommand(base.replace("原到期日：2026-08-31", "原到期日：8/31"), TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("原到期日"), r.error);
  r = parseRenewalLinkCommand(base.replace("原到期日：2026-08-31", "原到期日：2026-02-30"), TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("原到期日"), r.error);
  r = parseRenewalLinkCommand(base + "\nemail：bad", TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("email"), r.error);
  r = parseRenewalLinkCommand(base + "\n期限：0:40", TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("30 分鐘"), r.error);
  r = parseRenewalLinkCommand(base + "\n期限：7/21 12:00", TODAY, NOW);
  assert.ok(!r.ok && r.error.includes("24 小時"), r.error);
});

t("指令解析：YYYY/MM/DD 也吃、語言 en", () => {
  const r = parseRenewalLinkCommand(
    "/續租連結\n姓名：A\n金額：100\n月數：6\n原到期日：2026/08/31\n語言：en", TODAY, NOW);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.value.start, "2026-08-31");
  assert.strictEqual(r.value.lang, "en");
});

t("metadata key 完全對齊 create_renewal_link.js（handleRenewal 讀的 key）", () => {
  const m = buildRenewalMeta({
    name: "王小明", amount: 31250, months: 6, start: "2026-08-31",
    plan: "B", phone: "09000000000", email: "taro@example.com",
    expiryEventId: "cafe0000000000000000000000000000deadbeef",
    postal: "541-0000", address: "大阪府大阪市中央区テスト町1-2-3",
    items: "B set＋窗簾", lineName: "小明",
    lineUserId: "U0123456789abcdef0123456789abcdef", note: "備註", lang: "zh",
  });
  // create_renewal_link.js 的 meta key 集合（順序不拘、一個不多一個不少）
  assert.deepStrictEqual(Object.keys(m).sort(), [
    "address", "customer_contact", "customer_name", "customer_phone",
    "duration", "expiry_event_id", "items_note", "kumago_renewal", "lang",
    "line_display_name", "line_user_id", "new_expiry", "note", "plan",
    "postal", "renewal_months", "renewal_start",
  ].sort());
  assert.strictEqual(m.kumago_renewal, "1");
  assert.strictEqual(m.duration, "半年");
  assert.strictEqual(m.renewal_months, "6");
  assert.strictEqual(m.renewal_start, "2026-08-31");
  assert.strictEqual(m.new_expiry, computeNewExpiry("2026-08-31", 6)); // 2027-02-27？由同一函式保證
  assert.strictEqual(m.customer_contact, "taro@example.com"); // email 優先
  assert.strictEqual(m.customer_phone, "09000000000");
});

t("customer_contact：沒 email 就放電話；LINE ID 壞格式丟棄", () => {
  const m = buildRenewalMeta({
    name: "A", amount: 100, months: 12, start: "2026-08-31",
    phone: "09000000000", lineUserId: "bad-id",
  });
  assert.strictEqual(m.customer_contact, "09000000000");
  assert.strictEqual(m.line_user_id, "");
  assert.strictEqual(m.duration, "1年");
});

t("meta 直接餵 renewalView（webhook 端）欄位對得上", () => {
  const m = buildRenewalMeta({
    name: "王小明", amount: 31250, months: 6, start: "2026-08-31",
    plan: "B", email: "taro@example.com", items: "B set＋窗簾",
    expiryEventId: "cafe0000000000000000000000000000deadbeef",
  });
  const v = renewalView(m, [], 31250);
  assert.strictEqual(v.name, "王小明");
  assert.strictEqual(v.contact, "taro@example.com");
  assert.strictEqual(v.planName, "B 套組");
  assert.strictEqual(v.duration, "半年");
  assert.strictEqual(v.months, 6);
  assert.strictEqual(v.renewalStart, "2026-08-31");
  assert.strictEqual(v.newExpiry, computeNewExpiry("2026-08-31", 6));
  assert.strictEqual(v.expiryEventId, "cafe0000000000000000000000000000deadbeef");
  assert.strictEqual(v.itemsNote, "B set＋窗簾");
  assert.strictEqual(v.total, 31250);
});

t("品名照 create_renewal_link.js 慣例（zh/en）", () => {
  assert.strictEqual(
    renewalItemName({ plan: "B", months: 6, items: "有品項", lang: "zh" }),
    "【續租】B 套組 × 半年（含原加購品項）"
  );
  assert.strictEqual(
    renewalItemName({ plan: "B", months: 6, lang: "zh" }),
    "【續租】B 套組 × 半年"
  );
  assert.strictEqual(
    renewalItemName({ plan: "B", months: 6, lang: "en" }),
    "[Renewal] Plan B × 6 months"
  );
  assert.strictEqual(
    renewalItemName({ plan: "A", months: 12, lang: "en" }),
    "[Renewal] Plan A × 1 year"
  );
  assert.strictEqual(
    renewalItemName({ plan: "", months: 24, lang: "en" }),
    "[Renewal] Rental × 2 years"
  );
});

t("buildRenewalCustomerMessage（zh）：金額/期間/新到期日/連結/期限", () => {
  const v = { name: "王小明", amount: 31250, months: 6, start: "2026-08-31", plan: "B", items: "B set" };
  const exp = Math.floor(Date.parse("2026-07-19T12:00:00+09:00") / 1000);
  const newExpiry = computeNewExpiry("2026-08-31", 6).replace(/-/g, "/");
  const msg = buildRenewalCustomerMessage(v, "https://example.test/pay", exp);
  assert.ok(msg.includes("¥31,250"));
  assert.ok(msg.includes("2026/08/31"));
  assert.ok(msg.includes(newExpiry));
  assert.ok(msg.includes("新到期日"));
  assert.ok(msg.includes("https://example.test/pay"));
  assert.ok(msg.includes("付款期限"));
  assert.ok(msg.includes("7/19（日） 12:00"));
  const noExp = buildRenewalCustomerMessage(v, "u", null);
  assert.ok(!noExp.includes("付款期限"));
});

t("buildRenewalCustomerMessage（en）：英文版含期間與連結", () => {
  const v = { name: "Taro", amount: 31250, months: 6, start: "2026-08-31", plan: "B", lang: "en" };
  const msg = buildRenewalCustomerMessage(v, "https://example.test/pay", null);
  assert.ok(msg.includes("Renewal"));
  assert.ok(msg.includes("¥31,250"));
  assert.ok(msg.includes("6 months"));
  assert.ok(msg.includes("New expiry date"));
  assert.ok(msg.includes("https://example.test/pay"));
});

t("webhook 載入不炸（require api/telegram-webhook.js）", () => {
  const h = require("../api/telegram-webhook.js");
  assert.strictEqual(typeof h, "function");
});

console.log(`\n${n} tests passed ✅`);
