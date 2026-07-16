#!/usr/bin/env node
/* KUMAGO — 批次補建【到期】事件：給每筆沒有明確到期事件的租賃配送單，
 * 照 SOP（workflows/expiry_pickup_events.md）建全天到期事件。
 *
 *   node tools/backfill_expiry_events.js            # dry-run：列出會建哪些
 *   node tools/backfill_expiry_events.js --apply    # 實際建立
 *
 * 規則：
 * - 到期日：配送單「租期」行的結束日優先，否則 配送日＋方案月數 推估。
 * - 已過期超過 120 天（OVERDUE_WINDOW）不建，只列出請人工確認是否早已回收。
 * - 品項：套組基底（A=冰箱洗衣機微波爐；B=+單人床架床墊；C=+加大床架床墊）
 *   ＋配送單「加購」行。配送單有客製字樣（換/不要/升級…）→ 標 ⚠️ 請人工核。
 * - 冪等：事件 id = sha1("expiry-" + 配送事件id)，重跑不會重複建。
 * - 標題絕不含「回收」二字（會被 classify 當回收事件）。
 */
"use strict";
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(".env");
loadEnv(".env.local");

const { listEvents, insertEvent, jstToday } = require("../lib/gcal");
const { classify, planMonths, addMonths } = require("../lib/recovery");

const OVERDUE_CUTOFF_DAYS = 120; // 同 lib/recovery.js OVERDUE_WINDOW
const BASE_ITEMS = {
  A: "冰箱、洗衣機、微波爐",
  B: "冰箱、洗衣機、微波爐、單人床架、床墊（寬100cm）",
  C: "冰箱、洗衣機、微波爐、單人加大床架、床墊（寬120cm）",
};
const SPECIAL_RE = /換成|換掉|不要|升級|降級|加送|贈送|改成|客製|沒有床|無床/;

function addDays(iso, n) {
  return new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}
function intersects(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}
function rentalRangeFromDesc(text) {
  const m = (text || "").match(
    /租期[：: ]*\s*(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})\s*[-–~～到至]\s*(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/
  );
  if (!m) return null;
  const p = (n) => String(n).padStart(2, "0");
  return { start: `${m[1]}-${p(m[2])}-${p(m[3])}`, end: `${m[4]}-${p(m[5])}-${p(m[6])}` };
}
function grab(desc, re) {
  const m = (desc || "").match(re);
  return m ? m[1].trim() : "";
}

/* 標題：配送標題去掉時段/配送/金額/（無LINE），前面加【到期】 */
function expiryTitle(dvTitle) {
  const core = String(dvTitle || "")
    .replace(/^⚠️\s*/, "")
    .replace(/【(上午|下午|早上|晚上|全天|整天)】/g, " ")
    .replace(/入住配送|配送/g, " ")
    .replace(/[¥￥+]\s?[\d,]+/g, " ")
    .replace(/（無LINE）/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `【到期】${core}`;
}

function buildExpiryEvent(g, expected, base) {
  const allDesc = g.items.map((i) => i.desc).join("\n");
  const allText = g.items.map((i) => i.title + "\n" + i.desc).join("\n");

  const letterM = allText.match(/([ABCabc])\s*(?:方案|套組|套组|套餐|セット|set)/);
  const letter = letterM ? letterM[1].toUpperCase() : "";
  const addons =
    grab(allDesc, /【加購】(.+)/) || grab(allDesc, /^加購[：:]\s*(.+)$/m) || "";
  const addonsClean = addons.replace(/（無）|\(無\)/g, "").replace(/[¥￥]\s?[\d,]+/g, "").replace(/\s+/g, " ").trim();
  let items = letter ? BASE_ITEMS[letter] : "";
  if (addonsClean) items = items ? `${items}、${addonsClean}` : addonsClean;
  if (!items) items = "（自動彙整不出品項，請人工補）";

  const special = SPECIAL_RE.test(allText);
  const range = g.items.map((i) => rentalRangeFromDesc(i.desc)).find(Boolean);
  const email = (allDesc.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [""])[0];
  const phone = (allDesc.match(/(?<!\d)(0\d{9,10}|0\d{1,3}-\d{2,4}-\d{3,4})(?!\d)/) || [""])[0];
  const addr = grab(allDesc, /^地址[：:]\s*(.+)$/m);
  const map = (allDesc.match(/📍 Google 地圖：(\S+)/) || [])[1] ||
    (addr ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(addr) : "");
  const planText = grab(allDesc, /【方案】(.+)/) || grab(allDesc, /^方案[：:]\s*(.+)$/m) || "";

  const title = expiryTitle(base.title) + (special ? " ⚠️品項有客製待核" : "");
  const descLines = [
    `租期到期 ${expiryTitle(base.title).replace("【到期】", "")}`,
    email ? `Email：${email}` : null,
    phone ? `聯絡：${phone}` : null,
    planText ? `方案：${planText}` : null,
    `品項：${items}`,
    range ? `租期：${range.start.replace(/-/g, "/")} - ${range.end.replace(/-/g, "/")}`
          : `租期：配送 ${base.date} 起（到期日為推估）`,
    addr ? `地址：${addr}` : null,
    map ? `📍 Google 地圖：${map}` : null,
    "",
    `（本事件由 backfill_expiry_events.js 自動彙整自配送單，回收前請核對配送單備註${special ? "——⚠️有客製字樣" : ""}）`,
  ].filter((l) => l !== null);

  return {
    summary: title,
    description: descLines.join("\n"),
    start: { date: expected },
    end: { date: addDays(expected, 1) },
    reminders: { useDefault: false, overrides: [] },
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const today = jstToday();
  const cutoff = addDays(today, -OVERDUE_CUTOFF_DAYS);
  const timeMin = addDays(today, -800) + "T00:00:00+09:00";
  const timeMax = addDays(today, 800) + "T00:00:00+09:00";
  const events = await listEvents(timeMin, timeMax);
  const { deliveries, expiries, recoveries } = classify(events);

  // 聚合同一客人的多筆配送
  const groups = [];
  for (const dv of deliveries) {
    if (!dv.date || !dv.names.size) continue;
    const g = groups.find((x) => intersects(x.names, dv.names));
    if (g) { g.items.push(dv); for (const n of dv.names) g.names.add(n); }
    else groups.push({ names: new Set(dv.names), items: [dv] });
  }

  let created = 0, skippedHasExpiry = 0, skippedOld = [], skippedDone = 0, dup = 0;
  const plans = [];
  for (const g of groups) {
    const base = g.items.slice().sort((a, b) => a.date.localeCompare(b.date))[0];
    if (expiries.some((e) => intersects(g.names, e.names))) { skippedHasExpiry++; continue; }
    const done = recoveries.filter((r) => intersects(g.names, r.names))
      .some((r) => /回收完畢|已回收|已完成/.test(r.title));
    if (done) { skippedDone++; continue; }

    const range = g.items.map((i) => rentalRangeFromDesc(i.desc)).find(Boolean);
    const expected = (range && range.end) ||
      addMonths(base.date, planMonths(g.items.map((i) => i.title + i.desc).join(" ")));
    if (expected < cutoff) { skippedOld.push(`${expected}  ${base.title}`); continue; }

    const ev = buildExpiryEvent(g, expected, base);
    const eid = crypto.createHash("sha1").update(`expiry-${base.id}`).digest("hex");
    plans.push({ ev, eid, expected });
  }

  plans.sort((a, b) => a.expected.localeCompare(b.expected));
  for (const p of plans) {
    console.log(`${p.expected}  ${p.ev.summary}`);
    if (process.argv.includes("--verbose")) console.log(p.ev.description.split("\n").map((l) => "    " + l).join("\n"));
    if (apply) {
      const r = await insertEvent(p.ev, p.eid);
      if (r.duplicate) { dup++; console.log("    ↩️ 已存在（略過）"); }
      else { created++; console.log("    ✅ 已建立"); }
    }
  }

  console.log(`\n共 ${plans.length} 筆待建｜已有到期事件略過 ${skippedHasExpiry}｜已標回收完畢略過 ${skippedDone}`);
  if (skippedOld.length) {
    console.log(`\n🕳 已過期逾 ${OVERDUE_CUTOFF_DAYS} 天不補建（請人工確認是否早已回收，${skippedOld.length} 筆）：`);
    for (const s of skippedOld) console.log("  " + s);
  }
  if (apply) console.log(`\n建立 ${created} 筆，重複略過 ${dup} 筆`);
  else console.log("\n（dry-run，加 --apply 才會建立；--verbose 看完整內文）");
}

main().catch((e) => { console.error("失敗：", e.message); process.exit(1); });
