"use strict";
/*
 * 「年租回收防漏報表」cron —— 每 2 週一次。
 * Vercel Cron（見 vercel.json）每週一 00:00 UTC = 週一 09:00 JST 觸發這支端點，
 * 但只在「雙週閘門」命中的那一週實際推送（從 BIWEEKLY_ANCHOR 起算每 14 天）；
 * 非該週則直接回 ok+skipped，不送訊息。
 * 讀 KUMAGO 行事曆 → 以到期事件為錨算出「需安排/待完成」→ 推 Telegram 給老闆。
 *
 * 與 api/cron-telegram-deliveries.js 同架構、同 CRON_SECRET 驗證。
 * 需要的 env（都已存在、Vercel 也已設）：CRON_SECRET、GOOGLE_OAUTH_*、
 * TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID。手動測試：帶 Authorization: Bearer <CRON_SECRET> curl。
 */

const { listEvents, jstToday } = require("../lib/gcal.js");
const { sendTelegramTo } = require("../lib/telegram.js");
const { buildRecoveryReport } = require("../lib/recovery.js");

const LOOKAHEAD_DAYS = 45; // 到期前幾天開始列為「需安排」
const PAST_WINDOW = 800; // 往回抓夠久，才看得到過去的配送年租單（推估到期用，涵蓋兩年方案）
const FUTURE_WINDOW = 400; // 往前抓多少天的到期（涵蓋一年方案）
const BIWEEKLY_ANCHOR = "2026-07-06"; // 起算週一，之後每 14 天推一次（07-06, 07-20, 08-03…）

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 從錨定週一起算，today 落在「該推」的雙週嗎？（容忍 cron 觸發日與週一差幾天）
function isSendWeek(todayISO) {
  const days = Math.round(
    (Date.parse(todayISO + "T00:00:00Z") - Date.parse(BIWEEKLY_ANCHOR + "T00:00:00Z")) / 86400000
  );
  if (days < 0) return false;
  return Math.floor(days / 7) % 2 === 0;
}

module.exports = async function handler(req, res) {
  // Fail-closed: unset CRON_SECRET stops the cron (visible failure) rather than
  // exposing this Telegram-pushing endpoint. Vercel Cron sends the Bearer when
  // the secret is configured.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("cron-weekly-recovery: CRON_SECRET unset — refusing (fail-closed)");
    return res.status(500).json({ ok: false, error: "cron_not_configured" });
  }
  const auth = req.headers["authorization"] || "";
  if (auth !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  try {
    const today = jstToday();
    if (!isSendWeek(today)) {
      return res.status(200).json({ ok: true, skipped: true, reason: "off-week (biweekly)" });
    }
    const timeMin = addDays(today, -PAST_WINDOW) + "T00:00:00+09:00";
    const timeMax = addDays(today, FUTURE_WINDOW) + "T00:00:00+09:00";
    const events = await listEvents(timeMin, timeMax);

    const messages = buildRecoveryReport(events, today, LOOKAHEAD_DAYS);
    const chat = process.env.TELEGRAM_CHAT_ID;
    const messageIds = [];
    for (const m of messages) messageIds.push(await sendTelegramTo(chat, m, true));

    return res.status(200).json({ ok: true, events: events.length, messages: messageIds.length, messageIds });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
