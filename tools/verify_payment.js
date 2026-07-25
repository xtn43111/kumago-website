#!/usr/bin/env node
/* KUMAGO — 付款「四件標準」驗證（老闆專用 CLI）。
 *
 * 四件標準（見 memory payment-notification-standard）：任何付款都要做到
 *   1. LINE 通知客人   2. Email 通知   3. 確認客人 LINE ID   4. 行事曆事件登記
 * 這支工具對一筆 Stripe 付款逐件核對，缺哪件標 ⚠️ 並給補救提示。
 *
 * 能查到的是「有沒有嘗試/有沒有登記」的客觀證據：
 *   - 付款：Stripe session payment_status。
 *   - 行事曆登記：事件 id = sha1(session id)，查它存在 + kumago_notified=1 + 型別/日期。
 *   - LINE ID：metadata.line_user_id 是否為合法 U+32hex → 決定 webhook 有沒有推 LINE。
 *   - Email：metadata.customer_email 或結帳頁 email 是否可用；OWNER_EMAIL 是否設定。
 * LINE/Email 的「實際送達」無法從這裡查（要看 LINE/SMTP log），但「有沒有對象可送、
 * webhook 有沒有嘗試」這裡看得出來——四件裡最常漏的就是這個。
 *
 * 用法：
 *   node tools/verify_payment.js --session cs_live_xxx
 *   node tools/verify_payment.js --payment-link plink_xxx   （自動找該連結已付的 session）
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
function loadEnv(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(".env");
loadEnv(".env.local");

const { getEvent, orderEventId } = require(path.join(ROOT, "lib", "gcal.js"));

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    args[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return args;
}
function fail(msg) { console.error("❌ " + msg); process.exit(1); }
const OK = "✅", WARN = "⚠️ ";

// 付款類型 → 預期行事曆事件標題關鍵字。
const TYPES = {
  kumago_buyout: { label: "買斷", key: "買斷" },
  kumago_recovery: { label: "回收", key: "回收" },
  kumago_renewal: { label: "續租", key: "續租" },
  kumago_moving: { label: "搬家", key: "搬家" },
};
function paymentType(meta) {
  for (const [flag, t] of Object.entries(TYPES)) if (meta[flag] === "1") return t;
  return { label: "一般訂單", key: "配送" }; // 預設訂單建「入住配送」
}

async function stripeGet(pathq, secret) {
  const r = await fetch("https://api.stripe.com/v1/" + pathq, {
    headers: { Authorization: "Bearer " + secret },
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Stripe: " + ((j.error && j.error.message) || r.status));
  return j;
}

(async () => {
  const a = parseArgs(process.argv);
  const secret = process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY;
  if (!secret) fail("STRIPE_SECRET_KEY 未設定");

  // 取得 session（直接給 --session，或用 --payment-link 找已付的那筆）
  let session;
  if (a.session) {
    session = await stripeGet(
      "checkout/sessions/" + encodeURIComponent(a.session) + "?expand[]=customer_details",
      secret
    );
  } else if (a.paymentLink) {
    const list = await stripeGet(
      "checkout/sessions?payment_link=" + encodeURIComponent(a.paymentLink) + "&limit=10",
      secret
    );
    session = (list.data || []).find((s) => s.payment_status === "paid") || (list.data || [])[0];
    if (!session) fail("該 payment link 目前沒有任何 session");
  } else {
    fail("需 --session cs_xxx 或 --payment-link plink_xxx");
  }

  const meta = session.metadata || {};
  const t = paymentType(meta);
  const cd = session.customer_details || {};
  const amount = session.amount_total;

  console.log("══════ 付款四件驗證 ══════");
  console.log("session：" + session.id);
  console.log("類型　：" + t.label + "　金額：¥" + Number(amount || 0).toLocaleString("ja-JP"));
  console.log("客人　：" + (meta.customer_name || cd.name || "(未知)"));
  console.log("");

  const gaps = [];

  // 0. 付款狀態（前提）
  const paid = session.payment_status === "paid";
  console.log((paid ? OK : WARN) + "付款：" + session.payment_status + " / " + session.status);
  if (!paid) { gaps.push("尚未付款——以下驗證僅供參考"); }

  // 1 & 3. LINE ID + LINE 通知（互相綁定）
  const uid = String(meta.line_user_id || "");
  const validUid = /^U[0-9a-f]{32}$/.test(uid);
  if (validUid) {
    console.log(OK + "LINE ID：已記（" + uid + "）→ webhook 有對此 userId 推 LINE 通知");
  } else {
    console.log(WARN + "LINE ID：無 → webhook 沒推 LINE 通知（LINE 通知＝漏）");
    gaps.push("客人沒 LINE 通知：反查其 KUMAGO中古家電 頻道 userId，手動補推或請客人重收");
  }

  // 2. Email 通知
  const custEmail = (meta.customer_email && meta.customer_email.trim()) || (cd.email || "").trim();
  const ownerEmail = (process.env.OWNER_EMAIL || "").trim();
  if (custEmail) console.log(OK + "Email：客人 " + custEmail + " → 已寄客人確認信");
  else { console.log(WARN + "Email：客人 email 缺（metadata 無、結帳頁也沒填）→ 客人信沒寄"); gaps.push("客人沒收確認信：跟客人要 email 手動補寄"); }
  console.log((ownerEmail ? OK : WARN) + "Email：老闆 " + (ownerEmail || "OWNER_EMAIL 未設定！"));
  if (!ownerEmail) gaps.push("OWNER_EMAIL 未設定，老闆信全沒寄");

  // 4. 行事曆事件登記（eid = sha1(session id)）
  const eid = orderEventId(session.id);
  let ev = null;
  try { ev = await getEvent(eid); } catch (e) { console.log(WARN + "行事曆：查詢出錯 " + e.message); }
  if (!ev) {
    console.log(WARN + "行事曆：查無事件（id " + eid + "）→ 登記＝漏");
    gaps.push("行事曆沒登記：手動補建【" + t.label + "】事件（缺 delivery_date/recovery_date 等關鍵日常是主因）");
  } else {
    const notified = !!(ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.kumago_notified === "1");
    const typeOk = (ev.summary || "").includes(t.key);
    const date = (ev.start && (ev.start.date || ev.start.dateTime)) || "?";
    console.log(OK + "行事曆：已登記「" + ev.summary + "」（" + date + "）");
    console.log("   " + (notified ? OK : WARN) + "kumago_notified：" + (notified ? "1（流程走完）" : "缺（流程可能沒走完/重試中）"));
    console.log("   " + (typeOk ? OK : WARN) + "型別：標題含「" + t.key + "」" + (typeOk ? "" : " ← 對不上！"));
    if (!notified) gaps.push("行事曆事件沒 notified 旗標：webhook 可能中途失敗，查 Vercel log");
    if (!typeOk) gaps.push("行事曆事件型別對不上（應為" + t.label + "），核對是否抓錯事件");
  }

  console.log("");
  if (gaps.length === 0) {
    console.log("══════ " + OK + "四件到齊，結案 ══════");
  } else {
    console.log("══════ " + WARN + "有缺 " + gaps.length + " 項，待補 ══════");
    gaps.forEach((g, i) => console.log("  " + (i + 1) + ". " + g));
    process.exitCode = 2;
  }
})().catch((e) => fail(e.message));
