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
const { insertEvent, getEvent, patchEvent, listEvents, jstToday } = require("../lib/gcal.js");
const {
  sendTelegramTo, jstDayWindow, buildDigest,
  jstMonthWindow, parseMonth, buildMonthOverview, buildMonthDetail,
} = require("../lib/telegram.js");
const { buildManualEvent, parseDate, TEMPLATE, photoDescLine, PHOTO_LINE_RE } = require("../lib/tg_event.js");

/* Shown in /start & /help: how to ask for a specific day's tidied agenda, and
 * the two whole-month views. */
const QUERY_HELP =
  "📅 查某天行程：\n" +
  "　/行程            → 今天\n" +
  "　/行程 7/5        → 今年 7 月 5 日\n" +
  "　/行程 2026-07-05 → 指定日期\n" +
  "（也可用 查 / today）\n\n" +
  "🗓 查整月行程：\n" +
  "　/本月            → 本月有行程的日期統整\n" +
  "　/本月詳細        → 本月每天的完整行程\n" +
  "　/本月 8　/本月詳細 2026-08 → 指定月份";

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

/* One event id per photo ALBUM (media group), so every photo in the group
 * upserts the SAME event and accumulates into one gallery link. */
function albumEventIdFor(chatId, mediaGroupId) {
  return crypto.createHash("sha1").update(`tg-${chatId}-mg-${mediaGroupId}`).digest("hex");
}

/* file_ids we've accumulated for an album, read back from the event. */
function parseGalleryIds(csv) {
  return String(csv || "").split(",").map((s) => s.trim()).filter(Boolean);
}
function galleryUrlFor(base, ids) {
  return `${base}/api/tg-gallery?ids=${ids.map(encodeURIComponent).join(",")}`;
}

/* Is this message a "show me a day's tidied agenda" query rather than a new
 * event? A query is a SINGLE line that starts with a query keyword; everything
 * after the keyword is the (optional) date. Returns { dateRaw } or null.
 * Single-line-only keeps it from ever colliding with a multi-line labelled
 * manual event (those always carry 標題：/日期： lines). */
function parseQueryCommand(text) {
  const t = String(text || "").trim();
  if (!t || /\n/.test(t)) return null;
  const m = t.match(/^\/?(行程|查詢|查|agenda|today|schedule)\s*[：:]?\s*(.*)$/i);
  if (!m) return null;
  return { dateRaw: m[2].trim() };
}

/* Is this message a whole-month request? A SINGLE line starting with a month
 * keyword (本月 / 這個月 / 月曆 …). The optional word after it picks the view
 * (詳細 → full agenda, otherwise the compact overview); anything left over is
 * the month argument ("8", "2026-08"). Returns { detail, monthRaw } or null.
 * Single-line-only keeps it from colliding with a multi-line manual event. */
function parseMonthCommand(text) {
  const t = String(text || "").trim();
  if (!t || /\n/.test(t)) return null;
  const m = t.match(
    /^\/?(本月|这个月|這個月|当月|當月|月曆|月历|月行程|month)\s*(詳細|详细|詳情|详情|detail|全部|all|總覽|总览|總結|总结|overview|列表|list)?\s*[：:]?\s*(.*)$/i
  );
  if (!m) return null;
  const detail = /^(詳細|详细|詳情|详情|detail|全部|all)$/i.test(m[2] || "");
  return { detail, monthRaw: m[3].trim() };
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
  const mgid = msg.media_group_id; // present when the owner sends a photo album

  // /start or empty → show the template, don't treat as an event.
  if (!text.trim() && !fileId) {
    await safeReply(chatId, TEMPLATE, true);
    return res.status(200).json({ ok: true, hint: "template" });
  }
  if (/^\/(start|help)\b/i.test(text.trim())) {
    await safeReply(chatId, "🐻 KUMAGO 行程小幫手\n\n" + QUERY_HELP + "\n\n" + TEMPLATE, true);
    return res.status(200).json({ ok: true, hint: "help" });
  }

  // Month query: "/本月" → overview of booked days, "/本月詳細" → full agenda
  // for every day (no month = current JST month). Checked before the day query
  // and the manual-event parser. Photo messages are always event creations.
  const month = fileId ? null : parseMonthCommand(text);
  if (month) {
    const today = jstToday();
    const monthStr = parseMonth(month.monthRaw, today);
    if (month.monthRaw && !monthStr) {
      await safeReply(chatId, `⚠️ 月份看不懂：「${month.monthRaw}」\n請用 /本月 8 或 /本月 2026-08`, true);
      return res.status(200).json({ ok: true, month: "bad_month" });
    }
    try {
      const w = jstMonthWindow(monthStr);
      const events = await listEvents(w.timeMin, w.timeMax);
      const messages = month.detail
        ? buildMonthDetail(events, w)
        : buildMonthOverview(events, w);
      for (const m of messages) await safeReply(chatId, m, false);
      return res.status(200).json({ ok: true, month: monthStr, detail: month.detail, count: events.length });
    } catch (e) {
      console.error("telegram-webhook month:", e);
      await safeReply(chatId, `❌ 讀行事曆失敗：${e.message}`, true);
      return res.status(200).json({ ok: true, month: monthStr, error: e.message });
    }
  }

  // Date query: "/行程 7/5" → tidied agenda for that day (no date = today, JST).
  // Photo-bearing messages are always event creations, never queries.
  const query = fileId ? null : parseQueryCommand(text);
  if (query) {
    const today = jstToday();
    const dateStr = query.dateRaw ? parseDate(query.dateRaw, today) : today;
    if (query.dateRaw && !dateStr) {
      await safeReply(chatId, `⚠️ 日期看不懂：「${query.dateRaw}」\n請用 /行程 2026-07-05 或 /行程 7/5`, true);
      return res.status(200).json({ ok: true, query: "bad_date" });
    }
    try {
      const w = jstDayWindow(dateStr);
      const events = await listEvents(w.timeMin, w.timeMax);
      const messages = buildDigest(events, { ...w, title: "行程", emptyText: "這天沒有行程 🎉" });
      for (const m of messages) await safeReply(chatId, m, false);
      return res.status(200).json({ ok: true, query: dateStr, count: events.length });
    } catch (e) {
      console.error("telegram-webhook query:", e);
      await safeReply(chatId, `❌ 讀行事曆失敗：${e.message}`, true);
      return res.status(200).json({ ok: true, query: dateStr, error: e.message });
    }
  }

  // Photo ALBUM (media group): Telegram sends each photo as its own update that
  // shares media_group_id. Accumulate every photo's file_id into ONE gallery
  // link on ONE event (keyed by the group). Only the captioned photo replies;
  // the rest silently append. (Webhook is registered with max_connections=1 so
  // these updates arrive in order, making the read-append race-free.)
  if (mgid && fileId) {
    const eid = albumEventIdFor(chatId, mgid);
    const base = baseUrl(req);
    let existing = null;
    try { existing = await getEvent(eid); } catch (e) { console.error("album getEvent:", e.message); }
    const prevIds = parseGalleryIds(
      existing && existing.extendedProperties && existing.extendedProperties.private &&
      existing.extendedProperties.private.galleryIds
    );
    const ids = prevIds.includes(fileId) ? prevIds : [...prevIds, fileId];
    const gUrl = galleryUrlFor(base, ids);
    const extendedProperties = { private: { galleryIds: ids.join(",") } };

    if (text.trim()) {
      // The captioned photo defines the event (summary/date/…). Create it (or
      // patch, if a continuation photo somehow arrived first), then reply.
      const parsed = buildManualEvent(text, { photoUrl: gUrl, todayJst: jstToday() });
      if (!parsed.ok) {
        const reason = parsed.missing && parsed.missing.length
          ? `還缺：${parsed.missing.join("、")}` : (parsed.errors || []).join("\n");
        await safeReply(chatId, `⚠️ ${reason}\n\n${TEMPLATE}`, true);
        return res.status(200).json({ ok: true, album: "incomplete" });
      }
      parsed.event.extendedProperties = extendedProperties;
      try {
        const result = existing
          ? await patchEvent(eid, parsed.event)
          : await insertEvent(parsed.event, eid);
        let reply = fmtSuccess({ ...parsed.view, photoUrl: gUrl });
        if (result.htmlLink) reply += `\n\n🔗 ${result.htmlLink}`;
        reply += `\n🖼 已建立相簿連結（其餘照片自動併入同一連結）`;
        await safeReply(chatId, reply, false);
        return res.status(200).json({ ok: true, album: "created", count: ids.length });
      } catch (e) {
        console.error("telegram-webhook album create:", e);
        await safeReply(chatId, `❌ 加到行事曆失敗：${e.message}`, true);
        return res.status(200).json({ ok: true, album: "error", error: e.message });
      }
    }

    // Continuation photo (no caption): append its id to the album event. Reply
    // nothing so an N-photo album produces exactly one confirmation.
    if (!existing) {
      console.warn("album photo before its caption — dropped one file_id");
      return res.status(200).json({ ok: true, album: "waiting" });
    }
    const line = photoDescLine(gUrl);
    const desc = PHOTO_LINE_RE.test(existing.description || "")
      ? existing.description.replace(PHOTO_LINE_RE, line)
      : `${existing.description || ""}\n${line}`;
    try {
      await patchEvent(eid, { description: desc, extendedProperties });
      return res.status(200).json({ ok: true, album: "appended", count: ids.length });
    } catch (e) {
      console.error("telegram-webhook album append:", e);
      return res.status(200).json({ ok: true, album: "append_error", error: e.message });
    }
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
