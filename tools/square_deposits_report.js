#!/usr/bin/env node
/* KUMAGO — Square 每次匯款到銀行的明細報表（HTML，可再轉 PDF）
 *
 * 用法：node tools/square_deposits_report.js
 *
 * 做三件事：
 *  1. 把 Square 交易依 Deposit ID 分成入金批次
 *  2. 每個批次去銀行帳戶明細找對應的「振込 スクエア（カ」入金，核對金額
 *  3. 產出每筆匯款包含哪些客人款項的清單
 *
 * 實測要注意的兩點：
 *  - 銀行日期是 YYYYMMDD 字串，比對日期差一定要轉成 Date 再算；直接相減會在
 *    月底跨月時算出 71 天這種數字（20260430 vs 20260501）。
 *  - Square 有時會把兩個批次併成一筆銀行匯款（實測 2025-11-20 與 2025-12-11
 *    兩批合併成 2025-12-12 的一筆 ¥292,274）。所以「批次數 ≠ 銀行匯款筆數」。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "決算", "FY2025-07_2026-06");
const OUT = path.join(DIR, "Square匯款明細報表.html");
const FY_END = "2026-06-30";

const SQ = require("../lib/square_data");
const sq = SQ.load(DIR);

/* 銀行帳戶明細是 Shift_JIS 的 CSV，每欄都用雙引號包起來。 */
function loadBank() {
  const f = fs.readdirSync(DIR).find((x) => /銀行帳戶總明細/.test(x));
  if (!f) return [];
  const text = new TextDecoder("shift_jis").decode(fs.readFileSync(path.join(DIR, f)));
  return text.split(/\r?\n/).filter((l) => l.trim()).slice(1)
    .map((l) => (l.match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1)))
    .filter((r) => r.length >= 5)
    .map((r) => ({ ymd: r[0], iso: `${r[0].slice(0, 4)}-${r[0].slice(4, 6)}-${r[0].slice(6)}`, memo: r[1], in: r[2] ? +r[2] : 0, out: r[3] ? +r[3] : 0 }));
}
const bank = loadBank();
const bankSquare = bank.filter((b) => /スクエア/.test(b.memo) && b.in > 0);

/* 清單（收入）拿來補客人名與品項——Square 只給客戶名，品項在清單備註裡。 */
function loadLedger() {
  const f = fs.readdirSync(DIR).find((x) => /^KUMAGO_銷貨清單/.test(x));
  if (!f) return new Map();
  const rows = SQ.parseDelimited(fs.readFileSync(path.join(DIR, f), "utf8").replace(/^﻿/, ""), ",");
  const m = new Map();
  for (const r of rows.slice(1)) {
    if (!/^\d+$/.test(r[0] || "")) continue;
    const txId = r[11];
    if (txId) m.set(txId, { cat: r[3], name: r[4], detail: r[5], note: r[14] });
  }
  return m;
}
const ledger = loadLedger();

/* ── 依 Deposit ID 分批次 ─────────────────────────────── */
const groups = new Map();
for (const s of sq.all) {
  const key = s.depId || "NOID_" + s.depDate;
  if (!groups.has(key)) groups.set(key, { depId: s.depId, depDate: s.depDate, items: [] });
  groups.get(key).items.push(s);
}
const deposits = [...groups.values()].map((g) => ({
  ...g,
  items: g.items.sort((a, b) => a.date.localeCompare(b.date)),
  gross: g.items.reduce((a, s) => a + (s.gross || 0), 0),
  fees: g.items.reduce((a, s) => a + (s.fees || 0), 0),
  deposited: g.items.reduce((a, s) => a + (s.deposited || 0), 0),
})).sort((a, b) => a.depDate.localeCompare(b.depDate));

/* ── 對銀行 ───────────────────────────────────────────── */
const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);
const usedBank = new Set();
for (const d of deposits) {
  const i = bankSquare.findIndex((b, idx) => !usedBank.has(idx) && Math.abs(dayDiff(b.iso, d.depDate)) <= 5 && b.in === d.deposited);
  if (i >= 0) { usedBank.add(i); d.bank = bankSquare[i]; d.bankStatus = "單獨匯款"; }
}
// 沒單獨對上的，試「兩個批次併成一筆」
const unmatched = deposits.filter((d) => !d.bank && d.depDate <= FY_END);
for (let a = 0; a < unmatched.length; a++) {
  for (let b = a + 1; b < unmatched.length; b++) {
    const sum = unmatched[a].deposited + unmatched[b].deposited;
    const i = bankSquare.findIndex((x, idx) => !usedBank.has(idx) && x.in === sum &&
      Math.abs(dayDiff(x.iso, unmatched[b].depDate)) <= 5);
    if (i >= 0) {
      usedBank.add(i);
      unmatched[a].bank = unmatched[b].bank = bankSquare[i];
      unmatched[a].bankStatus = unmatched[b].bankStatus = "與另一批次合併匯款";
      unmatched[a].mergedWith = unmatched[b].depDate;
      unmatched[b].mergedWith = unmatched[a].depDate;
    }
  }
}

const inFY = deposits.filter((d) => d.depDate <= FY_END);
const bankTransfers = new Set(inFY.filter((d) => d.bank).map((d) => d.bank.iso + "|" + d.bank.in));

/* ── HTML ─────────────────────────────────────────────── */
const yen = (n) => (n < 0 ? "−¥" : "¥") + Math.abs(n).toLocaleString("ja-JP");
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const md = (iso) => iso.slice(5).replace("-", "/");

const totIn = inFY.reduce((a, d) => a + d.deposited, 0);
const totGross = inFY.reduce((a, d) => a + d.gross, 0);
const totFees = inFY.reduce((a, d) => a + d.fees, 0);

let h = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>KUMAGO Square 匯款明細 2025-07-01〜2026-06-30</title><style>
@page { size: A4; margin: 14mm 12mm; }
* { box-sizing: border-box; }
body { font-family: "Hiragino Sans", "PingFang TC", -apple-system, sans-serif; color: #1a1a1a; font-size: 10.5px; line-height: 1.5; margin: 0; }
h1 { font-size: 19px; margin: 0 0 2px; }
.sub { color: #666; font-size: 11px; margin-bottom: 14px; }
.cards { display: flex; gap: 8px; margin-bottom: 16px; }
.card { flex: 1; border: 1px solid #d8d0c4; border-radius: 6px; padding: 8px 10px; background: #faf7f2; }
.card .l { font-size: 10px; color: #7a6f60; }
.card .v { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
.note { border-left: 3px solid #c9a227; background: #fffdf3; padding: 8px 11px; margin-bottom: 16px; font-size: 10.5px; }
.dep { border: 1px solid #ccc; border-radius: 6px; margin-bottom: 11px; page-break-inside: avoid; overflow: hidden; }
.dep > .hd { background: #f0ebe2; padding: 6px 10px; display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.dep .hd .d { font-weight: 700; font-size: 12px; }
.dep .hd .m { color: #6b6257; font-size: 10px; }
.dep .hd .amt { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 13px; white-space: nowrap; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 3px 7px; border-top: 1px solid #e6e1d8; text-align: left; vertical-align: top; }
th { background: #fbfaf7; font-weight: 600; font-size: 9.5px; color: #6b6257; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
tfoot td { border-top: 1.5px solid #bbb; font-weight: 700; background: #fbfaf7; }
.warn { color: #a33; }
.ok { color: #2a7; }
.small { font-size: 9.5px; color: #777; }
</style></head><body>
<h1>Square 匯款明細</h1>
<div class="sub">KUMAGO 中古家電（（株）グローバルホーム）｜會計年度 2025-07-01 〜 2026-06-30｜產出 tools/square_deposits_report.js</div>

<div class="cards">
  <div class="card"><div class="l">銀行匯款筆數</div><div class="v">${bankTransfers.size} 筆</div></div>
  <div class="card"><div class="l">Square 入金批次</div><div class="v">${inFY.length} 批</div></div>
  <div class="card"><div class="l">刷卡總額</div><div class="v">${yen(totGross)}</div></div>
  <div class="card"><div class="l">手数料</div><div class="v">${yen(totFees)}</div></div>
  <div class="card"><div class="l">實際匯入帳戶</div><div class="v">${yen(totIn)}</div></div>
</div>

<div class="note">
<b>怎麼讀這份表</b>：一個「入金批次」是 Square 把一段期間的刷卡結算後匯一次款。
批次金額＝該批所有刷卡金額扣掉 Square 手数料。每個批次下面列出這筆匯款包含哪些客人的款項。<br>
<b>批次數與銀行匯款筆數不一定相等</b>：Square 偶爾會把兩個批次併成一筆銀行匯款
（本年度發生 1 次，見下方標示）。<br>
<b>銀行對帳</b>：每筆都去公司銀行帳戶明細裡找對應的「振込 スクエア（カ」入金比對金額，結果標在每個批次標題右邊。
</div>
`;

for (const d of inFY) {
  const bankTxt = d.bank
    ? `<span class="ok">✓ 銀行 ${d.bank.iso} 入金 ${yen(d.bank.in)}${d.bankStatus === "與另一批次合併匯款" ? `（與 ${d.mergedWith} 批次合併成一筆）` : ""}</span>`
    : `<span class="warn">✗ 銀行帳戶明細查無對應入金</span>`;
  h += `<div class="dep"><div class="hd">
    <div><span class="d">${d.depDate} 入金</span> <span class="m">${d.items.length} 筆款項｜${bankTxt}</span></div>
    <div class="amt">${yen(d.deposited)}</div></div>
  <table><thead><tr>
    <th style="width:62px">刷卡日</th><th style="width:110px">客人</th><th>內容／品項</th>
    <th class="n" style="width:66px">刷卡金額</th><th class="n" style="width:58px">手数料</th><th class="n" style="width:66px">入帳</th>
  </tr></thead><tbody>`;
  for (const s of d.items) {
    const L = ledger.get(s.txId);
    const desc = L ? (L.note || L.detail || "") : (s.desc && !/任意の金額|Custom Amount$/.test(s.desc) ? s.desc : "");
    const who = (L && L.name) || s.cust || "—";
    const isRefund = s.event === "Refund";
    h += `<tr>
      <td>${md(s.date)}</td>
      <td>${esc(who)}${isRefund ? ' <span class="warn">(退款)</span>' : ""}</td>
      <td>${esc(desc).slice(0, 90) || '<span class="small">（Square 未帶品項）</span>'}</td>
      <td class="n">${yen(s.gross)}</td><td class="n">${yen(s.fees)}</td><td class="n">${yen(s.deposited)}</td></tr>`;
  }
  h += `</tbody><tfoot><tr><td colspan="3">批次合計</td>
    <td class="n">${yen(d.gross)}</td><td class="n">${yen(d.fees)}</td><td class="n">${yen(d.deposited)}</td>
  </tr></tfoot></table></div>`;
}

const nextFY = deposits.filter((d) => d.depDate > FY_END);
if (nextFY.length) {
  h += `<div class="note"><b>下一年度的入金（不列入本期）</b><br>`;
  for (const d of nextFY) {
    h += `${d.depDate} 入金 ${yen(d.deposited)}（${d.items.length} 筆：${d.items.map((s) => esc((ledger.get(s.txId) || {}).name || s.cust)).join("、")}）
    ——刷卡日在本期（${d.items.map((s) => s.date).join("、")}）但入金在下期，銀行明細到 ${FY_END} 為止故查不到。<br>`;
  }
  h += `</div>`;
}

h += `<div class="note small">
資料來源：Square 交易明細（每筆刷卡）、transfer-details（每筆刷卡對應的入金批次）、
公司銀行帳戶總明細（到 2026-06-30，Shift_JIS）。<br>
本表只涵蓋「中古家電」這個 Square 單位。公司銀行帳戶同期另有其他 Square 單位的入金，
不在本表範圍內，對整體帳時請留意。
</div>
</body></html>`;

fs.writeFileSync(OUT, h);
console.log(`入金批次 ${inFY.length}（年度內）／銀行匯款 ${bankTransfers.size} 筆`);
console.log(`刷卡 ${yen(totGross)}／手数料 ${yen(totFees)}／實際入金 ${yen(totIn)}`);
const noBank = inFY.filter((d) => !d.bank);
if (noBank.length) console.log(`⚠️ 銀行查無對應：${noBank.map((d) => d.depDate + " " + yen(d.deposited)).join("、")}`);
console.log(`-> ${OUT}`);
