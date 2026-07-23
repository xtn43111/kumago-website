#!/usr/bin/env node
/* KUMAGO — 產生「家電傢俱買斷」Stripe 刷卡連結（老闆專用 CLI，不開公開端點）。
 *
 * 買斷＝客人把租用中的家電傢俱直接買下，付清後物品歸客人，沒有配送/回收/到期。
 * metadata 帶 kumago_buyout=1，付款後 api/stripe-webhook.js 走 lib/buyout_payment.js：
 * 建【買斷（費用已付）】記帳事件、有 line_user_id 就 LINE 推播客人付款確認、
 * 寄確認信（老闆＋客人）、Telegram 通知老闆。
 *
 * ⚠️ 預設產 Payment Link（付款前一直有效、付一次即失效）。
 * ⚠️ webhook 的買斷分支要先部署到 Vercel，客人才可以付款；先產連結後部署也行，
 *    但付款必須發生在部署之後。
 *
 * 用法：
 *   node tools/create_buyout_link.js \
 *     --name DIYA --amount 51000 --items "冰箱、洗衣機、沙發" \
 *     [--phone 090xxxxxxxx] [--email x@y.com] \
 *     [--line-user-id Uxxxx] [--line-name 顯示名] [--note 備註] \
 *     [--lang zh|ja|en] [--dry-run]
 *
 * 必填：--name --amount --items；其餘選填。
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
    args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return args;
}

function fail(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}

(async () => {
  const a = parseArgs(process.argv);

  // 本機 .env 放測試金鑰；正式連結吃 .env.local 的 STRIPE_SECRET_KEY_LIVE。
  const secret = process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY;
  if (!secret) fail("STRIPE_SECRET_KEY 未設定（.env）");
  if (secret.startsWith("sk_test")) {
    console.log("⚠️ 目前用的是 sk_test 測試金鑰——產出的連結不能刷真卡。");
    console.log("   要出正式連結：在 .env.local 加 STRIPE_SECRET_KEY_LIVE=sk_live_...\n");
  }
  if (!a.name) fail("--name 必填");
  const amount = parseInt(a.amount, 10);
  if (!amount || amount <= 0) fail("--amount 必填（日圓整數）");
  if (!a.items) fail("--items 必填（買斷品項，例：冰箱、洗衣機、沙發）");

  const email = (a.email || "").trim();
  const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  if (email && !isEmail) fail(`--email ${email} 格式不對`);
  const lang = a.lang || "zh";

  const meta = {
    kumago_buyout: "1",
    customer_name: a.name,
    customer_phone: a.phone || "",
    customer_email: isEmail ? email : "",
    items_note: a.items,
    note: a.note || "",
    line_display_name: String(a.lineName || "").trim().slice(0, 60),
    line_user_id: /^U[0-9a-f]{32}$/.test(String(a.lineUserId || "")) ? String(a.lineUserId) : "",
    lang,
  };

  const itemName =
    lang === "en"
      ? `[Buyout] Appliances/Furniture — ${a.items}`
      : lang === "ja"
      ? `【買取】家電・家具 — ${a.items}`
      : `【買斷】家電傢俱 — ${a.items}`;

  console.log("── 買斷單內容 ──");
  console.log(`客人：${a.name}${a.phone ? "　" + a.phone : ""}${email ? "　" + email : ""}`);
  console.log(`項目：${itemName}`);
  console.log(`金額：¥${amount.toLocaleString("ja-JP")}`);
  console.log(`買斷品項：${a.items}`);
  if (!meta.line_user_id) console.log("（未給 line-user-id：付款後不推 LINE 確認，老闆 Telegram 照通知）");
  if (!email) console.log("（未給 email：客人確認信改用結帳頁自填 email，沒填就 skip）");
  console.log("");

  if (a.dryRun) {
    console.log("（--dry-run：未呼叫 Stripe）");
    console.log(JSON.stringify(meta, null, 2));
    return;
  }

  // Payment Link：付款前一直有效、付一次即失效。metadata 會被 Stripe 原樣複製到
  // checkout session，webhook 買斷分支照常吃到。
  const params = new URLSearchParams();
  params.append("line_items[0][price_data][currency]", "jpy");
  params.append("line_items[0][price_data][product_data][name]", itemName);
  params.append("line_items[0][price_data][unit_amount]", String(amount));
  params.append("line_items[0][quantity]", "1");
  params.append("restrictions[completed_sessions][limit]", "1");
  params.append("after_completion[type]", "redirect");
  params.append("after_completion[redirect][url]", `${SITE_ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}`);
  Object.entries(meta).forEach(([k, val]) => {
    params.append(`metadata[${k}]`, String(val).slice(0, 500));
    params.append(`payment_intent_data[metadata][${k}]`, String(val).slice(0, 500));
  });

  const r = await fetch("https://api.stripe.com/v1/payment_links", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await r.json();
  if (!r.ok) fail("Stripe 錯誤：" + ((data.error && data.error.message) || r.status));

  console.log("✅ 付款連結（Payment Link，付款前一直有效、付一次即失效）：");
  console.log(data.url);
  console.log("");
  console.log("payment link id：" + data.id + "（要提前作廢：POST /v1/payment_links/" + data.id + " active=false）");
})().catch((e) => fail(e.message));
