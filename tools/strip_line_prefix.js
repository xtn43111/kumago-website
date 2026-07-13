#!/usr/bin/env node
/* KUMAGO — 一次性遷移：行事曆事件標題「（LINE: 顯示名）」改成「（顯示名）」。
 *
 * 2026-07-13 起新事件已直接寫（顯示名），此工具把既有事件改成同一格式。
 *
 *   node tools/strip_line_prefix.js            # dry-run：列出會改哪些
 *   node tools/strip_line_prefix.js --apply    # 實際 patch
 *
 * Auth 與 lib/gcal.js 共用 OAuth refresh-token 環境變數；讀專案根目錄 .env。
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
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(".env");
loadEnv(".env.local");

const { listEvents, patchEvent } = require("../lib/gcal");

// 「LINE:」前綴允許有無空白、全形/半形冒號。
// 注意：測試用不帶 g 的版本——帶 g 的 .test() 會記住 lastIndex，交錯漏抓。
const PREFIX_TEST = /（LINE[：:]\s*/;
const PREFIX_RE = /（LINE[：:]\s*/g;

async function main() {
  const apply = process.argv.includes("--apply");
  // 掃描窗與 pair-line-order 一致再放寬：過去 120 天～未來 600 天（年租回收在一年後）
  const now = Date.now();
  const timeMin = new Date(now - 400 * 86400 * 1000).toISOString();
  const timeMax = new Date(now + 600 * 86400 * 1000).toISOString();

  const events = await listEvents(timeMin, timeMax);
  const targets = events.filter((ev) => ev.summary && PREFIX_TEST.test(ev.summary));

  console.log(`掃描 ${events.length} 個事件，含「（LINE:」的有 ${targets.length} 個\n`);
  for (const ev of targets) {
    const newSummary = ev.summary.replace(PREFIX_RE, "（");
    PREFIX_RE.lastIndex = 0;
    const when = (ev.start && (ev.start.dateTime || ev.start.date)) || "?";
    console.log(`${when}  ${ev.summary}`);
    console.log(`      → ${newSummary}`);
    if (apply) {
      await patchEvent(ev.id, { summary: newSummary });
      console.log("      ✅ 已更新");
    }
  }
  if (!apply && targets.length) console.log("\n（dry-run，加 --apply 才會實際修改）");
}

main().catch((e) => {
  console.error("失敗：", e.message);
  process.exit(1);
});
