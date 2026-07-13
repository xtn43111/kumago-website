/**
 * /api/pair-line-order — 把 LINE 身分配對回 Google 行事曆的「⚠️（無LINE）」事件。
 *
 * 認證：Authorization: Bearer <CRON_SECRET>（與 cron 端點共用同一密鑰）。
 *
 * 三種用法：
 * 1. POST { userId, displayName, text }
 *    text = 客人傳進官方 LINE 的訂單／回收預約訊息（成功頁固定格式，三語）。
 *    解析姓名＋日期 → 在該日 ±1 天找「⚠️ <姓名>…（無LINE）」事件 → 補標題＋描述。
 *    呼叫者：line-smart-cs 本機 bot（order_pairing.py fire-and-forget）。
 * 2. POST { eventId, userId, displayName }
 *    直接指定事件配對（跳過訊息解析）。呼叫者：line-cs-search bot 的 /補配對。
 * 3. GET ?list=1
 *    回傳目前所有未配對（標題含（無LINE））的事件清單，供 /補配對 掃描。
 *
 * 測試：POST 加 ?dry=1 只解析與找事件，不 patch、不推播。
 */
"use strict";

const { listEvents, getEvent, patchEvent } = require("../lib/gcal");
const { sendTelegramTo } = require("../lib/telegram");

const ORDER_HEADERS = [
  "【KUMAGO 線上訂單・已完成付款】",
  "【KUMAGO オンライン注文・決済完了】",
  "[KUMAGO Online Order – Payment Completed]",
];
const RECOVERY_HEADERS = [
  "【期滿回收預約】",
  "【満了回収予約】",
  "[End-of-Rental Pickup Booking]",
];

const NAME_LABELS = ["姓名", "お名前", "Name"];
const ORDER_DATE_LABELS = ["入住日", "入居日", "Move-in date"];
const RECOVERY_DATE_LABELS = ["希望回收", "回収希望", "Preferred"];

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
  let dateLabels = null;
  if (ORDER_HEADERS.some((h) => t.startsWith(h))) dateLabels = ORDER_DATE_LABELS;
  else if (RECOVERY_HEADERS.some((h) => t.startsWith(h))) dateLabels = RECOVERY_DATE_LABELS;
  if (!dateLabels) return null;
  const name = extractField(t, NAME_LABELS);
  const dm = extractField(t, dateLabels).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!name || !dm) return null;
  return { name, date: dm[0] };
}

function dayWindow(dateStr) {
  // 目標日 ±1 天（JST）；事件本身以 Asia/Tokyo 建立
  const base = new Date(`${dateStr}T00:00:00+09:00`);
  const min = new Date(base.getTime() - 24 * 3600 * 1000);
  const max = new Date(base.getTime() + 2 * 24 * 3600 * 1000);
  return { timeMin: min.toISOString(), timeMax: max.toISOString() };
}

/* ⚠️ 標題 → 配對後標題。括號內直接寫 LINE 顯示名（不加 LINE: 前綴）。
 * 兩種既有格式各有正典寫法（回收的括號要放名字後面，
 * 防漏報表 lib/recovery.js 的姓名比對才對得上）：
 *   ⚠️ 名字 期滿回收預約（無LINE）   → 名字（顯示名）期滿回收預約
 *   ⚠️ 名字（無LINE） 入住配送 方案  → 名字（顯示名） 入住配送 方案 */
function pairedSummary(summary, displayName) {
  const rec = summary.match(/^⚠️\s*(.+?)\s*期滿回收預約（無LINE）\s*$/);
  if (rec) return `${rec[1]}（${displayName}）期滿回收預約`;
  return summary.replace(/^⚠️\s*/, "").replace("（無LINE）", `（${displayName}）`);
}

async function pairEvent(target, userId, displayName, via) {
  const shownName = (displayName || "").trim() || userId.slice(0, 8);
  const newSummary = pairedSummary(target.summary, shownName);
  const newDescription =
    (target.description || "") +
    `\n\n── LINE ──\n顯示名：${shownName}\nuserId：${userId}\n（${via}）`;
  await patchEvent(target.id, { summary: newSummary, description: newDescription });
  try {
    await sendTelegramTo(
      process.env.TELEGRAM_CHAT_ID,
      ["✅ 已配對 LINE 到行事曆", `事件：${target.summary}`, `→ ${newSummary}`].join("\n"),
      true
    );
  } catch (e) {
    // 配對本體已完成，推播失敗只記 log 不整體失敗
    console.error("pair-line-order: telegram notify failed:", e.message);
  }
  return newSummary;
}

/* 未配對事件掃描窗：過去 60 天（漏掉的舊單）～ 未來 550 天（年租回收在一年後） */
function scanWindow() {
  const now = Date.now();
  return {
    timeMin: new Date(now - 60 * 86400 * 1000).toISOString(),
    timeMax: new Date(now + 550 * 86400 * 1000).toISOString(),
  };
}

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = (req.headers && req.headers["authorization"]) || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  // ── 用法 3：GET ?list=1 未配對清單 ──
  if (req.method === "GET") {
    if (!(req.query && req.query.list)) {
      return res.status(400).json({ ok: false, error: "GET supports ?list=1 only" });
    }
    const w = scanWindow();
    const events = await listEvents(w.timeMin, w.timeMax);
    const unpaired = events
      .filter((ev) => ev.summary && ev.summary.includes("（無LINE）"))
      .map((ev) => ({
        id: ev.id,
        summary: ev.summary,
        start: (ev.start && (ev.start.dateTime || ev.start.date)) || "",
      }));
    return res.status(200).json({ ok: true, count: unpaired.length, events: unpaired });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST or GET ?list=1" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { userId, displayName, text, eventId } = body || {};
  if (!userId) return res.status(400).json({ ok: false, error: "userId required" });

  // ── 用法 2：指定事件直接配對 ──
  if (eventId) {
    const target = await getEvent(eventId);
    if (!target || target.status === "cancelled") {
      return res.status(404).json({ ok: false, error: "event not found" });
    }
    if (!target.summary || !target.summary.includes("（無LINE）")) {
      return res.status(200).json({ ok: true, matched: false, reason: "event not in unpaired state", summary: target.summary });
    }
    const newSummary = await pairEvent(target, userId, displayName, "手動指定配對（/補配對）");
    return res.status(200).json({ ok: true, matched: true, eventId, newSummary });
  }

  // ── 用法 1：訊息解析配對 ──
  if (!text) return res.status(400).json({ ok: false, error: "text or eventId required" });
  const parsed = parseOrderMessage(text);
  if (!parsed) {
    return res.status(200).json({ ok: true, matched: false, reason: "not an order/recovery message / parse failed" });
  }

  const dry = req.query && (req.query.dry === "1" || req.query.dry === "true");
  const w = dayWindow(parsed.date);
  const events = await listEvents(w.timeMin, w.timeMax);

  // 只認「（無LINE）」且含該姓名的事件；沒有（無LINE）標記 = 已配對，不重複配
  const target = events.find(
    (ev) =>
      ev.summary &&
      ev.summary.includes("（無LINE）") &&
      ev.summary.includes(parsed.name)
  );
  if (!target) {
    const already = events.some(
      (ev) => ev.summary && ev.summary.includes(parsed.name) && !ev.summary.includes("（無LINE）")
    );
    return res.status(200).json({
      ok: true, matched: false,
      reason: already ? "already paired" : "no matching ⚠️ event",
      name: parsed.name, date: parsed.date,
    });
  }

  if (dry) {
    return res.status(200).json({
      ok: true, matched: true, dry: true,
      eventId: target.id,
      newSummary: pairedSummary(target.summary, (displayName || "").trim() || userId.slice(0, 8)),
    });
  }
  const newSummary = await pairEvent(target, userId, displayName, "客人傳入訊息後自動配對");
  return res.status(200).json({ ok: true, matched: true, dry: false, eventId: target.id, newSummary });
};

module.exports.parseOrderMessage = parseOrderMessage; // 供測試
module.exports.pairedSummary = pairedSummary;         // 供測試
