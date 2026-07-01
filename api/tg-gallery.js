/* KUMAGO — Telegram photo gallery.
 *
 * A calendar event created from a Telegram photo ALBUM stores all its photos as
 * one stable link:  /api/tg-gallery?ids=<file_id>,<file_id>,...
 * This page renders each image inline via the existing /api/tg-photo proxy, so a
 * single event link shows every photo. The bot token never leaves the server
 * (tg-photo does the resolving); the file_ids are opaque, unguessable capabilities.
 */

"use strict";

// Same shape Telegram uses for file_ids (see tg-photo.js).
const FILE_ID_RE = /^[A-Za-z0-9_-]{16,256}$/;

module.exports = async function handler(req, res) {
  const raw = (req.query && req.query.ids) || "";
  const ids = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => FILE_ID_RE.test(s));

  if (!ids.length) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(400).end("<!doctype html><meta charset=utf-8><body style='font-family:sans-serif;padding:2rem'>沒有可顯示的照片。</body>");
  }

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const imgs = ids
    .map((id, i) => `<figure><img loading="lazy" src="/api/tg-photo?id=${esc(id)}" alt="照片 ${i + 1}"><figcaption>${i + 1} / ${ids.length}</figcaption></figure>`)
    .join("\n");

  const html = `<!doctype html>
<html lang="zh-Hant"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>KUMAGO 照片（${ids.length}）</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#111; color:#eee; font-family:-apple-system,"Segoe UI",Roboto,"Noto Sans TC",sans-serif; }
  header { padding:14px 16px; font-size:15px; font-weight:600; position:sticky; top:0; background:#111; border-bottom:1px solid #262626; }
  main { display:flex; flex-direction:column; align-items:center; gap:18px; padding:16px; max-width:900px; margin:0 auto; }
  figure { margin:0; width:100%; }
  img { width:100%; height:auto; border-radius:12px; display:block; background:#1c1c1c; }
  figcaption { text-align:center; color:#888; font-size:12px; padding-top:6px; }
</style>
</head><body>
<header>🐻 KUMAGO 照片　共 ${ids.length} 張</header>
<main>
${imgs}
</main>
</body></html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // The photos behind the ids never change; cache the shell briefly.
  res.setHeader("Cache-Control", "public, max-age=600");
  return res.status(200).end(html);
};
