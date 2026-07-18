#!/usr/bin/env node
/* KUMAGO — 產生「期滿回收處理費」Stripe 刷卡連結（老闆專用 CLI，不開公開端點）。
 *
 * 產生邏輯共用 lib/recovery_link.js（Telegram 的「/回收連結」指令也用同一份）。
 * metadata 帶 kumago_recovery=1，付款後 api/stripe-webhook.js 走
 * lib/recovery_payment.js：建【回收（費用已付）】行事曆事件、有 line_user_id
 * 就 LINE 推播客人付款確認、Telegram 通知老闆。
 *
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
 *     [--session] [--expires "2026-07-19T12:00"] [--dry-run]
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

const { createRecoveryLink, buildRecoveryMeta, itemNameFor, isRealDate } =
  require(path.join(ROOT, "lib", "recovery_link.js"));

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

  const v = {
    name: a.name,
    amount,
    date: a.date,
    address: a.address,
    items: a.items || "",
    elevator: a.elevator === "yes" || a.elevator === "no" ? a.elevator : "",
    phone: a.phone || "",
    lineUserId: a.lineUserId || "",
    lineName: a.lineName || "",
    note: a.note || "",
    lang: a.lang || "zh",
  };
  const meta = buildRecoveryMeta(v);

  console.log("── 回收處理費 ──");
  console.log(`客人：${v.name}${v.phone ? "　" + v.phone : ""}`);
  console.log(`項目：${itemNameFor(v)}`);
  console.log(`金額：¥${amount.toLocaleString("ja-JP")}`);
  console.log(`回收日：${v.date}`);
  console.log(`收取地址：${v.address}${v.elevator ? `（${v.elevator === "yes" ? "有" : "無"}電梯）` : ""}`);
  if (v.items) console.log(`品項：${v.items}`);
  if (expiresAt) console.log(`付款期限：${a.expires}（JST）`);
  if (!meta.line_user_id) console.log("（未給 line-user-id：付款後不推 LINE 確認，老闆 Telegram 照通知）");
  console.log("");

  if (a.dryRun) {
    console.log("（--dry-run：未呼叫 Stripe）");
    console.log(JSON.stringify(meta, null, 2));
    return;
  }

  const r = await createRecoveryLink(v, secret, { session: !!a.session, expiresAt });

  if (r.mode === "session") {
    console.log(`✅ 付款連結（${expiresAt ? "到期限前有效" : "24 小時內有效"}）：`);
    console.log(r.url);
    console.log("");
    console.log("session id：" + r.id);
  } else {
    console.log("✅ 付款連結（Payment Link，付款前一直有效、付一次即失效）：");
    console.log(r.url);
    console.log("");
    console.log("payment link id：" + r.id + "（要提前作廢：POST /v1/payment_links/" + r.id + " active=false）");
  }
})().catch((e) => fail(e.message));
