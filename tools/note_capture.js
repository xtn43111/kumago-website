#!/usr/bin/env node
/* KUMAGO — capture the currently-open iCloud note's photos at FULL resolution.
 *
 * v2 (2026-07): iCloud Notes now renders note photos into <canvas> (display
 * resolution only) — the old blob:<img> scrape gets nothing. Instead we tap the
 * network via CDP: attachment originals stream from cvws.icloud-content.com,
 * so we arm Network capture, RELOAD the note, then wheel-scroll top→bottom so
 * every attachment downloads. Each response body that decodes as a real image
 * (min side > 400px, deduped by md5) is saved to OUT as <prefix>_###.jpg/png,
 * plus per-viewport screenshots (<prefix>_NN.png) for visual reference.
 *
 * No Telegram upload here — matching/uploading happens downstream (the redo
 * pipeline matches new captures to old blurry photos by perceptual hash, then
 * tools/attach_note_photos.js --apply --replace patches the events).
 *
 *   node tools/note_capture.js <prefix> [maxSteps]
 * Output dir: .tmp/note_capture/ (override with NOTE_CAPTURE_OUT).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const puppeteer = require(path.join(ROOT, "node_modules/puppeteer-core"));

const OUT = process.env.NOTE_CAPTURE_OUT || path.join(ROOT, ".tmp", "note_capture");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function imgMeta(buf) {
  // JPEG / PNG / HEIC sniff, dims via sips (macOS)
  const tmp = path.join(OUT, ".probe.bin");
  fs.writeFileSync(tmp, buf);
  try {
    const o = execFileSync("sips", ["-g", "format", "-g", "pixelWidth", "-g", "pixelHeight", tmp], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const fmt = (o.match(/format: (\w+)/) || [])[1];
    const w = Number((o.match(/pixelWidth: (\d+)/) || [])[1]);
    const h = Number((o.match(/pixelHeight: (\d+)/) || [])[1]);
    if (!fmt || !w || !h) return null;
    return { fmt, w, h };
  } catch (_) { return null; }
}

(async () => {
  const prefix = process.argv[2] || "cap";
  const maxSteps = Number(process.argv[3] || 80);

  const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find((p) => /icloud\.com\/notes/.test(p.url())) || pages[0];
  await page.bringToFront();

  // ── arm network capture BEFORE reload ──────────────────────────────────
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable", { maxResourceBufferSize: 300 * 1024 * 1024, maxTotalBufferSize: 800 * 1024 * 1024 });
  // Disable cache so EVERY attachment re-downloads with a retrievable body.
  // (Cached images load from disk on reload → Network.getResponseBody returns
  // nothing → those photos silently go missing from the capture set.)
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const interesting = new Map(); // requestId -> url
  const bodies = [];             // { seq, buf }
  let seq = 0;
  const seenHash = new Set();
  cdp.on("Network.responseReceived", (e) => {
    const { url, mimeType } = e.response;
    if (/cvws\.icloud-content\.com|icloud-content\.com/.test(url) && /octet-stream|image/.test(mimeType || "")) {
      interesting.set(e.requestId, url);
    }
  });
  const pulls = [];
  cdp.on("Network.loadingFinished", (e) => {
    if (!interesting.has(e.requestId)) return;
    const p = cdp.send("Network.getResponseBody", { requestId: e.requestId })
      .then((b) => {
        const buf = Buffer.from(b.body, b.base64Encoded ? "base64" : "utf8");
        const md5 = crypto.createHash("md5").update(buf).digest("hex");
        if (seenHash.has(md5)) return;
        seenHash.add(md5);
        bodies.push({ seq: seq++, buf });
      })
      .catch(() => {});
    pulls.push(p);
  });

  // ── nuke the Service Worker + Cache Storage so NOTHING is served locally ──
  // iCloud Notes is a PWA: attachments cached by its service worker never hit
  // the network, so Network.setCacheDisabled alone still misses them. Clear both,
  // then reload, and every attachment must re-download (retrievable body).
  try {
    await cdp.send("ServiceWorker.enable");
    await cdp.send("Storage.clearDataForOrigin", {
      origin: new URL(page.url()).origin,
      storageTypes: "service_workers,cache_storage",
    });
  } catch (e) { console.warn("SW/cache clear warn:", e.message); }
  await page.evaluate(async () => {
    try {
      if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
      if (navigator.serviceWorker) {
        for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      }
    } catch (_) {}
  }).catch(() => {});

  // ── reload so every attachment re-downloads ────────────────────────────
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(15000); // let the note re-render

  // ── scroll top→bottom, screenshotting; lazy attachments stream in ──────
  const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const px = Math.round(vp.w * 0.72), py = Math.round(vp.h * 0.5);
  await page.mouse.move(px, py); await sleep(200);
  for (let k = 0; k < 18; k++) { await page.mouse.wheel({ deltaY: -1400 }); await sleep(40); }
  await sleep(1000);

  let last = "", same = 0, step = 0;
  for (; step < maxSteps; step++) {
    const shot = await page.screenshot();
    fs.writeFileSync(path.join(OUT, `${prefix}_${String(step).padStart(2, "0")}.png`), shot);
    const h = crypto.createHash("md5").update(shot).digest("hex");
    if (h === last) { same++; if (same >= 2) break; } else same = 0;
    last = h;
    await page.mouse.move(px, py);
    await page.mouse.wheel({ deltaY: Math.round(vp.h * 0.82) });
    await sleep(900);
  }
  await sleep(4000);          // trailing downloads
  await Promise.all(pulls);   // finish body pulls

  // ── keep real photos only (decodes, min side > 400), save in seq order ─
  bodies.sort((a, b) => a.seq - b.seq);
  const manifest = [];
  let n = 0;
  for (const { buf } of bodies) {
    const m = imgMeta(buf);
    if (!m || Math.min(m.w, m.h) <= 400) continue;
    n++;
    const ext = m.fmt === "png" ? "png" : m.fmt === "heic" || m.fmt === "heif" ? "heic" : "jpg";
    const file = path.join(OUT, `${prefix}_${String(n).padStart(3, "0")}.${ext}`);
    fs.writeFileSync(file, buf);
    manifest.push({ i: n, file, w: m.w, h: m.h, fmt: m.fmt, bytes: buf.length });
    console.log(`  [${n}] ${m.w}x${m.h} ${m.fmt} ${(buf.length / 1024).toFixed(0)}K → ${path.basename(file)}`);
  }
  fs.writeFileSync(path.join(OUT, `${prefix}_manifest.json`), JSON.stringify(manifest, null, 2));
  console.log(`\nscrolled ${step + 1} steps · ${bodies.length} network assets · ${n} photos kept`);
  console.log(`Saved ${prefix}_manifest.json + screenshots in ${OUT}`);
  browser.disconnect();
  process.exit(0);
})().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
