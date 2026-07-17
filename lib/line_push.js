"use strict";
/*
 * LINE Messaging API push（KUMAGO 官方帳號 → 客人）。
 *
 * Token：LINE_CHANNEL_ACCESS_TOKEN（Messaging API channel access token；
 * 本機在 .env，Vercel Production 也已設定同名變數）。
 * 未設定 → sendLinePush 回 {skipped:true}，不擋主流程（同 telegram.js 習慣）。
 */

const PUSH_URL = "https://api.line.me/v2/bot/message/push";

function isLineUserId(s) {
  return /^U[0-9a-f]{32}$/.test(String(s || ""));
}

/* 推播訊息給單一客人。messages = LINE message 物件陣列（最多 5 則）。
 * 回 {ok:true} / {skipped:true, reason} ；API 錯誤 throw（呼叫端自行 catch）。 */
async function sendLinePush(userId, messages) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return { skipped: true, reason: "no_token" };
  if (!isLineUserId(userId)) return { skipped: true, reason: "invalid_user_id" };
  const res = await fetch(PUSH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to: userId, messages }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`line_push_failed ${res.status}: ${body.slice(0, 300)}`);
  }
  return { ok: true };
}

/* 續租付款確認（付款完成 webhook 後推給客人）。v = renewalView()。 */
function buildRenewalPaidLineText(v) {
  const yen = (n) => "¥" + Number(n || 0).toLocaleString("ja-JP");
  const slash = (iso) => String(iso || "").replace(/-/g, "/");
  if (v.lang === "en") {
    const dur = v.months ? `${v.months} month${v.months > 1 ? "s" : ""}` : v.duration;
    return [
      "🐻 KUMAGO — Renewal payment received. Thank you!",
      "",
      `Plan: ${v.planName} × ${dur}`,
      `Amount: ${yen(v.total)}`,
      `New rental period: until ${slash(v.newExpiry)}`,
      "",
      "If you have any questions, just reply to this chat.",
    ].join("\n");
  }
  return [
    "🐻 KUMAGO 已收到您的續租付款，感謝您的續租！",
    "",
    `方案：${v.planName} × ${v.duration}`,
    `金額：${yen(v.total)}`,
    `新租期到期日：${slash(v.newExpiry)}`,
    "",
    "如有任何問題，直接在此對話回覆即可。",
  ].join("\n");
}

module.exports = { sendLinePush, buildRenewalPaidLineText, isLineUserId };
