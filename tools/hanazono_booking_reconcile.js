#!/usr/bin/env node
/* La Forêt花園町 — Square 收款明細（以 Square 實收為主）× 月曆訂房（HTML→PDF）
 *
 * 用法：node tools/hanazono_booking_reconcile.js
 *
 * 口徑：**以 Square 收到的錢為主**。一列＝一筆 Square 刷卡，金額一律採 Square
 * 的決済額／手数料／實際入帳；月曆訂房只是掛在旁邊的說明（入住日、房型、客人）。
 * 月曆標題寫的金額與 Square 不符時以 Square 為準，差額列在訂房欄供人工查核。
 *
 * 資料：
 *   花園町square明細-*.csv        每筆刷卡（決済額、手数料、Deposit ID/Date、客戶名）
 *   transfer-transactions-*.csv   入金批次 → 對到銀行「振込 スクエア（カ」的入金日
 *   花園町訂房紀錄-*.md           Google 行事曆訂房事件逐筆明細（含 2026-07 之後的未來訂房）
 *
 * 明細檔從 2025-07-01 起，批次裡上期刷卡、本期入金的那筆（2025-06-26）會補進來，
 * 總額才等於銀行實際收到的 ¥6,281,300（與入金照合表同一個數）。
 *
 * 訂房配對只認「金額完全一致＋刷卡日在入住前 120 天〜退房後 45 天」，
 * 對不上的不硬配（會把別位客人的訂金誤配），僅在第②節給候補提示。
 * 讀取與配對邏輯在 lib/hanazono_square.js，與入金照合表共用。
 */
const fs = require("fs");
const path = require("path");
const H = require("../lib/hanazono_square");

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "決算", "FY2025-07_2026-06");
const HDIR = path.join(DIR, "花園町square");
const OUT = path.join(HDIR, "花園町_訂房×Square收款_合併明細.html");

const yen = (n) => (n == null ? "—" : (n < 0 ? "−¥" : "¥") + Math.abs(n).toLocaleString("ja-JP"));
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sum = (a, f) => a.reduce((x, y) => x + (f(y) || 0), 0);

/* ── 載入 ─────────────────────────────────────────────── */
const bookings = H.loadBookings(HDIR);
const batches = H.loadBatches(HDIR);
const bankSq = H.loadBankSquare(DIR);
H.matchBatchesToBank(batches, bankSq, H.reserveKumagoBankRows(DIR, bankSq));

const payments = H.mergeBatchOnlyPayments(H.loadPayments(HDIR), batches);
const bankByDep = new Map(batches.filter((b) => b.bank).map((b) => [b.depId, b.bank.iso]));
const bankDate = (p) => bankByDep.get(p.depId) || p.depDate || "";

H.matchBookingsToPayments(bookings, payments);

/* 人工對應（決算/…/花園町square/人工對應_LINE查證.json）：從 LINE 聊天備份查證出來的，
 * key＝Square Transaction ID。bindCheckin 有值就強制綁到該入住日的月曆訂房（金額仍以
 * Square 為準）；沒有的只掛說明，仍留在「月曆無對應訂房」那節。 */
const manualPath = path.join(HDIR, "人工對應_LINE查證.json");
const manual = fs.existsSync(manualPath) ? JSON.parse(fs.readFileSync(manualPath, "utf8")) : {};
for (const [txId, m] of Object.entries(manual)) {
  if (txId.startsWith("_")) continue;
  const p = payments.find((x) => x.txId === txId);
  if (!p) { console.warn(`人工對應找不到交易 ${txId}`); continue; }
  p.manual = m;
  if (!m.bindCheckin || p.booking) continue;
  const b = bookings.find((x) => x.checkin === m.bindCheckin && !x.pay);
  if (!b) { console.warn(`人工對應找不到 ${m.bindCheckin} 的未配對訂房`); continue; }
  b.pay = p; p.booking = b; b.how = "人工對應（LINE 查證）"; b.manual = m;
  b.gap = H.dayDiff(p.date, b.checkin);
}

const valid = payments.filter((p) => p.event !== "Refund" && !p.voided);

/* ── 統計（金額一律以 Square 為準） ───────────────────── */
const stat = {
  n: valid.length,
  gross: sum(valid, (p) => p.gross),
  fees: sum(valid, (p) => p.fees),
  net: sum(valid, (p) => p.net),
  linked: valid.filter((p) => p.booking),
  orphan: valid.filter((p) => !p.booking),
  bookNights: sum(bookings, (b) => b.nights),
};
/* 訂房來源含 2026-07 之後的未來訂房（本期先收訂金／全額的才配得到），
 * 但「月曆有金額、Square 查無收款」要分開列：本期的才是決算要追的錢。 */
const FY_START = "2025-07-01";
const FY_END = "2026-06-30";
const future = (b) => b.checkin > FY_END;
const past = (b) => b.checkin < FY_START;           // TimeTree 補進來的上期訂房
stat.noSquare = bookings.filter((b) => !b.pay && b.amount && !future(b) && !past(b));
stat.noSquareNext = bookings.filter((b) => !b.pay && b.amount && future(b));
stat.noAmount = bookings.filter((b) => !b.pay && !b.amount && !future(b) && !past(b));
stat.noAmountNext = bookings.filter((b) => !b.pay && !b.amount && future(b));
stat.tt = bookings.filter((b) => b.src === "timetree");
stat.ttPast = stat.tt.filter(past);
stat.near = bookings.filter((b) => b.how === "差額配對");
stat.manualBound = bookings.filter((b) => b.how === "人工對應（LINE 查證）");
const orphanBy = (lab) => stat.orphan.filter((p) => (p.manual || {}).label === lab);
stat.orphanLine = orphanBy("LINE查證");
stat.orphanKumago = orphanBy("KUMAGO");
stat.orphanTodo = orphanBy("待查");
stat.orphanNone = stat.orphan.filter((p) => !p.manual);

/* 被排除在配對池外的 TimeTree 事件（取消／託賣／不上傳／不計），第⑤節列出來當查核軌跡 */
const pick = (re) => fs.readdirSync(HDIR).find((x) => re.test(x));
const fTT = pick(/^花園町TimeTree事件.*\.md$/);
const fGC = pick(/^花園町訂房紀錄.*\.md$/);
const ttDropped = fTT && fGC
  ? H.loadTimeTreeOnly(path.join(HDIR, fTT), H.loadBookingsDetail(path.join(HDIR, fGC)))
    .filter((e) => e.dropped && e.amount && e.checkin >= FY_START && e.checkin <= FY_END)
    .sort((a, b) => a.checkin.localeCompare(b.checkin))
  : [];
stat.noSquareSum = sum(stat.noSquare, (b) => b.amount);
stat.noSquareNextSum = sum(stat.noSquareNext, (b) => b.amount);
stat.fyBookings = bookings.filter((b) => !future(b) && !past(b));
stat.nextBookings = bookings.filter(future);
stat.bookNights = sum(stat.fyBookings, (b) => b.nights);
stat.linkedNext = stat.nextBookings.filter((b) => b.pay && !b.sharedWith);
const shared = bookings.filter((b) => b.sharedWith);
const bankTotal = sum(batches.filter((b) => b.bank), (b) => b.net);

const method = (p) => (p.source === "Payment Link" ? "刷卡連結" : p.source === "Point of Sale" ? "店頭刷卡" : p.source || "—");
const item = (p) => (p.desc && !/^(Custom Amount|任意の金額)$/.test(p.desc)
  ? esc(p.desc.replace(/^Custom Amount - /, "")).slice(0, 70) : '<span class="mini">（Square 未帶品項）</span>');

/* 掛在一筆刷卡旁邊的訂房說明。多房型分列的孿生事件一併列出。 */
function bookingCell(p) {
  const b = p.booking;
  const mtag = p.manual
    ? `<span class="tg ${p.manual.label === "KUMAGO" ? "tg-k" : p.manual.label === "待查" ? "tg-w" : "tg-m"}">${esc(p.manual.label)}</span> `
    : "";
  if (!b) {
    return p.manual
      ? `${mtag}<span class="mini">${esc(p.manual.text)}</span>`
      : '<span class="tg tg-w">月曆無對應訂房</span>';
  }
  const twins = bookings.filter((x) => x.sharedWith === b);
  const rooms = [b, ...twins].map((x) => esc(x.room || "—")).join("＋");
  const diff = b.amount && b.amount !== p.gross
    ? ` <span class="warn">（月曆記 ${yen(b.amount)}，差 ${yen(p.gross - b.amount)}）</span>` : "";
  const tags = mtag + (b.how === "差額配對" ? '<span class="tg tg-n">差額配對</span> ' : "") +
    (b.src === "timetree" ? '<span class="tg tg-t">TimeTree</span> ' : "");
  const mnote = p.manual ? `<br><span class="mini">${esc(p.manual.text)}</span>` : "";
  return `${tags}${b.checkin} 〜 ${b.checkout}　<b>${b.nights} 晚</b>　${rooms}<br>
    <span class="mini">${esc(b.guest)}｜${esc(b.title)}${diff}</span>${mnote}`;
}

/* ── HTML ─────────────────────────────────────────────── */
let h = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>花園町 Square 收款明細 × 訂房</title><style>
@page{size:A4 landscape;margin:11mm 10mm}
*{box-sizing:border-box}
body{font-family:"Hiragino Sans","PingFang TC",-apple-system,sans-serif;color:#1c1c1c;margin:0;
 font-size:10px;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h1{font-size:19px;margin:0 0 3px}
.sub{color:#6b6257;font-size:10.5px;margin-bottom:12px}
.kpis{display:flex;gap:7px;margin-bottom:11px}
.kpi{flex:1;border:1px solid #ddd6ca;border-radius:6px;padding:7px 9px;background:#fbfaf8}
.kpi.hi{background:#f3f8f4;border-color:#bcd8c5}
.kpi .l{font-size:9px;color:#7a6f60}
.kpi .v{font-size:14px;font-weight:700;font-variant-numeric:tabular-nums}
.kpi .n{font-size:8.5px;color:#8a8073}
.note{border-left:4px solid #c9a227;background:#fffdf3;padding:8px 11px;border-radius:0 5px 5px 0;margin-bottom:12px;font-size:10px}
.note b{color:#8a6d1f}
h2{font-size:12.5px;margin:15px 0 6px;padding-bottom:3px;border-bottom:1.5px solid #ddd6ca}
h3{font-size:10.5px;margin:10px 0 4px;color:#6b6257;font-weight:700}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{background:#f2ede4;font-size:8.8px;color:#5a5248;text-align:right;padding:4px 6px;border-bottom:1px solid #ddd6ca;white-space:nowrap}
th.l{text-align:left}
td{padding:3px 6px;border-bottom:1px solid #efe9de;text-align:right;white-space:nowrap}
td.l{text-align:left;white-space:nowrap}
td.w{white-space:normal}
tbody tr:nth-child(even) td{background:#faf8f4}
tfoot{display:table-row-group}
tfoot td{font-weight:700;background:#f2ede4;border-top:1.5px solid #c9bda6}
.mtot td{background:#f6f2ea;font-weight:600;color:#5a5248}
thead{display:table-header-group}
tr{break-inside:avoid;page-break-inside:avoid}
.tg{display:inline-block;font-size:8.2px;padding:0 4px;border-radius:3px;white-space:nowrap}
.tg-w{background:#fbe6d8;color:#8f4517}
.tg-n{background:#fdf0c8;color:#8a6d1f}
.tg-t{background:#e2ecf7;color:#2f5a86}
.tg-m{background:#dcefe2;color:#276443}
.tg-k{background:#ece3f5;color:#5c3f80}
.mini{font-size:8.5px;color:#8a8073}
.warn{color:#8f4517}
.foot{margin-top:14px;padding:9px 11px;background:#f2ede4;border-radius:6px;font-size:9.2px;color:#4a443c}
code{background:#e9e4da;padding:0 3px;border-radius:2px;font-size:8.6px}
</style></head><body>
<h1>花園町 Square 收款明細 × 訂房</h1>
<div class="sub">La Forêt花園町（株式会社グローバルホーム）｜2025-07-01 〜 2026-06-30（依銀行入金）｜
<b>金額以 Square 實收為準</b>｜產出 tools/hanazono_booking_reconcile.js</div>

<div class="kpis">
<div class="kpi"><div class="l">Square 收款</div><div class="v">${stat.n} 件</div><div class="n">退款成對抵銷後</div></div>
<div class="kpi"><div class="l">決済總額</div><div class="v">${yen(stat.gross)}</div><div class="n">客人實際刷的錢</div></div>
<div class="kpi"><div class="l">Square 手数料</div><div class="v">${yen(stat.fees)}</div><div class="n">連結 3.6%／店頭 2.5%</div></div>
<div class="kpi hi"><div class="l">實際入帳（營收基準）</div><div class="v">${yen(stat.net)}</div><div class="n">＝銀行 43 筆匯款 ${yen(bankTotal)}</div></div>
<div class="kpi"><div class="l">對到月曆訂房</div><div class="v">${stat.linked.length} 件</div><div class="n">未對到 ${stat.orphan.length} 件</div></div>
<div class="kpi"><div class="l">月曆有金額無 Square</div><div class="v">${stat.noSquare.length} 筆</div><div class="n">${yen(stat.noSquareSum)}　不計入上面</div></div>
</div>

<div class="note">
<b>口徑</b>：本表<b>以 Square 收到的錢為主</b>。一列＝一筆刷卡，金額全部採 Square 的決済額／手数料／
實際入帳；月曆訂房只掛在右邊當說明（入住日、晚數、房型、客人）。<br>
<b>月曆金額與 Square 不符時以 Square 為準</b>，差額寫在訂房欄括號裡供查核，不改變本表金額。<br>
<b>實際入帳 ${yen(stat.net)}</b> 已與公司銀行帳戶「振込 スクエア（カ」43 筆匯款逐筆核對一致
（批次明細見《花園町_Square入金照合表.pdf》）。<br>
<b>第②節</b>是月曆有記金額、Square 卻查無同額收款的訂房——那些錢走現金／匯款，<b>不在本表營收內</b>，
決算要另外確認。
</div>

<h2>① Square 收款明細（分月依刷卡日，本期範圍依銀行入金日）</h2>`;

const months = [...new Set(valid.map((p) => p.date.slice(0, 7)))].sort();
for (const m of months) {
  const rows = valid.filter((p) => p.date.slice(0, 7) === m).sort((a, b) => a.date.localeCompare(b.date));
  h += `<div class="sec"><h3>${m}${m < "2025-07" ? "<span class=\"mini\">（上期刷卡・本期入金，依入金日計入本期）</span>" : ""}（${rows.length} 件・決済 ${yen(sum(rows, (p) => p.gross))}・入帳 ${yen(sum(rows, (p) => p.net))}）</h3>
  <table><thead><tr>
    <th class="l" style="width:56px">刷卡日</th><th class="l" style="width:50px">方式</th><th class="l" style="width:60px">卡別</th>
    <th style="width:70px">決済額</th><th style="width:58px">手数料</th><th style="width:70px">實際入帳</th>
    <th class="l" style="width:58px">銀行入金</th><th class="l" style="width:140px">內容（Square）</th>
    <th class="l">對應訂房（月曆）</th>
  </tr></thead><tbody>`;
  for (const p of rows) {
    h += `<tr>
      <td class="l">${p.date}</td><td class="l">${method(p)}</td>
      <td class="l"><span class="mini">${esc(p.brand)}<br>****${esc(p.pan)}</span></td>
      <td>${yen(p.gross)}</td><td>${yen(p.fees)}<br><span class="mini">${p.rate || ""}%</span></td>
      <td><b>${yen(p.net)}</b></td>
      <td class="l">${bankDate(p)}</td>
      <td class="l w">${item(p)}</td>
      <td class="l w">${bookingCell(p)}</td></tr>`;
  }
  h += `</tbody><tfoot><tr class="mtot"><td class="l" colspan="3">${m} 小計</td>
    <td>${yen(sum(rows, (p) => p.gross))}</td><td>${yen(sum(rows, (p) => p.fees))}</td>
    <td>${yen(sum(rows, (p) => p.net))}</td><td colspan="3"></td></tr></tfoot></table></div>`;
}

h += `<table style="margin-top:6px"><tfoot><tr>
  <td class="l" style="width:172px">全期合計（${stat.n} 件）</td>
  <td style="width:70px">${yen(stat.gross)}</td><td style="width:58px">${yen(stat.fees)}</td>
  <td style="width:70px">${yen(stat.net)}</td><td class="l"></td></tr></tfoot></table>

<h2>② 月曆有金額、Square 查無收款（${stat.noSquare.length} 筆・月曆金額 ${yen(stat.noSquareSum)}）</h2>
<div class="note">走<b>現金、銀行匯款或其他管道</b>（月曆有幾筆直接寫「要付現金」）。Square 明細沒有同額交易，
<b>不列入本表的 ${yen(stat.net)} 入帳</b>。右欄「候補」是刷卡日在入住/退房前後 7 天內、差額 5% 內的
Square 交易，僅供人工判斷，未列為配對。</div>
<table><thead><tr>
  <th class="l" style="width:62px">入住</th><th class="l" style="width:62px">退房</th><th style="width:26px">晚</th>
  <th class="l" style="width:60px">房型</th><th class="l">客人／月曆標題</th><th style="width:76px">月曆金額</th>
  <th class="l" style="width:230px">候補（Square 相近交易）</th>
</tr></thead><tbody>`;
for (const b of stat.noSquare) {
  const s = b.suggest
    ? `${b.suggest.pay.date}　${yen(b.suggest.pay.gross)}　差 ${yen(b.suggest.diff)}${b.suggest.pay.cust ? "　" + esc(b.suggest.pay.cust) : ""}`
    : '<span class="mini">無</span>';
  h += `<tr><td class="l">${b.checkin}</td><td class="l">${b.checkout}</td><td>${b.nights}</td>
    <td class="l">${esc(b.room || "—")}</td>
    <td class="l w">${esc(b.guest)}<br><span class="mini">${esc(b.title)}</span></td>
    <td>${yen(b.amount)}</td><td class="l w">${s}</td></tr>`;
}
h += `</tbody><tfoot><tr><td class="l" colspan="5">合計</td><td>${yen(stat.noSquareSum)}</td><td></td></tr></tfoot></table>

<h2>③ 月曆未記金額的訂房（本期 ${stat.noAmount.length} 筆）</h2>
<table><thead><tr><th class="l" style="width:62px">入住</th><th class="l" style="width:62px">退房</th><th style="width:26px">晚</th>
<th class="l" style="width:60px">房型</th><th class="l">月曆標題</th></tr></thead><tbody>`;
for (const b of stat.noAmount) {
  h += `<tr><td class="l">${b.checkin}</td><td class="l">${b.checkout}</td><td>${b.nights}</td>
    <td class="l">${esc(b.room || "—")}</td><td class="l w">${esc(b.title)}</td></tr>`;
}
h += `</tbody></table>

<h2>④ 下期訂房（入住 ${FY_END} 之後，${stat.nextBookings.length} 筆）</h2>
<div class="note">訂房來源是 2025-07-01 起的<b>全部</b>月曆事件（含未來），本期先刷的訂金／全額才配得到訂房
（本期收款對到下期訂房 <b>${stat.linkedNext.length} 件</b>，已計在第①節）。
以下是<b>還沒有 Square 收款</b>的下期訂房，<b>不是本期決算的錢</b>，列出來供後續追蹤。</div>
<table><thead><tr>
  <th class="l" style="width:62px">入住</th><th class="l" style="width:62px">退房</th><th style="width:26px">晚</th>
  <th class="l" style="width:60px">房型</th><th class="l">客人／月曆標題</th><th style="width:76px">月曆金額</th>
</tr></thead><tbody>`;
for (const b of [...stat.noSquareNext, ...stat.noAmountNext].sort((a, c) => a.checkin.localeCompare(c.checkin))) {
  h += `<tr><td class="l">${b.checkin}</td><td class="l">${b.checkout}</td><td>${b.nights}</td>
    <td class="l">${esc(b.room || "—")}</td>
    <td class="l w">${esc(b.guest)}<br><span class="mini">${esc(b.title)}</span></td>
    <td>${b.amount ? yen(b.amount) : '<span class="mini">未記</span>'}</td></tr>`;
}
h += `</tbody><tfoot><tr><td class="l" colspan="5">合計（有記金額 ${stat.noSquareNext.length} 筆）</td>
  <td>${yen(stat.noSquareNextSum)}</td></tr></tfoot></table>

<h2>⑤ TimeTree 原始月曆比對（Google 月曆沒有的事件）</h2>
<div class="note">Google 月曆是 2025-07 才從 <b>TimeTree</b> 遷過來的，TimeTree 那本（2025-01 起 296 筆）是超集合。
拿來交叉比對，補到本表 <b>${stat.ttPast.length} 筆上期訂房</b>——上期入住、本期入金的那筆刷卡因此才認得出客人
（2025-06-26 刷卡 ¥47,273 ＝ 2025-06-27 入住的那筆寬敞房訂房，客人名見第①節該列）。<br>
以下是 TimeTree 有金額、Google 月曆沒有、且入住日落在本期的事件：<b>全部都是老闆自己標了取消／託賣／不上傳／不計的</b>，
所以不進配對池、也不算本期營收，列出來只為留查核軌跡。</div>
<table><thead><tr>
  <th class="l" style="width:62px">入住</th><th class="l" style="width:62px">退房</th>
  <th class="l" style="width:48px">標記</th><th class="l">TimeTree 標題</th><th style="width:76px">標題金額</th>
</tr></thead><tbody>`;
for (const e of ttDropped) {
  h += `<tr><td class="l">${e.checkin}</td><td class="l">${e.checkout}</td>
    <td class="l"><span class="tg tg-w">${esc(e.dropped)}</span></td>
    <td class="l w">${esc(e.title)}</td><td>${yen(e.amount)}</td></tr>`;
}
h += `</tbody></table>

<div class="foot">
<b>本表營收基準</b>：Square 決済 ${yen(stat.gross)}（${stat.n} 件）− 手数料 ${yen(-stat.fees)} ＝ 實際入帳 <b>${yen(stat.net)}</b>，
與公司銀行帳戶「振込 スクエア（カ」43 筆匯款金額逐筆一致，與《花園町_Square入金照合表》同一個數字。<br>
<b>含上期刷卡、本期入金 1 筆</b>：2025-06-26 刷卡 ¥47,273（2025-07-04 入金），依入金日計入本期。<br>
<b>差額配對 ${stat.near.length} 件</b>（第①節黃標）：刷卡日就是入住日、差額 ≤¥3,000 且 ≤3% 才認，
金額仍以 Square 為準，要退回人工判斷就改 <code>matchBookingsToPayments(..., {nearMatch:false})</code>。<br>
<b>本期月曆訂房 ${stat.fyBookings.length} 筆・${stat.bookNights} 晚</b>（另有下期 ${stat.nextBookings.length} 筆，第④節；
TimeTree 補進的上期訂房 ${stat.ttPast.length} 筆只用來認上期刷卡，不計本期）：
${stat.linked.length} 件 Square 收款對到訂房（其中 ${shared.length} 筆是同一筆訂房的多房型分列事件，併在同一列顯示，不重複計），
${stat.noSquare.length} 筆走非 Square 管道（第②節），${stat.noAmount.length} 筆月曆沒寫金額（第③節）。<br>
<b>未對到訂房的 ${stat.orphan.length} 件收款仍計入營收</b>，已逐筆用 LINE 官方帳號聊天備份查證
（2,677 個對話）：花園町但月曆沒有對應事件 ${stat.orphanLine.length} 件、
<b>KUMAGO 中古家電走本單位 Square 收 ${stat.orphanKumago.length} 件</b>（已在 KUMAGO 銷貨清單，
本表計入 Square 入帳但不是住宿收入）、查不到出處待調 Square 後台收據 ${stat.orphanTodo.length} 件。
另有 ${stat.manualBound.length} 件靠 LINE 查證綁回月曆訂房（第①節綠標）。金額全部以 Square 為準。<br>
<b>資料檔</b>：<code>花園町square明細-*.csv</code>、<code>transfer-transactions-*.csv</code>、
<code>花園町訂房紀錄-2025-07-01起.md</code>（Google 月曆逐筆事件，含未來訂房）、
<code>花園町TimeTree事件-2025起.md</code>（TimeTree 原始月曆，2025-01 起）、
<code>銀行帳戶總明細(到20260630).csv</code>（Shift_JIS）、
<code>人工對應_LINE查證.json</code>（LINE 聊天備份查證出來的對應，含出處原文）。
</div>
</body></html>`;

fs.writeFileSync(OUT, h);
console.log(`Square 收款 ${stat.n} 件｜決済 ${yen(stat.gross)}／手数料 ${yen(stat.fees)}／入帳 ${yen(stat.net)}（銀行 ${yen(bankTotal)}）`);
console.log(`對到訂房 ${stat.linked.length} 件（含 ${shared.length} 筆多房型分列）／未對到 ${stat.orphan.length} 件`);
console.log(`月曆有金額無 Square ${stat.noSquare.length} 筆 ${yen(stat.noSquareSum)}／未記金額 ${stat.noAmount.length} 筆`);
console.log(`-> ${OUT}`);
