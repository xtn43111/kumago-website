/**
 * POST /api/pair-line-order — 把「客人傳進官方 LINE 的訂單訊息」配對回行事曆事件。
 *
 * 呼叫者：line-smart-cs 本機 bot（收到以訂單標頭開頭的客人訊息時 fire-and-forget）。
 * 認證：Authorization: Bearer <CRON_SECRET>（與 cron 端點共用同一密鑰）。
 *
 * Body（JSON）：{ userId, displayName, text }
 *   text = 客人傳的訂單全文（成功頁產生的固定格式，zh/ja/en 三種標頭）。
 *
 * 行為：解析姓名＋入住日 → 在入住日 ±1 天找標題含「⚠️ <姓名>（無LINE）」的
 * 事件 → 標題改「<姓名>（LINE: <顯示名>）」、描述附 userId → Telegram 通知老闆。
 * 已配對過（標題含 LINE:）或找不到事件都回 200，不重試、不誤傷。
 *
 * 測試：?dry=1 只解析與找事件，不 patch、不推播。
 */
"use strict";

const { listEvents, patchEvent } = require("../lib/gcal");
const { sendTelegramTo } = require("../lib/telegram");

const ORDER_HEADERS = [
  "【KUMAGO 線上訂單・已完成付款】",
  "【KUMAGO オンライン注文・決済完了】",
  "[KUMAGO Online Order – Payment Completed]",
];

const NAME_LABELS = ["姓名", "お名前", "Name"];
const DATE_LABELS = ["入住日", "入居日", "Move-in date"];

function extractField(text, labels) {
  for (const label of labels) {
    // 全形/半形冒號皆可；取該行剩餘全部
    const m = text.match(new RegExp(`^${label}\\s*[：:]\\s*(.+)$`, "m"));
    if (m) return m[1].trim();
  }
  return "";
}

function parseOrderMessage(text) {
  const t = (text || "").trim();
  if (!ORDER_HEADERS.some((h) => t.startsWith(h))) return null;
  const name = extractField(t, NAME_LABELS);
  const dateRaw = extractField(t, DATE_LABELS);
  const dm = dateRaw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!name || !dm) return null;
  return { name, date: dm[0] };
}

function dayWindow(dateStr) {
  // 入住日 ±1 天（JST）；事件本身以 Asia/Tokyo 建立
  const base = new Date(`${dateStr}T00:00:00+09:00`);
  const min = new Date(base.getTime() - 24 * 3600 * 1000);
  const max = new Date(base.getTime() + 2 * 24 * 3600 * 1000);
  return { timeMin: min.toISOString(), timeMax: max.toISOString() };
}

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = (req.headers && req.headers["authorization"]) || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { userId, displayName, text } = body || {};
  if (!userId || !text) {
    return res.status(400).json({ ok: false, error: "userId and text required" });
  }

  const parsed = parseOrderMessage(text);
  if (!parsed) {
    return res.status(200).json({ ok: true, matched: false, reason: "not an order message / parse failed" });
  }

  const dry = req.query && (req.query.dry === "1" || req.query.dry === "true");
  const w = dayWindow(parsed.date);
  const events = await listEvents(w.timeMin, w.timeMax);

  // 只認「⚠️ …（無LINE）」且含該姓名的事件；已寫 LINE: 的不重複配對
  const target = events.find(
    (ev) =>
      ev.summary &&
      ev.summary.includes("（無LINE）") &&
      ev.summary.includes(parsed.name) &&
      !ev.summary.includes("LINE:")
  );
  if (!target) {
    const already = events.some(
      (ev) => ev.summary && ev.summary.includes(parsed.name) && ev.summary.includes("LINE:")
    );
    return res.status(200).json({
      ok: true, matched: false,
      reason: already ? "already paired" : "no matching ⚠️ event",
      name: parsed.name, date: parsed.date,
    });
  }

  const shownName = (displayName || "").trim() || userId.slice(0, 8);
  const newSummary = target.summary
    .replace(/^⚠️\s*/, "")
    .replace("（無LINE）", `（LINE: ${shownName}）`);
  const newDescription =
    (target.description || "") +
    `\n\n── LINE ──\n顯示名：${shownName}\nuserId：${userId}\n（客人傳入訂單訊息後自動配對）`;

  if (!dry) {
    await patchEvent(target.id, { summary: newSummary, description: newDescription });
    try {
      await sendTelegramTo(
        process.env.TELEGRAM_CHAT_ID,
        [
          "✅ 訂單已自動配對 LINE",
          `訂單：${parsed.name}（入住 ${parsed.date}）`,
          `LINE：${shownName}`,
          "行事曆標題已更新，可直接在聊天列表找到這位客人。",
        ].join("\n"),
        true
      );
    } catch (e) {
      // 配對本體已完成，推播失敗只記 log 不整體失敗
      console.error("pair-line-order: telegram notify failed:", e.message);
    }
  }

  return res.status(200).json({
    ok: true, matched: true, dry: !!dry,
    eventId: target.id, newSummary,
  });
};

module.exports.parseOrderMessage = parseOrderMessage; // 供測試
