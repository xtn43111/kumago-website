#!/usr/bin/env node
/* KUMAGO — Square 交易明細 × 行事曆進銷貨清單 對帳
 *
 * 用法：node tools/reconcile_square.js
 *
 * 三個實測得來的處理重點（不要簡化掉）：
 *  1. 退款沖銷：Square 退款列與原收款列共用同一個 Payment ID。兩者要成對抵銷，
 *     否則被退掉的金額會被當成真實營收（實測有 ¥136,180 一筆）。
 *  2. 日期容差要大：刷卡日 ≠ 配送日。客人常在海外先刷卡、兩三個月後才入住，
 *     實測最長超過 90 天，因此純金額配對放寬到 180 天。
 *  3. 兩段式配對：先「姓名＋金額」（日期不限，最可靠），再「金額＋最近日期」。
 *     單靠金額會亂配，因為方案價格（¥55,080 等）會重複出現。
 *
 * 輸出：決算/FY2025-07_2026-06/對帳_Square×行事曆清單.csv
 *   把未配對的 Square 收款分成 A 跨期／B 金額相符／C 同名不同額／D 查無 四類，
 *   D 類才是真正要追的疑似漏記。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "決算", "FY2025-07_2026-06");
const SQ_PATH = path.join(DIR, "Square交易明細_2025-07-01_2026-07-01.csv");
const LEDGER_PATH = path.join(DIR, "KUMAGO_銷貨清單（收入）_2025-07-01_2026-06-30.csv");
const EVENTS_PATH = path.join(ROOT, ".tmp", "gcal_events_2025-06-01_2026-11-01.json");
const OUT_PATH = path.join(DIR, "對帳_Square×行事曆清單.csv");

const FY_START = "2025-07-01";
const FY_END = "2026-06-30";
const AMOUNT_ONLY_TOLERANCE = 180; // 天

const SQ = require("../lib/square_data");
const { parseDelimited, nameMatch, matchToLedger, dayDiff } = SQ;

const csvCell = (v) => {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/* ── 讀 Square（交易明細＋入金明細，見 lib/square_data.js）──── */
const sqData = SQ.load(DIR);
const all = sqData.all;
const refunds = sqData.refunds;
const payments = sqData.txns;  // 有效收款（已排除退款列與被退掉的原交易）
const voided = sqData.voided;  // 已被退掉的原交易

/* ── 讀進銷貨清單 ───────────────────────────────────── */
const ledRows = parseDelimited(fs.readFileSync(LEDGER_PATH, "utf8").replace(/^﻿/, ""), ",");
const ledger = [];
for (const r of ledRows.slice(1)) {
  if (!/^\d+$/.test(r[0] || "")) continue;
  ledger.push({
    no: r[0], date: r[1], flow: "收入", cat: r[3], name: r[4], detail: r[5],
    amount: r[6] === "" ? null : parseInt(r[6], 10),
    channel: r[7], addr: r[12], phone: r[13], note: r[14],
    evId: r[15] || "", matched: null,
  });
}
const incomeLedger = ledger.filter((l) => l.flow === "收入" && l.amount != null);

/* ── 配對（邏輯在 lib/square_data.js，與清單產生器共用同一套）──
 * 先套人工綁定，再跑自動配對，兩邊結論才會跟清單一致。 */
const manualLinks = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, "修正_金額以Square為準.json"), "utf8")).manualLinks || {};
    const out = {};
    for (const [txId, v] of Object.entries(j)) if (v && v.eventId) out[txId] = v.eventId;
    return out;
  } catch (_) { return {}; }
})();
const byEvId = new Map(incomeLedger.filter((l) => l.evId).map((l) => [l.evId, l]));
const byTxId = new Map(payments.map((s) => [s.txId, s]));
const preBound = new Set();
for (const [txId, evId] of Object.entries(manualLinks)) {
  const s = byTxId.get(txId), l = byEvId.get(evId);
  if (s && l) { s.ledger = l; l.square = s; s.via = "人工綁定"; s.dayGap = dayDiff(l.date, s.date); preBound.add(s); }
}
matchToLedger(payments.filter((s) => !preBound.has(s)), incomeLedger.filter((l) => !l.square));
for (const s of payments) s.matched = s.ledger;
for (const l of incomeLedger) l.matched = l.square;

const sqUnmatched = payments.filter((s) => !s.matched);
const ledUnmatched = incomeLedger.filter((l) => !l.matched);

/* ── 未配對成因分類（拿完整行事曆事件當第二證據）─────── */
const events = fs.existsSync(EVENTS_PATH) ? JSON.parse(fs.readFileSync(EVENTS_PATH, "utf8")) : [];
const evDate = (e) => (e.start.date || e.start.dateTime || "").slice(0, 10);
function amountInEvent(e, amt) {
  const txt = e.summary + "\n" + e.description;
  const re = new RegExp("(?:[¥￥]|合計[：:]\\s*[¥￥]?)\\s*(?:" + amt + "|" + amt.toLocaleString("en-US") + ")(?![0-9])");
  return re.test(txt);
}
// 已經被其他 Square 交易配走的清單列，其對應事件不可再拿來當證據，
// 否則會把「同金額但已歸屬別人」的事件誤判成跨期或未入帳。
const consumed = new Set(incomeLedger.filter((l) => l.matched).map((l) => l.date + "|" + l.amount));
const isConsumed = (e, amt) => consumed.has(evDate(e) + "|" + amt);
// 同名佐證同樣要有時間關聯，否則一年前的同姓客人也會被當成證據。
const NAME_WINDOW = 180;

const cls = { outFY: [], inFY: [], nameDiff: [], none: [] };
for (const u of sqUnmatched) {
  const amtHits = events.filter((e) => amountInEvent(e, u.gross) && !isConsumed(e, u.gross));
  const nameHits = events.filter((e) =>
    nameMatch(u.cust, e.summary + " " + ((e.description.match(/姓名[：:][^\n]*/) || [""])[0])) &&
    Math.abs(dayDiff(evDate(e), u.date)) <= NAME_WINDOW);
  const both = amtHits.filter((e) => nameHits.includes(e));
  const pick = both[0] || (amtHits.length === 1 && Math.abs(dayDiff(evDate(amtHits[0]), u.date)) <= NAME_WINDOW ? amtHits[0] : null);
  if (pick) {
    const d = evDate(pick);
    const rec = { ...u, evDate: d, ev: pick.summary, why: both[0] ? "金額+姓名" : "金額唯一" };
    // 只有「配送日晚於年度末」才是前受金；早於年度初的同額事件是巧合，歸查無。
    if (d > FY_END) cls.outFY.push(rec);
    else if (d < FY_START) cls.none.push({ ...u, evDate: "", ev: "", why: "查無" });
    else cls.inFY.push(rec);
  } else if (nameHits.length) {
    const e = nameHits.sort((a, b) => Math.abs(dayDiff(evDate(a), u.date)) - Math.abs(dayDiff(evDate(b), u.date)))[0];
    cls.nameDiff.push({ ...u, evDate: evDate(e), ev: e.summary, why: "同名不同額" });
  } else cls.none.push({ ...u, evDate: "", ev: "", why: "查無" });
}

/* ── 統計 ───────────────────────────────────────────── */
const sum = (a, f) => a.reduce((x, y) => x + (f(y) || 0), 0);
const sqGross = sum(payments, (s) => s.gross);
const sqFees = sum(all, (s) => s.fees);
const sqNet = sum(all, (s) => s.net);
const ledIncome = sum(incomeLedger, (l) => l.amount);
const matched = payments.filter((s) => s.matched);

/* ── 報告 ───────────────────────────────────────────── */
const lines = [];
const push = (...c) => lines.push(c.map(csvCell).join(","));
const yen = (n) => "¥" + Number(n).toLocaleString("ja-JP");

push("KUMAGO 對帳報告：Square 交易明細 × 行事曆進銷貨清單");
push("會計年度", `${FY_START} ～ ${FY_END}`, "產生工具", "tools/reconcile_square.js");
push("");
push("【一】Square 側總覽");
push("項目", "筆數", "金額(日圓)", "說明");
push("Square 有效收款", payments.length, sqGross, `期間 ${all[0].date} ～ ${all[all.length - 1].date}（此前無 Square 交易）`);
push("退款沖銷（原交易＋退款成對抵銷）", voided.length, sum(voided, (s) => s.gross), "已從有效收款排除，不計營收");
push("Square 手数料", "", sqFees, "負數＝支付給 Square 的處理費，可認列費用");
push("Square 實際入金淨額", "", sqNet, "Net Total 合計，對得到銀行入金");
push("");
push("【二】兩邊對照");
push("項目", "筆數", "金額(日圓)", "說明");
push("Square 與清單成功對上", matched.length, sum(matched, (s) => s.gross), "同金額，且姓名或日期可佐證");
push("Square 有、清單沒有", sqUnmatched.length, sum(sqUnmatched, (s) => s.gross), "見【三】分類");
push("清單有、Square 沒有", ledUnmatched.length, sum(ledUnmatched, (l) => l.amount), "現金／銀行匯款／Stripe 等其他管道，非錯誤");
push("清單收入總計", incomeLedger.length, ledIncome, "");
push("");

const sect = (title, arr, note) => {
  push(`【三-${title}】${note}（${arr.length} 筆，${yen(sum(arr, (x) => x.gross))}）`);
  push("Square日期", "金額", "手数料", "客戶名(Square)", "來源", "行事曆事件日", "行事曆事件", "判斷依據", "Square品項描述");
  for (const r of arr) push(r.date, r.gross, r.fees, r.cust, r.source, r.evDate, r.ev, r.why, r.desc.slice(0, 90));
  push("");
};
push("【三】Square 有收款但清單找不到——依成因分類");
push("");
sect("D", cls.none, "★行事曆完全查無，疑似漏記營收，最優先追");
sect("C", cls.nameDiff, "★找得到同一位客人但金額不同（分次收款／加購另刷／金額記錯）");
sect("A", cls.outFY, "配送日落在本年度之外（前受金／跨期，非漏記，但要問税理士認列時點）");
sect("B", cls.inFY, "行事曆有同金額事件但未進清單（多為非收入類事件，請個別確認）");

push("【四】退款明細");
push("日期", "金額", "手数料返還", "客戶名", "描述");
for (const s of refunds) push(s.date, s.gross, s.fees, s.cust, s.desc.slice(0, 80));
push("");
push("【五】成功對上的明細");
push("Square日期", "清單日期", "日差", "金額", "手数料", "依據", "清單類別", "客戶名稱", "清單內容");
for (const s of matched.sort((a, b) => a.date.localeCompare(b.date))) {
  push(s.date, s.matched.date, s.dayGap, s.gross, s.fees, s.via, s.matched.cat, s.matched.name, s.matched.detail.replace(/\s+/g, " ").slice(0, 60));
}
push("");
push("【六】清單有收入但 Square 查無（＝其他收款管道）");
push("No.", "日期", "類別", "客戶名稱", "金額", "內容", "收款註記");
for (const l of ledUnmatched) push(l.no, l.date, l.cat, l.name, l.amount, l.detail.replace(/\s+/g, " ").slice(0, 70), l.paid);

fs.writeFileSync(OUT_PATH, "﻿" + lines.join("\r\n"));

/* 機器可讀的補記清單：D（查無）＋C（同名不同額＝另一筆獨立收款）。
 * 人工核可後交給 tools/backfill_square_events.js 建行事曆事件。
 * 注意：已存在的檔案不覆蓋——裡面可能有人工加的 note 或已刪掉不該補的列。 */
const LIST_PATH = path.join(DIR, "補記清單_Square.json");
if (!fs.existsSync(LIST_PATH)) {
  const toItem = (s, note) => ({
    date: s.date, amount: s.gross, fees: s.fees, cust: s.cust, source: s.source,
    brand: s.brand, desc: s.desc, depDate: s.depDate, txId: s.txId, note,
  });
  fs.writeFileSync(LIST_PATH, JSON.stringify({
    _說明: "Square 有收款但行事曆查無的交易。人工核可後跑 tools/backfill_square_events.js --apply 補建行事曆事件；不想補的直接從 items 刪掉。",
    _產生: "tools/reconcile_square.js（此檔已存在時不會被覆蓋）",
    items: [
      ...cls.none.map((s) => toItem(s, "行事曆完全查無")),
      ...cls.nameDiff.map((s) => toItem(s, `同一位客人另一筆獨立收款（行事曆最近事件：${s.evDate} ${s.ev}）`)),
    ].sort((a, b) => a.date.localeCompare(b.date)),
  }, null, 2));
  console.log(`已產生補記清單：${LIST_PATH}`);
}

console.log(`Square ${all[0].date} ～ ${all[all.length - 1].date}：有效收款 ${payments.length} 筆 ${yen(sqGross)}`);
console.log(`  退款沖銷 ${voided.length} 筆 ${yen(sum(voided, (s) => s.gross))}／手数料 ${yen(sqFees)}／入金淨額 ${yen(sqNet)}`);
console.log(`清單收入 ${incomeLedger.length} 筆 ${yen(ledIncome)}`);
console.log(`對上 ${matched.length} 筆 ${yen(sum(matched, (s) => s.gross))}`);
console.log(`未對上（Square 有清單無）${sqUnmatched.length} 筆 ${yen(sum(sqUnmatched, (s) => s.gross))}：`);
console.log(`  D 查無（疑似漏記）${cls.none.length} 筆 ${yen(sum(cls.none, (s) => s.gross))}`);
console.log(`  C 同名不同額     ${cls.nameDiff.length} 筆 ${yen(sum(cls.nameDiff, (s) => s.gross))}`);
console.log(`  A 跨期（配送在下年度）${cls.outFY.length} 筆 ${yen(sum(cls.outFY, (s) => s.gross))}`);
console.log(`  B 有同額事件未進清單 ${cls.inFY.length} 筆 ${yen(sum(cls.inFY, (s) => s.gross))}`);
console.log(`-> ${OUT_PATH}`);
