/* KUMAGO — local dev server.  `python3 -m http.server` only serves static files,
 * so the Stripe /api functions never run. This zero-dependency Node server serves
 * the static site AND executes the Vercel serverless functions in api/, so you can
 * click "前往付款" and reach the real Stripe (test-mode) checkout page locally.
 *
 *   node tools/dev_server.js          # → http://127.0.0.1:3000
 *
 * It loads .env, applies vercel.json's cleanUrls (/order → order.html), and wraps
 * Node's req/res to match the Vercel handler signature (res.status().json()).
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.PORT || 3000;

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

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
};

/* Give a Node ServerResponse the Vercel helpers the handlers expect. */
function wrapRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function runApiFunction(name, req, res) {
  const file = path.join(ROOT, "api", name + ".js");
  if (!fs.existsSync(file)) { res.statusCode = 404; return res.end("no such api function"); }
  let handler;
  try {
    delete require.cache[require.resolve(file)]; // hot-reload on each request
    handler = require(file);
  } catch (e) {
    res.statusCode = 500; return res.end("api load error: " + e.message);
  }
  wrapRes(res);

  // The webhook reads the raw stream itself; everything else gets req.body.
  if (name !== "stripe-webhook") {
    const raw = await readBody(req);
    req.body = raw.toString("utf8");
  }
  try {
    await handler(req, res);
  } catch (e) {
    if (!res.headersSent) { res.statusCode = 500; res.end("api error: " + e.message); }
  }
}

/* ---- static file serving with cleanUrls (extensionless → .html) ---- */
function resolveStatic(urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  let file = path.join(ROOT, rel);
  // prevent path traversal
  if (!file.startsWith(ROOT)) return null;
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  // cleanUrls: /order → order.html
  if (!path.extname(file)) {
    const html = file + ".html";
    if (fs.existsSync(html)) return html;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = req.url || "/";

  if (url.startsWith("/api/")) {
    const name = url.slice(5).split("?")[0].replace(/\/+$/, "");
    return runApiFunction(name, req, res);
  }

  const file = resolveStatic(url);
  if (!file) { res.statusCode = 404; res.setHeader("Content-Type", "text/html; charset=utf-8"); return res.end("<h1>404</h1>"); }
  res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  const ok = process.env.STRIPE_SECRET_KEY ? "set" : "MISSING";
  const mail = process.env.SMTP_USER ? "set" : "MISSING";
  console.log(`KUMAGO dev server → http://127.0.0.1:${PORT}`);
  console.log(`  STRIPE_SECRET_KEY: ${ok}   SMTP_USER: ${mail}`);
  console.log(`  order page:  http://127.0.0.1:${PORT}/order`);
});
