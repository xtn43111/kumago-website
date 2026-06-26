#!/usr/bin/env node
/* KUMAGO — one-time Google OAuth refresh-token minting tool.
 *
 * Run this ONCE locally to authorise xtn43111@gmail.com and obtain a long-lived
 * refresh token for writing to the shop Google Calendar. The token then lives in
 * env vars (GOOGLE_OAUTH_REFRESH_TOKEN) — locally in .env and in Vercel.
 *
 * Prereqs (you already have an OAuth client):
 *   • A Google Cloud OAuth 2.0 Client (type "Desktop app" is easiest).
 *   • The Google Calendar API enabled on that project.
 *   • xtn43111@gmail.com has "Make changes to events" on the target calendar.
 *
 * Provide the client id/secret one of two ways:
 *   A) Put the downloaded client_secret JSON at ./credentials.json, OR
 *   B) export GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=...
 *
 * Then:   node tools/google_oauth_setup.js
 * It prints a URL — open it, sign in as xtn43111@gmail.com, approve, and the tool
 * captures the code on a localhost callback and prints your env vars.
 *
 * Scope: calendar.events (create/edit events only — not full calendar admin).
 */

const http = require("http");
const crypto = require("crypto");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const PORT = 4567;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

function loadClient() {
  let id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  let secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const credPath = path.join(process.cwd(), "credentials.json");
  if ((!id || !secret) && fs.existsSync(credPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(credPath, "utf8"));
      const c = j.installed || j.web || j;
      id = id || c.client_id;
      secret = secret || c.client_secret;
    } catch (e) {
      console.error("Could not parse credentials.json:", e.message);
    }
  }
  if (!id || !secret) {
    console.error(
      "\n✗ Missing OAuth client.\n" +
        "  Provide ./credentials.json (downloaded from Google Cloud), or set\n" +
        "  GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in your shell.\n"
    );
    process.exit(1);
  }
  return { id, secret };
}

async function exchangeCode(client, code) {
  const body = new URLSearchParams({
    code,
    client_id: client.id,
    client_secret: client.secret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return r.json();
}

function main() {
  const client = loadClient();
  const state = crypto.randomBytes(16).toString("hex");

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: client.id,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline", // → returns a refresh_token
      prompt: "consent", // force a fresh refresh_token every run
      state,
    }).toString();

  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith("/oauth2callback")) {
      res.writeHead(404);
      return res.end("not found");
    }
    const u = new URL(req.url, REDIRECT_URI);
    const code = u.searchParams.get("code");
    const gotState = u.searchParams.get("state");
    const err = u.searchParams.get("error");

    if (err || !code || gotState !== state) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Authorisation failed: " + (err || "missing/invalid code"));
      console.error("\n✗ Authorisation failed:", err || "missing/invalid code");
      server.close();
      return;
    }

    const tok = await exchangeCode(client, code);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

    if (!tok.refresh_token) {
      res.end(
        "<h2>No refresh token returned.</h2><p>Revoke the app's access at " +
          "myaccount.google.com → Security → Third-party access, then run again.</p>"
      );
      console.error(
        "\n✗ No refresh_token in response:",
        JSON.stringify(tok, null, 2),
        "\n  (Revoke prior access at https://myaccount.google.com/permissions and retry.)"
      );
      server.close();
      return;
    }

    res.end(
      "<h2>✅ KUMAGO calendar authorised.</h2>" +
        "<p>You can close this tab and return to the terminal.</p>"
    );

    console.log("\n========================================================");
    console.log("✅ SUCCESS — add these to .env (local) AND Vercel env vars:");
    console.log("========================================================\n");
    console.log(`GOOGLE_OAUTH_CLIENT_ID=${client.id}`);
    console.log(`GOOGLE_OAUTH_CLIENT_SECRET=${client.secret}`);
    console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tok.refresh_token}`);
    console.log("\n(The calendar id is already defaulted in lib/gcal.js.)\n");
    server.close();
  });

  server.listen(PORT, () => {
    console.log("\nKUMAGO Google Calendar — OAuth setup");
    console.log("Open this URL and sign in as xtn43111@gmail.com:\n");
    console.log(authUrl + "\n");
    // Best-effort auto-open on macOS.
    exec(`open "${authUrl}"`, () => {});
  });
}

main();
