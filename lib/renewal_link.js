/* KUMAGO — 續租付款連結：Telegram「/續租連結」指令共用邏輯（仿 recovery_link.js）。
 *
 * 入口：api/telegram-webhook.js 的「/續租連結」指令。
 * metadata 帶 kumago_renewal=1，且 key 完全對齊 tools/create_renewal_link.js
 * （webhook 端 lib/renewal.js handleRenewal / renewalView 讀這些 key），
 * 所以付款後直接走既有續租流程：建【續租】紀錄事件、順延【到期】事件、
 * 寄確認信、LINE 推播客人、Telegram 推播老闆——webhook 不用改。
 *
 * 模式（同 recovery_link）：
 *   • 無期限 → Stripe Payment Link（付款前一直有效、付一次即失效）
 *   • 有期限（expiresAt epoch 秒）→ Checkout Session（Stripe 限 30 分～24 小時）
 */
"use strict";

const { computeNewExpiry } = require("./renewal.js");
const { parseCmdDate, parseCmdExpires, isRealDate, mdLabel } = require("./recovery_link.js");

const SITE_ORIGIN = "https://kumago.7-mori.com";
const PLAN_NAME = { A: "A 套組", B: "B 套組", C: "C 套組" };
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* 同 tools/create_renewal_link.js durationLabel：6→半年、12的倍數→N年、其餘 N個月。 */
function durationLabel(months) {
  const m = parseInt(months, 10);
  if (m === 6) return "半年";
  if (m % 12 === 0) return `${m / 12}年`;
  return `${m}個月`;
}

/* v = {name, amount, months, start, plan?, phone?, email?, expiryEventId?,
 *      postal?, address?, items?, lineName?, lineUserId?, note?, lang?}
 * → Stripe metadata（key 對齊 create_renewal_link.js，handleRenewal 直接吃）。 */
function buildRenewalMeta(v) {
  const months = parseInt(v.months, 10);
  const email = String(v.email || "").trim();
  const isEmail = EMAIL_RE.test(email);
  return {
    kumago_renewal: "1",
    plan: String(v.plan || "").toUpperCase(),
    duration: durationLabel(months),
    renewal_months: String(months),
    renewal_start: v.start,
    new_expiry: computeNewExpiry(v.start, months) || "",
    expiry_event_id: v.expiryEventId || "",
    customer_name: v.name,
    // contact 放 email（mailer 靠它寄客人確認信）；沒 email 就放電話
    customer_contact: isEmail ? email : (v.phone || ""),
    customer_phone: v.phone || "",
    line_display_name: String(v.lineName || "").trim().slice(0, 60),
    line_user_id: /^U[0-9a-f]{32}$/.test(String(v.lineUserId || "")) ? String(v.lineUserId) : "",
    postal: v.postal || "",
    address: v.address || "",
    items_note: v.items || "",
    note: v.note || "",
    lang: v.lang || "zh",
  };
}

/* Stripe line item 品名（照 create_renewal_link.js 慣例）。 */
function renewalItemName(v) {
  const months = parseInt(v.months, 10);
  const plan = String(v.plan || "").toUpperCase();
  const planName = PLAN_NAME[plan] || plan || "續租";
  if ((v.lang || "zh") === "en") {
    const dur = months % 12 === 0
      ? `${months / 12} year${months > 12 ? "s" : ""}`
      : `${months} months`;
    return `[Renewal] ${plan ? `Plan ${plan}` : "Rental"} × ${dur}`;
  }
  return `【續租】${planName} × ${durationLabel(months)}${v.items ? "（含原加購品項）" : ""}`;
}

/* 產連結。opts = {session?, expiresAt?}：有 expiresAt（或 session=true）→
 * Checkout Session；否則 Payment Link。回 {mode, url, id}；Stripe 錯誤 throw。 */
async function createRenewalLink(v, secret, opts) {
  if (!secret) throw new Error("Stripe secret key 未設定");
  const { session: wantSession, expiresAt } = opts || {};
  const meta = buildRenewalMeta(v);
  const itemName = renewalItemName(v);
  const amount = parseInt(v.amount, 10);
  if (!amount || amount <= 0) throw new Error("金額要是正整數（日圓）");
  if (!isRealDate(v.start)) throw new Error(`原到期日不是有效日期：${v.start}`);
  if (!meta.new_expiry) throw new Error("新到期日算不出來（檢查原到期日/月數）");

  const params = new URLSearchParams();
  const session = !!(wantSession || expiresAt);
  if (session) {
    params.append("mode", "payment");
    if (expiresAt) params.append("expires_at", String(expiresAt));
    params.append("success_url", `${SITE_ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}`);
    params.append("cancel_url", `${SITE_ORIGIN}/`);
    params.append("locale", meta.lang === "ja" ? "ja" : meta.lang === "en" ? "en" : "zh-TW");
    if (EMAIL_RE.test(meta.customer_contact)) params.append("customer_email", meta.customer_contact);
  } else {
    params.append("restrictions[completed_sessions][limit]", "1");
    params.append("after_completion[type]", "redirect");
    params.append("after_completion[redirect][url]", `${SITE_ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}`);
  }
  params.append("line_items[0][price_data][currency]", "jpy");
  params.append("line_items[0][price_data][product_data][name]", itemName);
  params.append("line_items[0][price_data][unit_amount]", String(amount));
  params.append("line_items[0][quantity]", "1");
  Object.entries(meta).forEach(([k, val]) => {
    params.append(`metadata[${k}]`, String(val).slice(0, 500));
    params.append(`payment_intent_data[metadata][${k}]`, String(val).slice(0, 500));
  });

  const endpoint = session
    ? "https://api.stripe.com/v1/checkout/sessions"
    : "https://api.stripe.com/v1/payment_links";
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await r.json();
  if (!r.ok) throw new Error("Stripe：" + ((data.error && data.error.message) || r.status));
  return { mode: session ? "session" : "payment_link", url: data.url, id: data.id };
}

/* ── Telegram「/續租連結」指令解析 ─────────────────────────────────────── */

const CMD_TEMPLATE = [
  "🔁 產續租刷卡連結：整段複製、改內容後送出",
  "",
  "/續租連結",
  "姓名：王小明",
  "金額：31250",
  "月數：6",
  "原到期日：2026-08-31",
  "方案：B",
  "email：taro@example.com",
  "品項：B set＋窗簾、曬衣桿（原加購續用）",
  "到期事件id：",
  "",
  "（姓名/金額/月數/原到期日必填，其餘選填。",
  "　原到期日＝續租起算日，用 YYYY-MM-DD。",
  "　到期事件id 給了，付款後行事曆【到期】事件才會自動順延。",
  "　期限＝付款截止（30分鐘～24小時內），留空＝連結不過期。",
  "　也可加：電話：… / 郵遞區號：… / 地址：… / LINE名：… /",
  "　LINE ID：… / 備註：… / 期限：7/19 12:00 / 語言：en）",
].join("\n");

/* 指令全文 → {ok:true, value, expiresAt} 或 {ok:false, error}；非本指令回 null。 */
function parseRenewalLinkCommand(text, todayISO, now) {
  const t = String(text || "").trim();
  if (!/^\/?續租連結/.test(t)) return null; // 不是這個指令
  const rest = t.replace(/^\/?續租連結\s*/, "");
  if (!rest.trim()) return { ok: false, error: "template" };

  const fields = {};
  const LABELS = {
    "姓名": "name", "金額": "amount", "月數": "months",
    "原到期日": "start", "起算日": "start",
    "方案": "plan", "電話": "phone",
    "email": "email", "信箱": "email",
    "到期事件id": "expiryEventId", "事件id": "expiryEventId",
    "郵遞區號": "postal", "地址": "address", "品項": "items",
    "line名稱": "lineName", "line名": "lineName",
    "line id": "lineUserId", "lineid": "lineUserId",
    "備註": "note", "期限": "expires", "語言": "lang",
  };
  const LABEL_RE = /^\s*(姓名|金額|月數|原到期日|起算日|方案|電話|email|信箱|到期事件id|事件id|郵遞區號|地址|品項|LINE名稱|LINE名|LINE ID|LINEID|備註|期限|語言)\s*[:：]\s*(.*)$/i;
  for (const line of rest.split("\n")) {
    const m = line.match(LABEL_RE);
    if (m) fields[LABELS[m[1].toLowerCase().replace(/\s+/g, " ")]] = m[2].trim();
  }

  const missing = [];
  if (!fields.name) missing.push("姓名");
  if (!fields.amount) missing.push("金額");
  if (!fields.months) missing.push("月數");
  if (!fields.start) missing.push("原到期日");
  if (missing.length) return { ok: false, error: `缺欄位：${missing.join("、")}` };

  const amount = parseInt(String(fields.amount).replace(/[,，¥\s]/g, ""), 10);
  if (!amount || amount <= 0) return { ok: false, error: `金額看不懂：「${fields.amount}」（要日圓整數）` };

  const months = parseInt(String(fields.months).replace(/個月|月|\s/g, ""), 10);
  if (!months || months <= 0) return { ok: false, error: `月數看不懂：「${fields.months}」（要正整數）` };

  // 原到期日只收 YYYY-MM-DD：M/D 會被「過去滾明年」規則亂改，續租起算日不能猜。
  const start = String(fields.start).trim().replace(/\//g, "-");
  if (!isRealDate(start)) {
    return { ok: false, error: `原到期日看不懂：「${fields.start}」（用 YYYY-MM-DD，例 2026-08-31）` };
  }

  const email = String(fields.email || "").trim();
  if (email && !EMAIL_RE.test(email)) {
    return { ok: false, error: `email 格式不對：「${email}」` };
  }

  let expiresAt = null;
  if (fields.expires) {
    expiresAt = parseCmdExpires(fields.expires, todayISO);
    if (!expiresAt) return { ok: false, error: `期限看不懂：「${fields.expires}」（用 7/19 12:00 或 12:00）` };
    const mins = (expiresAt * 1000 - (now || Date.now())) / 60000;
    if (mins < 30) return { ok: false, error: `期限距現在只剩 ${Math.round(mins)} 分鐘，Stripe 最少要 30 分鐘` };
    if (mins > 24 * 60) return { ok: false, error: "期限超過 24 小時（Stripe 上限）。要更久就別填期限，改用不過期連結" };
  }

  const lang = /^(en|英)/i.test(fields.lang || "") ? "en" : "zh";

  return {
    ok: true,
    expiresAt,
    value: {
      name: fields.name, amount, months, start,
      plan: (fields.plan || "").toUpperCase(),
      phone: fields.phone || "", email,
      expiryEventId: fields.expiryEventId || "",
      postal: fields.postal || "", address: fields.address || "",
      items: fields.items || "",
      lineName: fields.lineName || "", lineUserId: fields.lineUserId || "",
      note: fields.note || "", lang,
    },
  };
}

/* 給客人的訊息文字（老闆整段複製貼上 LINE）。zh/en 按 v.lang。 */
function buildRenewalCustomerMessage(v, url, expiresAt) {
  const yen = "¥" + Number(v.amount).toLocaleString("ja-JP");
  const newExpiry = computeNewExpiry(v.start, v.months) || "";
  const slash = (iso) => String(iso || "").replace(/-/g, "/");
  const plan = String(v.plan || "").toUpperCase();

  if ((v.lang || "zh") === "en") {
    const months = parseInt(v.months, 10);
    const dur = months % 12 === 0
      ? `${months / 12} year${months > 12 ? "s" : ""}`
      : `${months} months`;
    const lines = [
      "🐻 KUMAGO Rental Renewal — Payment Link",
      "",
      `Amount: ${yen} (${plan ? `Plan ${plan} × ` : ""}${dur})`,
      `Renewal period: ${slash(v.start)} – ${slash(newExpiry)}`,
      `New expiry date: ${slash(newExpiry)}`,
      "",
    ];
    if (expiresAt) {
      const d = new Date(expiresAt * 1000 + 9 * 3600 * 1000);
      const iso = d.toISOString();
      lines.push(
        "Please complete the payment before:",
        `⏰ ${mdLabel(iso.slice(0, 10))} ${iso.slice(11, 16)} (JST)`,
        ""
      );
    }
    lines.push(url, "", "Once paid, your rental is renewed automatically and a confirmation will be sent. Thank you! 🙇");
    return lines.join("\n");
  }

  const lines = [
    "🐻 KUMAGO 續租 付款連結",
    "",
    `金額：${yen}（${plan ? `${plan} 方案 × ` : ""}${durationLabel(v.months)}續租）`,
    `續租期間：${slash(v.start)} - ${slash(newExpiry)}`,
    `新到期日：${slash(newExpiry)}`,
    v.items ? `品項：${v.items}` : null,
    "",
  ];
  if (expiresAt) {
    const d = new Date(expiresAt * 1000 + 9 * 3600 * 1000);
    const iso = d.toISOString();
    lines.push(
      "請於期限內完成刷卡付款：",
      `⏰ 付款期限：${mdLabel(iso.slice(0, 10))} ${iso.slice(11, 16)}`,
      ""
    );
  }
  lines.push(url, "", "付款完成後系統會自動延長租期並寄送確認通知，感謝您的續租🙇");
  return lines.filter((l) => l !== null).join("\n");
}

module.exports = {
  durationLabel,
  buildRenewalMeta,
  renewalItemName,
  createRenewalLink,
  parseRenewalLinkCommand,
  buildRenewalCustomerMessage,
  CMD_TEMPLATE,
};
