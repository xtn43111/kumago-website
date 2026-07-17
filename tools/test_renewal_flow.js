#!/usr/bin/env node
/* KUMAGO — 續租流程離線測試（不打任何網路）。
 *
 *   node tools/test_renewal_flow.js
 *
 * 驗證：到期日計算、renewalView 欄位映射、【續租】紀錄事件（標題不得含
 * 配送/到期/回收 → recovery.js classify 不得誤抓）、到期事件 PATCH 內容、
 * 續租信與 Telegram 推播內容。全過 exit 0，任一失敗 exit 1。
 */
"use strict";
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

const {
  computeNewExpiry, renewalView, buildRenewalRecordEvent,
  buildExpiryEventPatch, buildRenewalPush,
} = require(path.join(ROOT, "lib", "renewal.js"));
const { buildRenewalCustomerEmail, buildRenewalOwnerEmail } =
  require(path.join(ROOT, "lib", "mailer.js"));
const { classify } = require(path.join(ROOT, "lib", "recovery.js"));

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("  ✅ " + label); return; }
  failures++;
  console.log("  ❌ " + label + (detail ? "　→ " + detail : ""));
}

/* ── 1. 到期日計算（起算日 + 月數 − 1 天）── */
console.log("1. computeNewExpiry");
check("2026-07-18 + 6個月 = 2027-01-17", computeNewExpiry("2026-07-18", 6) === "2027-01-17", computeNewExpiry("2026-07-18", 6));
check("2026-01-01 + 12個月 = 2026-12-31", computeNewExpiry("2026-01-01", 12) === "2026-12-31", computeNewExpiry("2026-01-01", 12));
check("2026-04-16 + 12個月 = 2027-04-15（SOP 慣例）", computeNewExpiry("2026-04-16", 12) === "2027-04-15", computeNewExpiry("2026-04-16", 12));
check("無效日期回 null", computeNewExpiry("2026-13-45", 6) === null);
check("月數 0 回 null", computeNewExpiry("2026-07-18", 0) === null);

/* ── 2. 模擬王測試續租單 ── */
const meta = {
  kumago_renewal: "1",
  plan: "B",
  duration: "半年",
  renewal_months: "6",
  renewal_start: "2026-07-18",
  new_expiry: "2027-01-17",
  expiry_event_id: "cafe0000000000000000000000000000deadbeef",
  customer_name: "王測試",
  customer_contact: "test@example.com",
  customer_phone: "09000000000",
  line_display_name: "",
  line_user_id: "U0123456789abcdef0123456789abcdef",
  postal: "541-0000",
  address: "大阪府大阪市中央区テスト町1-2-3",
  items_note: "B set＋窗簾、曬衣桿、桌子（原加購續用）",
  note: "",
  lang: "zh",
};
const lineItems = [{ description: "【續租】B 套組 × 半年（含原加購品項）", amount_total: 31250 }];
const v = renewalView(meta, lineItems, 31250);

console.log("2. renewalView");
check("newExpiry 由 start+months 重算", v.newExpiry === "2027-01-17", v.newExpiry);
check("total = 31250", v.total === 31250, String(v.total));
check("planName = B 套組", v.planName === "B 套組", v.planName);
check("contact = email", v.contact === "test@example.com", v.contact);

/* ── 3. 【續租】紀錄事件 ── */
console.log("3. buildRenewalRecordEvent");
const rec = buildRenewalRecordEvent(v);
check("有建出事件", !!rec);
check("全天事件落在續租起算日", rec && rec.start.date === "2026-07-18" && rec.end.date === "2026-07-19", rec && JSON.stringify(rec.start));
check("標題含【續租】與名字", rec && rec.summary.includes("【續租】") && rec.summary.includes("王測試"), rec && rec.summary);
check("標題不含 配送/到期/回收（防 classify 誤抓）", rec && !/配送|到期|回收/.test(rec.summary), rec && rec.summary);
check("說明含新租期與 LINE userId", rec && rec.description.includes("2026/07/18 - 2027/01/17") && rec.description.includes("U01234567"), "");
const cls = classify([{ id: "x", summary: rec ? rec.summary : "", start: { date: "2026-07-18" }, description: rec ? rec.description : "" }]);
check("classify：不進 到期/回收/配送 任何一類",
  cls.deliveries.length === 0 && cls.expiries.length === 0 && cls.recoveries.length === 0,
  JSON.stringify({ d: cls.deliveries.length, e: cls.expiries.length, r: cls.recoveries.length }));

/* ── 4. 到期事件 PATCH ── */
console.log("4. buildExpiryEventPatch");
const oldEvent = {
  summary: "【到期】王測試 B set租一年",
  description: "租期到期 王測試 B set租一年\n聯絡：09000000000\n（原說明）",
};
const patch = buildExpiryEventPatch(oldEvent, v, "2026-07-17");
check("日期移到 2027-01-17（全天）", patch && patch.start.date === "2027-01-17" && patch.end.date === "2027-01-18", patch && JSON.stringify(patch.start));
check("標題補「＋續租半年」", patch && patch.summary === "【到期】王測試 B set租一年＋續租半年", patch && patch.summary);
check("標題仍以【到期】開頭（classify 仍認得）", patch && patch.summary.startsWith("【到期】"));
check("說明開頭是續租紀錄、原說明保留", patch && patch.description.startsWith("🔁 2026-07-17 已續租半年") && patch.description.includes("（原說明）"), "");
const patched = classify([{ id: "y", summary: patch.summary, start: { date: "2027-01-17" }, description: patch.description }]);
check("classify：patch 後仍是到期事件", patched.expiries.length === 1 && patched.recoveries.length === 0);
// 已含「續租」的標題不重複補
const again = buildExpiryEventPatch({ summary: patch.summary, description: patch.description }, v, "2026-07-17");
check("二次續租不重複補標題", again && again.summary === undefined, again && again.summary);

/* ── 5. 信件 ── */
console.log("5. 續租信");
const cust = buildRenewalCustomerEmail(v);
check("客人信主旨", cust.subject === "【KUMAGO】續租確認 — B 套組 半年", cust.subject);
check("客人信含租期與金額", cust.text.includes("2026-07-18 ～ 2027-01-17") && cust.text.includes("¥31,250"), "");
check("客人信 HTML 含續租完成", cust.html.includes("續租完成"), "");
const owner = buildRenewalOwnerEmail(v);
check("老闆信含名字/金額/新到期", owner.text.includes("王測試") && owner.text.includes("¥31,250") && owner.text.includes("2027-01-17"), "");

/* ── 6. Telegram 推播 ── */
console.log("6. Telegram 推播");
const push = buildRenewalPush(v, []);
check("推播含名字/金額/新租期", push.includes("王測試") && push.includes("¥31,250") && push.includes("2026-07-18 ~ 2027-01-17"), "");
const pushWarn = buildRenewalPush(v, ["到期事件未順延（xx），請手動改到 2027-01-17"]);
check("有警告時 ⚠️ 前置", pushWarn.startsWith("⚠️"), "");
check("HTML 轉義（名字含 < 不炸）", buildRenewalPush({ ...v, name: "a<b" }, []).includes("a&lt;b"), "");

console.log("");
if (failures) { console.log(`❌ ${failures} 項失敗`); process.exit(1); }
console.log("✅ 全部通過");
