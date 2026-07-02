#!/usr/bin/env node
/* KUMAGO — manage & test the manual Telegram → Calendar event flow.
 *
 *   node tools/manual_event.js --parse "標題：庭綺 回收\n日期：7/5\n時間：14:00-16:00"
 *        Dry-run: parse a message and print the Calendar event JSON. No network.
 *
 *   node tools/manual_event.js --create "標題：測試\n日期：7/5"
 *        Actually insert the event onto the shop calendar (live Google write).
 *
 *   node tools/manual_event.js --set-webhook
 *        Register the webhook with Telegram so incoming messages reach
 *        /api/telegram-webhook. Uses PUBLIC_BASE_URL + TELEGRAM_WEBHOOK_SECRET.
 *
 *   node tools/manual_event.js --webhook-info      # show Telegram's current webhook
 *   node tools/manual_event.js --delete-webhook    # unregister (back to no webhook)
 *
 *   node tools/manual_event.js --set-commands
 *        Populate the bot's "/" menu (agenda/today/help). The Chinese /行程 and
 *        /查 still work as typed text — Telegram menus only allow ASCII names.
 *
 * Loads .env exactly like the other tools. Reads \n in CLI args as newlines.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

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

const { insertEvent, jstToday } = require("../lib/gcal.js");
const { buildManualEvent, TEMPLATE } = require("../lib/tg_event.js");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
const unesc = (s) => (s || "").replace(/\\n/g, "\n");

function eventIdFor(seed) {
  return require("crypto").createHash("sha1").update("tg-tool-" + seed).digest("hex");
}

async function setWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
  if (!base) throw new Error("PUBLIC_BASE_URL missing (e.g. https://kumago.7-mori.com)");
  const url = `${base}/api/telegram-webhook`;
  const params = {
    url,
    allowed_updates: JSON.stringify(["message", "edited_message"]),
    drop_pending_updates: "true",
    // Serialize delivery: photo-album updates then arrive in order, so the
    // gallery read-append in the webhook is race-free (single-owner, low volume).
    max_connections: "1",
  };
  if (secret) params.secret_token = secret;
  const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const j = await r.json();
  console.log("setWebhook →", JSON.stringify(j, null, 2));
  console.log(`\nWebhook URL: ${url}\nSecret header: ${secret ? "ENABLED" : "(none — set TELEGRAM_WEBHOOK_SECRET)"}`);
}

async function setCommands() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
  // ASCII-only names (Telegram restriction). The Chinese /行程 /查 are handled in
  // the webhook as plain text and need no menu entry.
  const commands = [
    { command: "today", description: "今天的行程整理" },
    { command: "agenda", description: "查某天行程（例：/agenda 7/5）" },
    { command: "help", description: "使用說明 / 新增行程格式" },
  ];
  const r = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands }),
  });
  console.log("setMyCommands →", JSON.stringify(await r.json(), null, 2));
}

async function webhookInfo() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const r = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  console.log(JSON.stringify(await r.json(), null, 2));
}

async function deleteWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const r = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
  console.log(JSON.stringify(await r.json(), null, 2));
}

/* Fetch a candidate chat/channel id from whatever updates Telegram has QUEUED.
 * Requires the webhook to be OFF first (run --delete-webhook), so the owner can
 * post/forward at leisure and the updates wait in the queue. Prints all chats
 * seen and does NOT touch the webhook (run --set-webhook afterwards). */
async function peekUpdates() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const allowed = JSON.stringify(["message", "channel_post", "edited_channel_post", "my_chat_member"]);
  const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-100&allowed_updates=${encodeURIComponent(allowed)}`);
  const j = await r.json();
  if (!j.ok) { console.log("getUpdates error:", JSON.stringify(j)); return; }
  console.log(`${(j.result || []).length} update(s) queued.`);
  const seen = new Map();
  for (const u of j.result || []) {
    const m = u.message || u.edited_message;
    const cand = [
      u.channel_post && u.channel_post.chat,
      u.edited_channel_post && u.edited_channel_post.chat,
      m && m.chat, m && m.forward_from_chat, m && m.forward_origin && m.forward_origin.chat,
      u.my_chat_member && u.my_chat_member.chat,
    ].filter(Boolean);
    console.log(`  · update ${u.update_id}: ${Object.keys(u).filter((k) => k !== "update_id").join(",")}`);
    for (const c of cand) if (!seen.has(c.id)) { seen.set(c.id, c); console.log(`    FOUND id=${c.id} type=${c.type} ${c.title || c.username || ""}`); }
  }
  const channels = [...seen.values()].filter((c) => c.type === "channel");
  console.log("\nChannels:", channels.length ? channels.map((c) => `${c.id} (${c.title})`).join(", ") : "none");
  console.log("All chats:", [...seen.values()].map((c) => `${c.id}:${c.type}`).join(", ") || "none");
}

/* Discover a chat/channel id. getUpdates can't run while a webhook is set, so we
 * temporarily remove it, poll for ~90s (post/forward a message in the channel
 * during this window), print every chat we see, then restore the webhook. */
async function findChat() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
  await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
  console.log("Webhook removed. In the next ~90s: post any message in the channel");
  console.log("(bot must be an admin), OR forward a channel message to the bot. Listening…\n");
  const seen = new Map();
  const deadline = Date.now() + 150000;
  let offset = 0;
  const allowed = JSON.stringify(["message", "channel_post", "edited_channel_post", "my_chat_member"]);
  while (Date.now() < deadline) {
    const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=10&offset=${offset}&allowed_updates=${encodeURIComponent(allowed)}`;
    let j;
    try { j = await (await fetch(url)).json(); } catch (e) { continue; }
    for (const u of j.result || []) {
      offset = u.update_id + 1;
      const m = u.message || u.edited_message;
      const cand = [
        u.channel_post && u.channel_post.chat,
        u.edited_channel_post && u.edited_channel_post.chat,
        m && m.chat,
        m && m.forward_from_chat,                       // older API
        m && m.forward_origin && m.forward_origin.chat, // newer API
        u.my_chat_member && u.my_chat_member.chat,
        u.my_chat_member && u.my_chat_member.from,
      ].filter(Boolean);
      console.log(`  · update ${u.update_id}: ${Object.keys(u).filter((k) => k !== "update_id").join(",")}`);
      for (const c of cand) {
        if (!seen.has(c.id)) {
          seen.set(c.id, c);
          console.log(`FOUND  id=${c.id}  type=${c.type}  ${c.title || c.username || ""}`);
        }
      }
    }
  }
  console.log("\nRestoring webhook…");
  await setWebhook();
  const channels = [...seen.values()].filter((c) => c.type === "channel");
  console.log("\nChannels seen:", channels.length
    ? channels.map((c) => `${c.id} (${c.title})`).join(", ")
    : "none — make sure the bot is an admin and you posted AFTER this started.");
}

(async () => {
  if (has("--find-chat")) return findChat();
  if (has("--peek")) return peekUpdates();
  if (has("--set-webhook")) return setWebhook();
  if (has("--set-commands")) return setCommands();
  if (has("--webhook-info")) return webhookInfo();
  if (has("--delete-webhook")) return deleteWebhook();

  const text = unesc(val("--parse") || val("--create"));
  if (!text) {
    console.log("Usage: --parse <msg> | --create <msg> | --set-webhook | --set-commands | --webhook-info | --delete-webhook");
    console.log("\nMessage template:\n" + TEMPLATE);
    return;
  }

  const photoUrl = val("--photo") || "";
  const parsed = buildManualEvent(text, { photoUrl, todayJst: jstToday() });
  if (!parsed.ok) {
    console.log("✗ Not parseable.");
    if (parsed.missing && parsed.missing.length) console.log("  missing:", parsed.missing.join("、"));
    if (parsed.errors && parsed.errors.length) console.log("  errors :", parsed.errors.join("; "));
    return;
  }

  console.log("✓ Parsed view:", JSON.stringify(parsed.view, null, 2));
  console.log("\nCalendar event:\n" + JSON.stringify(parsed.event, null, 2));

  if (has("--create")) {
    console.log("\nInserting onto the shop calendar…");
    const r = await insertEvent(parsed.event, eventIdFor(text));
    console.log("→", JSON.stringify(r, null, 2));
  } else {
    console.log("\n(dry-run — pass --create to actually write to the calendar)");
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
