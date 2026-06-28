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
    const metaRes = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(id)}`
    );
    const meta = await metaRes.json();
    if (!meta.ok || !meta.result || !meta.result.file_path) {
      return res.status(404).json({ error: "file_not_found" });
    }
    const filePath = meta.result.file_path;

    // 2. Download the bytes from Telegram's file CDN.
    const fileRes = await fetch(
      `https://api.telegram.org/file/bot${token}/${filePath}`
    );
    if (!fileRes.ok) return res.status(502).json({ error: "telegram_fetch_failed" });

    const buf = Buffer.from(await fileRes.arrayBuffer());
    const ext = (filePath.split(".").pop() || "").toLowerCase();
    const type =
      fileRes.headers.get("content-type") ||
      (ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg");

    res.setHeader("Content-Type", type);
    // Cache hard: the bytes behind a file_id never change.
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, immutable");
    return res.status(200).end(buf);
  } catch (e) {
    console.error("tg-photo:", e);
    return res.status(502).json({ error: "proxy_failed" });
  }
};
