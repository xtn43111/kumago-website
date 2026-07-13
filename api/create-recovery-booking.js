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
const { insertEvent, patchEvent, isConfigured } = require("../lib/gcal.js");
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

// 欄位長度上限（擋 10 萬字 payload 之類的濫用；行事曆/Telegram 都有實際顯示需求）。
const MAX = { name: 40, phone: 30, address: 120, note: 500 };
// 希望回收日期的合理窗（相對 JST 今天）：允許昨天以後、約 13 個月內。
const DATE_MIN_OFFSET = -2;   // 天
const DATE_MAX_OFFSET = 400;  // 天

// 現在的 JST 日期字串（日本無夏令時，UTC+9）。抽成函式方便測試注入 now。
function todayJST(now) {
  return new Date((now || Date.now()) + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 是否為真實存在的日曆日（擋 2026-13-45 / 2026-02-30 —— 否則全天事件路徑會
// 因 new Date(Invalid).toISOString() 丟出未捕捉的 RangeError 讓函式崩潰）。
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function dayOffsetJST(dateStr, now) {
  return Math.round(
    (Date.parse(`${dateStr}T00:00:00Z`) - Date.parse(`${todayJST(now)}T00:00:00Z`)) / 86400000
  );
}

/* 一致化 + 驗證進來的欄位。回傳 { ok, value? } 或
 * { ok:false, missing?[], invalid?[] }（missing=沒填；invalid=填了但格式/長度/範圍不對）。
 * now 參數僅供測試注入固定時間，正式呼叫省略。 */
function normalizeInput(body, now) {
  const b = body || {};
  const name = String(b.name || "").trim();
  const phone = String(b.phone || "").trim();
  const address = String(b.address || "").trim();
  const date = String(b.date || "").trim();
  const slot = String(b.slot || "").trim();
  const note = String(b.note || "").trim().slice(0, MAX.note);
  const lang = b.lang === "ja" ? "ja" : "zh";
  // LIFF 自動帶入的 LINE 身分（選填）：格式不對就靜默丟棄，不影響預約成立。
  const lineUserId = /^U[0-9a-f]{32}$/.test(String(b.lineUserId || "")) ? String(b.lineUserId) : "";
  const lineDisplayName = String(b.lineDisplayName || "").trim().slice(0, 60);

  // 先分「沒填」與「填了但不合法」，讓前端能給精準錯誤。
  const missing = [];
  if (!name) missing.push("name");
  if (!phone) missing.push("phone");
  if (!address) missing.push("address");
  if (!date) missing.push("date");
  if (!slot) missing.push("slot");
  if (missing.length) return { ok: false, missing };

  const invalid = [];
  if (name.length > MAX.name) invalid.push("name");
  // 電話：抽出數字後需 8–15 碼（涵蓋日本手機/市話與國際碼），原字串長度也設上限。
  const digits = phone.replace(/\D/g, "");
  if (phone.length > MAX.phone || digits.length < 8 || digits.length > 15) invalid.push("phone");
  if (address.length > MAX.address) invalid.push("address");
  if (!SLOT_LABEL[slot]) invalid.push("slot");
  if (!isRealDate(date)) invalid.push("date");
  else {
    const off = dayOffsetJST(date, now);
    if (off < DATE_MIN_OFFSET || off > DATE_MAX_OFFSET) invalid.push("date"); // 過去或太遠
  }
  if (invalid.length) return { ok: false, invalid };

  return { ok: true, value: { name, phone, address, date, slot, note, lang, lineUserId, lineDisplayName } };
}

/* 允許送單的來源網域（擋瀏覽器端跨站濫用；curl 類可偽造 Origin，故這只是一層）。 */
const ALLOWED_HOSTS = new Set(["kumago.7-mori.com", "localhost", "127.0.0.1"]);
function originAllowed(req) {
  const origin = req.headers && (req.headers.origin || "");
  if (!origin) return true; // 有些正常情境不帶 Origin（app 內嵌瀏覽器）→ 不擋
  try {
    const host = new URL(origin).hostname;
    return ALLOWED_HOSTS.has(host);
  } catch {
    return false; // Origin 有值但解不出 host → 可疑，擋
  }
}

/* 暖實例 best-effort 限流：同一 IP 10 分鐘最多 N 次。serverless 冷啟會重置、
 * 跨實例不共享，故非硬防護——真正的防濫用要 Turnstile 或共享 store（見待辦）。
 * 只在拿得到 client IP 時啟用（拿不到就不擋，避免誤傷正常流量與測試）。 */
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_MAX = 6;
const rlHits = new Map(); // ip -> number[] (timestamps)
function clientIp(req) {
  const xff = req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "");
  const ip = String(xff).split(",")[0].trim();
  return ip || null;
}
function rateLimited(req, now) {
  const ip = clientIp(req);
  if (!ip) return false;
  const t = now || Date.now();
  const arr = (rlHits.get(ip) || []).filter((ts) => t - ts < RL_WINDOW_MS);
  arr.push(t);
  rlHits.set(ip, arr);
  if (rlHits.size > 5000) rlHits.clear(); // 粗略上限，避免記憶體無限長
  return arr.length > RL_MAX;
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
    v.lineDisplayName
      ? `【LINE 名稱】${v.lineDisplayName}`
      : "⚠️【LINE】未取得——客人可能用一般瀏覽器開啟，聊天室裡可能找不到人",
    v.lineUserId ? `【LINE userId】${v.lineUserId}` : null,
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
    // 含「回收」→ 被歸類為 recovery，姓名供比對；LINE 顯示名直接進括號方便對人。
    summary: v.lineDisplayName
      ? `${v.name}（${v.lineDisplayName}）期滿回收預約`
      : `⚠️ ${v.name} 期滿回收預約（無LINE）`,
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
    v.lineDisplayName
      ? `LINE：${esc(v.lineDisplayName)}`
      : "⚠️ 未取得 LINE 名稱（客人可能不在 LINE 內開啟，聊天室恐找不到人）",
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

  // 擋跨站來源（有 Origin 且非白名單才擋；無 Origin 放行）。
  if (!originAllowed(req)) {
    return res.status(403).json({ error: "forbidden_origin" });
  }
  // 暖實例 best-effort 限流（拿得到 IP 時才生效）。
  if (rateLimited(req)) {
    res.setHeader("Retry-After", "600");
    return res.status(429).json({ error: "too_many_requests" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const parsed = normalizeInput(body);
  if (!parsed.ok) {
    return res.status(400).json({
      error: parsed.missing ? "missing_fields" : "invalid_fields",
      fields: parsed.missing || parsed.invalid,
    });
  }
  const v = parsed.value;

  if (!isConfigured()) {
    // 沒設定行事曆時，這筆會無處落地 —— 明白回錯，讓前端請客人改用 LINE。
    console.error("create-recovery-booking: gcal not configured — cannot record booking");
    return res.status(503).json({ error: "calendar_unavailable" });
  }

  const { event, eventId } = buildRecoveryEvent(v);

  // 行事曆 = 唯一落地紀錄，寫失敗就回錯。
  // 事件 id 只由 姓名/電話/日期/時段 決定（M2）：客人若用相同這四項、但修正了
  // 「地址」或「備註」重送，insertEvent 會撞 409 當重複、不更新 → 行事曆停在舊
  // 地址，而 Telegram 卻顯示新地址。故 duplicate 時補 patch 地址/說明，讓修正
  // 真的寫進唯一紀錄。
  let cal;
  try {
    cal = await insertEvent(event, eventId);
    if (cal && cal.duplicate) {
      // 重送也同步標題：第一次沒帶 LINE 資訊、第二次從 LINE 內重送時能補上。
      await patchEvent(eventId, {
        summary: event.summary,
        location: event.location,
        description: event.description,
      });
    }
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
module.exports.isRealDate = isRealDate;
module.exports.SLOT_TIMES = SLOT_TIMES;
module.exports.SLOT_LABEL = SLOT_LABEL;
