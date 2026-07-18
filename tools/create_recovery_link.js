#!/usr/bin/env node
/* KUMAGO — 產生「期滿回收處理費」Stripe 刷卡連結（老闆專用 CLI，不開公開端點）。
 *
 * metadata 帶 kumago_recovery=1，付款後 api/stripe-webhook.js 走
 * lib/recovery_payment.js：建【回收（費用已付）】行事曆事件（回收日全天）、
 * 有 line_user_id 就 LINE 推播客人付款確認、Telegram 通知老闆。
 *
 * ⚠️ webhook 的回收分支要先部署到 Vercel，客人才可以付款。
 * ⚠️ 預設產 Payment Link（付款前一直有效、付一次即失效）；--session 改產
 *    Checkout Session（24 小時過期；可用 --expires "YYYY-MM-DDTHH:MM" 指定
 *    JST 期限，需在 30 分鐘～24 小時內）。
 *
 * 用法：
 *   node tools/create_recovery_link.js \
 *     --name 王小明 --amount 35000 --date 2026-07-23 \
 *     --address "大阪府大阪市中央区○○町1-2-3 405" \
 *     --items "洗衣機、冰箱、床墊、桌子、椅子×2" \
 *     --elevator yes --phone 090xxxxxxxx \
 *     --line-user-id Uxxxx --line-name 顯示名 --note "備註" \
 *     [--session] [--dry-run]
 *
 * 必填：--name --amount --date --address；其餘選填。
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

const SITE_ORIGIN = "https://kumago.7-mori.com";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "dry-run") { args.dryRun = true; continue; }
    if (key === "session") { args.session = true; continue; }
    args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return args;
}

function fail(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

(async () => {
  const a = parseArgs(process.argv);

  // 本機 .env 放的是測試金鑰；正式連結吃 .env.local 的 STRIPE_SECRET_KEY_LIVE。
  const secret = process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY;
  if (!secret) fail("STRIPE_SECRET_KEY 未設定（.env）");
  if (secret.startsWith("sk_test")) {
    console.log("⚠️ 目前用的是 sk_test 測試金鑰——產出的連結不能刷真卡。");
    console.log("   要出正式連結：在 .env.local 加 STRIPE_SECRET_KEY_LIVE=sk_live_...\n");
  }
  if (!a.name) fail("--name 必填");
  const amount = parseInt(a.amount, 10);
  if (!amount || amount <= 0) fail("--amount 必填（日圓整數）");
  if (!isRealDate(a.date)) fail("--date 必填（YYYY-MM-DD，希望回收日）");
  if (!a.address) fail("--address 必填（收取地址）");
  const elevator = a.elevator === "yes" || a.elevator === "no" ? a.elevator : "";

  // --expires：JST 牆鐘時間 → epoch 秒。僅 --session 模式有效（Stripe 限 30 分～24 小時）。
  let expiresAt = null;
  if (a.expires) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(a.expires)) fail('--expires 格式：YYYY-MM-DDTHH:MM（JST）');
    expiresAt = Math.floor(Date.parse(a.expires + ":00+09:00") / 1000);
    if (isNaN(expiresAt)) fail(`--expires ${a.expires} 不是有效時間`);
    const mins = (expiresAt * 1000 - Date.now()) / 60000;
    if (mins < 30) fail(`--expires 距現在只剩 ${Math.round(mins)} 分鐘，Stripe 最少要 30 分鐘`);
    if (mins > 24 * 60) fail("--expires 超過 24 小時，Stripe Checkout Session 上限 24 小時");
    if (!a.session) fail("--expires 只支援 --session 模式（Payment Link 沒有期限功能）");
  }

  const meta = {
    kumago_recovery: "1",
    customer_name: a.name,
    customer_phone: a.phone || "",
    recovery_date: a.date,
    address: a.address,
    items_note: a.items || "",
    elevator,
    line_display_name: String(a.lineName || "").trim().slice(0, 60),
    line_user_id: /^U[0-9a-f]{32}$/.test(String(a.lineUserId || "")) ? String(a.lineUserId) : "",
    note: a.note || "",
    lang: a.lang || "zh",
  };

  const itemName =
    meta.lang === "ja"
      ? `【回収】期満回収 処理費（回収日 ${a.date}）`
      : `【回收】期滿回收處理費（回收日 ${a.date}）`;

  console.log("── 回收處理費 ──");
  console.log(`客人：${a.name}${a.phone ? "　" + a.phone : ""}`);
  console.log(`項目：${itemName}`);
  console.log(`金額：¥${amount.toLocaleString("ja-JP")}`);
  console.log(`回收日：${a.date}`);
  console.log(`收取地址：${a.address}${elevator ? `（${elevator === "yes" ? "有" : "無"}電梯）` : ""}`);
  if (meta.items_note) console.log(`品項：${meta.items_note}`);
  if (!meta.line_user_id) console.log("（未給 line-user-id：付款後不推 LINE 確認，老闆 Telegram 照通知）");
  console.log("");

  if (a.dryRun) {
    console.log("（--dry-run：未呼叫 Stripe）");
    console.log(JSON.stringify(meta, null, 2));
    return;
  }

  const params = new URLSearchParams();
  if (a.session) {
    params.append("mode", "payment");
    if (expiresAt) params.append("expires_at", String(expiresAt));
    params.append("success_url", `${SITE_ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}`);
    params.append("cancel_url", `${SITE_ORIGIN}/`);
    params.append("locale", meta.lang === "ja" ? "ja" : "zh-TW");
    params.append("line_items[0][price_data][currency]", "jpy");
    params.append("line_items[0][price_data][product_data][name]", itemName);
    params.append("line_items[0][price_data][unit_amount]", String(amount));
    params.append("line_items[0][quantity]", "1");
  } else {
    // Payment Link：不會 24 小時過期（付款一次後自動失效）。
    // metadata 會被 Stripe 原樣複製到 checkout session，webhook 回收分支照常吃到。
    params.append("line_items[0][price_data][currency]", "jpy");
    params.append("line_items[0][price_data][product_data][name]", itemName);
    params.append("line_items[0][price_data][unit_amount]", String(amount));
    params.append("line_items[0][quantity]", "1");
    params.append("restrictions[completed_sessions][limit]", "1");
    params.append("after_completion[type]", "redirect");
    params.append("after_completion[redirect][url]", `${SITE_ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}`);
  }
  Object.entries(meta).forEach(([k, v]) => {
    params.append(`metadata[${k}]`, String(v).slice(0, 500));
    params.append(`payment_intent_data[metadata][${k}]`, String(v).slice(0, 500));
  });

  const endpoint = a.session
    ? "https://api.stripe.com/v1/checkout/sessions"
    : "https://api.stripe.com/v1/payment_links";
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await r.json();
  if (!r.ok) fail("Stripe 錯誤：" + ((data.error && data.error.message) || r.status));

  if (a.session) {
    console.log("✅ 付款連結（24 小時內有效）：");
    console.log(data.url);
    console.log("");
    console.log("session id：" + data.id);
  } else {
    console.log("✅ 付款連結（Payment Link，付款前一直有效、付一次即失效）：");
    console.log(data.url);
    console.log("");
    console.log("payment link id：" + data.id + "（要提前作廢：POST /v1/payment_links/" + data.id + " active=false）");
  }
})().catch((e) => fail(e.message));
