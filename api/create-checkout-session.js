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
  low_table:     { price: 6000, name: "和式桌 Low table (75×50×31.5cm)" },
  rice_cooker:   { price: 7000, name: "電飯鍋 Rice cooker" },
  pot:           { price: 7000, name: "鍋具組 Pot set" },
  clothesline:   { price: 1800, name: "曬衣桿 Drying pole" },
};

/* Shipping fee, derived from the postal-code lookup (都道府県 + 市区町村).
 * ⚠ MUST stay in sync with order.js shippingFor(). 大阪市内 = free (0);
 * a returned null means the address is outside the online-quotable area
 * (→ LINE manual quote), so the checkout is rejected here as a safeguard. */
const SHIP_OSAKA_TIERS = [
  { fee: 6600,  cities: ["堺市", "松原市", "東大阪市"] },
  { fee: 9800,  cities: ["藤井寺市", "八尾市", "大阪狭山市", "柏原市", "守口市", "門真市",
                         "大東市", "豊中市", "吹田市", "高石市", "泉大津市", "和泉市",
                         "岸和田市", "寝屋川市", "枚方市", "茨木市", "摂津市", "池田市", "箕面市"] },
  { fee: 13800, cities: ["高槻市", "交野市", "四條畷市", "四条畷市", "泉佐野市", "貝塚市",
                         "富田林市", "羽曳野市", "阪南市", "河内長野市", "泉南市"] },
];

const KYOTO_25000 = ["向日市", "長岡京市", "八幡市", "京田辺市", "宇治市", "城陽市", "木津川市", "亀岡市"];
const NARA_15800 = ["奈良市", "天理市", "橿原市"];
const NARA_18000 = ["生駒市", "大和郡山市", "香芝市", "葛城市", "大和高田市"];
const HYOGO_18000 = ["神戸市", "尼崎市", "西宮市", "芦屋市", "伊丹市", "宝塚市", "川西市", "三田市"];

function shippingFee(pref, city) {
  pref = pref || "";
  city = city || "";
  const has = (name) => city.indexOf(name) === 0; // 政令市の区にも前方一致で対応
  if (pref === "大阪府") {
    if (has("大阪市")) return 0;
    for (const tier of SHIP_OSAKA_TIERS) if (tier.cities.some(has)) return tier.fee;
    return null;
  }
  if (pref === "京都府") {
    if (has("京都市")) return 18000;
    if (KYOTO_25000.some(has)) return 25000;
    return null;
  }
  if (pref === "奈良県") {
    if (NARA_15800.some(has)) return 15800;
    if (NARA_18000.some(has)) return 18000;
    return null;
  }
  if (pref === "兵庫県") {
    if (HYOGO_18000.some(has)) return 18000;
    return null;
  }
  return null;
}

/* Server-side postal → (pref, city) lookup, same zipcloud source the form uses.
 * The client's shipPref/shipCity are NEVER trusted for pricing — a tampered
 * request could claim 大阪市 (free) while shipping to 京都市 (¥18,000).
 * Returns { pref, city } on success, null when the postal code is unknown,
 * or throws on network/service failure (caller falls back + flags the order). */
async function lookupPostal(postal) {
  const zip = String(postal || "").replace(/[^0-9]/g, "");
  if (!/^\d{7}$/.test(zip)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch("https://zipcloud.ibsnet.co.jp/api/search?zipcode=" + zip, { signal: ctrl.signal });
    if (!r.ok) throw new Error("zipcloud http " + r.status);
    const data = await r.json();
    if (data.status !== 200) throw new Error("zipcloud status " + data.status);
    const a = data.results && data.results[0];
    if (!a) return null; // 查無此郵遞區號
    return { pref: a.address1 || "", city: a.address2 || "" };
  } finally {
    clearTimeout(timer);
  }
}

function durationLabel(d) {
  if (d === "半年") return "半年";
  if (d === "1年") return "1 年";
  if (d === "2年") return "2 年";
  return d.replace("個月", " 個月");
}

// moveInDate 必須是真實日曆日且在合理配送窗內。前端的 <input min> 可被繞過，
// 若讓畸形/過去日期進到付款，webhook 端 buildEvent 會回 null → 付款成功卻沒有
// 配送行事曆事件 → 這單會被漏掉（H4）。故在建立 Stripe session 前就擋掉。
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function moveInDateOk(s, now) {
  if (!isRealDate(s)) return false;
  const todayJst = new Date((now || Date.now()) + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const off = Math.round((Date.parse(`${s}T00:00:00Z`) - Date.parse(`${todayJst}T00:00:00Z`)) / 86400000);
  return off >= -1 && off <= 400; // 允許今天前後：昨天到約 13 個月內
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
          address, postal, building, mapUrl, shipPref, shipCity,
          room, noRoom, elevator, name, contact, note, lang,
          lineUserId, lineDisplayName } = body;

  // ---- validate core selection ----
  if (!PLAN_PRICES[plan] || !PLAN_PRICES[plan][duration]) {
    return res.status(400).json({ error: "invalid_plan_or_duration" });
  }
  // Recompute the shipping fee from the trusted table, keyed by a server-side
  // postal lookup (never the client's shipPref/shipCity — those are display-only).
  // null fee = outside the online area → must go through the LINE quote instead.
  let feePref, feeCity, shipVerify;
  try {
    const loc = await lookupPostal(postal);
    if (!loc) return res.status(400).json({ error: "invalid_postal" });
    feePref = loc.pref; feeCity = loc.city; shipVerify = "postal_ok";
  } catch (e) {
    // zipcloud 服務故障（非查無資料）：不擋單，退回客戶端值並標記給老闆稽核
    console.error("postal lookup failed, falling back to client values:", e.message);
    feePref = shipPref; feeCity = shipCity; shipVerify = "client_unverified";
  }
  const shipFee = shippingFee(feePref, feeCity);
  if (shipFee == null) {
    return res.status(400).json({ error: "area_requires_quote" });
  }
  if (!moveInDate || !time || !address || !elevator || !name || !contact) {
    return res.status(400).json({ error: "missing_required_fields" });
  }
  // Reject an unplaceable delivery date before capturing payment (H4).
  if (!moveInDateOk(moveInDate)) {
    return res.status(400).json({ error: "invalid_move_in_date" });
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
  // No-elevator floor-carry fee (kept in sync with order.js NO_ELEVATOR_FEE).
  if (elevator === "無") {
    items.push({ name: "無電梯樓層搬運費 No-elevator floor fee", amount: 3300 });
  }
  // Out-of-Osaka-City delivery fee (0 = 大阪市内 free, so no line item).
  if (shipFee > 0) {
    items.push({ name: `市外配送費 Delivery fee (${feeCity || area || ""})`.trim(), amount: shipFee });
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
    area: feeCity || area || "",
    ship_fee: String(shipFee),
    ship_verify: shipVerify, // postal_ok=郵遞區號伺服器端已驗 / client_unverified=zipcloud當機退回客戶端值，出貨前人工核對

    move_in_date: moveInDate,
    delivery_time: time,
    postal: postal || "",
    building: building || "",
    address: `${address} ${noRoom ? "(no room#)" : room || ""}`.trim(),
    map_url: mapUrl || "",
    elevator,
    customer_name: name,
    customer_contact: contact,
    // LIFF 自動帶入的 LINE 身分（選填；壞值靜默丟棄，不影響下單）
    line_display_name: String(lineDisplayName || "").trim().slice(0, 60),
    line_user_id: /^U[0-9a-f]{32}$/.test(String(lineUserId || "")) ? String(lineUserId) : "",
    note: note || "",
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
