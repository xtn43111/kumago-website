#!/usr/bin/env node
/* KUMAGO — 年租方案造冊掃描（唯讀）。
 *
 * 列出所有「未結案」年租客人，逐人整理：
 *   到期日／到期事件id／電話／email／LINE userId／LINE 顯示名
 * 並分區標出「缺電話」（要用官方 LINE 補要）與「缺 LINE userId」（推播不到）。
 *
 *   node tools/scan_annual_customers.js            # 人類可讀報告
 *   node tools/scan_annual_customers.js --json     # 只印 JSON
 *
 * 同時把完整 JSON 寫到 .tmp/annual_roster.json 供後續工具（補要電話、
 * 30天續租通知 backfill）使用。唯讀，不改任何事件。
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

const { listEvents, jstToday } = require("../lib/gcal");
const { classify, planMonths, addMonths, DONE_RE } = require("../lib/recovery");

function addDays(iso, n) {
  return new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}
const CJK_FRAG = /^[一-鿿]{2,4}$/;
function intersects(a, b) {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      if (CJK_FRAG.test(x) && CJK_FRAG.test(y) && (x.includes(y) || y.includes(x))) return true;
    }
  }
  return false;
}

/* 說明文字 → 電話。只認「聯絡/電話/TEL」開頭的行，避免把郵遞區號/金額當電話。 */
function phoneFromDesc(text) {
  for (const line of (text || "").split("\n")) {
    const m = line.match(/^\s*(?:聯絡|電話|连络|TEL|Tel|Phone)[：: ]\s*(.+)$/i);
    if (!m) continue;
    // 去掉尾註（「電話：xxx（LINE 回覆登記）」「xxx（Stripe 結帳）」等）再驗數字
    const val = m[1].trim().replace(/[（(][^）)]*[）)]\s*$/, "").trim();
    if (val.includes("@")) continue; // 聯絡欄放的是 email
    const digits = val.replace(/[\s\-()（）．.]/g, "");
    if (/^\+?\d{8,15}$/.test(digits)) return val;
  }
  return null;
}
function emailFromDesc(text) {
  const m = (text || "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0] : null;
}
function userIdFromDesc(text) {
  const m = (text || "").match(/userId[：:]\s*(U[0-9a-f]{32})/i);
  return m ? m[1] : null;
}
function lineNameFrom(title, desc) {
  let m = (desc || "").match(/^\s*(?:LINE 名稱|顯示名)[：:]\s*(.+)$/m);
  if (m) return m[1].trim();
  m = (title || "").match(/[（(]LINE:?\s*([^）)]+)[）)]/);
  if (m) return m[1].trim();
  return null;
}

async function main() {
  const jsonOnly = process.argv.includes("--json");
  const today = jstToday();
  const timeMin = addDays(today, -800) + "T00:00:00+09:00";
  const timeMax = addDays(today, 800) + "T00:00:00+09:00";
  const events = await listEvents(timeMin, timeMax);
  const { deliveries, expiries, recoveries } = classify(events);

  // 以名字碎片聚合同一客人（同 audit_expiry_events.js）
  const groups = [];
  for (const dv of deliveries) {
    if (!dv.date || !dv.names.size) continue;
    const g = groups.find((x) => intersects(x.names, dv.names));
    if (g) { g.items.push(dv); for (const n of dv.names) g.names.add(n); }
    else groups.push({ names: new Set(dv.names), items: [dv] });
  }

  const roster = [];
  for (const g of groups) {
    const base = g.items.slice().sort((a, b) => a.date.localeCompare(b.date))[0];
    const ex = expiries.filter((e) => intersects(g.names, e.names));
    const rec = recoveries.filter((r) => intersects(g.names, r.names));
    const closed =
      rec.some((r) => DONE_RE.test(r.title)) ||
      g.items.some((i) => DONE_RE.test(i.title)) ||
      ex.some((e) => DONE_RE.test(e.title));
    if (closed) continue;

    const all = [...g.items, ...ex, ...rec];
    const allText = all.map((i) => i.title + "\n" + i.desc).join("\n");
    const exSorted = ex.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const expiry = exSorted[0] || null;
    const expiryDate = expiry ? expiry.date : addMonths(base.date, planMonths(base.title + "\n" + base.desc));

    // 名字：配送標題去掉標記、括號、方案/金額/租期字樣
    const name = base.title
      .replace(/【[^】]*】/g, "")
      .replace(/入住配送|配送|⚠️/g, "")
      .replace(/[（(][^）)]*[）)]/g, "")
      .replace(/[ABCabc]\s*(方案|套組|套餐|set).*/g, "")
      .replace(/¥[\d,]+/g, "")
      .replace(/租?(一年|兩年|二年|三年|半年)|年租|\d+\s*個月|加購|多筆|現場/g, "")
      .replace(/\s+/g, " ")
      .trim();

    roster.push({
      name: name || [...g.names][0],
      deliveryDate: base.date,
      deliveryEventId: base.id,
      expiryDate,
      expiryEventId: expiry ? expiry.id : null,
      expiryTitle: expiry ? expiry.title : null,
      phone: phoneFromDesc(allText),
      email: emailFromDesc(allText),
      lineUserId: userIdFromDesc(allText),
      lineName: lineNameFrom(all.map((i) => i.title).join("\n"), allText),
      titles: g.items.map((i) => i.title),
    });
  }

  roster.sort((a, b) => (a.expiryDate || "").localeCompare(b.expiryDate || ""));
  const outPath = path.join(ROOT, ".tmp", "annual_roster.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(roster, null, 2));

  if (jsonOnly) { console.log(JSON.stringify(roster, null, 2)); return; }

  const noPhone = roster.filter((r) => !r.phone);
  const noUid = roster.filter((r) => !r.lineUserId);
  console.log(`未結案年租客人 ${roster.length} 位（已寫 .tmp/annual_roster.json）\n`);
  console.log(`📵 缺電話（${noPhone.length}）：`);
  for (const r of noPhone) {
    const tags = [r.lineUserId ? "可LINE推播" : "❌無userId", r.email ? "有email" : null].filter(Boolean);
    console.log(`  到期 ${r.expiryDate}  ${r.name}（LINE: ${r.lineName || "?"}）  ${tags.join("・")}`);
  }
  console.log(`\n🆔 缺 LINE userId（${noUid.length}）——推播不到，要用 qa.db 補：`);
  for (const r of noUid) console.log(`  到期 ${r.expiryDate}  ${r.name}（LINE: ${r.lineName || "?"}）`);
  console.log(`\n✅ 電話齊全：${roster.length - noPhone.length} 位`);
}

main().catch((e) => { console.error("失敗：", e.message); process.exit(1); });
