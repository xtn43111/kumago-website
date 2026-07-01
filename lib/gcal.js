/* KUMAGO — Google Calendar event writer for paid orders.
 *
 * After a payment succeeds, the Stripe webhook records the order onto the shop's
 * Google Calendar so the delivery shows up with date, time slot, full address and
 * the customer's Google Maps pin.
 *
 * Auth = OAuth refresh token (no SDK — raw fetch, matching the rest of /api).
 * Required env vars (set locally in .env AND in Vercel → Project → Settings → Env):
 *   GOOGLE_OAUTH_CLIENT_ID      the OAuth client id    (…apps.googleusercontent.com)
 *   GOOGLE_OAUTH_CLIENT_SECRET  the OAuth client secret
 *   GOOGLE_OAUTH_REFRESH_TOKEN  long-lived refresh token (mint via tools/google_oauth_setup.js)
 * Optional:
 *   GOOGLE_CALENDAR_ID          target calendar (defaults to the KUMAGO calendar below)
 *
 * If any required var is missing the writer no-ops (returns {skipped:true}) so a
 * missing config never breaks a paid order — the money is already captured.
 */

const crypto = require("crypto");
const { orderView } = require("./mailer.js");

// The KUMAGO shop calendar. Overridable via env for testing.
const DEFAULT_CALENDAR_ID =
  "d27cedcc3c4ecd42f9f04a9702a91a88d0d1043690fa153040ea466f6f8a5257@group.calendar.google.com";

const TIMEZONE = "Asia/Tokyo"; // deliveries are in Japan; JP has no DST

// Delivery time-slot key → [start, end] wall-clock times (Asia/Tokyo).
// Mirrors order.js TIMES / mailer.js TIME_LABEL.
const SLOT_TIMES = {
  "09-1130": ["09:00:00", "11:30:00"],
  "1230-16": ["12:30:00", "16:00:00"],
  // legacy keys (older sessions)
  "10-12": ["10:00:00", "12:00:00"],
  "12-14": ["12:00:00", "14:00:00"],
  "14-16": ["14:00:00", "16:00:00"],
};

function isConfigured() {
  return !!(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  );
}

function calendarId() {
  return (process.env.GOOGLE_CALENDAR_ID || DEFAULT_CALENDAR_ID).trim();
}

/* Exchange the refresh token for a short-lived access token. */
async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) {
    throw new Error(
      "token_exchange_failed: " + (j.error_description || j.error || r.status)
    );
  }
  return j.access_token;
}

function yen(n) {
  return "¥" + Number(n || 0).toLocaleString("ja-JP");
}

/* A valid Google Calendar event id is base32hex (0-9a-v). A sha1 hex digest of
 * the Stripe session id fits that, giving us a deterministic id so webhook
 * retries upsert the SAME event instead of creating duplicates. */
function eventIdFor(sessionId) {
  if (!sessionId) return null;
  return crypto.createHash("sha1").update(String(sessionId)).digest("hex"); // 40 hex chars
}

/* Build the Calendar event resource from the normalised order view. */
function buildEvent(v) {
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(v.moveInDate);
  if (!validDate) return null; // can't place an event without a real date

  const fullAddr =
    `〒${v.postal} ${v.address}${v.building ? " " + v.building : ""}`.trim();
  const addonLine = v.addonNames.length ? v.addonNames.join("、") : "（無）";
  const itemsText = v.items.map((i) => `・${i.label}　${yen(i.amount)}`).join("\n");

  // null = drop (absent optional field); "" = keep as a blank spacer line.
  const descLines = [
    "🐻 KUMAGO 配送單",
    "",
    `【方案】${v.planName} × ${v.duration}`,
    `【加購】${addonLine}`,
    `【合計（已付款）】${yen(v.total)}`,
    "",
    "── 配送 ──",
    `配送日：${v.moveInDate}　${v.deliveryTime}`,
    v.areaName ? `地區：${v.areaName}` : null,
    `地址：${fullAddr}`,
    `電梯：${v.elevator}`,
    v.mapUrl ? `📍 Google 地圖：${v.mapUrl}` : null,
    "",
    "── 客人 ──",
    `姓名：${v.name}`,
    `聯絡：${v.contact}`,
    v.note ? "" : null,
    v.note ? "── 備註 ──" : null,
    v.note || null,
    itemsText ? "" : null,
    itemsText ? "── 明細 ──" : null,
    itemsText || null,
  ].filter((l) => l !== null);

  const event = {
    summary: `${v.name} 入住配送 ${v.planName}`.trim(),
    // Calendar geocodes the address; the map_url also rides along in the body.
    location: v.mapUrl || fullAddr,
    description: descLines.join("\n"),
    // No calendar popups — the daily Telegram digest is the single reminder channel.
    reminders: { useDefault: false, overrides: [] },
  };

  const slot = SLOT_TIMES[v.deliveryTimeKey];
  if (slot) {
    event.start = { dateTime: `${v.moveInDate}T${slot[0]}`, timeZone: TIMEZONE };
    event.end = { dateTime: `${v.moveInDate}T${slot[1]}`, timeZone: TIMEZONE };
  } else {
    // Unknown/empty slot → all-day event on the move-in date.
    const d = new Date(`${v.moveInDate}T00:00:00Z`);
    const next = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
    event.start = { date: v.moveInDate };
    event.end = { date: next };
  }

  return event;
}

/* List events in [timeMin, timeMax) on the shop calendar, expanded to single
 * instances and sorted by start time. timeMin/timeMax are RFC3339 strings
 * (e.g. "2026-06-28T00:00:00+09:00"). Returns [] if not configured. Throws on
 * a hard API failure so the caller (cron) can surface it. */
async function listEvents(timeMin, timeMax) {
  if (!isConfigured()) return [];
  const token = await getAccessToken();
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    timeZone: TIMEZONE,
    maxResults: "250",
  });
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/` +
    `${encodeURIComponent(calendarId())}/events?${params.toString()}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  if (!r.ok) {
    throw new Error(
      "calendar_list_failed: " + ((j.error && j.error.message) || r.status)
    );
  }
  return j.items || [];
}

/* Today's date "YYYY-MM-DD" in Asia/Tokyo (for bare-date year rollover). */
function jstToday(now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now || new Date());
}

/* Insert an arbitrary event resource onto the shop calendar (used by the manual
 * Telegram webhook). Pass eventId for idempotent upsert (a 409 = already there,
 * treated as success so Telegram retries don't duplicate). Throws on a hard API
 * failure so the caller can reply with the error. Returns { htmlLink, eventId }. */
async function insertEvent(event, eventId) {
  if (!isConfigured()) throw new Error("gcal_not_configured");
  const body = eventId ? { ...event, id: eventId } : event;
  const token = await getAccessToken();
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/` +
    `${encodeURIComponent(calendarId())}/events`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 409) {
    // Same id already exists → a Telegram webhook retry. Treat as success.
    return { htmlLink: "", eventId, duplicate: true };
  }
  const j = await r.json();
  if (!r.ok) {
    throw new Error("calendar_insert_failed: " + ((j.error && j.error.message) || r.status));
  }
  return { htmlLink: j.htmlLink || "", eventId: j.id || eventId || "" };
}

/* Fetch a single event by id. Returns the event resource, or null on 404
 * (not found). Throws on other hard API failures. */
async function getEvent(eventId) {
  if (!isConfigured()) throw new Error("gcal_not_configured");
  if (!eventId) return null;
  const token = await getAccessToken();
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/` +
    `${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404 || r.status === 410) return null; // absent or deleted
  const j = await r.json();
  if (!r.ok) {
    throw new Error("calendar_get_failed: " + ((j.error && j.error.message) || r.status));
  }
  return j;
}

/* Patch (partial update) an existing event by id — merges the given fields onto
 * the stored event. Throws on a hard API failure. Returns { htmlLink, eventId }. */
async function patchEvent(eventId, patch) {
  if (!isConfigured()) throw new Error("gcal_not_configured");
  if (!eventId) throw new Error("patchEvent: eventId required");
  const token = await getAccessToken();
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/` +
    `${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const j = await r.json();
  if (!r.ok) {
    throw new Error("calendar_patch_failed: " + ((j.error && j.error.message) || r.status));
  }
  return { htmlLink: j.htmlLink || "", eventId: j.id || eventId };
}

/* Create (idempotent upsert) the calendar event for a paid order.
 * Never throws — returns a report so the webhook stays resilient. */
async function createOrderEvent(meta, lineItems, amountTotal, sessionId) {
  const report = { created: false, skipped: false, htmlLink: "", errors: [] };
  if (!isConfigured()) {
    report.skipped = true;
    return report;
  }

  const v = orderView(meta, lineItems, amountTotal);
  // orderView maps delivery_time → a display label; keep the raw key for slot lookup.
  v.deliveryTimeKey = (meta && meta.delivery_time) || "";

  const event = buildEvent(v);
  if (!event) {
    report.errors.push("invalid_move_in_date: " + (v.moveInDate || "(empty)"));
    return report;
  }

  const id = eventIdFor(sessionId);
  if (id) event.id = id;

  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    report.errors.push(e.message);
    return report;
  }

  const url =
    `https://www.googleapis.com/calendar/v3/calendars/` +
    `${encodeURIComponent(calendarId())}/events`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    });
    if (r.status === 409) {
      // Event id already exists → a webhook retry. Treat as success.
      report.created = true;
      report.duplicate = true;
      return report;
    }
    const j = await r.json();
    if (!r.ok) {
      report.errors.push(
        "calendar_insert_failed: " +
          ((j.error && j.error.message) || r.status)
      );
      return report;
    }
    report.created = true;
    report.htmlLink = j.htmlLink || "";
    report.eventId = j.id || id || "";
  } catch (e) {
    report.errors.push("calendar_exception: " + e.message);
  }
  return report;
}

module.exports = { isConfigured, buildEvent, createOrderEvent, listEvents, insertEvent, getEvent, patchEvent, jstToday, calendarId, TIMEZONE, DEFAULT_CALENDAR_ID };
