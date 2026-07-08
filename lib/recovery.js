"use strict";
/*
 * 年租回收 防漏報表邏輯（純函式，方便本地測試，不碰網路）。
 *
 * 雙錨點：
 *  (A) 「到期(【到期】…方案)」事件 —— 明確標了到期日與方案。
 *  (B) 「配送(年租)」單 —— 用配送日 + 方案期間推估到期日，補上「沒建到期事件」
 *      的年租（例如手動配送單只寫 B方案、沒另建到期），避免漏掉。
 * 兩錨點以客人名字碎片去重（同一位優先用到期事件，其次才用配送推估）。
 * 對每個錨點再比對「回收」事件是否已安排 / 已標「回收完畢」。
 *
 * 年租判斷（使用者規則）：標題/說明含 A/B/C方案、套餐、一年、兩年、或「租期」。
 * 狀態約定（記在行事曆事件「標題」上；說明不算數——說明會夾自助預約教學文字
 * 與客人自由備註，拿說明判狀態會被「回收完畢」「已完成」等字樣誤觸）：
 *   - 標題含「回收完畢/已回收/已完成」→ 結案，從報表移除。
 *   - 有對應回收事件、或標題含「已安排」→ 列「待標完畢」。
 */

const PLAN_RE = /[ABC]\s*方案|套餐|一年|兩年|二年|2\s*年|租期/;
const DONE_RE = /回收完畢|已回收|已完成|✅\s*完/;
const ARR_RE = /已安排|排定|✅\s*安排/;
const OVERDUE_WINDOW = 120; // 已過期超過這天數就不再列（假設早已處理，避免洗版）

function eventDate(e) {
  const s = e.start || {};
  return s.date || (s.dateTime || "").slice(0, 10) || null; // "YYYY-MM-DD"
}

// 非人名的常見雜詞（時段/物品/地點/金流），一律不當作比對碎片，避免誤配
const STOP = new Set([
  "上午", "下午", "早上", "中午", "晚上", "傍晚", "多筆", "現場", "無料", "免費",
  "套組", "套餐", "方案", "家電", "傢俱", "家具", "冰箱", "桌椅", "窗簾", "鍋具",
  "電風扇", "吸頂燈", "曬衣", "運費", "樓層", "房號", "號室", "大阪", "京都", "東京",
  "一年", "兩年", "三年", "個月", "半年", "續租", "退租", "沒有", "還有", "確認",
  "入住",
  "LINE", // 事件標題的（LINE: 名稱）標記——羅馬字碎片會全事件互相誤配，必擋
]);

// 從標題抽可比對的名字碎片：中文連續字、括號內真名、較長羅馬拼音（≥4，避開 LIN/FAN 等共用姓）
function nameFrags(title) {
  const t = title || "";
  const frags = new Set();
  const cleaned = t.replace(
    /方案|套餐|回收|配送|到期|入住|家電|傢俱|家具|冰箱|床|早上|上午|下午|中午|晚上|租|一年|兩年|三年|收|給|多筆|現場|無料|運費|樓層|續租|退租/g,
    " "
  );
  for (const m of cleaned.matchAll(/[一-鿿]{2,4}/g)) frags.add(m[0]);
  for (const m of t.matchAll(/[（(]([^）)]+)[）)]/g)) {
    const inner = m[1];
    for (const cm of inner.matchAll(/[一-鿿]{2,4}/g)) frags.add(cm[0]);
    for (const rm of inner.matchAll(/[A-Za-z]{4,}/g)) frags.add(rm[0].toUpperCase());
  }
  for (const m of t.matchAll(/[A-Za-z]{4,}/g)) frags.add(m[0].toUpperCase());
  for (const s of STOP) frags.delete(s);
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

// 從方案文字推估租期月數（預設一年）
function planMonths(text) {
  const t = text || "";
  if (/兩年|二年|2\s*年/.test(t)) return 24;
  if (/三年|3\s*年/.test(t)) return 36;
  if (/一年|1\s*年/.test(t)) return 12;
  const m = t.match(/(\d+)\s*個月/); // 必須有「個」——「7月15日」是日期不是租期
  if (m) return parseInt(m[1], 10);
  return 12; // 只寫 A/B/C方案、沒寫期間 → 當一年
}

function addMonths(iso, months) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
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
  const { deliveries, expiries, recoveries } = classify(events);

  // 組錨點（到期優先，配送推估補洞），以名字去重
  const anchors = [];
  const covered = [];
  for (const ex of expiries) {
    if (!ex.date) continue;
    anchors.push({ expiry: ex.date, label: cleanExpiry(ex.title), names: ex.names, src: ex, derived: false });
    covered.push(ex.names);
  }
  for (const dv of deliveries) {
    if (!dv.date) continue;
    if (covered.some((c) => intersects(dv.names, c))) continue; // 已被到期事件涵蓋
    const expiry = addMonths(dv.date, planMonths(dv.title + dv.desc));
    anchors.push({ expiry, label: `${cleanExpiry(dv.title)}〔配送${dv.date}·推估到期〕`, names: dv.names, src: dv, derived: true });
    covered.push(dv.names);
  }

  const overdue = [], soon = [], later = [], pending = [];
  let hiddenOld = 0; // 過期超過 OVERDUE_WINDOW 天、未結案卻被略過的數量
  for (const a of anchors) {
    const matched = recoveries.filter((r) => intersects(a.names, r.names));
    const done = matched.some((r) => DONE_RE.test(r.title)) || DONE_RE.test(a.src.title);
    if (done) continue;
    const arranged = matched.length > 0 || ARR_RE.test(a.src.title);
    if (arranged) { pending.push({ a, matched }); continue; }
    const d = daysBetween(todayISO, a.expiry);
    if (d < 0) { if (d >= -OVERDUE_WINDOW) overdue.push(a); else hiddenOld++; }
    else if (d <= leadDays) soon.push(a);
    else later.push(a);
  }

  const byExpiry = (x, y) => (x.expiry || "9999").localeCompare(y.expiry || "9999");
  overdue.sort(byExpiry); soon.sort(byExpiry); later.sort(byExpiry);
  pending.sort((x, y) => byExpiry(x.a, y.a));

  const mark = (a) => (a.derived ? "🔸" : "");   // 🔸=配送推估（非明確到期事件）
  const lines = [];
  lines.push(`🐻 年租回收防漏報表（${todayISO}）`);
  lines.push("");

  if (overdue.length) {
    lines.push(`🔴 已過期・尚未安排回收（${overdue.length}）`);
    for (const a of overdue) lines.push(`• ${a.expiry} ${mark(a)}${a.label}`);
    lines.push("");
  }

  // 別讓真的漏掉的回收永遠隱形：過期超過 OVERDUE_WINDOW 天的未結案項目雖不逐筆
  // 列出（避免洗版），但要出聲提醒有幾筆，老闆才知道要去翻舊帳。
  if (hiddenOld) {
    lines.push(`🕳 另有 ${hiddenOld} 筆過期逾 ${OVERDUE_WINDOW} 天、仍未標結案（未逐筆列出，請查舊行事曆確認是否已回收）`);
    lines.push("");
  }

  lines.push(`⚠️ ${leadDays} 天內到期・需安排回收（${soon.length}）`);
  if (soon.length) for (const a of soon) lines.push(`• ${a.expiry} ${mark(a)}${a.label}`);
  else lines.push("　（無，近期都安排好了 👍）");
  lines.push("");

  if (pending.length) {
    lines.push(`🔧 已安排・待標「回收完畢」（${pending.length}）`);
    for (const { a, matched } of pending) {
      const tag = matched.length ? ` → 已對到：${cleanRec(matched[0].title)}` : "（事件已標已安排）";
      lines.push(`• ${a.expiry} ${mark(a)}${a.label}${tag}`);
    }
    lines.push("");
  }

  if (later.length) {
    const n = later[0];
    lines.push(`🗓 更遠期到期・尚未安排：${later.length} 筆（暫不需動作，最近 ${n.expiry} ${mark(n)}${n.label}）`);
    lines.push("");
  }

  lines.push("——");
  lines.push("🔸=用配送日＋方案期間推估的到期（非明確到期事件）。結案：事件標題加「回收完畢」→ 移除；加「已安排」或建回收事件 → 列「待標完畢」。");

  return packLines(lines);
}

module.exports = { buildRecoveryReport, classify, nameFrags, planMonths, addMonths, PLAN_RE, DONE_RE, ARR_RE };
