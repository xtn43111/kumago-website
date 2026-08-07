/* La Forêt花園町（民宿）Square 決算資料共用讀取層
 *
 * 兩個工具共用，避免配對邏輯各自漂移：
 *   tools/hanazono_deposits_report.js   入金照合表（振込 × 銀行）
 *   tools/hanazono_booking_reconcile.js 月曆訂房 × Square 收款 合併明細
 *
 * 資料在 決算/FY2025-07_2026-06/花園町square/：
 *   transfer-transactions-<Deposit ID>-*.csv  一檔＝一入金批次（UTF-16LE＋Tab）
 *   花園町square明細-*.csv                    每筆刷卡（含 Customer Name、Deposit ID/Date）
 *   花園町_月曆訂房_*.md                       Google 行事曆訂房事件整理
 *
 * 坑：
 *  - 銀行明細是 Shift_JIS，日期是 YYYYMMDD 字串，比日期差要先轉 Date
 *  - 退款列與原決済列共用 Payment ID，必須成對抵銷
 *  - 同一個銀行帳戶收多個 Square 單位的入金，配銀行前要先讓 KUMAGO 佔位
 */
const fs = require("fs");
const path = require("path");
const SQ = require("./square_data");

const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);
const readUtf16 = (p) => fs.readFileSync(p).toString("utf16le").replace(/^﻿/, "");

/* ── 入金批次（transfer-transactions-*.csv，一檔一批） ── */
function loadBatches(hdir) {
  const batches = [];
  for (const f of fs.readdirSync(hdir).filter((x) => x.startsWith("transfer-transactions") && x.endsWith(".csv"))) {
    const rows = SQ.parseDelimited(readUtf16(path.join(hdir, f)), "\t");
    const H = rows[0];
    const ci = (n) => H.indexOf(n);
    const items = [];
    for (const r of rows.slice(1)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r[ci("Date")] || "")) continue;
      items.push({
        date: r[ci("Date")], time: (r[ci("Time")] || "").slice(0, 5),
        gross: SQ.yenToInt(r[ci("Gross Sales")]), fees: SQ.yenToInt(r[ci("Fees")]),
        net: SQ.yenToInt(r[ci("Net Total")]),
        desc: (r[ci("Description")] || "").replace(/\s+/g, " ").trim(),
        event: r[ci("Event Type")], source: r[ci("Source")],
        brand: r[ci("Card Brand")], pan: r[ci("PAN Suffix")],
        rate: r[ci("Fee Percentage Rate")], txId: r[ci("Transaction ID")], payId: r[ci("Payment ID")],
      });
    }
    if (!items.length) continue;
    const refundIds = new Set(items.filter((i) => i.event === "Refund").map((i) => i.payId));
    for (const i of items) if (refundIds.has(i.payId)) i.voided = true;
    const dates = items.map((i) => i.date).sort();
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
  return batches.sort((a, b) => a.last.localeCompare(b.last));
}

/* ── 每筆刷卡明細（花園町square明細-*.csv，有 Customer Name 與 Deposit Date） ── */
function loadPayments(hdir) {
  const f = fs.readdirSync(hdir).find((x) => /^花園町square明細.*\.csv$/.test(x));
  if (!f) return [];
  const rows = SQ.parseDelimited(readUtf16(path.join(hdir, f)), "\t");
  const H = rows[0];
  const ci = (n) => H.indexOf(n);
  const all = [];
  for (const r of rows.slice(1)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r[ci("Date")] || "")) continue;
    all.push({
      date: r[ci("Date")], time: (r[ci("Time")] || "").slice(0, 5),
      gross: SQ.yenToInt(r[ci("Gross Sales")]), fees: SQ.yenToInt(r[ci("Fees")]),
      net: SQ.yenToInt(r[ci("Net Total")]),
      desc: (r[ci("Description")] || "").replace(/\s+/g, " ").trim(),
      event: r[ci("Event Type")], source: r[ci("Source")],
      brand: r[ci("Card Brand")], pan: r[ci("PAN Suffix")],
      cust: (r[ci("Customer Name")] || "").trim(),
      rate: r[ci("Fee Percentage Rate")],
      depId: r[ci("Deposit ID")] || "", depDate: r[ci("Deposit Date")] || "",
      txId: r[ci("Transaction ID")], payId: r[ci("Payment ID")],
    });
  }
  const refundIds = new Set(all.filter((i) => i.event === "Refund").map((i) => i.payId));
  for (const i of all) if (refundIds.has(i.payId)) i.voided = true;
  return all.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}

/* 明細檔是依刷卡日匯出的（本期從 2025-07-01 起），入金批次裡卻可能有上期刷卡、
 * 本期入金的交易（實測 1 筆：2025-06-26 刷卡、2025-07-04 入金）。以「實際入帳」
 * 為主的報表要把這種補進來，總額才會等於銀行收到的錢。 */
function mergeBatchOnlyPayments(payments, batches) {
  const have = new Set(payments.map((p) => p.txId));
  const extra = [];
  for (const b of batches) {
    for (const i of b.items) {
      if (have.has(i.txId)) continue;
      extra.push({ ...i, cust: "", depId: b.depId, depDate: b.bank ? b.bank.iso : "", fromBatch: true });
    }
  }
  return payments.concat(extra).sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""));
}

/* ── 銀行帳戶明細（Shift_JIS） ── */
function loadBankSquare(dir) {
  const f = fs.readdirSync(dir).find((x) => /銀行帳戶總明細/.test(x));
  if (!f) return [];
  const text = new TextDecoder("shift_jis").decode(fs.readFileSync(path.join(dir, f)));
  return text.split(/\r?\n/).filter((l) => l.trim()).slice(1)
    .map((l) => (l.match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1)))
    .filter((r) => r.length >= 5)
    .map((r) => ({ iso: `${r[0].slice(0, 4)}-${r[0].slice(4, 6)}-${r[0].slice(6)}`, memo: r[1], in: r[2] ? +r[2] : 0 }))
    .filter((b) => /スクエア/.test(b.memo) && b.in > 0);
}

/* KUMAGO 中古家電的批次先佔住它那些銀行列（同帳戶、同摘要，不佔位會互搶同額列）。
 * 回傳被佔用的 index Set。 */
function reserveKumagoBankRows(dir, bankSq, fyEnd = "2026-06-30") {
  const used = new Set();
  let k;
  try { k = SQ.load(dir); } catch { return used; }
  const g = new Map();
  for (const s of k.all) {
    const key = s.depId || "NOID_" + s.depDate;
    if (!g.has(key)) g.set(key, { depDate: s.depDate, items: [] });
    g.get(key).items.push(s);
  }
  const dep = [...g.values()]
    .map((x) => ({ depDate: x.depDate, deposited: x.items.reduce((a, s) => a + (s.deposited || 0), 0) }))
    .sort((a, b) => a.depDate.localeCompare(b.depDate));
  for (const d of dep) {
    const i = bankSq.findIndex((b, idx) => !used.has(idx) && Math.abs(dayDiff(b.iso, d.depDate)) <= 5 && b.in === d.deposited);
    if (i >= 0) { used.add(i); d.hit = true; }
  }
  const un = dep.filter((d) => !d.hit && d.depDate <= fyEnd);
  for (let a = 0; a < un.length; a++) for (let b = a + 1; b < un.length; b++) {
    const i = bankSq.findIndex((x, idx) => !used.has(idx) && x.in === un[a].deposited + un[b].deposited &&
      Math.abs(dayDiff(x.iso, un[b].depDate)) <= 5);
    if (i >= 0) { used.add(i); un[a].hit = un[b].hit = true; }
  }
  return used;
}

/* 花園町批次 → 銀行入金列。批次檔沒有入金日欄，用「最終決済日之後 0〜12 天、
 * 金額完全一致」反推；結果寫回 batch.bank / batch.gap / batch.ambiguous。 */
function matchBatchesToBank(batches, bankSq, used = new Set()) {
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
  return used;
}

/* ── 月曆訂房 MD ──
 * 兩種格式都吃，優先用逐筆明細版（花園町訂房紀錄-*.md）：
 *   1. 逐筆明細版：`### 入住 → 退房（N 晚）｜房型` 開頭的區塊，含 🔗 組合 標記與未來訂房
 *   2. 舊表格版（花園町_月曆訂房_*.md）：每月一張 Markdown 表
 * 明細版涵蓋 2026-07 之後的未來訂房，本期刷卡先收的訂金／全額才配得到訂房。 */
function loadBookings(hdir) {
  const files = fs.readdirSync(hdir);
  const detail = files.find((x) => /^花園町訂房紀錄.*\.md$/.test(x));
  if (detail) {
    const g = loadBookingsDetail(path.join(hdir, detail));
    const tt = files.find((x) => /^花園町TimeTree事件.*\.md$/.test(x));
    return tt ? g.concat(loadTimeTreeOnly(path.join(hdir, tt), g).filter((e) => e.amount && !e.dropped))
      .sort((a, b) => a.checkin.localeCompare(b.checkin)) : g;
  }
  const f = files.find((x) => /^花園町_月曆訂房.*\.md$/.test(x));
  if (!f) return [];
  const lines = fs.readFileSync(path.join(hdir, f), "utf8").split(/\r?\n/);
  const out = [];
  let month = "";
  for (const line of lines) {
    const mh = line.match(/^##\s+(\d{4}-\d{2})/);
    if (mh) { month = mh[1]; continue; }
    const c = line.split("|").map((s) => s.trim());
    if (c.length < 8) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c[2] || "")) continue;
    const title = c[5] || "";
    const desc = c[7] || "";
    const room = (desc.match(/\[room\]\s*([^\/<]+)/) || [])[1];
    out.push({
      month, checkin: c[2], checkout: c[3], nights: +c[4] || 0,
      title, room: (room || "").trim(),
      created: c[6] || "",
      amount: titleAmount(title),
      guest: titleGuest(title),
      card: /💳/.test(title),
    });
  }
  return out.sort((a, b) => a.checkin.localeCompare(b.checkin));
}

/* 逐筆明細版 MD（docs/花園町訂房紀錄-*.md）。一個 `###` 區塊＝一筆月曆事件。 */
function loadBookingsDetail(file) {
  const out = [];
  for (const blk of fs.readFileSync(file, "utf8").split(/\n(?=### )/).slice(1)) {
    const h = blk.match(/^### (\d{4}-\d{2}-\d{2}) → (\d{4}-\d{2}-\d{2})（(\d+) 晚）｜([^\n]*)/);
    if (!h) continue;                                   // 統計摘要那幾個 ### 小節
    const [, checkin, checkout, nights, head] = h;
    const title = ((blk.match(/\*\*標題原文\*\*：(.*)/) || [])[1] || "").trim();
    const room = ((blk.match(/\[room\]\s*(.+)/) || [])[1] || head.replace(/\s*🔗.*$/, "")).trim();
    out.push({
      month: checkin.slice(0, 7), checkin, checkout, nights: +nights,
      title, room,
      combo: /🔗\s*組合/.test(head),                     // 同一單佔多房，月曆記成多筆同名事件
      eventId: (blk.match(/事件 id：`([^`]+)`/) || [])[1] || "",
      timetreeId: (blk.match(/\[timetree_id\]\s*([0-9a-f]{32})/) || [])[1] || "",
      created: (blk.match(/建立 (\d{4}-\d{2}-\d{2})/) || [])[1] || "",
      amount: titleAmount(title),
      guest: titleGuest(title),
      card: /💳/.test(title),
    });
  }
  return out.sort((a, b) => a.checkin.localeCompare(b.checkin));
}

/* TimeTree 原始月曆（docs/花園町TimeTree事件-*.md，2025-01 起 296 筆）。
 * Google 月曆是 2025-07 才從 TimeTree 遷過來的，所以 TimeTree 是超集合：
 *   - 2025-01〜06 的舊訂房（本期入金的上期刷卡要靠它才認得出客人）
 *   - 沒同步過去的事件（取消單、託賣／不上傳／不計）
 * 去重兩條路：Google 側的 [timetree_id] 對 TimeTree uuid（遷移進來的），
 * TimeTree 側備註的 [sync:gcal=<id>] 對 Google 事件 id（遷移後在 Google 開、反向同步的）。
 * TimeTree 全天事件的 end 是「最後一晚」，退房日要 +1 天才跟 Google 側對得起來。 */
function loadTimeTreeOnly(file, gBookings) {
  const gTT = new Set(gBookings.map((b) => b.timetreeId).filter(Boolean));
  const gEid = new Set(gBookings.map((b) => b.eventId).filter(Boolean));
  const out = [];
  for (const blk of fs.readFileSync(file, "utf8").split(/\n(?=### )/).slice(1)) {
    const title = blk.split("\n")[0].replace(/^###\s*/, "").trim();
    const per = (blk.match(/- 期間：(.*)/) || [])[1] || "";
    const days = [...per.matchAll(/(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
    if (!days.length) continue;
    const uuid = (blk.match(/uuid：`([^`]+)`/) || [])[1] || "";
    const note = (blk.match(/```\n([\s\S]*?)```/) || [])[1] || "";
    const sync = (note.match(/sync:gcal=([a-z0-9]+)/) || [])[1] || "";
    if (gTT.has(uuid) || (sync && gEid.has(sync))) continue;      // Google 側已有同一筆
    const allday = /全天/.test(per);
    const end = days[1] || days[0];
    const checkout = allday ? new Date(new Date(end + "T00:00:00Z").getTime() + 86400000).toISOString().slice(0, 10) : end;
    const noteAmt = +((note.match(/金額[:：]\s*[¥￥]?([\d,]+)/) || [])[1] || "").replace(/,/g, "") || null;
    out.push({
      month: days[0].slice(0, 7), checkin: days[0], checkout,
      nights: Math.max(0, Math.round((new Date(checkout) - new Date(days[0])) / 86400000)),
      title, room: "", combo: false, src: "timetree",
      label: (blk.match(/label_id：(\d+)/) || [])[1] || "",
      uuid,
      /* 取消／託賣／不上傳／不計＝老闆自己標明不算花園町這邊的收入，不進配對池，
       * 但留著在報表列出來，才知道這筆錢為什麼沒有對應收款。 */
      dropped: /取消|託賣|代售|不上傳|不計/.test(title) ? title.match(/取消|託賣|代售|不上傳|不計/)[0] : "",
      amount: titleAmount(title) || noteAmt,
      guest: titleGuest(title),
      card: /💳/.test(title),
    });
  }
  return out;
}

/* 標題記帳慣例：「尾¥157470」「尾刷卡¥143,000」「¥26250」「尾¥46,912」。
 * 括號內的房號、手環數字不是金額，所以只認 ¥ 開頭且 4 位數以上的數。
 *
 * 沒寫 ¥ 的也要抓（實測漏掉真實收款）：「尾116,310」「¥已全付清72860」「booking LIN YUTA 140,653」。
 * 這種只認 5 位數以上，才不會把手環數／床數／房號當金額。
 * 台幣計價（「尾台幣32000」「已付清18934元台幣」）不是日圓，一律不給金額——
 * 給了會拿去跟 Square 的日圓比對，配出假的一致。 */
function titleAmount(title) {
  const t = String(title);
  if (/台幣|台币|NT\$|TWD|元台/.test(t)) return null;
  const hits = [...t.matchAll(/[¥￥]\s?([\d,]{4,})/g)].map((m) => +m[1].replace(/,/g, ""));
  if (hits.length) {
    const tail = t.match(/尾(?:刷卡)?\s*[¥￥]\s?([\d,]{4,})/);
    return tail ? +tail[1].replace(/,/g, "") : hits[0];
  }
  const loose = [...t.matchAll(/(?<![\d,])(\d{1,3}(?:,\d{3})+|\d{5,})(?![\d,])/g)]
    .map((m) => +m[1].replace(/,/g, ""))
    .filter((n) => n >= 10000);
  return loose.length ? loose[0] : null;
}

/* 客人名：去掉房型、emoji、金額與括號註記後剩下的字。純顯示用，不參與配對判定。 */
function titleGuest(title) {
  let t = String(title)
    .replace(/[¥￥]\s?[\d,]+/g, "")
    .replace(/尾(刷卡)?/g, "")
    .replace(/（[^）]*）|\([^)]*\)/g, "")
    .replace(/包棟|寬敞房|寬敞套房|雙人房|P套房|續住|升級|加\d*床|\+\d*床|互惠|已全付清|已付清|無需付款/g, "")
    .replace(/(?<![\d,])(\d{1,3}(?:,\d{3})+|\d{5,})(?![\d,])/g, "")   // 沒寫 ¥ 的金額
    .replace(/[🛏️💳⚠️✅🚗🍤🐟🌧️🐯🎂🎁🏠]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/^[+＋、,．.・\-—　]+|[+＋、,．.・\-—　]+$/g, "")
    .trim();
  return t || "—";
}

/* 訂房 × 刷卡配對。金額完全一致優先，日期取離入住日最近的。
 * 民宿的收款慣例是入住當天或退房前後刷尾款，偶有提前刷；容差取
 * 入住前 120 天 〜 退房後 45 天。 */
function matchBookingsToPayments(bookings, payments, opts = {}) {
  const { beforeCheckin = 120, afterCheckout = 45, nearMatch = true } = opts;
  const pays = payments.filter((p) => p.event !== "Refund" && !p.voided);
  for (const b of bookings) b.pay = null;
  for (const p of pays) p.booking = null;

  const cands = [];
  for (const b of bookings) {
    if (!b.amount) continue;
    for (const p of pays) {
      if (p.gross !== b.amount) continue;
      const before = dayDiff(b.checkin, p.date);   // 正 = 入住前先刷
      const after = dayDiff(p.date, b.checkout);   // 正 = 退房後才刷
      if (before > beforeCheckin || after > afterCheckout) continue;
      cands.push({ b, p, score: Math.abs(dayDiff(p.date, b.checkin)) });
    }
  }
  cands.sort((a, b) => a.score - b.score);
  for (const c of cands) {
    if (c.b.pay || c.p.booking) continue;
    c.b.pay = c.p; c.p.booking = c.b; c.b.gap = dayDiff(c.p.date, c.b.checkin);
    c.b.how = "金額一致";
  }

  /* 差額配對：**同一天**刷卡、差額 ≤¥3,000 且 ≤3%，兩邊都還沒配對才算。
   * 只有這種「刷卡日就是入住日、差一點點」才敢認（實測全期只吃到 2 筆：一筆差 ¥100，
   * Square 客戶名的羅馬拼音就是月曆上那位客人；另一筆差 ¥3,000，像手環押金）。
   * 放寬到 ±7 天或 5% 就會把別位客人的訂金吸進來，那條路已經退回過。 */
  if (nearMatch) {
    const near = [];
    for (const b of bookings) {
      if (b.pay || !b.amount) continue;
      for (const p of pays) {
        if (p.booking) continue;
        const gap = Math.min(Math.abs(dayDiff(p.date, b.checkin)), Math.abs(dayDiff(p.date, b.checkout)));
        const diff = Math.abs(p.gross - b.amount);
        if (gap > 1 || diff > 3000 || diff > b.amount * 0.03) continue;
        near.push({ b, p, gap, diff });
      }
    }
    near.sort((a, c) => a.gap - c.gap || a.diff - c.diff);
    for (const c of near) {
      if (c.b.pay || c.p.booking) continue;
      c.b.pay = c.p; c.p.booking = c.b; c.b.gap = dayDiff(c.p.date, c.b.checkin);
      c.b.how = "差額配對"; c.b.nearDiff = c.p.gross - c.b.amount;
    }
  }

  /* 同一筆訂房拆成多個房型事件（「寬敞+雙人」會在月曆各記一筆，金額寫同一個尾款）。
   * 已配對的那筆算收款，其餘標成共用同一筆收款，不重複計。 */
  for (const b of bookings) {
    if (b.pay || !b.amount) continue;
    const twin = bookings.find((x) => x.pay && !x.sharedWith && x.amount === b.amount &&
      (x.checkin === b.checkin || (b.combo && x.combo && x.title === b.title)));
    if (twin) { b.pay = twin.pay; b.sharedWith = twin; b.how = "同筆訂房分列（共用收款）"; }
  }

  /* 金額對不上的不強配——實測用「日期近＋差額小」或姓名相似去硬配，會把隔幾天
   * 另一位客人的訂金配到這筆訂房上（Square 的 Customer Name 一半是空的，中文名
   * 與羅馬拼音混用，姓名比對誤判率高）。只留「候補提示」給人工判斷，不算配對。 */
  for (const b of bookings) {
    if (b.pay || !b.amount) continue;
    let best = null;
    for (const p of pays) {
      if (p.booking) continue;
      const g = Math.min(Math.abs(dayDiff(p.date, b.checkin)), Math.abs(dayDiff(p.date, b.checkout)));
      if (g > 7) continue;
      const diff = Math.abs(p.gross - b.amount);
      if (diff > Math.max(5000, b.amount * 0.05)) continue;
      if (!best || g < best.g) best = { p, g, diff };
    }
    if (best) b.suggest = { pay: best.p, diff: best.p.gross - b.amount, gap: best.g };
  }

  return {
    matched: bookings.filter((b) => b.pay),
    bookingsUnpaid: bookings.filter((b) => !b.pay),
    paymentsUnmatched: pays.filter((p) => !p.booking),
  };
}

module.exports = {
  loadBatches, loadPayments, mergeBatchOnlyPayments, loadBankSquare, reserveKumagoBankRows, matchBatchesToBank,
  loadBookings, loadBookingsDetail, loadTimeTreeOnly, matchBookingsToPayments, titleAmount, titleGuest, dayDiff,
};
