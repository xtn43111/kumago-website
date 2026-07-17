"use strict";
/*
 * 續租自動計價＋建 Stripe Checkout Session（api/renewal-session.js 用）。
 *
 * 計價規則（Peter 慣例，見 memory renewal-flow）：
 *   原成交價（套組＋加購，不含運費/搬運費）× 新月數 ÷ 原月數
 * 原成交價來源＝網站自動配送事件 description 的「── 明細 ──」區
 * （・label　¥n,nnn 行，排除 label 含 運費/搬運/配送費）。
 * 手動建的舊配送單沒有明細 → 算不出 → 回 null，走人工報價。
 *
 * 金額防呆：算出金額不在 ¥3,000 ~ ¥300,000 → 視為 parse 出錯，回 null 走人工。
 */

const PLAN_NAME = { A: "A 套組", B: "B 套組", C: "C 套組" };
const AMOUNT_MIN = 3000;
const AMOUNT_MAX = 300000;

/* 「── 明細 ──」區的 ・label　¥n,nnn 行 → [{label, amount}] */
function parsePaidItemsFromDesc(desc) {
  const items = [];
  for (const line of String(desc || "").split("\n")) {
    const m = line.match(/^・(.+?)[\s　]+¥([\d,]+)\s*$/);
    if (m) items.push({ label: m[1].trim(), amount: parseInt(m[2].replace(/,/g, ""), 10) });
  }
  return items;
}

const EXCLUDE_RE = /運費|搬運|配送費|送料/;

/* 配送事件 description ＋ 原/新月數 → 續租金額。算不出回 null。 */
function computeRenewalPrice(deliveryDesc, origMonths, newMonths) {
  if (!origMonths || !newMonths) return null;
  const items = parsePaidItemsFromDesc(deliveryDesc);
  if (!items.length) return null;
  const kept = items.filter((i) => !EXCLUDE_RE.test(i.label));
  const excluded = items.filter((i) => EXCLUDE_RE.test(i.label));
  const base = kept.reduce((s, i) => s + i.amount, 0);
  if (!base) return null;
  const amount = Math.round((base * newMonths) / origMonths);
  if (amount < AMOUNT_MIN || amount > AMOUNT_MAX) return null;
  return { amount, baseAmount: base, kept, excluded };
}

function durationLabel(months) {
  if (months === 6) return "半年";
  if (months % 12 === 0) return `${months / 12}年`;
  return `${months}個月`;
}

/* 建 checkout session。meta = 完整 kumago_renewal metadata（呼叫端組好）。
 * 回 {url, id}；Stripe 錯誤 throw。 */
async function createRenewalCheckout(meta, amount, siteOrigin, secret) {
  const months = parseInt(meta.renewal_months, 10);
  const plan = meta.plan;
  const itemName =
    meta.lang === "en"
      ? `[Renewal] ${plan ? `Plan ${plan}` : "Rental"} × ${months % 12 === 0 ? `${months / 12} year${months > 12 ? "s" : ""}` : `${months} months`}`
      : `【續租】${PLAN_NAME[plan] || plan || "續租"} × ${meta.duration}${meta.items_note ? "（含原加購品項）" : ""}`;

  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("success_url", `${siteOrigin}/success?session_id={CHECKOUT_SESSION_ID}`);
  params.append("cancel_url", `${siteOrigin}/`);
  params.append("locale", meta.lang === "ja" ? "ja" : meta.lang === "en" ? "en" : "zh-TW");
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(meta.customer_contact)) {
    params.append("customer_email", meta.customer_contact);
  }
  params.append("line_items[0][price_data][currency]", "jpy");
  params.append("line_items[0][price_data][product_data][name]", itemName);
  params.append("line_items[0][price_data][unit_amount]", String(amount));
  params.append("line_items[0][quantity]", "1");
  Object.entries(meta).forEach(([k, v]) => {
    params.append(`metadata[${k}]`, String(v).slice(0, 500));
    params.append(`payment_intent_data[metadata][${k}]`, String(v).slice(0, 500));
  });

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
    throw new Error("stripe_error: " + ((data.error && data.error.message) || r.status));
  }
  return { url: data.url, id: data.id, itemName };
}

module.exports = {
  parsePaidItemsFromDesc,
  computeRenewalPrice,
  createRenewalCheckout,
  durationLabel,
  PLAN_NAME, AMOUNT_MIN, AMOUNT_MAX,
};
