/* KUMAGO — 搬家服務費付款後續流程（webhook 分支，仿 recovery_payment.js）。
 *
 * lib/moving_link.js（Telegram /搬家連結）產生的付款連結 metadata 帶
 * kumago_moving=1，付款完成後 api/stripe-webhook.js 走這裡：
 *   1. 在店家行事曆建【搬家（費用已付）】事件（搬家日當天、全天）。
 *      標題/說明刻意不含「回收／到期／配送」——lib/recovery.js classify()
 *      按標題關鍵字分類，含了會被年租回收防漏報表或其他 cron 誤抓。
 *      冪等 id = sha1(session id)，同新訂單/續租/回收。
 *   2. 有 line_user_id 就 LINE 推播客人付款確認（沒有就 skip，不算錯）。
 *   3. 寄確認信（lib/mailer.js sendMovingEmails：老闆＋客人；客人 email
 *      拿不到就 skip，不算錯；寄失敗收進 warnings 不擋流程）。
 *   4. Telegram 即時通知老闆（帶上前面步驟的失敗警告）。
 * 韌性契約同其他分支：任何一步失敗都不能讓 Stripe 重試個沒完——款已收。
 */
"use strict";

const { insertEvent, patchEvent, orderEventId } = require("./gcal.js");
const { sendLinePush } = require("./line_push.js");
const { sendTelegram } = require("./telegram.js");
const { sendMovingEmails } = require("./mailer.js");

function yen(n) {
  return n == null ? "?" : "¥" + Number(n).toLocaleString("ja-JP");
}

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* metadata → 檢視物件（JPY 的 amount_total 就是日圓整數，直接用）。 */
function movingView(meta, amountTotal) {
  const m = meta || {};
  return {
    name: m.customer_name || "",
    phone: m.customer_phone || "",
    email: m.customer_email || "",
    movingDate: m.moving_date || "",
    movingTime: m.moving_time || "",
    addressFrom: m.address_from || "",
    addressTo: m.address_to || "",
    elevator: m.elevator || "", // "yes" / "no" / ""
    items: m.items_note || "",
    lineUserId: m.line_user_id || "",
    lineName: m.line_display_name || "",
    note: m.note || "",
    lang: m.lang || "zh",
    amount: amountTotal,
  };
}

/* 【搬家】行事曆事件（全天）。回 null = 搬家日無效（照建不了全天事件）。 */
function buildMovingPaidEvent(v) {
  if (!isRealDate(v.movingDate)) return null;
  const next = new Date(new Date(`${v.movingDate}T00:00:00Z`).getTime() + 86400000)
    .toISOString()
    .slice(0, 10);

  const elevatorLabel =
    v.elevator === "yes" ? "有電梯" : v.elevator === "no" ? "無電梯" : "";

  const descLines = [
    "🐻 KUMAGO 搬家服務（費用已刷卡付清）",
    "",
    `【姓名】${v.name}`,
    v.lineName ? `【LINE 名稱】${v.lineName}` : null,
    v.lineUserId ? `【LINE userId】${v.lineUserId}` : null,
    v.phone ? `【電話】${v.phone}` : null,
    v.email ? `【email】${v.email}` : null,
    `【搬家日】${v.movingDate}`,
    v.movingTime ? `【時間】${v.movingTime}` : null,
    `【搬出地址】${v.addressFrom}`,
    v.addressTo ? `【搬入地址】${v.addressTo}` : null,
    elevatorLabel ? `【電梯】${elevatorLabel}` : null,
    v.items ? `【搬運品項】${v.items}` : null,
    `【服務費】${yen(v.amount)}（已付・Stripe）`,
    v.note ? `【備註】${v.note}` : null,
  ].filter((l) => l !== null);

  return {
    // 標題刻意不含「回收／到期／配送」→ recovery.js classify() 不會誤抓。
    summary: `【搬家（費用已付）】${v.name}${v.lineName ? `（${v.lineName}）` : ""}`,
    location: v.addressFrom,
    description: descLines.join("\n"),
    start: { date: v.movingDate },
    end: { date: next },
    reminders: { useDefault: false, overrides: [] },
  };
}

/* 客人 LINE 付款確認文字（zh/en）。 */
function buildMovingPaidLineText(v) {
  if ((v.lang || "zh") === "en") {
    return [
      "🐻 KUMAGO — Moving service payment received. Thank you!",
      "",
      `Amount: ${yen(v.amount)}`,
      v.movingDate ? `Moving date: ${v.movingDate}` : null,
      v.addressFrom ? `From: ${v.addressFrom}` : null,
      v.addressTo ? `To: ${v.addressTo}` : null,
      v.items ? `Items: ${v.items}` : null,
      "",
      "We'll contact you before the moving day to confirm the schedule.",
    ].filter((l) => l !== null).join("\n");
  }
  return [
    "🐻 KUMAGO 已收到您的搬家服務費，謝謝！",
    "",
    `金額：${yen(v.amount)}`,
    v.movingDate ? `搬家日：${v.movingDate}` : null,
    v.addressFrom ? `搬出地址：${v.addressFrom}` : null,
    v.addressTo ? `搬入地址：${v.addressTo}` : null,
    v.items ? `品項：${v.items}` : null,
    "",
    "我們將於搬家日前與您確認詳細時間。",
  ].filter((l) => l !== null).join("\n");
}

/* 老闆 Telegram 推播（HTML）。 */
function buildMovingPaidPush(v, warnings) {
  const lines = [
    "<b>🚚 搬家服務費已付款</b>",
    "",
    `姓名：${escapeHtml(v.name)}${v.lineName ? `（${escapeHtml(v.lineName)}）` : ""}`,
    v.phone ? `電話：${escapeHtml(v.phone)}` : null,
    v.email ? `email：${escapeHtml(v.email)}` : null,
    `金額：${escapeHtml(yen(v.amount))}`,
    `搬家日：${escapeHtml(v.movingDate || "（未填）")}${v.movingTime ? `　${escapeHtml(v.movingTime)}` : ""}`,
    `搬出：${escapeHtml(v.addressFrom)}`,
    v.addressTo ? `搬入：${escapeHtml(v.addressTo)}` : null,
    v.elevator === "yes" ? "電梯：有" : v.elevator === "no" ? "電梯：無" : null,
    v.items ? `品項：${escapeHtml(v.items)}` : null,
    v.note ? `備註：${escapeHtml(v.note)}` : null,
  ].filter((l) => l !== null);
  (warnings || []).forEach((w) => lines.push("", "⚠️ " + escapeHtml(w)));
  return lines.join("\n");
}

async function handleMovingPayment(session, meta, amountTotal) {
  const report = {
    record: { created: false, errors: [] },
    line: { sent: false, errors: [] },
    emails: { owner: false, customer: false, skipped: false, errors: [] },
    telegram: { sent: false, errors: [] },
  };
  const v = movingView(meta, amountTotal);
  const recordId = orderEventId(session.id);

  // 1. 【搬家】事件（冪等 upsert）
  try {
    const ev = buildMovingPaidEvent(v);
    if (!ev) {
      report.record.errors.push("invalid_moving_date: " + (v.movingDate || "(empty)"));
    } else if (recordId) {
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
      { type: "text", text: buildMovingPaidLineText(v) },
    ]);
    report.line = r.ok ? { sent: true, errors: [] } : { sent: false, skipped: r.reason, errors: [] };
  } catch (e) {
    report.line = { sent: false, errors: [e.message] };
  }

  // 3. 確認信（老闆＋客人）。metadata 沒 email 就 fallback 用 Stripe 結帳頁
  // 客人自填的 email；兩者都沒有 → 客人信 skip，不算錯。
  try {
    const checkoutEmail =
      (session.customer_details && session.customer_details.email) || "";
    report.emails = await sendMovingEmails(v, checkoutEmail);
  } catch (e) {
    report.emails.errors.push(e.message);
  }

  // 4. Telegram（帶失敗警告，老闆才知道要人工補什麼）
  try {
    const warnings = [];
    if (report.record.errors.length)
      warnings.push(`搬家事件未建立（${report.record.errors[0]}），請手動加到行事曆 ${v.movingDate || ""}`);
    if (report.line.errors.length)
      warnings.push(`客人 LINE 付款確認推播失敗（${report.line.errors[0]}），請手動傳`);
    if (report.emails.errors.length)
      warnings.push(`確認信寄送有問題：${report.emails.errors.join("；")}`);
    await sendTelegram(buildMovingPaidPush(v, warnings));
    report.telegram.sent = true;
  } catch (e) {
    report.telegram.errors.push(e.message);
  }

  // 5. 標記已通知（同其他分支的 kumago_notified 去重旗標）
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
  movingView,
  buildMovingPaidEvent,
  buildMovingPaidLineText,
  buildMovingPaidPush,
  handleMovingPayment,
};
