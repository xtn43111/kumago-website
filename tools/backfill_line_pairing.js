#!/usr/bin/env node
/* KUMAGO — 把反查到的 LINE userId 回寫行事曆（到期＋配送事件）。
 *
 * 讀 .tmp/userid_matches.json（tools/match_line_userids.js 產出），只取
 * auto（唯一高信心）者，往該客人的【到期】與配送事件 description 尾端補：
 *
 *   ── LINE ──
 *   顯示名：<alias 表 msg_count 最高的顯示名>
 *   userId：Uxxxx
 *   語言：zh|ja|en（customer_pref；查無 → zh）
 *
 * 格式對齊 api/pair-line-order.js 的 pairEvent，之後 30 天續租通知直接從
 * 到期事件 description 讀 userId/語言。冪等：description 已含該 userId 就跳過。
 *
 *   node tools/backfill_line_pairing.js            # dry-run（只印會做什麼）
 *   node tools/backfill_line_pairing.js --apply    # 實際寫入
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

async function main() {
  const apply = process.argv.includes("--apply");
  const matches = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".tmp", "userid_matches.json"), "utf8")
  );
  const targets = matches.filter((m) => m.auto);
  console.log(`${apply ? "APPLY" : "DRY-RUN"}：唯一高信心 ${targets.length} 位\n`);

  let patched = 0, skipped = 0, failed = 0;
  for (const m of targets) {
    const uid = m.auto;
    const aliasRows = q(
      `SELECT display_name, msg_count FROM customer_alias_index
       WHERE imported_user_id='${esc(uid)}' ORDER BY msg_count DESC LIMIT 1`
    );
    const display = aliasRows.length ? aliasRows[0].display_name : (m.lineName || m.name);
    const prefRows = q(`SELECT lang FROM customer_pref WHERE customer_id='${esc(uid)}'`);
    const lang = prefRows.length ? prefRows[0].lang : "zh";
    const block = `\n\n── LINE ──\n顯示名：${display}\nuserId：${uid}\n語言：${lang}`;

    for (const evId of [m.expiryEventId, m.deliveryEventId].filter(Boolean)) {
      try {
        const ev = await getEvent(evId);
        if (!ev) { console.log(`  ⚠️ 事件不存在 ${m.name} ${evId}`); failed++; continue; }
        const desc = ev.description || "";
        if (desc.includes(uid)) { skipped++; continue; }
        if (apply) {
          await patchEvent(evId, { description: desc + block });
        }
        console.log(`  ${apply ? "✅" : "會寫"} ${m.name} → ${display}（${lang}）@ ${String(ev.summary).slice(0, 40)}`);
        patched++;
      } catch (e) {
        console.log(`  ❌ ${m.name} ${evId}: ${e.message}`);
        failed++;
      }
    }
  }
  console.log(`\n${apply ? "已寫入" : "將寫入"} ${patched} 事件／已含跳過 ${skipped}／失敗 ${failed}`);
  if (!apply) console.log("確認無誤後加 --apply 實際寫入。");
}

main().catch((e) => { console.error("失敗：", e.message); process.exit(1); });
