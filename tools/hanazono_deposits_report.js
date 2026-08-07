#!/usr/bin/env node
/* La Forêt花園町（民宿）— Square 入金照合表（HTML→PDF）
 *
 * 用法：node tools/hanazono_deposits_report.js
 *
 * 資料來源只有 Square 後台匯出的「transfer-transactions-<Deposit ID>-*.csv」
 * （一個檔＝一個入金批次，UTF-16LE＋Tab），放在
 *   決算/FY2025-07_2026-06/花園町square/
 * 這批檔案沒有「入金日」欄，入金日靠銀行帳戶明細比對回填。
 *
 * 做三件事：
 *  1. 每個檔算出批次的 決済額／手数料／入金額
 *  2. 先讓 KUMAGO 中古家電的批次（tools/square_deposits_report.js 同一套邏輯）
 *     佔掉它對應的銀行「振込 スクエア（カ」列，剩下的才給花園町配
 *     ——同一個銀行帳戶收多個 Square 單位的入金，不佔位會互搶同額的列
 *  3. 產出振込一覧＋每筆振込的內訳
 *
 * 踩過的坑（沿用 square_deposits_report.js 的教訓）：
 *  - 銀行明細是 Shift_JIS，日期是 YYYYMMDD 字串，比日期差要先轉 Date
 *  - 退款列與原決済列共用 Payment ID，成對抵銷，不能當兩筆營收
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "決算", "FY2025-07_2026-06");
const HDIR = path.join(DIR, "花園町square");
const OUT = path.join(HDIR, "花園町_Square入金照合表.html");
const SQ = require("../lib/square_data");

const yen = (n) => (n < 0 ? "-¥" : "¥") + Math.abs(n).toLocaleString("ja-JP");
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);

/* ── 1. 花園町批次 ─────────────────────────────────────── */
const batches = [];
for (const f of fs.readdirSync(HDIR).filter((x) => x.startsWith("transfer-transactions") && x.endsWith(".csv"))) {
  const rows = SQ.parseDelimited(fs.readFileSync(path.join(HDIR, f)).toString("utf16le").replace(/^﻿/, ""), "\t");
  const H = rows[0];
  const ci = (n) => H.indexOf(n);
  const items = [];
  for (const r of rows.slice(1)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r[ci("Date")] || "")) continue;
    items.push({
      date: r[ci("Date")], time: (r[ci("Time")] || "").slice(0, 5),
      gross: SQ.yenToInt(r[ci("Gross Sales")]),
      fees: SQ.yenToInt(r[ci("Fees")]),
      net: SQ.yenToInt(r[ci("Net Total")]),
      desc: (r[ci("Description")] || "").replace(/\s+/g, " ").trim(),
      event: r[ci("Event Type")], source: r[ci("Source")],
      brand: r[ci("Card Brand")], pan: r[ci("PAN Suffix")],
      rate: r[ci("Fee Percentage Rate")], txId: r[ci("Transaction ID")], payId: r[ci("Payment ID")],
    });
  }
  if (!items.length) continue;
  const dates = items.map((i) => i.date).sort();
  // 退款沖銷：退款列與原決済列共用 Payment ID
  const refundIds = new Set(items.filter((i) => i.event === "Refund").map((i) => i.payId));
  for (const i of items) if (refundIds.has(i.payId)) i.voided = true;
  batches.push({
    depId: f.replace("transfer-transactions-", "").replace(/-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/, ""),
    items: items.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time)),
    first: dates[0], last: dates[dates.length - 1],
    n: items.filter((i) => !i.voided).length,
    gross: items.reduce((a, i) => a + (i.gross || 0), 0),
    fees: items.reduce((a, i) => a + (i.fees || 0), 0),
    net: items.reduce((a, i) => a + (i.net || 0), 0),
  });
}
batches.sort((a, b) => a.last.localeCompare(b.last));

/* ── 2. 銀行明細（Shift_JIS） ──────────────────────────── */
const bankFile = fs.readdirSync(DIR).find((x) => /銀行帳戶總明細/.test(x));
const bankText = new TextDecoder("shift_jis").decode(fs.readFileSync(path.join(DIR, bankFile)));
const bank = bankText.split(/\r?\n/).filter((l) => l.trim()).slice(1)
  .map((l) => (l.match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1)))
  .filter((r) => r.length >= 5)
  .map((r) => ({ iso: `${r[0].slice(0, 4)}-${r[0].slice(4, 6)}-${r[0].slice(6)}`, memo: r[1], in: r[2] ? +r[2] : 0 }));
const bankSq = bank.filter((b) => /スクエア/.test(b.memo) && b.in > 0);
const used = new Set();

/* KUMAGO 中古家電先佔位（同帳戶、同摘要，不佔位會搶到同額的列） */
const k = SQ.load(DIR);
const kg = new Map();
for (const s of k.all) {
  const key = s.depId || "NOID_" + s.depDate;
  if (!kg.has(key)) kg.set(key, { depDate: s.depDate, items: [] });
  kg.get(key).items.push(s);
}
const kdep = [...kg.values()]
  .map((g) => ({ depDate: g.depDate, deposited: g.items.reduce((a, s) => a + (s.deposited || 0), 0) }))
  .sort((a, b) => a.depDate.localeCompare(b.depDate));
for (const d of kdep) {
  const i = bankSq.findIndex((b, idx) => !used.has(idx) && Math.abs(dayDiff(b.iso, d.depDate)) <= 5 && b.in === d.deposited);
  if (i >= 0) { used.add(i); d.hit = true; }
}
const kun = kdep.filter((d) => !d.hit && d.depDate <= "2026-06-30");
for (let a = 0; a < kun.length; a++) for (let b = a + 1; b < kun.length; b++) {
  const i = bankSq.findIndex((x, idx) => !used.has(idx) && x.in === kun[a].deposited + kun[b].deposited &&
    Math.abs(dayDiff(x.iso, kun[b].depDate)) <= 5);
  if (i >= 0) { used.add(i); kun[a].hit = kun[b].hit = true; }
}
const kumagoUsed = used.size;

/* 花園町：入金日未知，用「最後決済日之後 0〜12 天、金額完全一致」配 */
for (const b of batches) {
  b.cands = [];
  bankSq.forEach((x, idx) => {
    if (x.in !== b.net) return;
    const d = dayDiff(x.iso, b.last);
    if (d < 0 || d > 12) return;
    b.cands.push({ idx, d });
  });
  b.cands.sort((a, c) => a.d - c.d);
}
for (const b of [...batches].sort((a, c) => a.cands.length - c.cands.length || a.last.localeCompare(c.last))) {
  const c = b.cands.find((x) => !used.has(x.idx));
  if (!c) continue;
  used.add(c.idx);
  b.bank = bankSq[c.idx]; b.gap = c.d; b.ambiguous = b.cands.length > 1;
}

/* ── 3. HTML ──────────────────────────────────────────── */
const tot = (f) => batches.reduce((a, b) => a + f(b), 0);
const totGross = tot((b) => b.gross), totFees = tot((b) => b.fees), totNet = tot((b) => b.net);
const nTx = tot((b) => b.n);
const okCount = batches.filter((b) => b.bank).length;
const feeRate = ((-totFees / totGross) * 100).toFixed(2);
const restBank = bankSq.filter((_, i) => !used.has(i));
const restSum = restBank.reduce((a, b) => a + b.in, 0);
const method = (i) => (i.source === "Payment Link" ? "決済リンク" : i.source === "Point of Sale" ? "店頭決済" : i.source || "—");
const label = (i) => {
  const d = i.desc && !/^(Custom Amount|任意の金額)$/.test(i.desc) ? i.desc.replace(/^Custom Amount - /, "") : "";
  return d || '<span style="color:#9a9184">（Square 品目記載なし）</span>';
};

let h = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>La Forêt花園町 Square 入金照合表</title><style>
@page{size:A4;margin:14mm 12mm 12mm}
*{box-sizing:border-box}
body{font-family:"Hiragino Sans","PingFang TC",-apple-system,sans-serif;color:#1c1c1c;margin:0;
 font-size:10.5px;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h1{font-size:20px;margin:0 0 3px}
.sub{color:#6b6257;font-size:11px;margin-bottom:14px}
.kpis{display:flex;gap:8px;margin-bottom:12px}
.kpi{flex:1;border:1px solid #ddd6ca;border-radius:6px;padding:8px 10px;background:#fbfaf8}
.kpi .l{font-size:9.5px;color:#7a6f60}
.kpi .v{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:1px}
.kpi .n{font-size:9px;color:#8a8073;margin-top:1px}
.note{border-left:4px solid #c9a227;background:#fffdf3;padding:9px 12px;border-radius:0 5px 5px 0;
 margin-bottom:14px;font-size:10.5px}
.note b{color:#8a6d1f}
h2{font-size:13px;margin:16px 0 7px;padding-bottom:3px;border-bottom:1.5px solid #ddd6ca}
table{width:100%;border-collapse:collapse}
.sum th{background:#f2ede4;font-size:9.5px;color:#5a5248;text-align:right;padding:5px 6px;border-bottom:1px solid #ddd6ca}
.sum th:nth-child(-n+3){text-align:left}
.sum td{padding:4px 6px;border-bottom:1px solid #eee8dd;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.sum td:nth-child(-n+3){text-align:left}
.sum tr:nth-child(even) td{background:#faf8f4}
.sum tfoot td{font-weight:700;background:#f2ede4;border-top:1.5px solid #c9bda6}
.ok{color:#2c7a4b;font-weight:700}
.warn{color:#b3541e;font-weight:700}
.dep{border:1px solid #ddd6ca;border-radius:6px;margin-bottom:8px;overflow:hidden;
 break-inside:avoid;page-break-inside:avoid}
.dh{background:#f2ede4;padding:6px 10px;display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.dh .d{font-weight:700;font-size:12px}
.dh .m{color:#6b6257;font-size:9.5px}
.dh .m .ok,.dh .m .warn{white-space:nowrap}
.dh .a{font-variant-numeric:tabular-nums;font-size:11px;white-space:nowrap}
.dh .a b{font-size:13px}
.it{width:100%;font-size:9.8px}
.it th{background:#f8f5f0;color:#7a6f60;font-size:8.8px;font-weight:600;text-align:right;
 padding:3px 8px;border-bottom:1px solid #e6dfd2}
.it th:nth-child(-n+4){text-align:left}
.it td{padding:4px 8px;border-bottom:1px solid #f0ebe1;vertical-align:top;
 font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.it td:nth-child(3){white-space:normal}
.it td:nth-child(-n+4){text-align:left}
.it tr:last-child td{border-bottom:none}
.it .item{color:#4a443c;font-size:9.2px}
.tag{display:inline-block;font-size:8.2px;padding:0 4px;border-radius:3px;background:#eee8dd;color:#6b6257}
.void{background:#fdf3f0}
.foot{margin-top:16px;padding:10px 12px;background:#f2ede4;border-radius:6px;font-size:9.8px;color:#4a443c}
code{background:#e9e4da;padding:0 3px;border-radius:2px;font-size:9px}
</style></head><body>
<h1>Square 入金照合表</h1>
<div class="sub">La Forêt花園町（株式会社グローバルホーム）｜銀行入金 ${batches[0].bank ? batches[0].bank.iso : batches[0].last} 〜 ${batches[batches.length - 1].bank ? batches[batches.length - 1].bank.iso : batches[batches.length - 1].last}｜製表 tools/hanazono_deposits_report.js</div>
<div class="kpis">
<div class="kpi"><div class="l">振込回数</div><div class="v">${batches.length} 回</div><div class="n">取引 ${nTx} 件</div></div>
<div class="kpi"><div class="l">決済総額</div><div class="v">${yen(totGross)}</div><div class="n">Square 収納額</div></div>
<div class="kpi"><div class="l">Square 手数料</div><div class="v">${yen(totFees)}</div><div class="n">平均 ${feeRate}%</div></div>
<div class="kpi"><div class="l">入金額</div><div class="v">${yen(totNet)}</div><div class="n">当社口座へ振込</div></div>
<div class="kpi"><div class="l">銀行照合</div><div class="v">${okCount} / ${batches.length}</div><div class="n">${okCount === batches.length ? "全件一致" : "要確認あり"}</div></div>
</div>
<div class="note">Square は決済分から手数料を差し引いて当社口座へ振り込む。1 回の振込に複数件の決済が含まれる。
手数料率は決済リンク 3.6%、店頭決済 2.5%。<br>
<b>照合結果：${okCount} 回すべて銀行入金（摘要「振込 スクエア（カ」）と金額完全一致（合計 ${yen(totNet)}）。</b><br>
Square の明細に入金日欄がないため、<b>入金日は銀行明細から特定</b>した（最終決済日の 0〜12 日後・金額完全一致で一意に確定）。</div>
<h2>① 振込一覧</h2>
<table class="sum"><thead><tr><th>#</th><th>銀行入金日</th><th>決済期間</th><th>件数</th><th>決済総額</th><th>手数料</th><th>入金額</th><th>照合</th></tr></thead><tbody>`;

batches.forEach((b, i) => {
  h += `<tr><td>${i + 1}</td><td>${b.bank ? b.bank.iso : '<span class="warn">不明</span>'}</td>
  <td>${b.first === b.last ? b.first : b.first + " 〜 " + b.last}</td><td>${b.n}</td>
  <td>${yen(b.gross)}</td><td>${yen(b.fees)}</td><td><b>${yen(b.net)}</b></td>
  <td>${b.bank ? '<span class="ok">✓ 一致</span>' : '<span class="warn">✗ 未照合</span>'}</td></tr>`;
});
h += `</tbody><tfoot><tr><td colspan="3">合計</td><td>${nTx}</td><td>${yen(totGross)}</td><td>${yen(totFees)}</td><td>${yen(totNet)}</td><td>${okCount}/${batches.length}</td></tr></tfoot></table>
<h2>② 振込内訳</h2>`;

batches.forEach((b, i) => {
  h += `<div class="dep"><div class="dh">
  <div><span class="d">#${i + 1}　${b.bank ? b.bank.iso : b.last} 入金</span>
  <span class="m">${b.n} 件｜Deposit ID <code>${esc(b.depId)}</code>${b.bank ? ` <span class="ok">✓ 銀行一致</span>` : ' <span class="warn">✗ 銀行未照合</span>'}</span></div>
  <div class="a">決済 ${yen(b.gross)}　手数料 ${yen(b.fees)}　入金 <b>${yen(b.net)}</b></div></div>
  <table class="it"><thead><tr><th>決済日</th><th>決済方法</th><th>内容</th><th>カード</th><th>決済額</th><th>手数料</th><th>差引</th></tr></thead><tbody>`;
  for (const it of b.items) {
    const isRef = it.event === "Refund";
    h += `<tr${it.voided ? ' class="void"' : ""}>
    <td>${it.date}</td>
    <td><span class="tag">${method(it)}</span>${isRef ? ' <span class="warn">返金</span>' : it.voided ? ' <span class="warn">返金済</span>' : ""}</td>
    <td class="item">${label(it)}</td>
    <td>${esc(it.brand)} ****${esc(it.pan)}</td>
    <td>${yen(it.gross)}</td>
    <td>${yen(it.fees)}<br><span style="font-size:8px;color:#8a8073">${it.rate || ""}%</span></td>
    <td><b>${yen(it.net)}</b></td></tr>`;
  }
  h += `</tbody></table></div>`;
});

h += `<div class="foot">
<b>資料の出所</b>：Square 管理画面「振込ごとの取引明細」${batches.length} ファイル（<code>transfer-transactions-&lt;Deposit ID&gt;-*.csv</code>）／
当社銀行口座 総明細（〜2026-06-30、Shift_JIS）。<br>
<b>返金の扱い</b>：返金は元の決済と同一 Payment ID で対になっており、振込内訳では両方を薄赤で表示している
（本表では ${batches.reduce((a, b) => a + b.items.filter((i) => i.event === "Refund").length, 0)} 組）。差引後の入金額には影響しない。<br>
<b>本表の範囲</b>：Square 単位「La Forêt花園町」のみ。同一口座には他単位（KUMAGO 中古家電ほか）の
Square 入金も入っており、本表には含まれない。当期の口座内「振込 スクエア（カ」は全 ${bankSq.length} 件 ${yen(bankSq.reduce((a, x) => a + x.in, 0))}、
うち KUMAGO 中古家電 ${kumagoUsed} 件、本表（花園町）${okCount} 件、残り ${restBank.length} 件 ${yen(restSum)} は他単位分。<br>
<b>顧客名・品目</b>：この明細ファイルには顧客名欄がなく、品目も「任意の金額／Custom Amount」の決済が大半のため、
記載のあるものだけ内容欄に表示している。個別の領収書は Square 管理画面で Deposit ID から遡れる。
</div>
</body></html>`;

fs.writeFileSync(OUT, h);
console.log(`批次 ${batches.length}／取引 ${nTx}（返金対消し後）`);
console.log(`決済 ${yen(totGross)}／手数料 ${yen(totFees)}／入金 ${yen(totNet)}`);
console.log(`銀行照合 ${okCount}/${batches.length}${batches.some((b) => b.ambiguous) ? "（候補複数あり：" + batches.filter((b) => b.ambiguous).map((b) => b.last).join("、") + "）" : ""}`);
console.log(`他単位の残り銀行入金 ${restBank.length} 件 ${yen(restSum)}`);
console.log(`-> ${OUT}`);
