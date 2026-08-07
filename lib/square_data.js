/* KUMAGO — Square 決算資料讀取與配對（給 tools/export_tax_ledger.js 與
 * tools/reconcile_square.js 共用，避免兩邊配對邏輯各自漂移）。
 *
 * 三份來源檔（都在 決算/<年度>/，Square 後台匯出，UTF-16LE + Tab 分隔）：
 *   Square交易明細_*.csv      每筆刷卡：金額、手数料、卡別、客戶名、品項描述
 *   transfer-details-*.csv    每筆刷卡對應的入金：Deposited（實際匯進公司帳戶）、Deposit ID
 *   transfer-transactions-*   每個入金批次的細目（與上面重複，本模組不讀）
 *
 * 注意：transfer-details 是依「入金日」篩選匯出的，所以年度最後幾天刷卡、
 * 跨月才入金的交易不會在裡面（實測 2 筆）。那幾筆改用 Square交易明細 自帶的
 * Deposit Date / Net Total 補上，不會漏。
 */
const fs = require("fs");
const path = require("path");

/* 支援引號內分隔符與換行的解析（Square 的 Description 欄有內嵌換行）。 */
function parseDelimited(text, delim) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* Square 匯出的金額長這樣：¥55,080 / -¥1,983 / ¥0。負號在 ¥ 前面。 */
function yenToInt(s) {
  const str = String(s || "").trim();
  const m = str.replace(/,/g, "").match(/(\d+)/);
  if (!m) return null;
  return (str.includes("-") ? -1 : 1) * parseInt(m[1], 10);
}

function readUtf16(p) {
  return fs.readFileSync(p).toString("utf16le").replace(/^﻿/, "");
}

/* 目錄裡找符合前綴的檔（檔名帶日期，不寫死）。 */
function findFile(dir, prefix) {
  const hit = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".csv"));
  return hit.length ? path.join(dir, hit.sort().pop()) : null;
}

/* 載入並合併。回 { txns, byTxId, refunds, voided, totals }。
 * txns = 有效收款（已排除退款列與被退掉的原交易）。 */
function load(dir) {
  const sqPath = findFile(dir, "Square交易明細");
  if (!sqPath) throw new Error("找不到 Square交易明細_*.csv：" + dir);
  const rows = parseDelimited(readUtf16(sqPath), "\t");
  const H = rows[0];
  const ci = (n) => H.indexOf(n);

  const all = [];
  for (const r of rows.slice(1)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r[ci("Date")] || "")) continue;
    all.push({
      date: r[ci("Date")], time: r[ci("Time")] || "",
      gross: yenToInt(r[ci("Gross Sales")]),
      fees: yenToInt(r[ci("Fees")]),
      net: yenToInt(r[ci("Net Total")]),
      source: r[ci("Source")] || "", brand: r[ci("Card Brand")] || "",
      desc: (r[ci("Description")] || "").replace(/\s+/g, " ").trim(),
      event: r[ci("Event Type")] || "", cust: r[ci("Customer Name")] || "",
      depDate: r[ci("Deposit Date")] || "", depId: "",
      deposited: null,
      txId: r[ci("Transaction ID")] || "", payId: r[ci("Payment ID")] || "",
    });
  }
  all.sort((a, b) => a.date.localeCompare(b.date));

  // 入金明細：實際匯進公司帳戶的金額
  const tdPath = findFile(dir, "transfer-details");
  if (tdPath) {
    const t = parseDelimited(readUtf16(tdPath), "\t");
    const TH = t[0];
    const ti = (n) => TH.indexOf(n);
    const map = new Map();
    for (const r of t.slice(1)) {
      const id = r[ti("Transaction ID")];
      if (!id) continue;
      map.set(id, {
        deposited: yenToInt(r[ti("Deposited")]),
        depId: r[ti("Deposit ID")] || "",
        depDate: r[ti("Deposit Date")] || "",
      });
    }
    for (const s of all) {
      const d = map.get(s.txId);
      if (d) { s.deposited = d.deposited; s.depId = d.depId; s.depDate = d.depDate || s.depDate; }
    }
  }
  // 入金明細沒涵蓋的（年度末刷卡、跨月入金）用 Square 自帶的 Net Total 補
  for (const s of all) if (s.deposited === null) s.deposited = s.net;

  // 退款沖銷：退款列與原收款列共用 Payment ID
  const refunds = all.filter((s) => s.event === "Refund");
  const refundedIds = new Set(refunds.map((s) => s.payId).filter(Boolean));
  const voided = all.filter((s) => s.event !== "Refund" && refundedIds.has(s.payId));
  const txns = all.filter((s) => s.event !== "Refund" && !refundedIds.has(s.payId));

  const sum = (a, f) => a.reduce((x, y) => x + (f(y) || 0), 0);
  return {
    all, txns, refunds, voided,
    byTxId: new Map(all.map((s) => [s.txId, s])),
    totals: {
      gross: sum(txns, (s) => s.gross),
      fees: sum(all, (s) => s.fees),
      net: sum(all, (s) => s.net),
      deposited: sum(all, (s) => s.deposited),
      voided: sum(voided, (s) => s.gross),
    },
    files: { sqPath, tdPath },
  };
}

const norm = (s) => String(s || "").replace(/[\s　・,，()（）]/g, "").toLowerCase();

/* Square 客戶名 vs 清單客戶名/內容。中文取連續 2 字命中；羅馬拼音要求各段皆命中。 */
function nameMatch(sqName, hayRaw) {
  const n = norm(sqName);
  if (!n || n.includes("@") || n.length < 2) return false;
  const hay = norm(hayRaw);
  if (!hay) return false;
  if (n.length >= 3 && hay.includes(n)) return true;
  if (/^[a-z\s]+$/i.test(sqName)) {
    const parts = sqName.toLowerCase().split(/\s+/).filter((x) => x.length >= 3);
    return parts.length > 0 && parts.every((p) => hay.includes(p));
  }
  for (let i = 0; i + 2 <= n.length; i++) if (hay.includes(n.slice(i, i + 2))) return true;
  return false;
}

const dayDiff = (a, b) => Math.round((new Date(a + "T00:00:00Z") - new Date(b + "T00:00:00Z")) / 86400000);

/* 兩段式配對：先「姓名＋金額」（最可靠），再「金額＋最近日期」。
 * 單靠金額會亂配，因為方案價格（¥55,080 等）會重複出現。
 *
 * 日期容差必須不對稱，這是實測踩出來的：
 *   prepay  = 刷卡日早於配送日。客人常在海外先付款、兩三個月後才入住，要放寬。
 *   postpay = 刷卡日晚於配送日。先配送後收錢頂多隔幾週，放寬會把幾個月後
 *             另一位客人的同額交易亂配過來（實測 2025-07-31 的事件被配到 11 月的交易）。
 *
 * ledgerRows 需有 { date, amount, name, detail }；配對結果寫回 row.square / txn.ledger。 */
function matchToLedger(txns, ledgerRows, opts = {}) {
  const {
    namePrepayDays = 365, namePostpayDays = 60,
    amountPrepayDays = 180, amountPostpayDays = 30,
  } = opts;

  for (const s of txns) s.ledger = null;
  for (const l of ledgerRows) l.square = null;

  const pass = (requireName, prepay, postpay) => {
    const cands = [];
    for (const s of txns) {
      if (s.ledger) continue;
      for (const l of ledgerRows) {
        if (l.square || l.amount !== s.gross) continue;
        const d = dayDiff(l.date, s.date); // 正 = 先付款後配送
        if (d > prepay || d < -postpay) continue;
        const nm = nameMatch(s.cust, l.name + " " + l.detail);
        if (requireName && !nm) continue;
        cands.push({ s, l, absd: Math.abs(d), d, nm });
      }
    }
    cands.sort((a, b) => (b.nm - a.nm) || (a.absd - b.absd));
    for (const c of cands) {
      if (c.s.ledger || c.l.square) continue;
      c.s.ledger = c.l; c.l.square = c.s;
      c.s.dayGap = c.d; c.s.via = c.nm ? "姓名+金額" : "金額+日期";
    }
  };
  pass(true, namePrepayDays, namePostpayDays);
  pass(false, amountPrepayDays, amountPostpayDays);

  return {
    matched: txns.filter((s) => s.ledger),
    sqUnmatched: txns.filter((s) => !s.ledger),
    ledgerUnmatched: ledgerRows.filter((l) => !l.square),
  };
}

module.exports = { load, parseDelimited, yenToInt, nameMatch, matchToLedger, dayDiff };
