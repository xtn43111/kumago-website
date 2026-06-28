/* KUMAGO — Telegram photo proxy.
 *
 * Calendar events created from Telegram messages store a photo as a stable,
 * token-free URL on THIS site:  /api/tg-photo?id=<telegram_file_id>
 * When opened, we resolve the file_id to a temporary Telegram download path
 * (server-side, using TELEGRAM_BOT_TOKEN) and stream the image back. The bot
 * token never leaves the server, so it's safe to keep these URLs in events.
 *
 * The file_id is an opaque, unguessable capability — anyone with the link can
 * view the image (calendar links must open without auth), but cannot enumerate
 * others. We validate its shape to keep the param from being abused.
 */

"use strict";

// Telegram file_ids are URL-safe base64-ish: letters, digits, - and _.
const FILE_ID_RE = /^[A-Za-z0-9_-]{16,256}$/;

module.exports = async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: "telegram_not_configured" });

  const id = (req.query && req.query.id) || "";
  if (!FILE_ID_RE.test(id)) return res.status(400).json({ error: "bad_file_id" });

  try {
    // 1. Resolve file_id → file_path.
    // Retry getFile: a freshly-uploaded photo can briefly 404 / be "temporarily
    // unavailable" while Telegram finishes processing it. A couple of short
    // retries makes the very first click after sending reliable.
    let filePath = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const metaRes = await fetch(
        `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(id)}`
      );
      const meta = await metaRes.json();
      if (meta.ok && meta.result && meta.result.file_path) {
        filePath = meta.result.file_path;
        break;
      }
      lastErr = (meta && meta.description) || `status ${metaRes.status}`;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!filePath) {
      console.error("tg-photo getFile failed:", lastErr, "len", id.length);
      return res.status(404).json({ error: "file_not_found", detail: lastErr });
    }

    // 2. Download the bytes from Telegram's file CDN.
    const fileRes = await fetch(
      `https://api.telegram.org/file/bot${token}/${filePath}`
    );
    if (!fileRes.ok) return res.status(502).json({ error: "telegram_fetch_failed" });

    const buf = Buffer.from(await fileRes.arrayBuffer());

    // Telegram's CDN often serves images as application/octet-stream, which makes
    // browsers DOWNLOAD instead of DISPLAY. Derive a real image type from the file
    // extension and only trust the response's type when it's already image/*.
    const ext = (filePath.split(".").pop() || "").toLowerCase();
    const EXT_TYPE = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif",
    };
    const respType = fileRes.headers.get("content-type") || "";
    const type = EXT_TYPE[ext] || (/^image\//.test(respType) ? respType : "image/jpeg");

    res.setHeader("Content-Type", type);
    res.setHeader("Content-Disposition", "inline"); // show in-browser, don't download
    // Cache hard: the bytes behind a file_id never change.
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, immutable");
    return res.status(200).end(buf);
  } catch (e) {
    console.error("tg-photo:", e);
    return res.status(502).json({ error: "proxy_failed" });
  }
};
