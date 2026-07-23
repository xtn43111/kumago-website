/* KUMAGO — 家電傢俱「買斷」付款後續流程（webhook 分支）。
 *
 * tools/create_buyout_link.js 產生的付款連結 metadata 帶 kumago_buyout=1，
 * 付款完成後 api/stripe-webhook.js 走這裡。買斷＝客人把租用中的家電傢俱直接
 * 買下，付清後物品歸客人所有，沒有配送、沒有回收、沒有到期。所以：
 *   1. 在店家行事曆建【買斷（費用已付）】全天事件（付款當天 JST，純記帳＋去重）。
 *      冪等 id = sha1(session id)，同其他分支。標題含「買斷」不含「回收/到期」，
 *      不會被 lib/recovery.js 防漏報表或到期通知誤抓。
 *   2. 有 line_user_id 就 LINE 推播客人付款確認（沒有就 skip，不算錯）。
 *   3. 寄確認信（lib/mailer.js sendBuyoutEmails：老闆＋客人；客人 email 拿不到
 *      就 skip，不算錯）。
 *   4. Telegram 即時通知老闆（帶上前面步驟的失敗警告）。
 *
 * 韌性契約同其他分支：任何一步失敗都不能讓 Stripe 重試個沒完——款已收。
 */
"use strict";

const { insertEvent, patchEvent, orderEventId } = require("./gcal.js");
const { sendLinePush } = require("./line_push.js");
const { sendTelegram } = require("./telegram.js");
const { sendBuyoutEmails } = require("./mailer.js");

function yen(n) {
  return n == null ? "?" : "¥" + Number(n).toLocaleString("ja-JP");
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* 付款當天的 JST 日期（YYYY-MM-DD）。買斷沒有指定日，記在付款當天即可。 */
function todayJST() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10);
}

/* metadata → 檢視物件。JPY 無小數，amount_total 直接是日圓整數。 */
function buyoutView(meta, amountTotal) {
  const m = meta || {};
  return {
    name: m.customer_name || "",
    phone: m.customer_phone || m.checkout_phone || "",
    email: m.customer_email || "",
    items: m.items_note || "",
    note: m.note || "",
    lineUserId: m.line_user_id || "",
    lineName: m.line_display_name || "",
    amount: amountTotal,
  };
}

/* 【買斷】行事曆事件（全天，付款當天）。永遠建得起來（日期用今天）。 */
function buildBuyoutPaidEvent(v) {
  const day = todayJST();
  const next = new Date(new Date(`${day}T00:00:00Z`).getTime() + 86400000)
    .toISOString()
    .slice(0, 10);

  const descLines = [
    "🐻 KUMAGO 家電傢俱買斷（款項已刷卡付清）",
    "",
    `【姓名】${v.name}`,
    v.lineName ? `【LINE 名稱】${v.lineName}` : null,
    v.lineUserId ? `【LINE userId】${v.lineUserId}` : null,
    v.phone ? `【電話】${v.phone}` : null,
    v.items ? `【買斷品項】${v.items}` : null,
    `【買斷金額】${yen(v.amount)}（已付・Stripe）`,
    v.note ? `【備註】${v.note}` : null,
    "",
    "＊買斷物品已歸客人所有，不需回收、不需列入到期。",
  ].filter((l) => l !== null);

  return {
    // 標題含「買斷」，明確排除「回收/到期」關鍵字，防漏報表與到期通知都不會誤抓。
    summary: `${v.name}${v.lineName ? `（${v.lineName}）` : ""} 家電傢俱買斷（費用已付）`,
    description: descLines.join("\n"),
    start: { date: day },
    end: { date: next },
    reminders: { useDefault: false, overrides: [] },
  };
}

/* 客人 LINE 付款確認文字。 */
function buildBuyoutPaidLineText(v) {
  return [
    "🐻 KUMAGO 已收到您的買斷款項，謝謝！",
    "",
    `金額：${yen(v.amount)}`,
    v.items ? `品項：${v.items}` : null,
    "",
    "付清後該物品歸您所有，無需再回收。",
  ].filter((l) => l !== null).join("\n");
}

/* 老闆 Telegram 推播（HTML）。 */
function buildBuyoutPaidPush(v, warnings) {
  const lines = [
    "<b>🛋️ 家電傢俱買斷已付款</b>",
    "",
    `姓名：${escapeHtml(v.name)}${v.lineName ? `（${escapeHtml(v.lineName)}）` : ""}`,
    v.phone ? `電話：${escapeHtml(v.phone)}` : null,
    `金額：${escapeHtml(yen(v.amount))}`,
    v.items ? `買斷品項：${escapeHtml(v.items)}` : null,
    v.note ? `備註：${escapeHtml(v.note)}` : null,
  ].filter((l) => l !== null);
  (warnings || []).forEach((w) => lines.push("", "⚠️ " + escapeHtml(w)));
  return lines.join("\n");
}

async function handleBuyoutPayment(session, meta, amountTotal) {
  const report = {
    record: { created: false, errors: [] },
    line: { sent: false, errors: [] },
    emails: { owner: false, customer: false, skipped: false, errors: [] },
    telegram: { sent: false, errors: [] },
  };
  const v = buyoutView(meta, amountTotal);
  const recordId = orderEventId(session.id);

  // 1. 【買斷】事件（冪等 upsert）
  try {
    const ev = buildBuyoutPaidEvent(v);
    if (recordId) {
      const r = await insertEvent(ev, recordId);
      report.record.created = true;
      report.record.duplicate = !!r.duplicate;
    }
  } catch (e) {
    report.record.errors.push(e.message);
  }

  // 2. LINE 推播客人付款確認（有 line_user_id 才推）
  try {
    const r = await sendLinePush(v.lineUserId, [
      { type: "text", text: buildBuyoutPaidLineText(v) },
    ]);
    report.line = r.ok ? { sent: true, errors: [] } : { sent: false, skipped: r.reason, errors: [] };
  } catch (e) {
    report.line = { sent: false, errors: [e.message] };
  }

  // 3. 確認信（老闆＋客人）。metadata 沒 email 就 fallback 用 Stripe 結帳頁客人自填的。
  try {
    const checkoutEmail =
      (session.customer_details && session.customer_details.email) || "";
    report.emails = await sendBuyoutEmails(v, checkoutEmail);
  } catch (e) {
    report.emails.errors.push(e.message);
  }

  // 4. Telegram（帶失敗警告）
  try {
    const warnings = [];
    if (report.record.errors.length)
      warnings.push(`買斷事件未建立（${report.record.errors[0]}），請手動加到行事曆`);
    if (report.line.errors.length)
      warnings.push(`客人 LINE 付款確認推播失敗（${report.line.errors[0]}），請手動傳`);
    if (report.emails.errors.length)
      warnings.push(`確認信寄送有問題：${report.emails.errors.join("；")}`);
    await sendTelegram(buildBuyoutPaidPush(v, warnings));
    report.telegram.sent = true;
  } catch (e) {
    report.telegram.errors.push(e.message);
  }

  // 5. 標記已通知（去重旗標，同其他分支）
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
  buyoutView,
  buildBuyoutPaidEvent,
  buildBuyoutPaidLineText,
  buildBuyoutPaidPush,
  handleBuyoutPayment,
};
