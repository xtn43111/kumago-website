/* KUMAGO — daily Telegram delivery digest (Vercel Cron).
 *
 * Runs every day at 00:00 UTC (= 09:00 Asia/Tokyo) per the "crons" entry in
 * vercel.json, reads TOMORROW's deliveries off the shop Google Calendar, strips
 * 金額 / 租期 / email, and pushes the briefing to the owner over Telegram.
 *
 * Auth: when CRON_SECRET is set, Vercel sends "Authorization: Bearer <secret>";
 * we reject anything else so the endpoint can't be triggered by outsiders.
 *
 * Manual run (for testing): GET /api/cron-telegram-deliveries with the same
 * Authorization header, or run tools/test_telegram_push.js locally.
 */

"use strict";

const { listEvents, patchEvent, jstToday } = require("../lib/gcal.js");
const { jstTomorrowWindow, buildDigest, sendTelegram } = require("../lib/telegram.js");
const { runRenewalNotices } = require("../lib/renewal_notice.js");
const { sendLinePush } = require("../lib/line_push.js");

module.exports = async function handler(req, res) {
  // Fail-closed: unset CRON_SECRET must stop the cron (a visible failure), never
  // leave this Telegram-pushing endpoint open to anyone. Vercel Cron sends the
  // Bearer automatically when the secret is configured.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("cron-telegram-deliveries: CRON_SECRET unset — refusing (fail-closed)");
    return res.status(500).json({ ok: false, error: "cron_not_configured" });
  }
  const auth = req.headers["authorization"] || "";
  if (auth !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const w = jstTomorrowWindow(new Date());
    const events = await listEvents(w.timeMin, w.timeMax);
    const messages = buildDigest(events, w);

    const messageIds = [];
    for (const m of messages) {
      messageIds.push(await sendTelegram(m));
    }

    // 年租 30 天到期通知（同一支每日 cron 順跑；失敗不擋 digest 回報）
    let renewalNotice = null;
    try {
      renewalNotice = await runRenewalNotices({
        listEvents, patchEvent, sendLinePush, sendTelegram,
        todayISO: jstToday(),
      });
    } catch (e) {
      renewalNotice = { error: e.message };
    }

    return res.status(200).json({
      ok: true,
      date: w.dateStr,
      count: events.length,
      messages: messageIds.length,
      messageIds,
      renewalNotice,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
