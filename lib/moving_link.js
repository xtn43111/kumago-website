/* KUMAGO — 搬家服務付款連結：Telegram「/搬家連結」指令共用邏輯（仿 recovery_link.js）。
 *
 * 入口：api/telegram-webhook.js 的「/搬家連結」指令。
 * metadata 帶 kumago_moving=1 → 付款後 api/stripe-webhook.js 走
 * lib/moving_payment.js（建行事曆事件＋LINE 推播＋確認信＋Telegram；見該檔）。
 *
 * 模式（同 recovery_link）：
 *   • 無期限 → Stripe Payment Link（付款前一直有效、付一次即失效）
 *   • 有期限（expiresAt epoch 秒）→ Checkout Session（Stripe 限 30 分～24 小時）
 */
"use strict";

const { parseCmdDate, parseCmdExpires, isRealDate, mdLabel } = require("./recovery_link.js");

const SITE_ORIGIN = "https://kumago.7-mori.com";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* v = {name, amount, date, addressFrom, addressTo?, time?, elevator?("yes"/"no"/""),
 *      phone?, email?, items?, lineName?, lineUserId?, note?, lang?}
 * → Stripe metadata 物件。 */
function buildMovingMeta(v) {
  const email = String(v.email || "").trim();
  return {
    kumago_moving: "1",
    customer_name: v.name,
    customer_phone: v.phone || "",
    customer_email: EMAIL_RE.test(email) ? email : "",
    moving_date: v.date,
    moving_time: v.time || "",
    address_from: v.addressFrom,
    address_to: v.addressTo || "",
    elevator: v.elevator === "yes" || v.elevator === "no" ? v.elevator : "",
    items_note: v.items || "",
    line_display_name: String(v.lineName || "").trim().slice(0, 60),
    line_user_id: /^U[0-9a-f]{32}$/.test(String(v.lineUserId || "")) ? String(v.lineUserId) : "",
    note: v.note || "",
    lang: v.lang || "zh",
  };
}

/* Stripe line item 品名：【搬家服務】姓名 M/D。 */
function movingItemName(v) {
  const md = `${Number(v.date.slice(5, 7))}/${Number(v.date.slice(8, 10))}`;
  return (v.lang || "zh") === "en"
    ? `[Moving Service] ${v.name} ${md}`
    : `【搬家服務】${v.name} ${md}`;
}

/* 產連結。opts = {session?, expiresAt?}。回 {mode, url, id}；Stripe 錯誤 throw。 */
async function createMovingLink(v, secret, opts) {
  if (!secret) throw new Error("Stripe secret key 未設定");
  const { session: wantSession, expiresAt } = opts || {};
  const meta = buildMovingMeta(v);
  const itemName = movingItemName(v);
  const amount = parseInt(v.amount, 10);
  if (!amount || amount <= 0) throw new Error("金額要是正整數（日圓）");
  if (!isRealDate(v.date)) throw new Error(`搬家日不是有效日期：${v.date}`);

  const params = new URLSearchParams();
  const session = !!(wantSession || expiresAt);
  if (session) {
    params.append("mode", "payment");
    if (expiresAt) params.append("expires_at", String(expiresAt));
    params.append("success_url", `${SITE_ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}`);
    params.append("cancel_url", `${SITE_ORIGIN}/`);
    params.append("locale", meta.lang === "ja" ? "ja" : meta.lang === "en" ? "en" : "zh-TW");
    if (meta.customer_email) params.append("customer_email", meta.customer_email);
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

/* ── Telegram「/搬家連結」指令解析 ─────────────────────────────────────── */

const CMD_TEMPLATE = [
  "🚚 產搬家服務刷卡連結：整段複製、改內容後送出",
  "",
  "/搬家連結",
  "姓名：王小明",
  "金額：15000",
  "搬家日：8/10",
  "搬出地址：大阪府大阪市○○区○○町1-2-3 405",
  "搬入地址：大阪府吹田市○○町4-5-6 202",
  "時間：上午",
  "電梯：有",
  "品項：冰箱、洗衣機、床墊",
  "",
  "（姓名/金額/搬家日/搬出地址必填，其餘選填。",
  "　期限＝付款截止（30分鐘～24小時內），留空＝連結不過期。",
  "　也可加：電話：… / email：… / LINE名：… / LINE ID：… /",
  "　備註：… / 期限：7/19 12:00 / 語言：en）",
].join("\n");

/* 指令全文 → {ok:true, value, expiresAt} 或 {ok:false, error}；非本指令回 null。 */
function parseMovingLinkCommand(text, todayISO, now) {
  const t = String(text || "").trim();
  if (!/^\/?搬家連結/.test(t)) return null; // 不是這個指令
  const rest = t.replace(/^\/?搬家連結\s*/, "");
  if (!rest.trim()) return { ok: false, error: "template" };

  const fields = {};
  const LABELS = {
    "姓名": "name", "金額": "amount", "搬家日": "date", "日期": "date",
    "搬出地址": "addressFrom", "搬入地址": "addressTo",
    "時間": "time", "電梯": "elevator", "電話": "phone",
    "email": "email", "信箱": "email", "品項": "items",
    "line名稱": "lineName", "line名": "lineName",
    "line id": "lineUserId", "lineid": "lineUserId",
    "備註": "note", "期限": "expires", "語言": "lang",
  };
  const LABEL_RE = /^\s*(姓名|金額|搬家日|日期|搬出地址|搬入地址|時間|電梯|電話|email|信箱|品項|LINE名稱|LINE名|LINE ID|LINEID|備註|期限|語言)\s*[:：]\s*(.*)$/i;
  for (const line of rest.split("\n")) {
    const m = line.match(LABEL_RE);
    if (m) fields[LABELS[m[1].toLowerCase().replace(/\s+/g, " ")]] = m[2].trim();
  }

  const missing = [];
  if (!fields.name) missing.push("姓名");
  if (!fields.amount) missing.push("金額");
  if (!fields.date) missing.push("搬家日");
  if (!fields.addressFrom) missing.push("搬出地址");
  if (missing.length) return { ok: false, error: `缺欄位：${missing.join("、")}` };

  const amount = parseInt(String(fields.amount).replace(/[,，¥\s]/g, ""), 10);
  if (!amount || amount <= 0) return { ok: false, error: `金額看不懂：「${fields.amount}」（要日圓整數）` };

  const date = parseCmdDate(fields.date, todayISO);
  if (!date) return { ok: false, error: `搬家日看不懂：「${fields.date}」（用 8/10 或 2026-08-10）` };

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

  const elevator =
    /有|yes/i.test(fields.elevator || "") ? "yes" :
    /無|没|沒|no/i.test(fields.elevator || "") ? "no" : "";

  const lang = /^(en|英)/i.test(fields.lang || "") ? "en" : "zh";

  return {
    ok: true,
    expiresAt,
    value: {
      name: fields.name, amount, date,
      addressFrom: fields.addressFrom, addressTo: fields.addressTo || "",
      time: fields.time || "", elevator,
      phone: fields.phone || "", email,
      items: fields.items || "",
      lineName: fields.lineName || "", lineUserId: fields.lineUserId || "",
      note: fields.note || "", lang,
    },
  };
}

/* 給客人的訊息文字（老闆整段複製貼上 LINE）。zh/en 按 v.lang。 */
function buildMovingCustomerMessage(v, url, expiresAt) {
  const yen = "¥" + Number(v.amount).toLocaleString("ja-JP");

  if ((v.lang || "zh") === "en") {
    const lines = [
      "🐻 KUMAGO Moving Service — Payment Link",
      "",
      `Amount: ${yen} (moving service)`,
      `Moving date: ${mdLabel(v.date)}`,
      `From: ${v.addressFrom}`,
      v.addressTo ? `To: ${v.addressTo}` : null,
      v.time ? `Time: ${v.time}` : null,
      v.items ? `Items: ${v.items}` : null,
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
    lines.push(url, "", "Once paid we'll be notified automatically, and we'll contact you before the moving day to confirm the schedule. 🙇");
    return lines.filter((l) => l !== null).join("\n");
  }

  const lines = [
    "🐻 KUMAGO 搬家服務 付款連結",
    "",
    `金額：${yen}（搬家服務費）`,
    `搬家日：${mdLabel(v.date)}`,
    `搬出地址：${v.addressFrom}`,
    v.addressTo ? `搬入地址：${v.addressTo}` : null,
    v.time ? `時間：${v.time}` : null,
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
  lines.push(url, "", "付款完成後系統會自動通知我們，我們將於搬家日前與您確認詳細時間🙇");
  return lines.filter((l) => l !== null).join("\n");
}

module.exports = {
  buildMovingMeta,
  movingItemName,
  createMovingLink,
  parseMovingLinkCommand,
  buildMovingCustomerMessage,
  CMD_TEMPLATE,
};
