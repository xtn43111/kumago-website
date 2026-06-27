/* KUMAGO — Telegram daily delivery digest.
 *
 * Turns the shop calendar's events into a delivery-only briefing pushed to the
 * owner via the @littleBKbear_bot Telegram bot, then sends it. Deliberately
 * STRIPS the three things the owner doesn't want on the road:
 *   • 金額  — the 【合計】 line and any ¥ prices in 明細
 *   • 租期  — the "× {duration}" tail of the 【方案】 line
 *   • email — the 聯絡 line is dropped when its value is an email (the contact
 *             field is free-text and may hold an email instead of a phone);
 *             only a phone number is kept.
 *
 * Pure helpers (window/sanitize/digest) are testable without network. sendTelegram
 * is the only side-effecting call.
 *
 * Env vars (in .env AND Vercel → Settings → Env):
 *   TELEGRAM_BOT_TOKEN   bot API token from BotFather
 *   TELEGRAM_CHAT_ID     the owner's private chat id
 */

"use strict";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TG_LIMIT = 3500; // stay well under Telegram's 4096-char hard cap

// Any yen amount, half- or full-width: ¥55,080 / ￥4000 / ¥ 3,500
const AMOUNT_RE = /[¥￥]\s?[\d,]+/g;
// Duration tokens used in this shop's titles & 方案 lines: 一年 / 兩年 / 3個月 / 4月 / 1年
const DUR = "[一二兩三四五六七八九十0-9]+\\s*(?:個月|月|年)";

function stripAmounts(s) {
  return s.replace(AMOUNT_RE, "").replace(/\s{2,}/g, " ");
}
// 租期: remove "方案一年" → "方案" (titles) and " × 1年" → "" (body 方案 lines)
function stripDuration(s) {
  return s
    .replace(new RegExp("(方案)\\s*" + DUR, "g"), "$1")
    .replace(new RegExp("\\s*×\\s*" + DUR, "g"), "");
}
// Tidy leftovers after amounts/durations are removed.
function tidy(s) {
  return s.replace(/\s*、\s*/g, "、").replace(/、\s*$/, "").replace(/\s{2,}/g, " ").trimEnd();
}

// Messages are sent as Telegram HTML. Map lines render as plain "地點：<url>"
// (owner wants the raw URL, not a hidden hyperlink).<url> is an internal sentinel for "this line is a map link".
const MAP_MARK = "";
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
function isMapLine(line) {
  return /https?:\/\/\S+/.test(line) && /(地圖|地點|maps)/i.test(line);
}
function mapUrl(line) {
  const m = line.match(/https?:\/\/\S+/);
  return m ? m[0] : "";
}
// Render one (possibly sentinel) line to its final HTML form.
function renderLine(line) {
  if (line.startsWith(MAP_MARK)) {
    return `地點：${escapeHtml(line.slice(1))}`;
  }
  return escapeHtml(line);
}
function render(msg) {
  return msg.split("\n").map(renderLine).join("\n");
}

/* Compute tomorrow's Asia/Tokyo window. now is a Date (defaults to real now).
 * JST has no DST, so +24h / +48h always advance the JST calendar date by 1 / 2. */
function jstTomorrowWindow(now) {
  now = now || new Date();
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const wdFmt = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Tokyo", weekday: "short",
  });
  const tomorrow = new Date(now.getTime() + 86400000);
  const dayAfter = new Date(now.getTime() + 2 * 86400000);
  const dateStr = dateFmt.format(tomorrow); // YYYY-MM-DD in JST
  const nextStr = dateFmt.format(dayAfter);
  return {
    dateStr,
    weekday: wdFmt.format(tomorrow),
    timeMin: `${dateStr}T00:00:00+09:00`,
    timeMax: `${nextStr}T00:00:00+09:00`,
  };
}

/* The delivery time slot for one event, in JST wall-clock. */
function slotLabel(event) {
  const s = (event && event.start) || {};
  const e = (event && event.end) || {};
  if (s.dateTime) {
    const f = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const start = f.format(new Date(s.dateTime));
    const end = e.dateTime ? "–" + f.format(new Date(e.dateTime)) : "";
    return start + end;
  }
  return "整天 / 未指定時段";
}

/* Clean one description line. Returns null to drop the line entirely, or a
 * MAP_MARK-prefixed url for a map link. Handles both the auto-generated 配送單
 * format and the owner's free-form manual format. stripAmt=false keeps 金額
 * (回收/搬家 jobs need "收/給多少錢"); delivery jobs strip it (already paid). */
function sanitizeLine(raw, stripAmt) {
  let line = raw;
  const t = line.trim();

  if (line.startsWith("🐻")) return null;                       // auto header — we add our own
  if (/^(e-?mail|電子郵件)\s*[：:]/i.test(t)) return null;        // email — always drop
  if (/^租期\s*[：:]/.test(t)) return null;                      // 租期 dates — always drop
  if (/^(姓名)\s*[：:]/.test(t) || t.startsWith("【姓名")) return null; // name is in the header
  if (isMapLine(t)) return MAP_MARK + mapUrl(t);               // map → short "地點" link
  if (/^電梯\s*[：:]/.test(t)) {                                 // elevator: only note when there ISN'T one
    const v = t.replace(/^電梯\s*[：:]/, "").trim();
    if (!/[無沒]/.test(v)) return null;                         // 有 → drop; 無/沒有 → keep
  }
  if (/^聯絡\s*[：:]/.test(t)) {                                 // 聯絡 that is really an email → drop
    const v = t.replace(/^聯絡\s*[：:]/, "").trim();
    if (EMAIL_RE.test(v)) return null;
  }

  if (/^(方案|【方案)/.test(t)) line = stripDuration(line);      // strip 租期 from plan line
  line = line.replace(/[（(]\s*有電梯\s*[）)]/g, "");             // drop inline "(有電梯)" markers

  if (stripAmt) {
    if (/^(合計|總計|小計|總額)\s*[：:]/.test(t) || t.startsWith("【合計")) return null; // total
    line = line.replace(/\s*¥[\d,]*\s*$/, "");                  // 明細 "・item ¥1,234" → "・item"
    line = stripAmounts(line);                                  // strip 金額 everywhere
    const tt = line.trim();
    if (/[：:]$/.test(tt)) return null;                         // dangling label e.g. "合計：" / "收："
    if (/^[收付]$/.test(tt)) return null;                       // lone "收"/"付" left by a fee line
  }

  if (line.trim() === "") return null;                          // went blank after cleaning
  return tidy(line);
}

/* Filter an event's description down to job-safe lines. */
function sanitizeDescription(desc, stripAmt) {
  if (!desc) return [];
  const out = [];
  for (const raw of String(desc).split("\n")) {
    const l = sanitizeLine(raw, stripAmt);
    if (l === null) continue;
    out.push(l);
  }
  // collapse runs of blank lines and trim the ends
  const collapsed = [];
  for (const l of out) {
    if (l.trim() === "" && (collapsed.length === 0 || collapsed[collapsed.length - 1].trim() === "")) continue;
    collapsed.push(l);
  }
  while (collapsed.length && collapsed[collapsed.length - 1].trim() === "") collapsed.pop();
  return collapsed;
}

/* Clean an event title for the block header: drop the 【上午/下午】 slot prefix
 * (the real time is shown beside it), strip 租期 (and 金額 for delivery only). */
function cleanTitle(summary, stripAmt) {
  let s = String(summary || "");
  s = s.replace(/^【(上午|下午|早上|晚上|全天|整天)】\s*/, "");
  s = stripDuration(s);
  s = s.replace(/[（(]\s*有電梯\s*[）)]/g, "");
  if (stripAmt) s = stripAmounts(s);
  s = s.trim();
  return s || "（無標題）";
}

/* Delivery jobs (online-paid) hide 金額; 回收/搬家 jobs show it. */
function isDeliveryEvent(event) {
  return /配送|入住配送/.test(String(event.summary || ""));
}

/* One numbered agenda block (plain text; map lines carry the MAP_MARK sentinel). */
function eventBlock(event, n) {
  const stripAmt = isDeliveryEvent(event);
  const header = `【${n}】${cleanTitle(event.summary, stripAmt)}　🕒 ${slotLabel(event)}`;
  const body = sanitizeDescription(event.description, stripAmt);
  return [header, ...body].join("\n");
}

/* Build the full digest as an array of Telegram-sized message strings. */
function buildDigest(events, ctx) {
  const dateLine = `📅 ${ctx.dateStr}（${ctx.weekday}）`;
  if (!events.length) {
    return [render(`🐻 KUMAGO 明日行程\n${dateLine}\n\n明天沒有行程 🎉`)];
  }
  const header = `🐻 KUMAGO 明日行程\n${dateLine}　共 ${events.length} 筆`;
  const sep = "\n\n━━━━━━━━━━\n\n";
  const blocks = events.map((e, i) => eventBlock(e, i + 1));

  // Accumulate plain-text blocks, but measure the RENDERED (HTML) length so a
  // message never overflows Telegram's cap once links expand.
  const msgs = [];
  let cur = header;
  for (const b of blocks) {
    const candidate = cur + sep + b;
    if (render(candidate).length > TG_LIMIT) {
      msgs.push(render(cur));
      cur = b;
    } else {
      cur = candidate;
    }
  }
  if (cur) msgs.push(render(cur));
  return msgs;
}

function yen(n) {
  return "¥" + Number(n || 0).toLocaleString("ja-JP");
}

/* Instant per-order push to the owner the moment a payment completes (separate
 * from the daily digest). Customer / delivery info sits up top for at-a-glance
 * action; items and amount follow. `v` is the normalised orderView from
 * lib/mailer.js. Returns Telegram-HTML (matches sendTelegram's parse_mode). */
function buildOrderPush(v) {
  const e = escapeHtml;
  const fullAddr =
    `〒${v.postal} ${v.address}${v.building ? " " + v.building : ""}`.trim();
  const addonLine = v.addonNames.length ? v.addonNames.map(e).join("、") : "（無）";
  const items = (v.items || []).map((i) => `・${e(i.label)}　${yen(i.amount)}`);

  const lines = [
    "<b>KUMAGO 新訂單・已付款</b>",
    "",
    v.name ? `姓名：${e(v.name)}` : null,
    v.contact ? `聯絡：${e(v.contact)}` : null,
    v.moveInDate
      ? `入住日：${e(v.moveInDate)}${v.deliveryTime ? "　" + e(v.deliveryTime) : ""}`
      : null,
    v.areaName ? `配送地區：${e(v.areaName)}` : null,
    fullAddr ? `地址：${e(fullAddr)}` : null,
    v.mapUrl ? `地點：${e(v.mapUrl)}` : null,
    v.elevator ? `電梯：${e(v.elevator)}` : null,
    v.note ? `備註：${e(v.note)}` : null,
    "",
    "―― 訂單明細 ――",
    v.planName
      ? `方案：${e(v.planName)}${v.duration ? " × " + e(v.duration) : ""}`
      : null,
    `加購：${addonLine}`,
    "",
    ...(items.length ? items : ["（無）"]),
    `合計（已付款）：${yen(v.total)}`,
  ].filter((l) => l !== null);

  return lines.join("\n");
}

/* Send one message via the Telegram Bot API. Throws on failure. */
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error("telegram_not_configured");
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error("telegram_send_failed: " + (j.description || r.status));
  return j.result.message_id;
}

module.exports = {
  jstTomorrowWindow,
  slotLabel,
  sanitizeDescription,
  eventBlock,
  buildDigest,
  buildOrderPush,
  sendTelegram,
};
