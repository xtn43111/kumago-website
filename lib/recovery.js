"use strict";
/*
 * 年租回收 防漏報表邏輯（純函式，方便本地測試，不碰網路）。
 *
 * 以「到期(【到期】…方案)」事件為錨——年租租約到期＝該回收的時機，到期事件本身
 * 就帶客人名＋方案。對每筆到期，用客人名字碎片比對「回收」事件是否已安排、是否
 * 已標「回收完畢」。輸出分區：已過期未安排 / 45天內需安排 / 已安排待標完畢 /
 * 更遠期（暫不需動作，只給數量）。
 *
 * 年租判斷（使用者規則）：標題/說明含 A/B/C方案、套餐、一年、兩年、或「租期」。
 * 狀態約定（記在行事曆事件上）：
 *   - 標題或說明含「回收完畢/已回收/已完成」→ 結案，從報表移除。
 *   - 有對應的回收事件、或含「已安排」→ 視為已安排（待標完畢）。
 */

const PLAN_RE = /[ABC]\s*方案|套餐|一年|兩年|二年|2\s*年|租期/;
const DONE_RE = /回收完畢|已回收|已完成|✅\s*完/;
const ARR_RE = /已安排|排定|✅\s*安排/;

function eventDate(e) {
  const s = e.start || {};
  const v = s.date || (s.dateTime || "").slice(0, 10);
  return v || null; // "YYYY-MM-DD"
}

// 從標題抽可比對的名字碎片：中文連續字、括號暱稱、羅馬拼音
function nameFrags(title) {
  const t = title || "";
  const frags = new Set();
  const cleaned = t.replace(
    /方案|套餐|回收|配送|到期|家電|傢俱|家具|冰箱|床|早上|上午|下午|租|一年|兩年|收|給/g,
    " "
  );
  for (const m of cleaned.matchAll(/[一-鿿]{2,4}/g)) frags.add(m[0]);
  for (const m of t.matchAll(/[（(]([^）)]+)[）)]/g)) frags.add(m[1].trim());
  for (const m of t.matchAll(/[A-Za-z]{3,}/g)) frags.add(m[0].toUpperCase());
  return frags;
}

function intersects(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function classify(events) {
  const deliveries = [], expiries = [], recoveries = [];
  for (const e of events) {
    const s = e.summary || "";
    const rec = { title: s, date: eventDate(e), desc: e.description || "", names: nameFrags(s) };
    if (s.includes("回收")) recoveries.push(rec);      // 有「回收」優先算回收（即使也含到期）
    else if (s.includes("到期")) expiries.push(rec);
    else if (s.includes("配送") && PLAN_RE.test(s + rec.desc)) deliveries.push(rec);
  }
  return { deliveries, expiries, recoveries };
}

function daysBetween(fromISO, toISO) {
  return Math.round((Date.parse(toISO + "T00:00:00Z") - Date.parse(fromISO + "T00:00:00Z")) / 86400000);
}

const cleanExpiry = (t) => (t || "").replace(/【到期】|【上午】|【下午】/g, "").trim();
const cleanRec = (t) => (t || "").replace(/【上午】|【下午】/g, "").trim().slice(0, 28);

function packLines(lines, limit = 3500) {
  const msgs = [];
  let cur = "";
  for (const ln of lines) {
    if (cur.length + ln.length + 1 > limit && cur) { msgs.push(cur.trimEnd()); cur = ""; }
    cur += ln + "\n";
  }
  if (cur.trim()) msgs.push(cur.trimEnd());
  return msgs;
}

/**
 * @param events 行事曆事件陣列（listEvents 回傳）
 * @param todayISO "YYYY-MM-DD"（JST）
 * @param leadDays 到期前幾天開始列為「需安排」
 * @returns string[]（每則 <3500 字，直接逐則送 Telegram）
 */
function buildRecoveryReport(events, todayISO, leadDays = 45) {
  const { expiries, recoveries } = classify(events);
  const overdue = [], soon = [], later = [], pending = [];

  for (const ex of expiries) {
    const matched = recoveries.filter((r) => intersects(ex.names, r.names));
    const done = matched.some((r) => DONE_RE.test(r.title + r.desc)) || DONE_RE.test(ex.title + ex.desc);
    if (done) continue;
    const arranged = matched.length > 0 || ARR_RE.test(ex.title + ex.desc);
    if (arranged) { pending.push({ ex, matched }); continue; }
    if (!ex.date) { later.push(ex); continue; }
    const d = daysBetween(todayISO, ex.date);
    if (d < 0) overdue.push(ex);
    else if (d <= leadDays) soon.push(ex);
    else later.push(ex);
  }

  const byDate = (a, b) => (a.date || "9999").localeCompare(b.date || "9999");
  overdue.sort(byDate); soon.sort(byDate); later.sort(byDate);
  pending.sort((a, b) => byDate(a.ex, b.ex));

  const lines = [];
  lines.push(`🐻 年租回收防漏報表（${todayISO}）`);
  lines.push("");

  if (overdue.length) {
    lines.push(`🔴 已過期・尚未安排回收（${overdue.length}）`);
    for (const ex of overdue) lines.push(`• ${ex.date} ${cleanExpiry(ex.title)}`);
    lines.push("");
  }

  lines.push(`⚠️ ${leadDays} 天內到期・需安排回收（${soon.length}）`);
  if (soon.length) for (const ex of soon) lines.push(`• ${ex.date} ${cleanExpiry(ex.title)}`);
  else lines.push("　（無，近期都安排好了 👍）");
  lines.push("");

  if (pending.length) {
    lines.push(`🔧 已安排・待標「回收完畢」（${pending.length}）`);
    for (const { ex, matched } of pending) {
      const tag = matched.length ? ` → 已對到：${cleanRec(matched[0].title)}` : "（事件已標已安排）";
      lines.push(`• ${ex.date || ""} ${cleanExpiry(ex.title)}${tag}`);
    }
    lines.push("");
  }

  if (later.length) {
    const nearest = later[0];
    lines.push(`🗓 更遠期到期・尚未安排：${later.length} 筆（暫不需動作，最近一筆 ${nearest.date || "?"} ${cleanExpiry(nearest.title)}）`);
    lines.push("");
  }

  lines.push("——");
  lines.push("結案方式：在該到期或回收事件標題加「回收完畢」→ 從報表移除；加「已安排」或建立回收事件 → 列入「待標完畢」。");

  return packLines(lines);
}

module.exports = { buildRecoveryReport, classify, nameFrags, PLAN_RE, DONE_RE, ARR_RE };
