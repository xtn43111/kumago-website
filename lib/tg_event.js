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
  "姓名": "summary", "名字": "summary", "name": "summary",
  "日期": "date", "date": "date",
  "時間": "time", "time": "time",
  "地址": "address", "住址": "address", "address": "address",
  "地圖": "map", "地點": "map", "地点": "map", "連結": "map", "链接": "map", "map": "map", "maps": "map",
  "聯絡": "contact", "联络": "contact", "電話": "contact", "电话": "contact", "phone": "contact", "contact": "contact",
  "備註": "note", "备注": "note", "注": "note", "note": "note", "memo": "note",
};

const URL_RE = /https?:\/\/\S+/;

/* The event-description photo line. Kept as an explicit HTML <a> (NOT a bare URL)
 * because mobile Google Calendar truncates long bare URLs. Shared by
 * buildManualEvent and the album-append path so both write the identical line. */
function photoDescLine(url) {
  return `🖼 照片：<a href="${String(url).replace(/&/g, "&amp;")}">點此查看</a>`;
}
// Matches that whole line (for replacing it when more album photos arrive).
const PHOTO_LINE_RE = /^🖼\s*照片\s*[：:].*$/m;

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
      // summary 先到先贏（標題 vs 姓名 同時出現時，前面的算數，後到的進備註）
      else if (field === "summary" && fields.summary) fields.extra.push(line.trim());
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

/* ── 自由格式（無標籤）解析 ──────────────────────────────
 * 老闆直接貼一段資訊（LINE 對話、備忘），不用死格式標籤。
 * 觸發時機：訊息裡一個可辨識標籤都沒有（parseFields 全進 extra）。
 * 策略：全文掃日期／時間／電話／Email／URL；帶日本地址特徵的行當地址；
 * 第一行（去掉日期時間電話碎片後）當標題；其餘行全數進備註。 */

const REL_DATES = { "今天": 0, "今日": 0, "明天": 1, "明日": 1, "後天": 2, "后天": 2, "大後天": 3, "大后天": 3 };
// 大後天要排在後天前面，長詞先比對
const DATE_TOKEN_RE =
  /(\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?)|(\d{1,2}\s*[/月]\s*\d{1,2}\s*日?)|(大後天|大后天|後天|后天|明天|明日|今天|今日)/;
const TIME_TOKEN_RE =
  /(\d{1,2}\s*[:：]\s*\d{2}(?:\s*[-~～–—到至]\s*\d{1,2}\s*[:：]\s*\d{2})?)/;
const CN_TIME_RE = /(凌晨|早上|上午|中午|下午|晚上)\s*(\d{1,2})\s*[點点時时](半)?/;
const PHONE_RE = /(?<!\d)(0\d{1,3}[-\s]?\d{3,4}[-\s]?\d{3,4})(?!\d)/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function relDateToIso(word, todayJst) {
  const days = REL_DATES[word];
  if (days === undefined) return null;
  const d = new Date(`${todayJst}T00:00:00Z`);
  return new Date(d.getTime() + days * 86400000).toISOString().slice(0, 10);
}

/* 中文時段 → "HH:MM"。下午/晚上 +12；中午12點=12:00；半=:30。 */
function cnTimeToHM(m) {
  let h = Number(m[2]);
  if (h > 23) return null;
  const period = m[1];
  if ((period === "下午" || period === "晚上") && h < 12) h += 12;
  if (period === "中午" && h < 11) h += 12; // 中午1點 = 13:00
  if (period === "凌晨" && h === 12) h = 0;
  const mi = m[3] ? "30" : "00";
  return `${String(h).padStart(2, "0")}:${mi}`;
}

function looksLikeAddress(line) {
  if (/丁目|番地|号室|號室|〒/.test(line)) return true;
  const hits = (line.match(/[都道府県縣市区區町村]/g) || []).length;
  return hits >= 2 && /[0-9０-９]/.test(line);
}

/* 全文掃描 → 與 parseFields 同形狀的欄位（值都是 raw 字串，交給既有
 * parseDate/parseTime 處理）。找不到日期回 null（叫不出事件）。 */
function freeFormScan(text, todayJst) {
  const lines = String(text || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return null;
  const whole = lines.join("\n");

  // 日期（必要）：相對詞直接換算成 ISO，parseDate 看得懂
  const dm = whole.match(DATE_TOKEN_RE);
  if (!dm) return null;
  const dateRaw = dm[3] ? relDateToIso(dm[3], todayJst) : dm[0].replace(/\s+/g, "");
  if (!dateRaw) return null;

  // 時間：數字格式優先，再試中文時段（「下午2點半」→ 14:30）
  let timeRaw = "";
  const tm = whole.match(TIME_TOKEN_RE);
  if (tm) timeRaw = tm[0].replace(/\s+/g, "");
  else {
    const cm = whole.match(CN_TIME_RE);
    if (cm) { const hm = cnTimeToHM(cm); if (hm) timeRaw = hm; }
  }

  const pm = whole.match(PHONE_RE);
  const em = whole.match(EMAIL_RE);
  const um = whole.match(URL_RE);
  const addrLine = lines.find(looksLikeAddress) || "";

  // 標題：第一個「去掉日期/時間/電話碎片後還有東西」且不是地址的行
  let title = "", titleLine = "";
  for (const line of lines) {
    if (line === addrLine) continue;
    const stripped = line
      .replace(DATE_TOKEN_RE, " ")
      .replace(TIME_TOKEN_RE, " ")
      .replace(CN_TIME_RE, " ")
      .replace(PHONE_RE, " ")
      .replace(EMAIL_RE, " ")
      .replace(URL_RE, " ")
      .replace(/[\s，,、。;；:：~～\-–—]+/g, " ")
      .trim();
    if (stripped.length >= 2) { title = stripped.slice(0, 60); titleLine = line; break; }
  }
  if (!title) return null; // 只有日期沒內容，不硬建

  // 備註：標題行與地址行以外全部保留（電話/Email 行照樣留著，資訊不丟）
  const note = lines.filter((l) => l !== titleLine && l !== addrLine).join("\n");

  return {
    summary: title,
    date: dateRaw,
    time: timeRaw,
    address: addrLine,
    contact: (pm && pm[0]) || (em && em[0]) || "",
    map: (um && um[0]) || "",
    note,
    extra: [],
    freeForm: true,
  };
}

/* Build the Calendar event resource from parsed fields.
 *   opts.photoUrl  proxy URL of an attached photo (optional)
 *   opts.todayJst  "YYYY-MM-DD" in Asia/Tokyo (for year-rollover on bare dates)
 * Returns { ok, event, view } or { ok:false, missing, errors }. */
function buildManualEvent(text, opts) {
  opts = opts || {};
  const todayJst = opts.todayJst || "1970-01-01";
  let f = parseFields(text);

  // 一個標籤都沒有 → 走自由格式全文掃描（貼一段話就能加行程）。
  // map 不算：parseFields 會自動把訊息裡的 URL 撿進 f.map，不代表有打標籤。
  const hasLabels = ["summary", "date", "time", "address", "contact", "note"]
    .some((k) => f[k]);
  if (!hasLabels) {
    const ff = freeFormScan(text, todayJst);
    if (ff) f = ff;
  }

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
    opts.photoUrl ? photoDescLine(opts.photoUrl) : null,
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

/* Is this message an "ADD photos to an EXISTING event" command? The owner
 * attaches new photo(s) and captions them with the command, a date, and
 * (optionally) a title keyword to pick the event:
 *
 *   加照片：7/5 庭綺            (single line: date then keyword)
 *   加照片\n日期：7/5\n標題：庭綺    (labelled lines also work)
 *
 * The new photos MERGE with the event's existing ones into one link (they do
 * not replace them). Aliases: 加照片 / 新增照片 / 補照片 / 更新照片 / 換照片 /
 * 改照片 / 照片更新. Returns null when the text is not this command at all;
 * otherwise { ok:true, date:"YYYY-MM-DD", keyword } or { ok:false, error }. */
const PHOTO_UPDATE_RE = /^\/?(加照片|新增照片|补照片|補照片|更新照片|換照片|换照片|改照片|照片更新)\s*[：:]?\s*/;
function parsePhotoUpdate(text, todayJst) {
  const t = String(text || "").trim();
  const m = t.match(PHOTO_UPDATE_RE);
  if (!m) return null;

  const rest = t.slice(m[0].length).trim();
  let dateRaw = "", keyword = "";

  if (/\n/.test(rest) || /^(日期|標題|标题|date|title)\s*[：:]/.test(rest)) {
    // Labelled form: reuse the normal field parser on the remainder.
    const f = parseFields(rest);
    dateRaw = f.date || "";
    keyword = (f.summary || f.extra.join(" ") || "").trim();
  } else {
    // Single line: the first token that parses as a date is the date; whatever
    // is left over is the title keyword.
    const tokens = rest.split(/\s+/).filter(Boolean);
    const rem = [];
    for (const tok of tokens) {
      if (!dateRaw && parseDate(tok, todayJst)) dateRaw = tok;
      else rem.push(tok);
    }
    keyword = rem.join(" ").trim();
  }

  if (!dateRaw) {
    return { ok: false, error: "請帶日期，例：加照片：7/5 庭綺" };
  }
  let date = parseDate(dateRaw, todayJst);
  if (!date) {
    return { ok: false, error: `日期看不懂：「${dateRaw}」（請用 2026-07-05 或 7/5）` };
  }
  // Bare dates (no explicit year) mean THIS year here — the target event often
  // already happened, so parseDate's roll-to-next-year (meant for NEW events)
  // would point at the wrong year. An explicit 4-digit year is kept as-is.
  if (!/\d{4}/.test(dateRaw)) {
    date = todayJst.slice(0, 4) + date.slice(4);
  }
  return { ok: true, date, keyword };
}

/* The reply template shown when a message can't be parsed. */
const TEMPLATE =
  "直接把資訊貼過來就行（要有日期），例如：\n\n" +
  "庭綺 回收冰箱洗衣機\n" +
  "7/20 下午2點\n" +
  "大阪市東成区大今里4-23-14 503\n" +
  "080-1234-5678\n\n" +
  "會自動抓日期／時間／地址／電話，其餘進備註。\n" +
  "也可用標籤格式精準指定：\n" +
  "標題：… 日期：… 時間：… 地址：… 聯絡：… 備註：…\n\n" +
  "（時間可省略＝整天；可直接附一張照片，會自動存進事件）\n\n" +
  "🖼 幫既有行程加照片：附上新照片，說明打\n" +
  "加照片：7/5 庭綺\n" +
  "（日期必填；後面可加標題關鍵字鎖定是哪一筆。\n" +
  "新照片會跟原有照片併成同一個連結，不會蓋掉）";

module.exports = {
  buildManualEvent, parseFields, parseDate, parseTime, splitLabel, TEMPLATE, TIMEZONE,
  photoDescLine, PHOTO_LINE_RE, parsePhotoUpdate, freeFormScan,
};
