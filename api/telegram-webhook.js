/* KUMAGO — manual event creation over Telegram.
 *
 * The owner sends a labelled message (optionally with a photo) to
 * @littleBKbear_bot; Telegram POSTs the update here and we create a matching
 * event on the shop Google Calendar — the manual counterpart to the automatic
 * "入住配送" events the Stripe webhook writes. An attached photo is stored as a
 * token-free proxy URL (/api/tg-photo) inside the event, the same way the order
 * flow stores the Google Maps link.
 *
 * Setup (run once):  node tools/manual_event.js --set-webhook
 *   → registers https://<domain>/api/telegram-webhook with Telegram, with a
 *     secret_token so only Telegram can call this endpoint.
 *
 * Security:
 *   • If TELEGRAM_WEBHOOK_SECRET is set, the X-Telegram-Bot-Api-Secret-Token
 *     header must match (Telegram sends it on every call).
 *   • Only messages from TELEGRAM_CHAT_ID (the owner) are acted on; anything
 *     else is silently acked.
 *
 * Resilience: always returns 200 once a message is handled so Telegram doesn't
 * retry. The calendar event id is derived from chat+message id, so a retry
 * upserts the SAME event instead of duplicating.
 */

"use strict";

const crypto = require("crypto");
const { insertEvent, jstToday } = require("../lib/gcal.js");
const { sendTelegramTo } = require("../lib/telegram.js");
const { buildManualEvent, TEMPLATE } = require("../lib/tg_event.js");

/* Public base URL for building the photo proxy link. Prefer an explicit env so
 * the link is stable regardless of which Vercel host served the request. */
function baseUrl(req) {
  const env = process.env.PUBLIC_BASE_URL;
  if (env) return env.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  return `${proto}://${host}`;
}

/* Largest photo size's file_id, or an image document's file_id. */
function photoFileId(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) {
    return msg.photo[msg.photo.length - 1].file_id; // last = highest resolution
  }
  if (msg.document && /^image\//.test(msg.document.mime_type || "")) {
    return msg.document.file_id;
  }
  return null;
}

/* base32hex-safe (0-9a-f) deterministic id so webhook retries upsert one event. */
function eventIdFor(chatId, messageId) {
  return crypto.createHash("sha1").update(`tg-${chatId}-${messageId}`).digest("hex");
}

function fmtSuccess(view) {
  const e = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = [
    "✅ 已加到行事曆",
    "",
    `📌 ${e(view.summary)}`,
    `📅 ${e(view.date)}　🕒 ${e(view.time)}`,
    view.address ? `📍 ${e(view.address)}` : null,
    view.contact ? `📞 ${e(view.contact)}` : null,
    view.photoUrl ? "🖼 已附照片" : null,
  ].filter((l) => l !== null);
  return lines.join("\n");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Reject anything that isn't Telegram (when a secret is configured).
  const wantSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (wantSecret) {
    const got = req.headers["x-telegram-bot-api-secret-token"];
    if (got !== wantSecret) return res.status(401).json({ error: "unauthorized" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const msg = body.message || body.edited_message;
  // Ack non-message updates fast so Telegram doesn't retry.
  if (!msg || !msg.chat) return res.status(200).json({ ok: true, ignored: "no_message" });

  // Owner-only: silently ignore anyone else.
  const owner = process.env.TELEGRAM_CHAT_ID;
  if (owner && String(msg.chat.id) !== String(owner)) {
    return res.status(200).json({ ok: true, ignored: "not_owner" });
  }
  const chatId = msg.chat.id;

  const text = msg.text || msg.caption || "";
  const fileId = photoFileId(msg);

  // /start or empty → show the template, don't treat as an event.
  if (!text.trim() && !fileId) {
    await safeReply(chatId, TEMPLATE, true);
    return res.status(200).json({ ok: true, hint: "template" });
  }
  if (/^\/(start|help)\b/i.test(text.trim())) {
    await safeReply(chatId, "🐻 KUMAGO 行程小幫手\n\n" + TEMPLATE, true);
    return res.status(200).json({ ok: true, hint: "help" });
  }

  const photoUrl = fileId ? `${baseUrl(req)}/api/tg-photo?id=${encodeURIComponent(fileId)}` : "";
  const parsed = buildManualEvent(text, { photoUrl, todayJst: jstToday() });

  if (!parsed.ok) {
    const reason = parsed.missing && parsed.missing.length
      ? `還缺：${parsed.missing.join("、")}`
      : (parsed.errors || []).join("\n");
    await safeReply(chatId, `⚠️ ${reason}\n\n${TEMPLATE}`, true);
    return res.status(200).json({ ok: true, parse: "incomplete" });
  }

  try {
    const eid = eventIdFor(chatId, msg.message_id);
    const result = await insertEvent(parsed.event, eid);
    let reply = fmtSuccess(parsed.view);
    if (result.htmlLink) reply += `\n\n🔗 ${result.htmlLink}`;
    await safeReply(chatId, reply, false);
    return res.status(200).json({ ok: true, created: true, eventId: result.eventId });
  } catch (e) {
    console.error("telegram-webhook insert:", e);
    await safeReply(chatId, `❌ 加到行事曆失敗：${e.message}`, true);
    return res.status(200).json({ ok: true, created: false, error: e.message });
  }
};

/* Reply but never let a Telegram send failure surface as a 500 (which would
 * make Telegram retry the whole update). */
async function safeReply(chatId, text, plain) {
  try { await sendTelegramTo(chatId, text, plain); }
  catch (e) { console.error("telegram-webhook reply:", e.message); }
}
