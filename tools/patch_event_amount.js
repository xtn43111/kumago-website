#!/usr/bin/env node
/* KUMAGO — 依 Square 實收金額修正行事曆事件上的金額（標題＋描述）。
 *
 * 用法：
 *   node tools/patch_event_amount.js <eventId> <舊金額> <新金額>            # dry-run
 *   node tools/patch_event_amount.js <eventId> <舊金額> <新金額> --apply    # 實際寫入
 *
 * 安全設計：
 *  - 先讀出事件，確認標題或描述真的含舊金額才動手；不含就中止（避免改錯事件）。
 *  - 只替換金額數字，其餘文字原樣保留。
 *  - 描述尾端加一行修正註記，寫明原金額與依據，之後看得出來被改過。
 *  - 用 patch（部分更新），不覆蓋整個事件資源，不動時間、地點、其他欄位。
 */
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(".env");
loadEnv(".env.local");

const { getEvent, patchEvent } = require("../lib/gcal");

const [eventId, oldRaw, newRaw] = process.argv.slice(2);
const APPLY = process.argv.includes("--apply");
if (!eventId || !oldRaw || !newRaw) {
  console.error("用法：node tools/patch_event_amount.js <eventId> <舊金額> <新金額> [--apply]");
  process.exit(1);
}
const oldN = parseInt(String(oldRaw).replace(/[^\d]/g, ""), 10);
const newN = parseInt(String(newRaw).replace(/[^\d]/g, ""), 10);

/* 同一個數字在文字裡可能寫成 28000 或 28,000，兩種都要換。 */
function replaceAmount(text, from, to) {
  if (!text) return { text, hits: 0 };
  let hits = 0;
  const forms = [from.toLocaleString("en-US"), String(from)];
  let out = text;
  for (const f of forms) {
    const re = new RegExp("(?<![0-9])" + f.replace(/,/g, ",") + "(?![0-9])", "g");
    out = out.replace(re, () => { hits++; return to.toLocaleString("en-US").length === String(to).length ? String(to) : (f.includes(",") ? to.toLocaleString("en-US") : String(to)); });
  }
  return { text: out, hits };
}

(async () => {
  const ev = await getEvent(eventId);
  if (!ev) { console.error("找不到事件：" + eventId); process.exit(1); }

  console.log("目前事件：");
  console.log("  標題：" + ev.summary);
  console.log("  日期：" + (ev.start.date || ev.start.dateTime || ""));
  console.log("  描述：\n" + (ev.description || "").split("\n").map((l) => "    " + l).join("\n"));

  const s = replaceAmount(ev.summary || "", oldN, newN);
  const d = replaceAmount(ev.description || "", oldN, newN);
  if (s.hits + d.hits === 0) {
    console.error(`\n中止：事件裡找不到金額 ${oldN}，不確定是不是要改的那筆。`);
    process.exit(1);
  }

  const stamp = `\n\n【${new Date().toISOString().slice(0, 10)} 決算修正】金額由 ¥${oldN.toLocaleString("ja-JP")} 更正為 ¥${newN.toLocaleString("ja-JP")}，依據 Square 實收金額。`;
  const patch = { summary: s.text, description: d.text + stamp };

  console.log(`\n將改為（命中 標題${s.hits} 處／描述${d.hits} 處）：`);
  console.log("  標題：" + patch.summary);
  console.log("  描述：\n" + patch.description.split("\n").map((l) => "    " + l).join("\n"));

  if (!APPLY) { console.log("\n以上為預覽。確認後加 --apply 實際寫入。"); return; }
  const r = await patchEvent(eventId, patch);
  console.log("\n✓ 已更新 " + (r.htmlLink || eventId));
})().catch((e) => { console.error(e.message); process.exit(1); });
