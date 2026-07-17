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

// 年租判斷：手動單寫「C方案一年/B set租一年」，網站自動單寫「B 套組」＋內文「× 1 年」，
// 短租寫「B方案4月」「×4 個月」——全部要認得，否則照片提醒/週報/清查都會漏該筆
const PLAN_RE = /[ABC]\s*(方案|套組|套组|套餐|セット|set)|套餐|一年|兩年|二年|三年|半年|[×xX]\s*\d+\s*年|\d\s*年|\d+\s*個月|方案\s*\d{1,2}\s*月|租期/i;
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
  "LINE", // 舊格式（LINE: 名稱）與（無LINE）標記——羅馬字碎片會全事件互相誤配，必擋
  "SET", "PLAN", // 「B set」方案寫法——fallback 羅馬單字時不能當名字
  // 單一漢字規則的雜字：「1年」「4月」「年租」剝完剩的量詞/單位不是名字。
  // 實測 2026-07-17：「年」讓 Diya/Sanse/Ngjojo/LIU CHIHYU 全被當同一人，
  // backfill 四人併一組只建一筆到期事件、週報假配對「Vera 年租回收」。
  "年", "月", "日", "天", "半", "個", "給", "樣", "元", "円", "已",
]);

// 從標題抽可比對的名字碎片：中文連續字、假名、括號內真名、羅馬拼音。
// 羅馬拼音規則：全名（≥2 個字）整串當一個碎片；單一字要 ≥5 字母——
// 4 字母單字（XUAN/CHIA…）是常見音節，實測會跨客人誤配（劉于瑄 撞 WU PIN XUAN）。
function nameFrags(title) {
  const t = title || "";
  const frags = new Set();
  const cleaned = t.replace(
    /品項有客製待核|品項|客製|待核|方案|套組|套餐|已完成|已回收|完畢|完成|回收|配送|到期|入住|家電|傢俱|家具|冰箱|床|早上|上午|下午|中午|晚上|租|一年|兩年|三年|收|給|多筆|現場|無料|運費|樓層|續租|退租/g,
    " "
  );
  for (const m of cleaned.matchAll(/[一-鿿]{2,4}/g)) frags.add(m[0]);
  // 假名名字（ホウユル、リンリン、ゆめ）
  for (const m of cleaned.matchAll(/[ぁ-んァ-ヶー]{2,}/g)) frags.add(m[0]);
  for (const m of t.matchAll(/[（(]([^）)]+)[）)]/g)) {
    const inner = m[1];
    for (const cm of inner.matchAll(/[一-鿿]{2,4}/g)) frags.add(cm[0]);
    for (const km of inner.matchAll(/[ぁ-んァ-ヶー]{2,}/g)) frags.add(km[0]);
    for (const rm of inner.matchAll(/[A-Za-z]{4,}/g)) frags.add(rm[0].toUpperCase());
  }
  // 羅馬字全名整串（WU CHIH CHIA → "WU CHIH CHIA"），空白正規化成單一空格
  for (const m of t.matchAll(/[A-Za-z]{2,}(?:\s+[A-Za-z]{2,})+/g)) {
    frags.add(m[0].toUpperCase().replace(/\s+/g, " "));
  }
  for (const m of t.matchAll(/[A-Za-z]{5,}/g)) frags.add(m[0].toUpperCase());
  // 單字中文姓（荊/張/涓…）：抽不出 2 字以上中文名時，取 cleaned 裡孤立的單一漢字
  if (![...frags].some((f) => /[一-鿿]{2}/.test(f))) {
    for (const m of cleaned.matchAll(/(?<![一-鿿])[一-鿿](?![一-鿿])/g)) frags.add(m[0]);
  }
  for (const s of STOP) frags.delete(s);
  // 完全抽不出東西才放寬：接受 3–4 字母羅馬單字名（Vera/Yuna/CHEN…）。
  // 只在雙方都沒有更強碎片時才會用到，XUAN/CHIA 型誤配不會復活
  //（有中文名的那方碎片非空，不會走到這裡）。
  if (!frags.size) {
    for (const m of t.matchAll(/[A-Za-z]{3,4}/g)) {
      const w = m[0].toUpperCase();
      if (!STOP.has(w)) frags.add(w);
    }
  }
  return frags;
}

// 中文名碎片允許「包含」也算同一人：欣蓓 ⊂ 蔡欣蓓（回收單常補姓）。
// 只限雙方都是 2-4 字純中文，羅馬/假名仍要完全相等。
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

function classify(events) {
  const deliveries = [], expiries = [], recoveries = [];
  for (const e of events) {
    const s = e.summary || "";
    const rec = { id: e.id, title: s, date: eventDate(e), desc: e.description || "", names: nameFrags(s) };
    if (s.includes("【到期】")) expiries.push(rec);    // 明確標記最優先（標題就算提到回收也算到期）
    else if (s.includes("回收")) recoveries.push(rec); // 其次「回收」（「到期回收」這種算回收工作）
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
  if (/半年/.test(t)) return 6;
  let m = t.match(/(\d+)\s*個月/); // 「× 4 個月」（網站自動單）
  if (m) return parseInt(m[1], 10);
  m = t.match(/方案\s*(\d{1,2})\s*月(?![\d日])/); // 「B方案4月」＝4 個月；「7月15日」是日期不算
  if (m) return parseInt(m[1], 10);
  return 12; // 只寫 A/B/C方案、沒寫期間 → 當一年
}

function addMonths(iso, months) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/* 錨點的租期起日：配送推估錨＝配送日；到期事件錨＝說明的「租期：起-迄」或
 * 「租期：配送 YYYY-MM-DD 起」。抓不到回 null（不做日期防呆）。 */
function anchorRentalStart(a) {
  if (a.derived) return a.src.date || null;
  const desc = a.src.desc || "";
  let m = desc.match(/租期[：: ]*\s*(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})\s*[-–~～到至]/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  m = desc.match(/租期[：: ]*配送\s*(\d{4})-(\d{2})-(\d{2})\s*起/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
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
    // 日期防呆：回收日早於這份租約的起日，不可能是這筆的回收（實測：
    // Chao-Chang chen 2025-08-10 回收被 CHANG 碎片誤配到 2025-09-30 才配送的雅媗）
    const start = anchorRentalStart(a);
    const matched = recoveries.filter(
      (r) => intersects(a.names, r.names) && !(start && r.date && r.date < start)
    );
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
