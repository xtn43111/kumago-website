#!/usr/bin/env node
/* KUMAGO — capture the currently-open iCloud note and re-host its photos.
 *
 * The owner's monthly notes live in iCloud (already open in a logged-in Chrome
 * driven over the DevTools port 9222). Note TEXT sits in a shadow DOM we can't
 * read, and images are ephemeral blob: URLs — so we:
 *   1. wheel-scroll the note top→bottom, screenshotting each viewport
 *      (<prefix>_NN.png) so the operator can read the schedule visually, and
 *   2. collect every content photo (blob:, min side > 200px) in document order,
 *      download its bytes in-page, and sendPhoto them to the storage channel,
 *      collecting a durable file_id for each (usable via /api/tg-photo).
 *
 * Output: <prefix>_manifest.json = [{ i, file_id, w, h }] in visual order, plus
 * the screenshots. The operator maps photo ranges to events from the shots, then
 * builds /api/tg-gallery?ids=... links per event.
 *
 *   node tools/note_capture.js <prefix> [maxSteps]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
const puppeteer = require(path.join(ROOT, "node_modules/puppeteer-core"));

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

const OUT = "/private/tmp/claude-501/-Users-peter-kumago-website/378c36b7-e91d-4358-8a49-29fe790fd835/scratchpad";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL = process.env.TELEGRAM_STORAGE_CHANNEL_ID;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendPhoto(buf, caption) {
  const fd = new FormData();
  fd.append("chat_id", CHANNEL);
  if (caption) fd.append("caption", caption);
  fd.append("photo", new Blob([buf], { type: "image/jpeg" }), "photo.jpg");
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

(async () => {
  const prefix = process.argv[2] || "cap";
  const maxSteps = Number(process.argv[3] || 60);
  if (!TOKEN || !CHANNEL) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_STORAGE_CHANNEL_ID missing");

  const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find((p) => /icloud\.com\/notes/.test(p.url())) || pages[0];
  await page.bringToFront();
  const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const px = Math.round(vp.w * 0.72), py = Math.round(vp.h * 0.5);

  // The note body renders in the notes3 frame; images sit in a shadow DOM, so we
  // pierce shadow roots. Blobs are virtualized (revoked when scrolled away), so
  // we fetch each photo's bytes IN ITS FRAME while it's on-screen.
  function frameOf() {
    return page.frames().find((f) => /notes3/.test(f.url())) || page.mainFrame();
  }

  // Currently-loaded content photos (blob:, min side > 200), shadow-piercing.
  async function loadedPhotoSrcs(frame) {
    return await frame.evaluate(() => {
      const acc = [];
      (function deep(root) {
        for (const el of root.querySelectorAll("*")) {
          if (el.tagName === "IMG") acc.push(el);
          if (el.shadowRoot) deep(el.shadowRoot);
        }
      })(document);
      return acc
        .filter((im) => /^blob:/.test(im.currentSrc || im.src) && Math.min(im.naturalWidth, im.naturalHeight) > 200)
        .map((im) => ({ src: im.currentSrc || im.src, w: im.naturalWidth, h: im.naturalHeight }));
    });
  }
  // Fetch one blob's bytes as base64, inside the frame that owns it.
  async function fetchBytes(frame, src) {
    return await frame.evaluate(async (s) => {
      const b = await (await fetch(s)).blob();
      const buf = new Uint8Array(await b.arrayBuffer());
      let bin = ""; for (let k = 0; k < buf.length; k++) bin += String.fromCharCode(buf[k]);
      return btoa(bin);
    }, src);
  }

  // 1) scroll to top
  await page.mouse.move(px, py); await sleep(200);
  for (let k = 0; k < 18; k++) { await page.mouse.wheel({ deltaY: -1400 }); await sleep(40); }
  await sleep(700);

  // 2) scroll down; screenshot + grab each new photo's bytes while visible
  const order = []; const seenSrc = new Set(); const seenHash = new Set();
  let last = "", same = 0, step = 0;
  for (; step < maxSteps; step++) {
    const shot = await page.screenshot();
    fs.writeFileSync(`${OUT}/${prefix}_${String(step).padStart(2, "0")}.png`, shot);
    const frame = frameOf();
    for (const im of await loadedPhotoSrcs(frame)) {
      if (seenSrc.has(im.src)) continue;
      seenSrc.add(im.src);
      let b64;
      try { b64 = await fetchBytes(frame, im.src); } catch (_) { continue; }
      const hash = crypto.createHash("md5").update(b64).digest("hex");
      if (seenHash.has(hash)) continue; // same photo re-blobbed after virtualization
      seenHash.add(hash);
      order.push({ b64, w: im.w, h: im.h });
    }
    const h = crypto.createHash("md5").update(shot).digest("hex");
    if (h === last) { same++; if (same >= 2) break; } else same = 0;
    last = h;
    await page.mouse.move(px, py);
    await page.mouse.wheel({ deltaY: Math.round(vp.h * 0.82) });
    await sleep(1000); // let lazy images decode before the next grab
  }
  console.log(`scrolled ${step + 1} steps · ${order.length} content photos captured`);

  // 3) rehost each captured photo to the storage channel, in visual order
  const manifest = [];
  for (let i = 0; i < order.length; i++) {
    const bytes = Buffer.from(order[i].b64, "base64");
    try {
      const fid = await sendPhoto(bytes, `${prefix} #${i + 1}`);
      manifest.push({ i: i + 1, file_id: fid, w: order[i].w, h: order[i].h });
      console.log(`  [${i + 1}/${order.length}] ${order[i].w}x${order[i].h} → ${fid ? fid.slice(0, 24) + "…" : "no id"}`);
    } catch (e) { console.log(`  [${i + 1}] sendPhoto failed: ${e.message}`); }
    await sleep(1200); // stay under Telegram rate limits
  }

  fs.writeFileSync(`${OUT}/${prefix}_manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`\nSaved ${prefix}_manifest.json (${manifest.length} photos) + ${step + 1} screenshots ${prefix}_NN.png`);
  browser.disconnect();
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
