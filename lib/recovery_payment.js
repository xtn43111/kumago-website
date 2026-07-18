/* KUMAGO — 期滿回收「處理費」付款後續流程（webhook 分支）。
 *
 * tools/create_recovery_link.js 產生的付款連結 metadata 帶 kumago_recovery=1，
 * 付款完成後 api/stripe-webhook.js 走這裡：
 *   1. 在店家行事曆建【回收（費用已付）】事件（回收日當天、全天）——標題含
 *      「回收」，lib/recovery.js 防漏報表會自動歸類；完成後老闆把標題改含
 *      「回收完畢」即結案。冪等 id = sha1(session id)，同新訂單/續租。
 *   2. 有 line_user_id 就 LINE 推播客人付款確認（沒有就 skip，不算錯）。
 *   3. Telegram 即時通知老闆（帶上前面步驟的失敗警告）。
 *
 * 不寄 email：回收客人聯絡管道是 LINE，老闆看 Telegram。
 * 韌性契約同其他分支：任何一步失敗都不能讓 Stripe 重試個沒完——款已收。
 */
"use strict";

const { insertEvent, patchEvent, orderEventId } = require("./gcal.js");
const { sendLinePush } = require("./line_push.js");
const { sendTelegram } = require("./telegram.js");

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

/* metadata → 檢視物件。amount_total 是「分」單位嗎？——JPY 無小數，Stripe 的
 * amount_total 對 JPY 就是日圓整數，直接用。 */
function recoveryView(meta, amountTotal) {
  const m = meta || {};
  return {
    name: m.customer_name || "",
    phone: m.customer_phone || "",
    address: m.address || "",
    recoveryDate: m.recovery_date || "",
    items: m.items_note || "",
    elevator: m.elevator || "", // "yes" / "no" / ""
    note: m.note || "",
    lineUserId: m.line_user_id || "",
    lineName: m.line_display_name || "",
    amount: amountTotal,
  };
}

/* 【回收】行事曆事件（全天）。回 null = 回收日無效（照建不了全天事件）。 */
function buildRecoveryPaidEvent(v) {
  if (!isRealDate(v.recoveryDate)) return null;
  const next = new Date(new Date(`${v.recoveryDate}T00:00:00Z`).getTime() + 86400000)
    .toISOString()
    .slice(0, 10);

  const elevatorLabel =
    v.elevator === "yes" ? "有電梯" : v.elevator === "no" ? "無電梯" : "";

  const descLines = [
    "🐻 KUMAGO 期滿回收（處理費已刷卡付清）",
    "",
    `【姓名】${v.name}`,
    v.lineName ? `【LINE 名稱】${v.lineName}` : null,
    v.lineUserId ? `【LINE userId】${v.lineUserId}` : null,
    v.phone ? `【電話】${v.phone}` : null,
    `【回收日】${v.recoveryDate}`,
    `【收取地址】${v.address}`,
    elevatorLabel ? `【電梯】${elevatorLabel}` : null,
    v.items ? `【回收品項】${v.items}` : null,
    `【處理費】${yen(v.amount)}（已付・Stripe）`,
    v.note ? `【備註】${v.note}` : null,
    "",
    "＊完成回收後請把標題改含「回收完畢」，防漏報表才會結案。",
  ].filter((l) => l !== null);

  return {
    // 標題含「回收」→ lib/recovery.js classify() 歸為 recoveries。
    summary: `${v.name}${v.lineName ? `（${v.lineName}）` : ""} 期滿回收（費用已付）`,
    location: v.address,
    description: descLines.join("\n"),
    start: { date: v.recoveryDate },
    end: { date: next },
    reminders: { useDefault: false, overrides: [] },
  };
}

/* 客人 LINE 付款確認文字。 */
function buildRecoveryPaidLineText(v) {
  return [
    "🐻 KUMAGO 已收到您的回收處理費，謝謝！",
    "",
    `金額：${yen(v.amount)}`,
    v.recoveryDate ? `回收日：${v.recoveryDate}` : null,
    v.address ? `收取地址：${v.address}` : null,
    v.items ? `品項：${v.items}` : null,
    "",
    "回收當天若時間有異動會再與您聯繫。",
  ].filter((l) => l !== null).join("\n");
}

/* 老闆 Telegram 推播（HTML）。 */
function buildRecoveryPaidPush(v, warnings) {
  const lines = [
    "<b>🐻 回收處理費已付款</b>",
    "",
    `姓名：${escapeHtml(v.name)}${v.lineName ? `（${escapeHtml(v.lineName)}）` : ""}`,
    v.phone ? `電話：${escapeHtml(v.phone)}` : null,
    `金額：${escapeHtml(yen(v.amount))}`,
    `回收日：${escapeHtml(v.recoveryDate || "（未填）")}`,
    `收取地址：${escapeHtml(v.address)}`,
    v.elevator === "yes" ? "電梯：有" : v.elevator === "no" ? "電梯：無" : null,
    v.items ? `品項：${escapeHtml(v.items)}` : null,
    v.note ? `備註：${escapeHtml(v.note)}` : null,
  ].filter((l) => l !== null);
  (warnings || []).forEach((w) => lines.push("", "⚠️ " + escapeHtml(w)));
  return lines.join("\n");
}

async function handleRecoveryPayment(session, meta, amountTotal) {
  const report = {
    record: { created: false, errors: [] },
    line: { sent: false, errors: [] },
    telegram: { sent: false, errors: [] },
  };
  const v = recoveryView(meta, amountTotal);
  const recordId = orderEventId(session.id);

  // 1. 【回收】事件（冪等 upsert）
  try {
    const ev = buildRecoveryPaidEvent(v);
    if (!ev) {
      report.record.errors.push("invalid_recovery_date: " + (v.recoveryDate || "(empty)"));
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
      { type: "text", text: buildRecoveryPaidLineText(v) },
    ]);
    report.line = r.ok ? { sent: true, errors: [] } : { sent: false, skipped: r.reason, errors: [] };
  } catch (e) {
    report.line = { sent: false, errors: [e.message] };
  }

  // 3. Telegram（帶失敗警告，老闆才知道要人工補什麼）
  try {
    const warnings = [];
    if (report.record.errors.length)
      warnings.push(`回收事件未建立（${report.record.errors[0]}），請手動加到行事曆 ${v.recoveryDate || ""}`);
    if (report.line.errors.length)
      warnings.push(`客人 LINE 付款確認推播失敗（${report.line.errors[0]}），請手動傳`);
    await sendTelegram(buildRecoveryPaidPush(v, warnings));
    report.telegram.sent = true;
  } catch (e) {
    report.telegram.errors.push(e.message);
  }

  // 4. 標記已通知（同其他分支的 kumago_notified 去重旗標）
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
  recoveryView,
  buildRecoveryPaidEvent,
  buildRecoveryPaidLineText,
  buildRecoveryPaidPush,
  handleRecoveryPayment,
};
