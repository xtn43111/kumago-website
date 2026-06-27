/* KUMAGO — Stripe webhook. Fires the order emails after a payment succeeds.
 *
 * Stripe → POST /api/stripe-webhook  (event: checkout.session.completed)
 *   1. Verify the signature against STRIPE_WEBHOOK_SECRET (skipped if unset — dev only).
 *   2. Pull the full line items for the session.
 *   3. Send owner + customer confirmation emails (lib/mailer.js).
 *
 * Setup (production): Stripe Dashboard → Developers → Webhooks → Add endpoint
 *   URL  = https://<your-domain>/api/stripe-webhook
 *   event = checkout.session.completed
 *   → copy the "Signing secret" (whsec_...) into the STRIPE_WEBHOOK_SECRET env var.
 *
 * We must read the RAW request body for signature verification, so Vercel's
 * automatic body parser is disabled below.
 */

const crypto = require("crypto");
const { sendOrderEmails, orderView } = require("../lib/mailer.js");
const { createOrderEvent } = require("../lib/gcal.js");
const { buildOrderPush, sendTelegram } = require("../lib/telegram.js");

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* Verify Stripe's "t=...,v1=..." signature header (no SDK needed). */
function verifySignature(raw, header, secret, toleranceSec = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.split("=").map((s) => s.trim()))
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const signed = `${t}.${raw.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(signed).digest("hex");
  let ok = false;
  try {
    ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  } catch { ok = false; }
  if (!ok) return false;
  // Reject events outside the tolerance window (replay protection).
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - Number(t)) <= toleranceSec;
}

async function fetchLineItems(sessionId, secret) {
  try {
    const r = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items?limit=100`,
      { headers: { Authorization: `Bearer ${secret}` } }
    );
    const j = await r.json();
    return Array.isArray(j.data) ? j.data : [];
  } catch {
    return [];
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let raw;
  try { raw = await readRawBody(req); } catch { return res.status(400).json({ error: "bad_body" }); }

  // Verify signature when a secret is configured. Without one (local dev), accept
  // unverified events but log loudly — never run unverified in production.
  if (whSecret) {
    const sig = req.headers["stripe-signature"];
    if (!verifySignature(raw, sig, whSecret)) {
      console.error("stripe-webhook: signature verification failed");
      return res.status(400).json({ error: "invalid_signature" });
    }
  } else {
    console.warn("stripe-webhook: STRIPE_WEBHOOK_SECRET unset — accepting UNVERIFIED event (dev only)");
  }

  let event;
  try { event = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).json({ error: "bad_json" }); }

  // Ack non-relevant events fast so Stripe doesn't retry.
  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ received: true, ignored: event.type });
  }

  const session = (event.data && event.data.object) || {};
  // Only fulfil truly-paid sessions.
  if (session.payment_status && session.payment_status !== "paid") {
    return res.status(200).json({ received: true, unpaid: session.payment_status });
  }

  const meta = session.metadata || {};
  const lineItems = secret ? await fetchLineItems(session.id, secret) : [];
  const amountTotal = session.amount_total != null ? session.amount_total : null;

  let report = { owner: false, customer: false, skipped: false, errors: [] };
  try {
    report = await sendOrderEmails(meta, lineItems, amountTotal);
  } catch (e) {
    // A mail failure must not make Stripe retry endlessly — payment already captured.
    console.error("stripe-webhook: sendOrderEmails threw:", e);
  }
  if (report.errors && report.errors.length) console.error("stripe-webhook mail errors:", report.errors);
  console.log("stripe-webhook: emails", JSON.stringify({ id: session.id, ...report }));

  // Record the order onto the shop Google Calendar (idempotent on session id, so
  // Stripe retries upsert the same event). A failure here must never make Stripe
  // retry endlessly — the payment is already captured.
  let cal = { created: false, skipped: false, errors: [] };
  try {
    cal = await createOrderEvent(meta, lineItems, amountTotal, session.id);
  } catch (e) {
    console.error("stripe-webhook: createOrderEvent threw:", e);
  }
  if (cal.errors && cal.errors.length) console.error("stripe-webhook calendar errors:", cal.errors);
  console.log("stripe-webhook: calendar", JSON.stringify({ id: session.id, ...cal }));

  // Instant per-order push to the owner's Telegram (separate from the daily
  // digest). Same resilience contract as email/calendar: never throw, never make
  // Stripe retry — the payment is already captured. No-ops if the bot is unset.
  let tg = { sent: false, errors: [] };
  try {
    await sendTelegram(buildOrderPush(orderView(meta, lineItems, amountTotal)));
    tg.sent = true;
  } catch (e) {
    console.error("stripe-webhook: telegram push threw:", e);
    tg.errors.push(e.message);
  }
  console.log("stripe-webhook: telegram", JSON.stringify({ id: session.id, ...tg }));

  return res.status(200).json({ received: true, emails: report, calendar: cal, telegram: tg });
};

// Disable Vercel's automatic body parser — we need the raw bytes for the HMAC.
// (Must be set AFTER the handler assignment above, or it gets overwritten.)
module.exports.config = { api: { bodyParser: false } };
