/* KUMAGO — 期滿回收預約（客人自助）。
 *
 * 客人在 LINE 圖文選單點「年租回收」→ 開啟 /recovery 表單 → 填姓名/電話/存放地址/
 * 希望回收日期與時段 → POST 到這裡。我們：
 *   1. 在店家 Google 行事曆寫一筆「回收」事件（標題含「回收」，讓 lib/recovery.js
 *      的防漏報表能用姓名碎片自動對上到期年租，列為「待標完畢」）。
 *   2. 即時 Telegram 通知老闆（@littleBKbear_bot）。
 *
 * 照片採「僅提醒」：表單不收檔案，客人直接在 LINE 對話傳物品現況照片。
 *
 * 韌性契約：行事曆是唯一的落地紀錄 —— 寫失敗就回 5xx 讓前端請客人改用 LINE。
 * Telegram 只是即時提醒，失敗僅記 log，不影響回應（避免通知掛掉害客人以為沒送出）。
 *
 * 需要的環境變數：GOOGLE_OAUTH_* + GOOGLE_CALENDAR_ID（見 lib/gcal.js）、
 * TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID（見 lib/telegram.js）。
 */

const crypto = require("crypto");
const { insertEvent, isConfigured } = require("../lib/gcal.js");
const { sendTelegram } = require("../lib/telegram.js");

const TIMEZONE = "Asia/Tokyo"; // 日本無夏令時

// 時段 key → [起, 迄] JST 牆鐘時間。沿用 order/gcal 既有的兩個配送時段。
const SLOT_TIMES = {
  "09-1130": ["09:00:00", "11:30:00"],
  "1230-16": ["12:30:00", "16:00:00"],
};
// 時段 key → 顯示標籤（寫進事件說明 / Telegram）。
const SLOT_LABEL = {
  "09-1130": "上午 09:00–11:30",
  "1230-16": "下午 12:30–16:00",
  any: "整天皆可",
};

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* 一致化 + 驗證進來的欄位。回傳 { ok, value?, missing? }。 */
function normalizeInput(body) {
  const b = body || {};
  const name = String(b.name || "").trim();
  const phone = String(b.phone || "").trim();
  const address = String(b.address || "").trim();
  const date = String(b.date || "").trim();
  const slot = String(b.slot || "").trim();
  const note = String(b.note || "").trim().slice(0, 500);
  const lang = b.lang === "ja" ? "ja" : "zh";

  const missing = [];
  if (!name) missing.push("name");
  if (!phone) missing.push("phone");
  if (!address) missing.push("address");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) missing.push("date");
  if (!SLOT_LABEL[slot]) missing.push("slot");

  if (missing.length) return { ok: false, missing };
  return { ok: true, value: { name, phone, address, date, slot, note, lang } };
}

/* 由 Stripe 訂單以外的自助表單，用內容雜湊當事件 id（base32hex 相容），
 * 讓客人重複送出同一筆（同姓名/電話/日期/時段）只會 upsert 同一個事件，不重複。 */
function eventIdFor(v) {
  const key = `recovery|${v.name}|${v.phone}|${v.date}|${v.slot}`;
  return crypto.createHash("sha1").update(key).digest("hex"); // 40 hex chars
}

/* 純函式：把驗證過的輸入組成 Google Calendar 事件資源（含決定性 id）。
 * 抽出來方便離線測試，不碰網路。 */
function buildRecoveryEvent(v) {
  const slotLabel = SLOT_LABEL[v.slot] || v.slot;

  // null = 丟掉該行；其餘照留。標題含「回收」→ 防漏報表 classify() 歸為 recoveries。
  const descLines = [
    "🐻 KUMAGO 期滿回收預約（客人自助送出）",
    "",
    `【姓名】${v.name}`,
    `【電話】${v.phone}`,
    `【希望回收】${v.date}　${slotLabel}`,
    `【物品存放地址】${v.address}`,
    v.note ? `【備註】${v.note}` : null,
    "",
    "⚠️ 物品現況照片：請於 LINE 對話向客人索取（客人已被提醒自行傳送）",
    "",
    "＊完成回收後請把標題改含「回收完畢」，防漏報表才會結案。",
  ].filter((l) => l !== null);

  const event = {
    summary: `${v.name} 期滿回收預約`, // 含「回收」→ 被歸類為 recovery，姓名供比對
    location: v.address,
    description: descLines.join("\n"),
    reminders: { useDefault: false, overrides: [] }, // 無彈窗提醒，統一走每日 Telegram
  };

  const slot = SLOT_TIMES[v.slot];
  if (slot) {
    event.start = { dateTime: `${v.date}T${slot[0]}`, timeZone: TIMEZONE };
    event.end = { dateTime: `${v.date}T${slot[1]}`, timeZone: TIMEZONE };
  } else {
    // 整天皆可 → 全天事件
    const next = new Date(new Date(`${v.date}T00:00:00Z`).getTime() + 86400000)
      .toISOString()
      .slice(0, 10);
    event.start = { date: v.date };
    event.end = { date: next };
  }

  return { event, eventId: eventIdFor(v) };
}

/* 即時 Telegram 通知（HTML）。 */
function buildRecoveryPush(v) {
  const slotLabel = SLOT_LABEL[v.slot] || v.slot;
  const lines = [
    "<b>🐻 新回收預約・客人自助</b>",
    "",
    `姓名：${esc(v.name)}`,
    `電話：${esc(v.phone)}`,
    `希望回收：${esc(v.date)}　${esc(slotLabel)}`,
    `存放地址：${esc(v.address)}`,
    v.note ? `備註：${esc(v.note)}` : null,
    "",
    "⚠️ 記得跟客人要「物品現況照片」（若 LINE 尚未收到）",
  ].filter((l) => l !== null);
  return lines.join("\n");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const parsed = normalizeInput(body);
  if (!parsed.ok) {
    return res.status(400).json({ error: "missing_fields", fields: parsed.missing });
  }
  const v = parsed.value;

  if (!isConfigured()) {
    // 沒設定行事曆時，這筆會無處落地 —— 明白回錯，讓前端請客人改用 LINE。
    console.error("create-recovery-booking: gcal not configured — cannot record booking");
    return res.status(503).json({ error: "calendar_unavailable" });
  }

  const { event, eventId } = buildRecoveryEvent(v);

  // 行事曆 = 唯一落地紀錄，寫失敗就回錯。
  let cal;
  try {
    cal = await insertEvent(event, eventId);
  } catch (e) {
    console.error("create-recovery-booking: insertEvent failed:", e);
    return res.status(502).json({ error: "calendar_write_failed" });
  }

  // Telegram 即時提醒 = 盡力而為，失敗不影響回應。
  let tg = { sent: false, error: null };
  try {
    await sendTelegram(buildRecoveryPush(v));
    tg.sent = true;
  } catch (e) {
    console.error("create-recovery-booking: telegram push failed:", e);
    tg.error = e.message;
  }
  console.log("create-recovery-booking:", JSON.stringify({ eventId, duplicate: !!cal.duplicate, tg: tg.sent }));

  return res.status(200).json({ ok: true, duplicate: !!cal.duplicate, telegram: tg.sent });
};

// 匯出純函式供測試。
module.exports.normalizeInput = normalizeInput;
module.exports.buildRecoveryEvent = buildRecoveryEvent;
module.exports.buildRecoveryPush = buildRecoveryPush;
module.exports.SLOT_TIMES = SLOT_TIMES;
module.exports.SLOT_LABEL = SLOT_LABEL;
