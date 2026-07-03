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
 *   node tools/attach_note_photos.js <mapping.json> --apply --replace  # overwrite existing gallery
 *
 * Idempotent: an event that already carries extendedProperties.private.galleryIds
 * is skipped — unless --replace, which re-uploads and overwrites the gallery
 * link (used to redo the 2025-06→10 backfill whose PDF sources were 192px
 * thumbnails). Original descriptions are backed up next to the mapping as
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
  const replace = process.argv.includes("--replace");
  if (!mapPath) throw new Error("usage: attach_note_photos.js <mapping.json> [--apply]");
  if (apply && (!TOKEN || !CHANNEL || !BASE)) {
    throw new Error("missing TELEGRAM_BOT_TOKEN / TELEGRAM_STORAGE_CHANNEL_ID / PUBLIC_BASE_URL");
  }
  const rows = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  const backupPath = mapPath.replace(/\.json$/, "") + ".backup.json";
  const backup = fs.existsSync(backupPath) ? JSON.parse(fs.readFileSync(backupPath, "utf8")) : {};

  for (const row of rows) {
    // Each image slot is either a local path (string → upload as hi-res) or
    // { keepId } (pass an existing Telegram file_id straight through, so an
    // unmatched photo keeps its original rather than being clobbered).
    const slots = (row.images || []).map((x) => (typeof x === "string" ? { path: x } : x));
    const nUp = slots.filter((s) => s.path).length;
    const nKeep = slots.filter((s) => s.keepId).length;
    console.log(`\n▶ ${row.label}  [${row.eventId}]  ${slots.length} 張（升級 ${nUp}／保留 ${nKeep}）`);
    for (const s of slots) {
      if (s.path) {
        if (!fs.existsSync(s.path)) throw new Error(`missing image: ${s.path}`);
        console.log(`    ↑ ${path.basename(s.path)}`);
      } else if (s.keepId) {
        console.log(`    · 保留原圖 ${s.keepId.slice(0, 16)}…`);
      } else {
        throw new Error(`bad image slot in ${row.eventId}: ${JSON.stringify(s)}`);
      }
    }
    if (!apply) { console.log("    (dry-run — 不上傳、不修改)"); continue; }

    const ev = await getEvent(row.eventId);
    const hasGallery = ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.galleryIds;
    if (hasGallery && !replace) {
      console.log("    ↷ 已有相簿，跳過（idempotent；要覆蓋請加 --replace）");
      continue;
    }
    if (hasGallery) console.log("    ⟳ 已有相簿 → --replace 覆蓋");
    if (!(row.eventId in backup)) {
      backup[row.eventId] = { summary: ev.summary || "", description: ev.description || "" };
      fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    }

    const ids = [];
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s.keepId) { ids.push(s.keepId); continue; }
      const fid = await sendPhoto(fs.readFileSync(s.path), `${row.label} #${i + 1}`);
      if (!fid) throw new Error(`no file_id for ${s.path}`);
      ids.push(fid);
      console.log(`    ↑ ${path.basename(s.path)} → ${fid.slice(0, 20)}…`);
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
