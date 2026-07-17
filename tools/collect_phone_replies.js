#!/usr/bin/env node
/* KUMAGO — 收電話回覆、登記行事曆。
 *
 * 讀 .tmp/phone_requests.json（tools/request_phone_via_line.js --send 的發送
 * 記錄），掃 qa.db 該客人發送時間之後的 in 訊息，抽出電話號碼，寫進該客人的
 * 【到期】與配送事件 description（「電話：xxx（LINE 回覆登記）」）。
 *
 *   node tools/collect_phone_replies.js            # dry-run：列誰回了什麼
 *   node tools/collect_phone_replies.js --apply    # 寫入行事曆
 *
 * 已登記過（description 已有電話行）自動跳過，可重複跑。
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

const { getEvent, patchEvent } = require("../lib/gcal");

const DB = "/Users/peter/projects/line-smart-cs/data/qa.db";
function q(sql) {
  const out = execFileSync("sqlite3", ["-json", `file:${DB}?mode=ro`, sql], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  }).trim();
  return out ? JSON.parse(out) : [];
}
const esc = (s) => String(s).replace(/'/g, "''");

/* 訊息文字 → 電話號碼（日本手機/市話或含國碼；8-15 碼）。找不到回 null。 */
function extractPhone(text) {
  const m = String(text || "").match(/(?:\+?\d[\d\-\s()（）]{6,}\d)/g);
  if (!m) return null;
  for (const cand of m) {
    const digits = cand.replace(/[^\d+]/g, "");
    if (/^(?:\+81|0)\d{8,10}$/.test(digits) || /^\+\d{10,14}$/.test(digits)) {
      return cand.trim().replace(/\s+/g, "");
    }
  }
  return null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const reqPath = path.join(ROOT, ".tmp", "phone_requests.json");
  if (!fs.existsSync(reqPath)) {
    console.error("沒有發送記錄（.tmp/phone_requests.json）——先跑 request_phone_via_line.js --send");
    process.exit(1);
  }
  const requests = JSON.parse(fs.readFileSync(reqPath, "utf8"));
  const found = [], waiting = [];

  for (const r of requests) {
    // qa.db created_at 是本地時間（datetime('now','localtime')）
    const sentLocal = new Date(r.sentAt).toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).replace("T", " ");
    const rows = q(
      `SELECT text, created_at FROM customer_message
       WHERE customer_id='${esc(r.userId)}' AND direction='in'
         AND created_at > '${esc(sentLocal)}'
       ORDER BY id ASC LIMIT 50`
    );
    let phone = null, evidence = null;
    for (const row of rows) {
      const p = extractPhone(row.text);
      if (p) { phone = p; evidence = row; break; }
    }
    if (!phone) { waiting.push(r); continue; }
    found.push({ ...r, phone, evidence: evidence.text.slice(0, 60), at: evidence.created_at });
  }

  console.log(`${apply ? "APPLY" : "DRY-RUN"}：已回覆電話 ${found.length}／未回覆 ${waiting.length}\n`);
  let patched = 0;
  for (const f of found) {
    console.log(`  📞 ${f.name} → ${f.phone}（${f.at}「${f.evidence.replace(/\n/g, " ")}」）`);
    for (const evId of [f.expiryEventId, f.deliveryEventId].filter(Boolean)) {
      try {
        const ev = await getEvent(evId);
        if (!ev) continue;
        const desc = ev.description || "";
        if (/^電話[：:]/m.test(desc) || desc.includes(f.phone)) continue;
        if (apply) {
          await patchEvent(evId, { description: desc + `\n電話：${f.phone}（LINE 回覆登記）` });
        }
        patched++;
      } catch (e) {
        console.log(`     ❌ 寫入失敗 ${evId}: ${e.message}`);
      }
    }
  }
  console.log(`\n${apply ? "已寫入" : "將寫入"} ${patched} 個事件。`);
  if (waiting.length) {
    console.log(`\n⏳ 尚未回覆（${waiting.length}）：` + waiting.map((w) => w.name).join("、"));
  }
  if (!apply && found.length) console.log("\n確認無誤後加 --apply 寫入行事曆。");
}

main().catch((e) => { console.error("失敗：", e.message); process.exit(1); });
