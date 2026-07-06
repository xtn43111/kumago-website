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

/* Build the Asia/Tokyo [00:00, next-00:00) window for an explicit calendar day.
 * dateStr is "YYYY-MM-DD" (already validated, e.g. by tg_event.parseDate). Used
 * by the on-demand "/行程 <date>" Telegram query. */
function jstDayWindow(dateStr) {
  const wdFmt = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Tokyo", weekday: "short",
  });
  const next = new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + 86400000)
    .toISOString().slice(0, 10);
  return {
    dateStr,
    // noon JST keeps the weekday correct regardless of the host's own zone.
    weekday: wdFmt.format(new Date(`${dateStr}T12:00:00+09:00`)),
    timeMin: `${dateStr}T00:00:00+09:00`,
    timeMax: `${next}T00:00:00+09:00`,
  };
}

/* Parse a bare month token into "YYYY-MM" (JST). Empty → current month. Accepts:
 *   8   8月   2026-08   2026/8   2026.08   當月的年份補上。 Returns null if unusable.
 * todayJst is "YYYY-MM-DD" (supplies the year when only a month is given). */
function parseMonth(raw, todayJst) {
  const s = String(raw || "").trim();
  if (!s) return todayJst.slice(0, 7); // no argument → current JST month
  const cleaned = s
    .replace(/[年.]/g, "-").replace(/月/g, "").replace(/\//g, "-")
    .replace(/-+$/, "").replace(/-+/g, "-");
  const parts = cleaned.split("-").map((x) => x.trim()).filter(Boolean);
  let y, mo;
  if (parts.length >= 2) { y = Number(parts[0]); mo = Number(parts[1]); }
  else if (parts.length === 1) { mo = Number(parts[0]); y = Number(todayJst.slice(0, 4)); }
  else return null;
  if (!(mo >= 1 && mo <= 12) || !(y >= 2000 && y <= 2999)) return null;
  return `${y}-${String(mo).padStart(2, "0")}`;
}

/* Build the Asia/Tokyo [first-00:00, next-month-first-00:00) window for a whole
 * calendar month. monthStr is "YYYY-MM" (already validated by parseMonth). Used
 * by the on-demand "/本月" overview & "/本月詳細" Telegram queries. */
function jstMonthWindow(monthStr) {
  const [y, mo] = monthStr.split("-").map(Number);
  const pad = (n) => String(n).padStart(2, "0");
  const ny = mo === 12 ? y + 1 : y;
  const nmo = mo === 12 ? 1 : mo + 1;
  return {
    monthStr,
    label: `${y}年${mo}月`,
    timeMin: `${y}-${pad(mo)}-01T00:00:00+09:00`,
    timeMax: `${ny}-${pad(nmo)}-01T00:00:00+09:00`,
  };
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

/* The Asia/Tokyo calendar date ("YYYY-MM-DD") an event falls on. All-day events
 * already carry a date; timed events are projected into JST. */
function eventJstDate(event) {
  const s = (event && event.start) || {};
  if (s.date) return s.date;
  if (s.dateTime) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(s.dateTime));
  }
  return "";
}

/* "YYYY-MM-DD" → "M/D（週）" in Asia/Tokyo (noon keeps the weekday zone-proof). */
function mdWeek(dateStr) {
  const [, mo, d] = dateStr.split("-").map(Number);
  const weekday = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Tokyo", weekday: "short",
  }).format(new Date(`${dateStr}T12:00:00+09:00`));
  return `${mo}/${d}（${weekday}）`;
}

/* Group events by their JST date, preserving order. listEvents returns them
 * sorted by start time, so both the dates and each day's events come out
 * chronological. Returns [[dateStr, events], …]. */
function groupByDate(events) {
  const map = new Map();
  for (const e of events) {
    const k = eventJstDate(e);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  return [...map.entries()];
}

/* Clean one description line. Returns null to drop the line entirely, or a
 * MAP_MARK-prefixed url for a map link. Handles both the auto-generated 配送單
 * format and the owner's free-form manual format. stripAmt=false keeps 金額
 * (回收/搬家 jobs need "收/給多少錢"); delivery jobs strip it (already paid). */
function sanitizeLine(raw, stripAmt) {
  let line = raw;
  const t = line.trim();

  if (line.startsWith("🐻")) return null;                       // auto header — we add our own
  {                                                             // manual-event photo stored as an <a> (for mobile calendar) → show raw URL
    const pm = t.match(/^🖼\s*照片\s*[：:]\s*<a\s+href="([^"]+)"[^>]*>.*?<\/a>\s*$/i);
    if (pm) return `🖼 照片：${pm[1].replace(/&amp;/g, "&")}`;
  }
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

/* Pack plain-text blocks into as few Telegram-sized messages as possible.
 * Measures the RENDERED (HTML) length so a message never overflows Telegram's
 * cap once map/photo links expand. Each block stays intact (never split), so
 * blocks should individually sit under the limit. Returns rendered strings. */
function packMessages(header, blocks, sep) {
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

/* Build the full digest as an array of Telegram-sized message strings.
 * ctx.title    heading after "🐻 KUMAGO " (default "明日行程" for the daily cron;
 *              the on-demand date query passes "行程").
 * ctx.emptyText the no-events line (default "明天沒有行程 🎉"). */
function buildDigest(events, ctx) {
  const title = ctx.title || "明日行程";
  const emptyText = ctx.emptyText || "明天沒有行程 🎉";
  const dateLine = `📅 ${ctx.dateStr}（${ctx.weekday}）`;
  if (!events.length) {
    return [render(`🐻 KUMAGO ${title}\n${dateLine}\n\n${emptyText}`)];
  }
  const header = `🐻 KUMAGO ${title}\n${dateLine}　共 ${events.length} 筆`;
  const blocks = events.map((e, i) => eventBlock(e, i + 1));
  return packMessages(header, blocks, "\n\n━━━━━━━━━━\n\n");
}

/* Month overview ("/本月"): one compact block per day that has events — each
 * event shown as "🕒 時段　標題". Gives an at-a-glance list of which days are
 * booked. ctx.label is "YYYY年M月"; ctx.emptyText overrides the no-events line. */
function buildMonthOverview(events, ctx) {
  const header = `🐻 KUMAGO ${ctx.label} 總覽`;
  if (!events.length) {
    return [render(`${header}\n\n${ctx.emptyText || "這個月沒有行程 🎉"}`)];
  }
  const groups = groupByDate(events);
  const top = `${header}\n共 ${events.length} 筆・${groups.length} 天有行程`;
  const blocks = groups.map(([date, evs]) => {
    const lines = [`📅 ${mdWeek(date)}　${evs.length} 筆`];
    for (const e of evs) {
      const stripAmt = isDeliveryEvent(e);
      lines.push(`　🕒 ${slotLabel(e)}　${cleanTitle(e.summary, stripAmt)}`);
    }
    return lines.join("\n");
  });
  return packMessages(top, blocks, "\n\n");
}

/* Month detail ("/本月詳細"): every event's full agenda block, grouped under a
 * date header for each day. Reuses the daily-digest eventBlock so the on-the-road
 * sanitising (drops 金額/租期/email) is identical. */
function buildMonthDetail(events, ctx) {
  const header = `🐻 KUMAGO ${ctx.label} 詳細行程`;
  if (!events.length) {
    return [render(`${header}\n\n${ctx.emptyText || "這個月沒有行程 🎉"}`)];
  }
  const groups = groupByDate(events);
  const top = `${header}\n共 ${events.length} 筆・${groups.length} 天有行程`;
  // Flat atom list: each date header and each event block is its own atom, so a
  // day with many events can still split across messages without overflowing.
  const atoms = [];
  for (const [date, evs] of groups) {
    atoms.push(`━━━ ${mdWeek(date)} ━━━`);
    evs.forEach((e, i) => atoms.push(eventBlock(e, i + 1)));
  }
  return packMessages(top, atoms, "\n\n");
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

/* Send a message to an explicit chat id (used to reply to the owner's incoming
 * messages on the manual-event webhook). plainText=true skips HTML parsing so a
 * raw reply can't trip Telegram's HTML parser. Throws on failure. */
const TG_HARD_LIMIT = 4096; // Telegram's absolute per-message character cap
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTelegramTo(chatId, text, plainText) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) throw new Error("telegram_not_configured");

  let body = String(text == null ? "" : text);
  let mode = plainText ? null : "HTML";
  // M1: a single oversized block would otherwise be rejected whole (the owner
  // silently loses that message). Truncate to fit; drop HTML parsing on a
  // truncated body so a cut-off tag can't turn into a "can't parse entities"
  // rejection — literal tags are ugly but the content still gets through.
  if (body.length > TG_HARD_LIMIT) {
    body = body.slice(0, TG_HARD_LIMIT - 24) + "\n…（訊息過長，已截斷）";
    mode = null;
  }

  const payload = { chat_id: chatId, text: body, disable_web_page_preview: true };
  if (mode) payload.parse_mode = mode;

  // M2: honour Telegram 429 rate limits (retry_after) instead of dropping the
  // message — a multi-message digest otherwise loses whichever chunk got limited.
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (j.ok) return j.result.message_id;
    const retryAfter = j.parameters && j.parameters.retry_after;
    if (r.status === 429 && retryAfter != null && attempt < 2) {
      await sleep(Math.min(Number(retryAfter) || 1, 5) * 1000);
      continue;
    }
    throw new Error("telegram_send_failed: " + (j.description || r.status));
  }
}

/* Send one message via the Telegram Bot API to the owner's configured chat.
 * Throws on failure. */
async function sendTelegram(text) {
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!chat) throw new Error("telegram_not_configured");
  return sendTelegramTo(chat, text);
}

module.exports = {
  jstTomorrowWindow,
  jstDayWindow,
  jstMonthWindow,
  parseMonth,
  slotLabel,
  sanitizeDescription,
  eventBlock,
  buildDigest,
  buildMonthOverview,
  buildMonthDetail,
  buildOrderPush,
  sendTelegram,
  sendTelegramTo,
};
