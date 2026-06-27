/* KUMAGO — preview / test the daily Telegram delivery digest.
 *
 *   node tools/test_telegram_push.js                 # dry-run for TOMORROW (JST), prints only
 *   node tools/test_telegram_push.js --date=2026-07-01   # dry-run for a specific JST date
 *   node tools/test_telegram_push.js --scan=60       # list events in the next N days (find a populated day)
 *   node tools/test_telegram_push.js --send          # actually send (tomorrow)
 *   node tools/test_telegram_push.js --date=2026-07-01 --send
 *
 * Loads .env exactly like tools/dev_server.js. Dry-run by default — never sends
 * unless --send is passed.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

/* ---- load .env into process.env (first '=' splits key/value) ---- */
(function loadEnv() {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i === -1) continue;
    const k = s.slice(0, i).trim();
    if (!(k in process.env)) process.env[k] = s.slice(i + 1).trim();
  }
})();

const { listEvents } = require("../lib/gcal.js");
const { jstTomorrowWindow, buildDigest, sendTelegram } = require("../lib/telegram.js");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const a = args.find((x) => x.startsWith(f + "="));
  return a ? a.slice(f.length + 1) : null;
};

/* Build a one-day JST window for an explicit YYYY-MM-DD date. */
function windowForDate(dateStr) {
  const next = new Date(new Date(`${dateStr}T00:00:00+09:00`).getTime() + 86400000);
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const wdFmt = new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Tokyo", weekday: "short" });
  return {
    dateStr,
    weekday: wdFmt.format(new Date(`${dateStr}T00:00:00+09:00`)),
    timeMin: `${dateStr}T00:00:00+09:00`,
    timeMax: `${dateFmt.format(next)}T00:00:00+09:00`,
  };
}

(async () => {
  // --scan: list upcoming events so we can find a day that actually has deliveries.
  const scan = val("--scan");
  if (scan) {
    const days = parseInt(scan, 10) || 30;
    const now = new Date();
    const timeMin = new Date(now.getTime() - 86400000).toISOString();
    const timeMax = new Date(now.getTime() + days * 86400000).toISOString();
    const events = await listEvents(timeMin, timeMax);
    console.log(`Upcoming events in the next ${days} day(s): ${events.length}`);
    for (const e of events) {
      const when = (e.start && (e.start.dateTime || e.start.date)) || "?";
      console.log(`  ${when}  ${e.summary || "(no title)"}`);
    }
    return;
  }

  const dateArg = val("--date");
  const w = dateArg ? windowForDate(dateArg) : jstTomorrowWindow(new Date());

  console.log(`Window: ${w.timeMin} → ${w.timeMax}  (${w.dateStr} ${w.weekday})`);
  const events = await listEvents(w.timeMin, w.timeMax);
  console.log(`Found ${events.length} event(s).\n`);

  const messages = buildDigest(events, w);
  messages.forEach((m, i) => {
    console.log(`────── message ${i + 1}/${messages.length} (${m.length} chars) ──────`);
    console.log(m);
    console.log("");
  });

  if (has("--send")) {
    console.log("Sending to Telegram…");
    for (const m of messages) {
      const id = await sendTelegram(m);
      console.log("  sent, message_id =", id);
    }
  } else {
    console.log("(dry-run — pass --send to actually push to Telegram)");
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
