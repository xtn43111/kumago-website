#!/usr/bin/env node
/* KUMAGO — 產生「續租」Stripe Checkout 付款連結（老闆專用 CLI，不開公開端點）。
 *
 * 金額自訂（續租不走網站價目表），metadata 帶 kumago_renewal=1，付款後
 * api/stripe-webhook.js 會走 lib/renewal.js 續租流程：建【續租】紀錄事件、
 * 順延既有【到期】事件、寄確認信（老闆＋客人）、Telegram 推播。
 *
 * ⚠️ 連結是 Stripe Checkout Session，24 小時未付款會過期——過期就重跑一次
 *    產新連結即可（每次都是新 session，冪等由 webhook 端保證）。
 * ⚠️ webhook 的續租分支要先部署到 Vercel，客人才可以付款；先產連結後部署
 *    也行，但付款必須發生在部署之後。
 *
 * 用法：
 *   node tools/create_renewal_link.js \
 *     --name 王小明 --phone 09000000000 --email x@y.com \
 *     --plan B --months 6 --amount 31250 \
 *     --start 2026-07-18 --expiry-event-id <既有【到期】事件id> \
 *     --postal 541-0000 --address "大阪府大阪市中央区○○町1-2-3" \
 *     --items-note "B set＋窗簾、曬衣桿、桌子（原加購續用）" \
 *     --line-user-id Uxxxx --line-name 顯示名 --note "備註" \
 *     [--dry-run]
 *
 * 必填：--name --amount --months --start；其餘選填但建議都給
 * （email 給了客人才收得到系統確認信；expiry-event-id 給了到期事件才會自動順延）。
 */
"use strict";
const fs = require("fs");
const path = require("path");

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

const { computeNewExpiry } = require(path.join(ROOT, "lib", "renewal.js"));

const SITE_ORIGIN = "https://kumago.7-mori.com";
const PLAN_NAME = { A: "A 套組", B: "B 套組", C: "C 套組" };

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "dry-run") { args.dryRun = true; continue; }
    args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return args;
}

function fail(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}

function durationLabel(months) {
  const m = parseInt(months, 10);
  if (m === 6) return "半年";
  if (m % 12 === 0) return `${m / 12}年`;
  return `${m}個月`;
}

(async () => {
  const a = parseArgs(process.argv);

  // 本機 .env 放的是測試金鑰；要出正式連結，把正式金鑰放 .env.local 的
  // STRIPE_SECRET_KEY_LIVE（gitignored），這裡優先吃它。
  const secret = process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY;
  if (!secret) fail("STRIPE_SECRET_KEY 未設定（.env）");
  if (secret.startsWith("sk_test")) {
    console.log("⚠️ 目前用的是 sk_test 測試金鑰——產出的連結不能刷真卡。");
    console.log("   要出正式連結：在 .env.local 加 STRIPE_SECRET_KEY_LIVE=sk_live_...\n");
  }
  if (!a.name) fail("--name 必填");
  const amount = parseInt(a.amount, 10);
  if (!amount || amount <= 0) fail("--amount 必填（日圓整數）");
  const months = parseInt(a.months, 10);
  if (!months || months <= 0) fail("--months 必填（整數月數）");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.start || "")) fail("--start 必填（YYYY-MM-DD，續租起算日＝原到期日）");
  const newExpiry = computeNewExpiry(a.start, months);
  if (!newExpiry) fail(`--start ${a.start} 不是有效日期`);

  const duration = a.duration || durationLabel(months);
  const plan = (a.plan || "").toUpperCase();
  const planName = PLAN_NAME[plan] || plan || "續租";
  const email = (a.email || "").trim();
  const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  if (email && !isEmail) fail(`--email ${email} 格式不對`);

  const meta = {
    kumago_renewal: "1",
    plan: plan,
    duration,
    renewal_months: String(months),
    renewal_start: a.start,
    new_expiry: newExpiry,
    expiry_event_id: a.expiryEventId || "",
    customer_name: a.name,
    // contact 放 email（mailer 靠它寄客人確認信）；沒 email 就放電話
    customer_contact: isEmail ? email : (a.phone || ""),
    customer_phone: a.phone || "",
    line_display_name: String(a.lineName || "").trim().slice(0, 60),
    line_user_id: /^U[0-9a-f]{32}$/.test(String(a.lineUserId || "")) ? String(a.lineUserId) : "",
    postal: a.postal || "",
    address: a.address || "",
    items_note: a.itemsNote || "",
    note: a.note || "",
    lang: a.lang || "zh",
  };

  const itemName =
    meta.lang === "en"
      ? `[Renewal] ${plan ? `Plan ${plan}` : "Rental"} × ${months % 12 === 0 ? `${months / 12} year${months > 12 ? "s" : ""}` : `${months} months`}`
      : `【續租】${planName} × ${duration}${a.itemsNote ? "（含原加購品項）" : ""}`;

  console.log("── 續租單內容 ──");
  console.log(`客人：${a.name}${a.phone ? "　" + a.phone : ""}${email ? "　" + email : ""}`);
  console.log(`項目：${itemName}`);
  console.log(`金額：¥${amount.toLocaleString("ja-JP")}`);
  console.log(`新租期：${a.start} ～ ${newExpiry}（${duration}）`);
  console.log(`到期事件：${a.expiryEventId ? a.expiryEventId + "（付款後自動順延）" : "⚠️ 未指定，付款後要手動順延"}`);
  if (!email) console.log("⚠️ 未給 email：客人不會收到系統確認信（老闆信照寄）");
  console.log("");

  if (a.dryRun) {
    console.log("（--dry-run：未呼叫 Stripe）");
    console.log(JSON.stringify(meta, null, 2));
    return;
  }

  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("success_url", `${SITE_ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}`);
  params.append("cancel_url", `${SITE_ORIGIN}/`);
  params.append("locale", meta.lang === "ja" ? "ja" : meta.lang === "en" ? "en" : "zh-TW");
  if (isEmail) params.append("customer_email", email);
  params.append("line_items[0][price_data][currency]", "jpy");
  params.append("line_items[0][price_data][product_data][name]", itemName);
  params.append("line_items[0][price_data][unit_amount]", String(amount));
  params.append("line_items[0][quantity]", "1");
  Object.entries(meta).forEach(([k, v]) => {
    params.append(`metadata[${k}]`, String(v).slice(0, 500));
    params.append(`payment_intent_data[metadata][${k}]`, String(v).slice(0, 500));
  });

  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await r.json();
  if (!r.ok) fail("Stripe 錯誤：" + ((data.error && data.error.message) || r.status));

  console.log("✅ 付款連結（24 小時內有效）：");
  console.log(data.url);
  console.log("");
  console.log("session id：" + data.id);
})().catch((e) => fail(e.message));
