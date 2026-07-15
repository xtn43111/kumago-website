#!/usr/bin/env node
/* KUMAGO — 清查：每筆租賃配送單有沒有對應的明確【到期】/回收事件。
 *
 * 防漏報表（lib/recovery.js）對沒有到期事件的配送單會自動推估（🔸），
 * 所以不會完全漏掉；但 SOP（workflows/expiry_pickup_events.md）要求
 * 明確到期事件要含品項明細，現場才能照著收。此工具列出：
 *   1. 只有推估、沒有明確【到期】事件的租賃單
 *   2. 明確到期事件的日期 vs 配送單「租期」行不一致的
 *
 *   node tools/audit_expiry_events.js
 *
 * 唯讀，不改任何事件。Auth 同 lib/gcal.js（讀專案根目錄 .env）。
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

function intersects(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/* 配送單內文的「租期：2026/04/16 - 2027/04/15」行 → 結束日 ISO（沒有回 null）*/
function rentalEndFromDesc(text) {
  const m = (text || "").match(
    /租期[：: ]*\s*(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})\s*[-–~～到至]\s*(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/
  );
  if (!m) return null;
  return `${m[4]}-${String(m[5]).padStart(2, "0")}-${String(m[6]).padStart(2, "0")}`;
}

async function main() {
  const today = jstToday();
  const timeMin = addDays(today, -800) + "T00:00:00+09:00";
  const timeMax = addDays(today, 800) + "T00:00:00+09:00";
  const events = await listEvents(timeMin, timeMax);
  const { deliveries, expiries, recoveries } = classify(events);

  console.log(`掃描 ${events.length} 事件：配送 ${deliveries.length}／到期 ${expiries.length}／回收 ${recoveries.length}\n`);

  // 同一客人可能有多筆配送事件（自動+手動）：以名字碎片聚合
  const groups = [];
  for (const dv of deliveries) {
    if (!dv.date || !dv.names.size) {
      if (!dv.names.size) console.log(`⚠️ 抽不出名字碎片，無法比對：${dv.date} ${dv.title}`);
      continue;
    }
    const g = groups.find((x) => intersects(x.names, dv.names));
    if (g) { g.items.push(dv); for (const n of dv.names) g.names.add(n); }
    else groups.push({ names: new Set(dv.names), items: [dv] });
  }

  const missing = [], mismatch = [], okList = [], closed = [];
  for (const g of groups) {
    // 取最早配送日當基準；租期行有明確結束日就用它，否則配送日+方案月數
    const base = g.items.slice().sort((a, b) => a.date.localeCompare(b.date))[0];
    const all = g.items.map((i) => i.title + "\n" + i.desc).join("\n");
    const descEnd = g.items.map((i) => rentalEndFromDesc(i.desc)).find(Boolean) || null;
    const expected = descEnd || addMonths(base.date, planMonths(all));

    const ex = expiries.filter((e) => intersects(g.names, e.names));
    const rec = recoveries.filter((r) => intersects(g.names, r.names));
    const done = rec.some((r) => DONE_RE.test(r.title)) || g.items.some((i) => DONE_RE.test(i.title));

    const label = `${base.title}（配送 ${base.date}）`;
    if (done) { closed.push({ label, expected }); continue; }
    if (!ex.length) {
      missing.push({ label, expected, hasRecovery: rec.length > 0, descEnd: !!descEnd });
    } else {
      const exDates = ex.map((e) => e.date).filter(Boolean);
      const hit = exDates.some((d) => Math.abs((Date.parse(d) - Date.parse(expected)) / 86400000) <= 3);
      if (!hit) mismatch.push({ label, expected, exTitle: ex[0].title, exDate: exDates[0] || "?" });
      else okList.push({ label, expected });
    }
  }

  const byDate = (a, b) => (a.expected || "").localeCompare(b.expected || "");
  missing.sort(byDate); mismatch.sort(byDate);

  console.log(`❌ 沒有明確【到期】事件（${missing.length}）——防漏報表僅以🔸推估涵蓋：`);
  for (const m of missing) {
    const tags = [m.descEnd ? "租期行" : "推估", m.hasRecovery ? "已有回收事件" : null].filter(Boolean);
    console.log(`  到期 ${m.expected}（${tags.join("・")}）  ${m.label}`);
  }

  if (mismatch.length) {
    console.log(`\n⚠️ 有到期事件但日期對不上（差>3天，${mismatch.length}）：`);
    for (const m of mismatch) {
      console.log(`  預期 ${m.expected} vs 事件 ${m.exDate}「${m.exTitle}」  ${m.label}`);
    }
  }

  console.log(`\n✅ 有明確到期事件且日期吻合：${okList.length} 筆`);
  console.log(`✅ 已標回收完畢（結案）：${closed.length} 筆`);
}

main().catch((e) => { console.error("失敗：", e.message); process.exit(1); });
