#!/usr/bin/env node
/* KUMAGO — 把「Square 有收款、行事曆查無」的交易補建成行事曆事件。
 *
 * 用法：
 *   node tools/backfill_square_events.js            # dry-run，只印出要建什麼
 *   node tools/backfill_square_events.js --apply    # 實際寫入 KUMAGO 行事曆
 *
 * 安全設計：
 *  - 事件 id = sha1("square-" + Transaction ID)，冪等；重跑不會建重複事件（409 視為成功）。
 *  - 標題一律帶「(Square補記)」，之後在行事曆與清單裡都能一眼認出是對帳補的，不是原始紀錄。
 *  - 標題絕不含「回收」二字——lib/recovery.js 的 classify 會把它抓去當回收案件。
 *  - 全天事件，日期 = Square 刷卡日（不是配送日，因為配送日不可考）。
 *  - 要補哪些筆寫在 決算/FY2025-07_2026-06/補記清單_Square.json，人工核可後才跑 --apply。
 */
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(".env");
loadEnv(".env.local");

const { insertEvent, calendarId, isConfigured } = require("../lib/gcal");

const LIST_PATH = path.join(ROOT, "決算", "FY2025-07_2026-06", "補記清單_Square.json");
const APPLY = process.argv.includes("--apply");

const yen = (n) => "¥" + Number(n).toLocaleString("ja-JP");

/* 依 Square 品項描述決定標題動詞，讓清單分類能落到正確類別。
 * 沒有品項資訊的（Square 顯示「任意の金額」）標「收款」＋待確認。 */
function titleFor(t) {
  const d = t.desc || "";
  const who = t.cust || "（未留名）";
  if (/引越|搬家/.test(d)) return `${who} 搬家 ${yen(t.amount)}（Square補記）`;
  if (/セット|set|プラン|方案|レンタル|套組/i.test(d)) return `${who} 配送 ${yen(t.amount)}（Square補記）`;
  if (t.note && /加購|追加|品項/.test(t.note)) return `${who} 加購 ${yen(t.amount)}（Square補記）`;
  if (d && d !== "Custom Amount" && !/任意の金額/.test(d)) return `${who} 配送 ${yen(t.amount)}（Square補記）`;
  return `${who} 收款 ${yen(t.amount)}（Square補記・品項待確認）`;
}

function buildEvent(t) {
  const next = new Date(new Date(t.date + "T00:00:00Z").getTime() + 86400000).toISOString().slice(0, 10);
  const desc = [
    "🐻 KUMAGO 決算對帳補記（來源：Square 交易明細，非現場紀錄）",
    "",
    `刷卡日：${t.date}`,
    `實收金額：${yen(t.amount)}`,
    t.fees != null ? `Square 手数料：${yen(t.fees)}` : null,
    t.depDate ? `入金日：${t.depDate}` : null,
    t.source ? `收款方式：${t.source}${t.brand ? "／" + t.brand : ""}` : null,
    "",
    `Square 品項描述：${t.desc || "（Square 未帶品項，顯示「任意の金額」）"}`,
    t.note ? `對帳註記：${t.note}` : null,
    "",
    `Square Transaction ID：${t.txId}`,
    "",
    "⚠️ 這筆當初沒有留下行事曆紀錄，是 2026-08 年度決算對帳時依 Square 補建的。",
    "配送日、地址、品項明細若需要，請回查 LINE 對話或 Square 後台。",
  ].filter((l) => l !== null).join("\n");

  return {
    summary: titleFor(t),
    description: desc,
    start: { date: t.date },
    end: { date: next },
    reminders: { useDefault: false, overrides: [] },
  };
}

(async () => {
  if (!fs.existsSync(LIST_PATH)) {
    console.error(`找不到補記清單：${LIST_PATH}\n請先由 tools/reconcile_square.js 產生並人工核可。`);
    process.exit(1);
  }
  const list = JSON.parse(fs.readFileSync(LIST_PATH, "utf8"));
  const items = list.items || [];
  if (!items.length) { console.log("補記清單是空的，沒有要建的事件。"); return; }

  // 冪等 id 來自 txId。少了它或有重複，所有事件會撞同一個 id，寫入時第 2 筆起
  // 全部回 409 被誤判成「已存在」——實際只建了 1 筆。這裡直接擋掉。
  const ids = items.map((t) => t.txId);
  const bad = ids.filter((x) => !x);
  const dups = ids.filter((x, i) => x && ids.indexOf(x) !== i);
  if (bad.length || dups.length) {
    console.error(`補記清單有問題，中止：缺 txId ${bad.length} 筆／重複 txId ${dups.length} 筆`);
    console.error("請重跑 tools/reconcile_square.js 重新產生清單。");
    process.exit(1);
  }

  console.log(`模式：${APPLY ? "★ 實際寫入" : "dry-run（不寫入，加 --apply 才會寫）"}`);
  console.log(`目標行事曆：${calendarId()}`);
  console.log(`待補記：${items.length} 筆，合計 ${yen(items.reduce((a, t) => a + t.amount, 0))}\n`);

  let created = 0, dup = 0, failed = 0;
  for (const t of items) {
    const ev = buildEvent(t);
    const id = crypto.createHash("sha1").update("square-" + t.txId).digest("hex");
    console.log(`${t.date}  ${yen(t.amount).padStart(10)}  ${ev.summary}`);
    if (!APPLY) continue;
    try {
      const r = await insertEvent(ev, id);
      if (r.duplicate) { dup++; console.log("    → 已存在，略過"); }
      else { created++; console.log(`    → 已建立 ${r.htmlLink || id}`); }
    } catch (e) {
      failed++;
      console.log(`    → 失敗：${e.message}`);
    }
  }

  if (APPLY) {
    console.log(`\n新建 ${created}／已存在 ${dup}／失敗 ${failed}`);
    console.log("接著重跑：node tools/export_tax_ledger.js 2025-07-01 2026-06-30");
  } else {
    console.log("\n以上為預覽。確認無誤後執行：node tools/backfill_square_events.js --apply");
  }
  if (!isConfigured()) console.log("⚠️ 行事曆 OAuth 未設定，--apply 會失敗。");
})().catch((e) => { console.error(e.message); process.exit(1); });
