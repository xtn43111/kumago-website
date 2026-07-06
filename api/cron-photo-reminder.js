/* KUMAGO — delivery-day photo reminder (external trigger, 20:00 JST).
 *
 * Vercel Hobby allows only 2 cron entries and both slots are taken
 * (daily deliveries digest + biweekly recovery report), so this endpoint is
 * NOT in vercel.json "crons" — it is hit at 20:00 JST by the line-smart-cs
 * scheduler running on the shop Mac (app/services/photo_request.py).
 *
 * What it does: reads TODAY's (JST) events off the shop Google Calendar,
 * keeps the 年租方案 deliveries (same rule as lib/recovery.js: title contains
 * 配送 and title+description match PLAN_RE), and pushes one Telegram message
 * asking the owner to upload photos of the delivered items. The message
 * includes a ready-to-copy 「加照片：M/D 關鍵字」 caption per event so the
 * photos land on the right calendar event (the existing telegram-webhook
 * photo-merge flow). Those photos are what the recovery run relies on to
 * identify the items (and their condition) to collect when the plan expires.
 *
 * No matching deliveries today → sends nothing (count 0, silent).
 *
 * Auth: same as the other crons — when CRON_SECRET is set, requires
 * "Authorization: Bearer <secret>". Manual test: GET with that header;
 * add ?dry=1 to get the would-be message back without sending it.
 */

"use strict";

const { listEvents } = require("../lib/gcal.js");
const { jstDayWindow, slotLabel, sendTelegramTo } = require("../lib/telegram.js");
const { PLAN_RE, nameFrags } = require("../lib/recovery.js");
const { PHOTO_LINE_RE } = require("../lib/tg_event.js");

/* Today's JST calendar date, "YYYY-MM-DD". */
function jstToday(now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now || new Date());
}

/* 年租配送 event? — mirrors lib/recovery.js's delivery-anchor rule. */
function isYearlyDelivery(ev) {
  const s = String(ev.summary || "");
  const d = String(ev.description || "");
  return s.includes("配送") && PLAN_RE.test(s + " " + d);
}

function hasPhotos(ev) {
  return PHOTO_LINE_RE.test(String(ev.description || ""));
}

/* Strip the 【上午/下午】 slot prefix for a compact block header. */
function shortTitle(summary) {
  return String(summary || "")
    .replace(/^【(上午|下午|早上|晚上|全天|整天)】\s*/, "")
    .trim() || "（無標題）";
}

/* Build the reminder (plain text — sent with plainText=true). */
function buildReminder(events, w) {
  const md = `${Number(w.dateStr.slice(5, 7))}/${Number(w.dateStr.slice(8, 10))}`;
  const lines = [
    "🐻 KUMAGO 配送照片提醒",
    `📅 ${w.dateStr}（${w.weekday}）今天有 ${events.length} 筆年租配送`,
    "",
    "請上傳今天配送品項的現場照片：",
    "傳照片時在說明文字打下面這行，照片就會掛到那筆行程上",
    "（到期回收時要靠照片核對品項與狀態）",
  ];
  events.forEach((ev, i) => {
    const frag = [...(nameFrags(ev.summary) || [])][0] || "";
    lines.push("");
    lines.push(`【${i + 1}】${shortTitle(ev.summary)}　🕒 ${slotLabel(ev)}`);
    lines.push(`　加照片：${md}${frag ? " " + frag : ""}`);
    if (hasPhotos(ev)) lines.push("　（這筆已有照片，補拍會併進同一相簿）");
  });
  return lines.join("\n");
}

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  try {
    const w = jstDayWindow(jstToday());
    const all = await listEvents(w.timeMin, w.timeMax);
    const deliveries = all.filter(isYearlyDelivery);

    if (!deliveries.length) {
      return res.status(200).json({
        ok: true, date: w.dateStr, total: all.length, deliveries: 0, sent: false,
      });
    }

    const text = buildReminder(deliveries, w);
    const dry = req.query && (req.query.dry === "1" || req.query.dry === "true");
    let messageId = null;
    if (!dry) {
      messageId = await sendTelegramTo(process.env.TELEGRAM_CHAT_ID, text, true);
    }

    return res.status(200).json({
      ok: true,
      date: w.dateStr,
      total: all.length,
      deliveries: deliveries.length,
      sent: !dry,
      messageId,
      ...(dry ? { preview: text } : {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
