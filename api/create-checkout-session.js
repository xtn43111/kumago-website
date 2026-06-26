/* KUMAGO — create a Stripe Checkout Session for an annual-rental order.
 *
 * Runs as a Vercel serverless function (Node runtime, no build step).
 * The Stripe secret key MUST be set as a Vercel Environment Variable:
 *     STRIPE_SECRET_KEY = sk_live_... (or sk_test_... while testing)
 * It is never committed to the repo.
 *
 * Security: the browser only sends plan/duration/addon KEYS. We recompute the
 * authoritative amount here from the server-side price table below, so a tampered
 * client total can never reach the charge. JPY is a zero-decimal currency, so
 * unit_amount is the yen value as-is (no ×100).
 */

const PLAN_PRICES = {
  A: { "1個月": 28400, "2個月": 31130, "3個月": 32920, "4個月": 36250, "5個月": 37430, "半年": 38490, "1年": 45100, "2年": 63250 },
  B: { "1個月": 32910, "2個月": 35640, "3個月": 38400, "4個月": 41820, "5個月": 43640, "半年": 46270, "1年": 55080, "2年": 69990 },
  C: { "1個月": 46980, "2個月": 49360, "3個月": 52430, "4個月": 55690, "5個月": 59350, "半年": 62340, "1年": 72320, "2年": 91630 },
};

const PLAN_NAME = { A: "A 套組", B: "B 套組", C: "C 套組" };

const ADDONS = {
  floor_mat:     { price: 1800, name: "地板保護墊 Floor mat" },
  kettle:        { price: 4500, name: "熱水壺 Kettle" },
  ceiling_light: { price: 4500, name: "可調光吸頂燈 Ceiling light" },
  curtain:       { price: 4900, name: "4 片窗簾組 Curtains x4" },
  vacuum:        { price: 4500, name: "吸塵器 Vacuum" },
  fan:           { price: 4500, name: "電風扇 Fan" },
  clothes_rack:  { price: 4500, name: "室內掛衣架 Clothes rack" },
  desk:          { price: 9000, name: "桌椅組 Desk & chair" },
  rice_cooker:   { price: 7000, name: "電飯鍋 Rice cooker" },
  pot:           { price: 7000, name: "鍋具組 Pot set" },
  clothesline:   { price: 1800, name: "曬衣桿 Drying pole" },
};

// Online-payable areas only. 市外 (nara/kyoto/hyogo) needs a manual shipping quote → LINE.
const ONLINE_AREAS = new Set(["osaka"]);

function durationLabel(d) {
  if (d === "半年") return "半年";
  if (d === "1年") return "1 年";
  if (d === "2年") return "2 年";
  return d.replace("個月", " 個月");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const { plan, duration, addons = [], area, moveInDate, time,
          address, room, noRoom, elevator, name, contact, lang } = body;

  // ---- validate core selection ----
  if (!PLAN_PRICES[plan] || !PLAN_PRICES[plan][duration]) {
    return res.status(400).json({ error: "invalid_plan_or_duration" });
  }
  if (!ONLINE_AREAS.has(area)) {
    return res.status(400).json({ error: "area_requires_quote" });
  }
  if (!moveInDate || !time || !address || !elevator || !name || !contact) {
    return res.status(400).json({ error: "missing_required_fields" });
  }
  if (!noRoom && !room) {
    return res.status(400).json({ error: "missing_room" });
  }

  // ---- build line items from the trusted table ----
  const items = [];
  items.push({
    name: `${PLAN_NAME[plan]} × ${durationLabel(duration)}`,
    amount: PLAN_PRICES[plan][duration],
  });
  const addonList = Array.isArray(addons) ? addons : [];
  for (const k of addonList) {
    if (ADDONS[k]) items.push({ name: ADDONS[k].name, amount: ADDONS[k].price });
  }

  // ---- origin for redirect URLs ----
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const origin = `${proto}://${host}`;

  // ---- assemble Stripe Checkout Session params (form-encoded) ----
  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("success_url", `${origin}/success?session_id={CHECKOUT_SESSION_ID}`);
  params.append("cancel_url", `${origin}/order?canceled=1`);
  params.append("locale", lang === "ja" ? "ja" : "zh-TW");
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact)) {
    params.append("customer_email", contact);
  }

  items.forEach((it, i) => {
    params.append(`line_items[${i}][price_data][currency]`, "jpy");
    params.append(`line_items[${i}][price_data][product_data][name]`, it.name);
    params.append(`line_items[${i}][price_data][unit_amount]`, String(it.amount));
    params.append(`line_items[${i}][quantity]`, "1");
  });

  // Full order details ride along as metadata so the owner sees everything in the
  // Stripe Dashboard / payment receipt. (each value ≤ 500 chars)
  const meta = {
    plan, duration,
    addons: addonList.join(",") || "(none)",
    area,
    move_in_date: moveInDate,
    delivery_time: time,
    address: `${address} ${noRoom ? "(no room#)" : room || ""}`.trim(),
    elevator,
    customer_name: name,
    customer_contact: contact,
    lang: lang || "zh",
  };
  Object.entries(meta).forEach(([k, v]) => {
    params.append(`metadata[${k}]`, String(v).slice(0, 500));
    params.append(`payment_intent_data[metadata][${k}]`, String(v).slice(0, 500));
  });

  try {
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("Stripe error:", data && data.error);
      return res.status(502).json({ error: "stripe_error", detail: data && data.error && data.error.message });
    }
    return res.status(200).json({ url: data.url, id: data.id });
  } catch (err) {
    console.error("checkout exception:", err);
    return res.status(500).json({ error: "server_error" });
  }
};
