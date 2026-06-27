#!/usr/bin/env node
/* KUMAGO — list calendar events from a date onward and (optionally) backfill a
 * Google Maps link onto any event that is missing one.
 *
 * Many older order events were written before the customer map pin was recorded,
 * so their `location` is plain address text and the description has no
 * "📍 Google 地圖：" line. This tool finds those and, with --apply, adds a Maps
 * search link built from the address it can read off the event.
 *
 *   node tools/calendar_backfill_maps.js            # dry-run: list + show what would change
 *   node tools/calendar_backfill_maps.js --apply    # actually patch the events
 *
 * Auth reuses the same OAuth refresh-token env vars as lib/gcal.js.
 * Reads .env (and .env.local) from the project root — no dotenv dependency.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Minimal .env loader (no dotenv dep). .env wins over .env.local already-set keys.
function loadEnv(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(".env");
loadEnv(".env.local");

const DEFAULT_CALENDAR_ID =
  "d27cedcc3c4ecd42f9f04a9702a91a88d0d1043690fa153040ea466f6f8a5257@group.calendar.google.com";

const APPLY = process.argv.includes("--apply");
// timeMin: June 1 of the current year, Asia/Tokyo. Overridable via --from=YYYY-MM-DD.
const fromArg = (process.argv.find((a) => a.startsWith("--from=")) || "").split("=")[1];
const TIME_MIN = (fromArg || "2026-06-01") + "T00:00:00+09:00";

function calendarId() {
  return (process.env.GOOGLE_CALENDAR_ID || DEFAULT_CALENDAR_ID).trim();
}

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
    throw new Error("token_exchange_failed: " + (j.error_description || j.error || r.status));
  }
  return j.access_token;
}

async function listEvents(token) {
  const out = [];
  let pageToken = "";
  do {
    const qs = new URLSearchParams({
      timeMin: TIME_MIN,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      showDeleted: "false",
    });
    if (pageToken) qs.set("pageToken", pageToken);
    const url =
      `https://www.googleapis.com/calendar/v3/calendars/` +
      `${encodeURIComponent(calendarId())}/events?${qs.toString()}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (!r.ok) throw new Error("list_failed: " + ((j.error && j.error.message) || r.status));
    out.push(...(j.items || []));
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

const MAPS_RE = /(https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.[^\s]+|(?:www\.)?google\.[^\s]*\/maps[^\s]*))/i;

// Does this event already reference a Google Maps link anywhere?
function existingMapUrl(ev) {
  for (const field of [ev.location, ev.description]) {
    if (field) {
      const m = String(field).match(MAPS_RE);
      if (m) return m[1];
    }
  }
  return null;
}

// Pull the postal/address text out of the event so we can build a search link.
// Order events put "地址：〒123-4567 ..." in the description; location holds the
// same address text when no pin was recorded.
function addressOf(ev) {
  if (ev.description) {
    const m = ev.description.match(/地址[：:]\s*(.+)/);
    if (m) return m[1].trim();
  }
  if (ev.location) return String(ev.location).trim();
  return null;
}

function mapsSearchUrl(addr) {
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(addr);
}

async function patchEvent(token, id, body) {
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/` +
    `${encodeURIComponent(calendarId())}/events/${encodeURIComponent(id)}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("patch_failed: " + ((j.error && j.error.message) || r.status));
  return j;
}

(async () => {
  if (!process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    console.error("✗ Missing GOOGLE_OAUTH_* env vars (.env). Run tools/google_oauth_setup.js first.");
    process.exit(1);
  }
  const token = await getAccessToken();
  const events = await listEvents(token);
  console.log(`Calendar: ${calendarId()}`);
  console.log(`Events from ${TIME_MIN}: ${events.length}\n`);

  const missing = [];
  for (const ev of events) {
    const when = (ev.start && (ev.start.dateTime || ev.start.date)) || "(no date)";
    const map = existingMapUrl(ev);
    const flag = map ? "✅ map" : "❌ NO MAP";
    console.log(`${flag}  ${when}  ${ev.summary || "(untitled)"}`);
    if (!map) missing.push(ev);
  }

  console.log(`\n${missing.length} event(s) missing a Google Maps link.`);
  if (!missing.length) return;

  const skipped = [];
  let updated = 0;
  for (const ev of missing) {
    const addr = addressOf(ev);
    // Skip if there's no usable address: empty, or a "待補/待確認/未提供" placeholder.
    const placeholder = !addr || /待補|待確認|待提供|未提供|未定|^[（(]?\s*[)）]?$/.test(addr);
    if (placeholder) {
      console.log(`  ⚠️  ${ev.summary}: no usable address ("${addr || ""}") — skipped.`);
      skipped.push(ev.summary);
      continue;
    }
    const newUrl = mapsSearchUrl(addr);
    if (!APPLY) {
      console.log(`  [dry-run] would add map for "${ev.summary}" → ${addr}`);
      continue;
    }
    // Non-destructive: keep `location` (the readable address Calendar geocodes)
    // and only append the map link line to the description.
    const desc = ev.description || "";
    const newDesc = desc.trimEnd() + (desc ? "\n" : "") + `📍 Google 地圖：${newUrl}`;
    try {
      await patchEvent(token, ev.id, { description: newDesc });
      console.log(`  ✏️  updated "${ev.summary}"`);
      updated++;
    } catch (e) {
      console.log(`  ✗ failed "${ev.summary}": ${e.message}`);
    }
  }

  if (APPLY) {
    console.log(`\nDone: ${updated} updated, ${skipped.length} skipped (no address).`);
  } else {
    console.log(`\nDry-run only. Re-run with --apply to write changes.`);
    if (skipped.length) console.log(`Would skip ${skipped.length} (no usable address).`);
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
