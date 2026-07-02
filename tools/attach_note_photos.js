#!/usr/bin/env node
/* KUMAGO — attach monthly-note product photos to existing calendar events.
 *
 * The owner's monthly notes (exported as PDFs) carry per-customer reference
 * photos of the appliances/furniture in each order. This tool re-hosts those
 * photos to the Telegram storage channel (durable file_ids) and writes a single
 * "🖼 照片：點此查看" gallery link into the matching calendar event — the same
 * shape api/telegram-webhook.js produces for a live photo album.
 *
 * Input: a mapping JSON, an array of:
 *   { "eventId": "<gcal id>", "label": "庭綺 配送", "images": ["/abs/p05_01.png", ...] }
 *
 * Usage:
 *   node tools/attach_note_photos.js <mapping.json>            # dry-run (no upload/patch)
 *   node tools/attach_note_photos.js <mapping.json> --apply    # upload + patch
 *
 * Idempotent: an event that already carries extendedProperties.private.galleryIds
 * is skipped. Original descriptions are backed up next to the mapping as
 * <mapping>.backup.json before any patch, so every change is reversible.
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

const { getEvent, patchEvent } = require(path.join(ROOT, "lib/gcal.js"));
const { photoDescLine, PHOTO_LINE_RE } = require(path.join(ROOT, "lib/tg_event.js"));

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL = process.env.TELEGRAM_STORAGE_CHANNEL_ID;
const BASE = process.env.PUBLIC_BASE_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendPhoto(buf, caption) {
  const fd = new FormData();
  fd.append("chat_id", CHANNEL);
  if (caption) fd.append("caption", caption);
  fd.append("photo", new Blob([buf], { type: "image/png" }), "photo.png");
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: "POST", body: fd });
    const j = await r.json();
    if (j.ok) {
      const sizes = j.result.photo || [];
      return sizes.length ? sizes[sizes.length - 1].file_id : null;
    }
    if (j.error_code === 429) { await sleep(((j.parameters && j.parameters.retry_after) || 3) * 1000); continue; }
    throw new Error("sendPhoto failed: " + (j.description || r.status));
  }
  throw new Error("sendPhoto: too many retries");
}

function galleryUrl(ids) {
  return ids.length === 1
    ? `${BASE}/api/tg-photo?id=${encodeURIComponent(ids[0])}`
    : `${BASE}/api/tg-gallery?ids=${ids.map(encodeURIComponent).join(",")}`;
}

(async () => {
  const mapPath = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!mapPath) throw new Error("usage: attach_note_photos.js <mapping.json> [--apply]");
  if (apply && (!TOKEN || !CHANNEL || !BASE)) {
    throw new Error("missing TELEGRAM_BOT_TOKEN / TELEGRAM_STORAGE_CHANNEL_ID / PUBLIC_BASE_URL");
  }
  const rows = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  const backupPath = mapPath.replace(/\.json$/, "") + ".backup.json";
  const backup = fs.existsSync(backupPath) ? JSON.parse(fs.readFileSync(backupPath, "utf8")) : {};

  for (const row of rows) {
    const n = (row.images || []).length;
    console.log(`\n▶ ${row.label}  [${row.eventId}]  ${n} 張`);
    for (const im of row.images) {
      if (!fs.existsSync(im)) throw new Error(`missing image: ${im}`);
      console.log(`    · ${path.basename(im)}`);
    }
    if (!apply) { console.log("    (dry-run — 不上傳、不修改)"); continue; }

    const ev = await getEvent(row.eventId);
    if (ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.galleryIds) {
      console.log("    ↷ 已有相簿，跳過（idempotent）");
      continue;
    }
    if (!(row.eventId in backup)) {
      backup[row.eventId] = { summary: ev.summary || "", description: ev.description || "" };
      fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    }

    const ids = [];
    for (let i = 0; i < row.images.length; i++) {
      const fid = await sendPhoto(fs.readFileSync(row.images[i]), `${row.label} #${i + 1}`);
      if (!fid) throw new Error(`no file_id for ${row.images[i]}`);
      ids.push(fid);
      console.log(`    ↑ ${path.basename(row.images[i])} → ${fid.slice(0, 20)}…`);
      await sleep(1200); // stay under Telegram rate limits
    }
    const url = galleryUrl(ids);
    const line = photoDescLine(url);
    const oldDesc = ev.description || "";
    const desc = PHOTO_LINE_RE.test(oldDesc) ? oldDesc.replace(PHOTO_LINE_RE, line) : `${oldDesc}\n${line}`;
    await patchEvent(row.eventId, {
      description: desc,
      extendedProperties: { private: { galleryIds: ids.join(",") } },
    });
    console.log(`    ✅ 已掛上：${url}`);
  }
  console.log(apply ? "\n完成。" : "\n(dry-run 完成，加 --apply 才會真的上傳/修改)");
})().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
