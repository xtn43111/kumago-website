/* KUMAGO — parse a manual Telegram message into a Google Calendar event.
 *
 * The owner types a labelled message to @littleBKbear_bot and it becomes an
 * event on the shop calendar. Deliberately DETERMINISTIC (no AI): the message
 * uses fixed labels, so parsing is a plain regex map — reliable and free.
 *
 * Supported labels (full-width ：or half-width : both work; aliases listed):
 *   標題 / 主題 / 事件 / title        → summary   (required)
 *   日期 / date                       → date      (required)  e.g. 2026-07-05, 7/5
 *   時間 / time                       → time      (optional)  e.g. 14:00 or 14:00-16:00
 *   地址 / 住址 / address              → location text
 *   地圖 / 地點 / 連結 / map           → map URL (also auto-detected from any URL)
 *   聯絡 / 電話 / phone / contact       → contact
 *   備註 / 注 / note / memo            → note
 *
 * A photo's proxy URL (built by the webhook) is passed in via opts.photoUrl and
 * appended to the description as a 🖼 照片 line.
 *
 * Pure module — no network, no env. buildManualEvent() returns either
 *   { ok:true,  event, view }      a Calendar event resource ready to insert
 *   { ok:false, missing, errors }  what the owner still needs to provide
 */

"use strict";

const TIMEZONE = "Asia/Tokyo"; // deliveries are in Japan; JP has no DST

// label alias → canonical field. Lowercased before lookup.
const LABELS = {
  "標題": "summary", "主題": "summary", "事件": "summary", "title": "summary",
  "日期": "date", "date": "date",
  "時間": "time", "time": "time",
  "地址": "address", "住址": "address", "address": "address",
  "地圖": "map", "地點": "map", "地点": "map", "連結": "map", "链接": "map", "map": "map", "maps": "map",
  "聯絡": "contact", "联络": "contact", "電話": "contact", "电话": "contact", "phone": "contact", "contact": "contact",
  "備註": "note", "备注": "note", "注": "note", "note": "note", "memo": "note",
};

const URL_RE = /https?:\/\/\S+/;

/* Split a "標籤：值" line. Returns [field, value] or null if not a labelled line.
 * Matches the FIRST ：or : so values may themselves contain colons (URLs, times). */
function splitLabel(line) {
  const m = line.match(/^\s*([^：:]{1,8})\s*[：:]\s*(.*)$/);
  if (!m) return null;
  const key = m[1].trim().toLowerCase();
  const field = LABELS[key];
  if (!field) return null;
  return [field, m[2].trim()];
}

/* Parse a date token into YYYY-MM-DD (JST). Accepts:
 *   2026-07-05  2026/07/05  2026.7.5  7/5  07-05  7月5日
 * When the year is omitted, picks the next occurrence: this year if the date is
 * today-or-later in JST, otherwise next year. todayJst is "YYYY-MM-DD".  */
function parseDate(raw, todayJst) {
  if (!raw) return null;
  let s = raw.trim().replace(/[年月]/g, "-").replace(/日/g, "").replace(/\./g, "-").replace(/\//g, "-");
  s = s.replace(/-+$/, "").replace(/-+/g, "-");
  const parts = s.split("-").map((x) => x.trim()).filter(Boolean);
  let y, mo, d;
  if (parts.length === 3) {
    [y, mo, d] = parts.map(Number);
  } else if (parts.length === 2) {
    [mo, d] = parts.map(Number);
    y = Number(todayJst.slice(0, 4));
  } else {
    return null;
  }
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  const pad = (n) => String(n).padStart(2, "0");
  let iso = `${y}-${pad(mo)}-${pad(d)}`;
  // No explicit year → roll forward if already past.
  if (parts.length === 2 && iso < todayJst) {
    iso = `${y + 1}-${pad(mo)}-${pad(d)}`;
  }
  // Final sanity: a real calendar date (rejects 2/30 etc.).
  const dt = new Date(`${iso}T00:00:00Z`);
  if (dt.getUTCMonth() + 1 !== mo || dt.getUTCDate() !== d) return null;
  return iso;
}

/* Parse a time field into { start, end } "HH:MM:SS" (end may be null). Accepts:
 *   14:00            → 14:00–15:00 (defaults to +1h)
 *   14:00-16:00      → 14:00–16:00   ("~" / "～" / "–" / "到" also split a range)
 *   1400 / 1400-1600 → same
 * Returns null if no usable time (→ caller makes an all-day event). */
function parseTime(raw) {
  if (!raw) return null;
  const norm = raw.replace(/[～~–—到至]/g, "-").trim();
  const toHM = (tok) => {
    if (!tok) return null;
    let t = tok.trim();
    let m = t.match(/^(\d{1,2})\s*[:：]\s*(\d{2})$/);
    if (!m) m = t.match(/^(\d{1,2})(\d{2})$/); // 1400
    if (!m) m = t.match(/^(\d{1,2})$/) ? [null, t.match(/^(\d{1,2})$/)[1], "00"] : null;
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00`;
  };
  const [a, b] = norm.split("-");
  const start = toHM(a);
  if (!start) return null;
  let end = b != null ? toHM(b) : null;
  if (!end) {
    // default +1h, clamped to 23:59:59
    const [h, mi] = start.split(":").map(Number);
    const eh = Math.min(h + 1, 23);
    end = `${String(eh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00`;
  }
  return { start, end };
}

/* Parse a labelled message body (text or photo caption) into fields. Any line
 * that isn't a recognised label is collected as free-text 內文 (kept as note). */
function parseFields(text) {
  const fields = { extra: [] };
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) continue;
    const kv = splitLabel(line);
    if (kv) {
      const [field, value] = kv;
      // 'note' can span multiple labelled lines — concatenate.
      if (field === "note" && fields.note) fields.note += "\n" + value;
      else fields[field] = value;
    } else {
      fields.extra.push(line.trim());
    }
  }
  // Auto-detect a map/location URL if no explicit 地圖 label was given.
  if (!fields.map) {
    for (const l of [fields.address, ...fields.extra]) {
      const m = l && l.match(URL_RE);
      if (m) { fields.map = m[0]; break; }
    }
  }
  return fields;
}

/* Build the Calendar event resource from parsed fields.
 *   opts.photoUrl  proxy URL of an attached photo (optional)
 *   opts.todayJst  "YYYY-MM-DD" in Asia/Tokyo (for year-rollover on bare dates)
 * Returns { ok, event, view } or { ok:false, missing, errors }. */
function buildManualEvent(text, opts) {
  opts = opts || {};
  const todayJst = opts.todayJst || "1970-01-01";
  const f = parseFields(text);

  // 標題 falls back to the first free-text line if unlabelled.
  let summary = f.summary;
  if (!summary && f.extra.length) summary = f.extra.shift();

  const missing = [];
  if (!summary) missing.push("標題");
  const date = parseDate(f.date, todayJst);
  if (!f.date) missing.push("日期");
  else if (!date) return { ok: false, missing: [], errors: [`日期看不懂：「${f.date}」（請用 2026-07-05 或 7/5）`] };

  if (missing.length) return { ok: false, missing, errors: [] };

  const time = parseTime(f.time);
  const note = [f.note, ...(f.extra || [])].filter(Boolean).join("\n").trim();

  // Auto-generate a Google Maps search link from the address when the owner only
  // gave an address (no explicit map/pin URL) — same format as the order flow
  // (order.js searchMapUrl), so the event always carries a clickable 地圖 link.
  if (!f.map && f.address) {
    f.map = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(f.address);
  }

  const descLines = [
    "🐻 KUMAGO 手動行程",
    "",
    f.address ? `地址：${f.address}` : null,
    f.map ? `📍 Google 地圖：${f.map}` : null,
    f.contact ? `聯絡：${f.contact}` : null,
    note ? `備註：${note}` : null,
    // Explicit HTML anchor, NOT a bare URL: mobile Google Calendar's auto-link
    // detector truncates the tail of long bare URLs (drops the last chars of the
    // file_id → "invalid file_id"). An <a href> is used verbatim, so it's safe.
    opts.photoUrl
      ? `🖼 照片：<a href="${opts.photoUrl.replace(/&/g, "&amp;")}">點此查看</a>`
      : null,
  ].filter((l) => l !== null);

  const event = {
    summary,
    description: descLines.join("\n"),
  };
  if (f.map) event.location = f.map;
  else if (f.address) event.location = f.address;

  if (time) {
    event.start = { dateTime: `${date}T${time.start}`, timeZone: TIMEZONE };
    event.end = { dateTime: `${date}T${time.end}`, timeZone: TIMEZONE };
  } else {
    const next = new Date(new Date(`${date}T00:00:00Z`).getTime() + 86400000)
      .toISOString().slice(0, 10);
    event.start = { date };
    event.end = { date: next };
  }
  // No calendar popups — the daily Telegram digest is the single reminder channel.
  event.reminders = { useDefault: false, overrides: [] };

  const view = {
    summary, date,
    time: time ? `${time.start.slice(0, 5)}–${time.end.slice(0, 5)}` : "整天",
    address: f.address || "", map: f.map || "", contact: f.contact || "",
    note, photoUrl: opts.photoUrl || "",
  };
  return { ok: true, event, view };
}

/* The reply template shown when a message can't be parsed. */
const TEMPLATE =
  "請用這個格式新增行程（標題＋日期必填）：\n\n" +
  "標題：庭綺 回收\n" +
  "日期：2026-07-05\n" +
  "時間：14:00-16:00\n" +
  "地址：大阪市東成区…\n" +
  "聯絡：080-xxxx-xxxx\n" +
  "備註：3樓無電梯\n\n" +
  "（時間可省略＝整天；可直接附一張照片，會自動存進事件）";

module.exports = {
  buildManualEvent, parseFields, parseDate, parseTime, splitLabel, TEMPLATE, TIMEZONE,
};
