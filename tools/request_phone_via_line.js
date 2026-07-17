#!/usr/bin/env node
/* KUMAGO — 年租造冊：用官方 LINE 向缺電話的客人補要電話。
 *
 * 對 roster（tools/scan_annual_customers.js 產出）中「缺電話且有 LINE userId」
 * 的客人，push 一則請他回覆手機號碼的訊息（語言依 qa.db customer_pref）。
 *
 *   node tools/request_phone_via_line.js           # 預覽名單＋訊息（不發送）
 *   node tools/request_phone_via_line.js --send    # 實際發送（真訊息，發前要 Peter 放行）
 *
 * --send 時同步：
 *   1. INSERT qa.db customer_message（direction=out/processed=1/source=live），
 *      客服歷史才完整（同 Diya 案慣例）。
 *   2. 發送記錄寫 .tmp/phone_requests.json，供 tools/collect_phone_replies.js
 *      之後掃回覆、登記行事曆。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

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

const { sendLinePush } = require("../lib/line_push");

const DB = "/Users/peter/projects/line-smart-cs/data/qa.db";
function q(sql, write) {
  const uri = write ? DB : `file:${DB}?mode=ro`;
  const out = execFileSync("sqlite3", ["-json", uri, sql], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  }).trim();
  return out ? JSON.parse(out) : [];
}
const esc = (s) => String(s).replace(/'/g, "''");

const MSG = {
  zh: "🐻 KUMAGO 您好！我們正在更新年租客戶名冊，想跟您登記聯絡電話（僅用於配送與回收的聯繫）。\n\n麻煩直接在此回覆您的手機號碼（例如：080-1234-5678），謝謝您！🙏",
  ja: "🐻 KUMAGOです。年間レンタルのお客様名簿を更新しております。お手数ですが、携帯電話番号（例：080-1234-5678）をこのトークにご返信いただけますか？（配送・回収のご連絡のみに使用します）よろしくお願いいたします🙏",
  en: "🐻 Hello from KUMAGO! We're updating our annual-rental customer records. Could you reply here with your phone number (e.g. 080-1234-5678)? It will only be used to contact you about delivery and pick-up. Thank you! 🙏",
};

async function main() {
  const send = process.argv.includes("--send");
  const roster = JSON.parse(fs.readFileSync(path.join(ROOT, ".tmp", "annual_roster.json"), "utf8"));
  const targets = roster.filter((r) => !r.phone && r.lineUserId);

  console.log(`${send ? "SEND" : "預覽"}：缺電話且可 LINE 推播 ${targets.length} 位\n`);
  for (const t of targets) {
    const pref = q(`SELECT lang FROM customer_pref WHERE customer_id='${esc(t.lineUserId)}'`);
    t.lang = pref.length ? pref[0].lang : "zh";
    if (!MSG[t.lang]) t.lang = "zh";
    console.log(`  ${t.name}（LINE: ${t.lineName || "?"}／${t.lang}）到期 ${t.expiryDate}`);
  }
  console.log("\n── 訊息內容（zh）──\n" + MSG.zh + "\n");
  if (!send) {
    console.log("（預覽模式：未發送。確認後加 --send 實發——發送前需 Peter 放行。）");
    return;
  }

  const log = [];
  let okCount = 0, failCount = 0;
  for (const t of targets) {
    try {
      const r = await sendLinePush(t.lineUserId, [{ type: "text", text: MSG[t.lang] }]);
      if (!r.ok) throw new Error("skipped:" + r.reason);
      q(`INSERT INTO customer_message (customer_id, text, direction, processed, source)
         VALUES ('${esc(t.lineUserId)}', '${esc(MSG[t.lang])}', 'out', 1, 'live')`, true);
      log.push({
        userId: t.lineUserId, name: t.name, lang: t.lang,
        expiryEventId: t.expiryEventId, deliveryEventId: t.deliveryEventId,
        sentAt: new Date().toISOString(),
      });
      okCount++;
      console.log(`  ✅ ${t.name}`);
      await new Promise((r2) => setTimeout(r2, 300));
    } catch (e) {
      failCount++;
      console.log(`  ❌ ${t.name}: ${e.message}`);
    }
  }
  const outPath = path.join(ROOT, ".tmp", "phone_requests.json");
  const prev = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : [];
  fs.writeFileSync(outPath, JSON.stringify(prev.concat(log), null, 2));
  console.log(`\n發送 ${okCount} 成功／${failCount} 失敗。記錄已寫 .tmp/phone_requests.json`);
  console.log("之後跑 node tools/collect_phone_replies.js 收回覆、登記行事曆。");
}

main().catch((e) => { console.error("失敗：", e.message); process.exit(1); });
