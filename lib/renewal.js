/* KUMAGO — 續租（renewal）流程。
 *
 * 產生連結：tools/create_renewal_link.js 建一張帶 kumago_renewal=1 metadata 的
 * Stripe Checkout（金額自訂，不走網站價目表）。付款後 api/stripe-webhook.js
 * 轉進本模組，走續租流程而非新訂單流程：
 *   1. 建全天【續租】紀錄事件（冪等 id = sha1(session id)，同新訂單公式，
 *      所以 webhook 既有的 kumago_notified 去重直接沿用）。
 *      標題絕不含「配送 / 到期 / 回收」——lib/recovery.js 的 classify() 按標題
 *      關鍵字分類，含了會被防漏報表誤抓。
 *   2. 把既有【到期】事件（meta.expiry_event_id）延到新到期日，並在說明
 *      開頭記一行續租紀錄。到期日往後移之後，每週防漏報表自然改按新日期提醒。
 *   3. 寄老闆＋客人續租確認信（lib/mailer.js sendRenewalEmails）。
 *   4. Telegram 即時推播老闆；任何一步失敗會在推播裡標 ⚠️。
 * 與新訂單同一韌性契約：任何一步失敗都不 throw、不讓 Stripe 重試。
 *
 * 到期日慣例與 lib/gcal.js buildExpiryEvent 相同：起算日 + 月數 − 1 天
 * （2026-07-18 起續半年 → 2027-01-17 到期）。
 */

const {
  insertEvent, getEvent, patchEvent, orderEventId, jstToday,
} = require("./gcal.js");
const { sendRenewalEmails } = require("./mailer.js");
const { sendTelegram } = require("./telegram.js");

const PLAN_NAME = { A: "A 套組", B: "B 套組", C: "C 套組" };

function yen(n) {
  return "¥" + Number(n || 0).toLocaleString("ja-JP");
}

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/* 起算日 + 月數 − 1 天（同 buildExpiryEvent 的租期慣例）。回 null = 輸入不可用。 */
function computeNewExpiry(startDate, months) {
  const m = parseInt(months, 10);
  if (!isRealDate(startDate) || !m || m <= 0) return null;
  const d = new Date(`${startDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + m);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/* 把 metadata + line items 攤平成續租視圖（對齊 mailer.js orderView 的欄位習慣）。
 * new_expiry 一律由 renewal_start + renewal_months 重算，metadata 值僅作備援——
 * 產連結工具與 webhook 之間不可能不同步。 */
function renewalView(meta, lineItems, amountTotal) {
  meta = meta || {};
  const items = (Array.isArray(lineItems) ? lineItems : []).map((li) => ({
    label: li.description || (li.price && li.price.product) || "—",
    amount: li.amount_total != null ? li.amount_total : (li.amount || 0),
  }));
  const total =
    amountTotal != null ? amountTotal : items.reduce((s, i) => s + i.amount, 0);
  const months = parseInt(meta.renewal_months, 10) || 0;
  return {
    name: meta.customer_name || "",
    contact: meta.customer_contact || "",
    phone: meta.customer_phone || "",
    lineName: meta.line_display_name || "",
    lineUserId: meta.line_user_id || "",
    planName: PLAN_NAME[meta.plan] || meta.plan || "",
    duration: meta.duration || (months ? `${months}個月` : ""),
    months,
    renewalStart: meta.renewal_start || "",
    newExpiry:
      computeNewExpiry(meta.renewal_start, months) || meta.new_expiry || "",
    expiryEventId: meta.expiry_event_id || "",
    postal: meta.postal || "",
    address: meta.address || "",
    itemsNote: meta.items_note || "",
    note: meta.note || "",
    lang: meta.lang || "zh",
    items,
    total,
  };
}

/* 全天【續租】紀錄事件（放在續租起算日）。回 null = 日期不可用。 */
function buildRenewalRecordEvent(v) {
  if (!isRealDate(v.renewalStart)) return null;
  const next = new Date(Date.parse(`${v.renewalStart}T00:00:00Z`) + 86400000)
    .toISOString().slice(0, 10);
  const nameTag = v.lineName ? `${v.name}（${v.lineName}）` : v.name;
  const fullAddr = `${v.postal ? "〒" + v.postal + " " : ""}${v.address}`.trim();
  return {
    summary: `【續租】${nameTag} ${v.planName}×${v.duration} ${yen(v.total)}`,
    description: [
      "🐻 KUMAGO 續租紀錄",
      "",
      `【方案】${v.planName} × ${v.duration}（續租）`,
      `【金額（已付款）】${yen(v.total)}`,
      `【新租期】${v.renewalStart.replace(/-/g, "/")} - ${v.newExpiry.replace(/-/g, "/")}`,
      v.itemsNote ? `【品項】${v.itemsNote}` : null,
      "",
      "── 客人 ──",
      `姓名：${v.name}`,
      v.lineName ? `LINE 名稱：${v.lineName}` : null,
      v.lineUserId ? `LINE userId：${v.lineUserId}` : null,
      v.contact ? `聯絡：${v.contact}` : null,
      v.phone && v.phone !== v.contact ? `電話：${v.phone}` : null,
      fullAddr ? `地址：${fullAddr}` : null,
      v.note ? "" : null,
      v.note ? "── 備註 ──" : null,
      v.note || null,
      "",
      "（本事件由續租付款自動建立；同名【到期】事件已順延至新到期日）",
    ].filter((l) => l !== null).join("\n"),
    start: { date: v.renewalStart },
    end: { date: next },
    reminders: { useDefault: false, overrides: [] },
  };
}

/* 既有【到期】事件的 PATCH 內容：日期移到新到期日、說明開頭記一行續租、
 * 標題補「＋續租 X」（重複續租不重複補）。oldEvent = getEvent() 的原事件。 */
function buildExpiryEventPatch(oldEvent, v, paidDateISO) {
  if (!isRealDate(v.newExpiry)) return null;
  const next = new Date(Date.parse(`${v.newExpiry}T00:00:00Z`) + 86400000)
    .toISOString().slice(0, 10);
  const stamp =
    `🔁 ${paidDateISO} 已續租${v.duration}（${yen(v.total)}）：` +
    `新到期日 ${v.newExpiry.replace(/-/g, "/")}`;
  const oldDesc = (oldEvent && oldEvent.description) || "";
  const oldSummary = (oldEvent && oldEvent.summary) || "";
  const patch = {
    start: { date: v.newExpiry },
    end: { date: next },
    description: stamp + (oldDesc ? "\n" + oldDesc : ""),
  };
  if (oldSummary && !oldSummary.includes("續租")) {
    patch.summary = `${oldSummary}＋續租${v.duration}`;
  }
  return patch;
}

/* Telegram 續租推播（HTML，同 buildOrderPush 的 parse_mode）。 */
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildRenewalPush(v, warnings) {
  const e = escapeHtml;
  const lines = [
    "<b>KUMAGO 續租・已付款 🔁</b>",
    "",
    v.name ? `姓名：${e(v.name)}` : null,
    v.lineName ? `LINE：${e(v.lineName)}` : null,
    v.contact ? `聯絡：${e(v.contact)}` : null,
    v.phone && v.phone !== v.contact ? `電話：${e(v.phone)}` : null,
    v.address ? `地址：${e((v.postal ? "〒" + v.postal + " " : "") + v.address)}` : null,
    "",
    `方案：${e(v.planName)} × ${e(v.duration)}（續租）`,
    v.itemsNote ? `品項：${e(v.itemsNote)}` : null,
    `新租期：${e(v.renewalStart)} ~ ${e(v.newExpiry)}`,
    `合計（已付款）：${yen(v.total)}`,
    v.note ? `備註：${e(v.note)}` : null,
  ].filter((l) => l !== null);
  let text = lines.join("\n");
  if (warnings && warnings.length) {
    text = `⚠️ ${warnings.map(e).join("；")}\n\n` + text;
  }
  return text;
}

/* 續租付款主流程（webhook 呼叫）。永不 throw，回報告物件。 */
async function handleRenewal(session, meta, lineItems, amountTotal) {
  const report = {
    record: { created: false, errors: [] },
    expiry: { patched: false, errors: [] },
    emails: { owner: false, customer: false, skipped: false, errors: [] },
    telegram: { sent: false, errors: [] },
  };
  const v = renewalView(meta, lineItems, amountTotal);
  const recordId = orderEventId(session.id);

  // 1. 【續租】紀錄事件（冪等 upsert）
  try {
    const ev = buildRenewalRecordEvent(v);
    if (!ev) {
      report.record.errors.push("invalid_renewal_start: " + (v.renewalStart || "(empty)"));
    } else if (recordId) {
      const r = await insertEvent(ev, recordId);
      report.record.created = true;
      report.record.duplicate = !!r.duplicate;
    }
  } catch (e) {
    report.record.errors.push(e.message);
  }

  // 2. 延長既有【到期】事件
  if (!v.expiryEventId) {
    report.expiry.errors.push("no_expiry_event_id");
  } else {
    try {
      const old = await getEvent(v.expiryEventId);
      if (!old) {
        report.expiry.errors.push("expiry_event_not_found: " + v.expiryEventId);
      } else {
        const patch = buildExpiryEventPatch(old, v, jstToday());
        if (!patch) {
          report.expiry.errors.push("invalid_new_expiry: " + (v.newExpiry || "(empty)"));
        } else {
          await patchEvent(v.expiryEventId, patch);
          report.expiry.patched = true;
        }
      }
    } catch (e) {
      report.expiry.errors.push(e.message);
    }
  }

  // 3. 確認信（老闆＋客人）
  try {
    report.emails = await sendRenewalEmails(v);
  } catch (e) {
    report.emails.errors.push(e.message);
  }

  // 4. Telegram 推播（帶上前面各步的失敗警告，老闆才看得到要人工補什麼）
  try {
    const warnings = [];
    if (report.record.errors.length)
      warnings.push(`續租紀錄事件未建立（${report.record.errors[0]}），請手動處理`);
    if (report.expiry.errors.length)
      warnings.push(`到期事件未順延（${report.expiry.errors[0]}），請手動改到 ${v.newExpiry || "新到期日"}`);
    if (report.emails.errors.length)
      warnings.push(`通知信寄送有問題：${report.emails.errors.join("；")}`);
    await sendTelegram(buildRenewalPush(v, warnings));
    report.telegram.sent = true;
  } catch (e) {
    report.telegram.errors.push(e.message);
  }

  // 5. 標記已通知（同新訂單的 kumago_notified 去重旗標）
  if (recordId && report.record.created) {
    try {
      await patchEvent(recordId, { extendedProperties: { private: { kumago_notified: "1" } } });
    } catch (e) {
      report.record.errors.push("set_notified_failed: " + e.message);
    }
  }

  return report;
}

module.exports = {
  computeNewExpiry,
  renewalView,
  buildRenewalRecordEvent,
  buildExpiryEventPatch,
  buildRenewalPush,
  handleRenewal,
};
