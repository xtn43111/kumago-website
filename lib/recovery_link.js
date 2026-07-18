/* KUMAGO — 回收處理費付款連結：共用產生邏輯。
 *
 * 兩個入口共用這裡：
 *   • tools/create_recovery_link.js（老闆本機 CLI）
 *   • api/telegram-webhook.js 的「/回收連結」指令（Telegram 直接產）
 *
 * metadata 帶 kumago_recovery=1 → 付款後 api/stripe-webhook.js 走
 * lib/recovery_payment.js（建行事曆事件＋Telegram 通知；見該檔）。
 *
 * 模式：
 *   • 無期限 → Stripe Payment Link（付款前一直有效、付一次即失效）
 *   • 有期限（expiresAt epoch 秒）→ Checkout Session（Stripe 限 30 分～24 小時）
 */
"use strict";

const SITE_ORIGIN = "https://kumago.7-mori.com";

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/* v = {name, amount, date, address, items?, elevator?("yes"/"no"/""), phone?,
 *      lineUserId?, lineName?, note?, lang?} → Stripe metadata 物件。 */
function buildRecoveryMeta(v) {
  return {
    kumago_recovery: "1",
    customer_name: v.name,
    customer_phone: v.phone || "",
    recovery_date: v.date,
    address: v.address,
    items_note: v.items || "",
    elevator: v.elevator === "yes" || v.elevator === "no" ? v.elevator : "",
    line_display_name: String(v.lineName || "").trim().slice(0, 60),
    line_user_id: /^U[0-9a-f]{32}$/.test(String(v.lineUserId || "")) ? String(v.lineUserId) : "",
    note: v.note || "",
    lang: v.lang || "zh",
  };
}

function itemNameFor(v) {
  return (v.lang || "zh") === "ja"
    ? `【回収】期満回収 処理費（回収日 ${v.date}）`
    : `【回收】期滿回收處理費（回收日 ${v.date}）`;
}

/* 產連結。opts = {session?, expiresAt?}：expiresAt（epoch 秒）或 session=true
 * → Checkout Session（無 expiresAt 時 Stripe 預設 24 小時）；否則 Payment Link。
 * 回 {mode:"session"|"payment_link", url, id}；Stripe 錯誤 throw Error。 */
async function createRecoveryLink(v, secret, opts) {
  if (!secret) throw new Error("Stripe secret key 未設定");
  const { session: wantSession, expiresAt } = opts || {};
  const meta = buildRecoveryMeta(v);
  const itemName = itemNameFor(v);
  const amount = parseInt(v.amount, 10);
  if (!amount || amount <= 0) throw new Error("金額要是正整數（日圓）");
  if (!isRealDate(v.date)) throw new Error(`回收日不是有效日期：${v.date}`);

  const params = new URLSearchParams();
  const session = !!(wantSession || expiresAt);
  if (session) {
    params.append("mode", "payment");
    if (expiresAt) params.append("expires_at", String(expiresAt));
    params.append("success_url", `${SITE_ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}`);
    params.append("cancel_url", `${SITE_ORIGIN}/`);
    params.append("locale", meta.lang === "ja" ? "ja" : "zh-TW");
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

/* ── Telegram「/回收連結」指令解析 ─────────────────────────────────────── */

const CMD_TEMPLATE = [
  "🧾 產回收處理費刷卡連結：整段複製、改內容後送出",
  "",
  "/回收連結",
  "姓名：王小明",
  "金額：34000",
  "回收日：7/23",
  "地址：大阪府大阪市○○区○○町1-2-3 405",
  "品項：洗衣機、冰箱、床墊",
  "電梯：有",
  "期限：7/19 12:00",
  "",
  "（姓名/金額/回收日/地址必填，其餘選填。",
  "　期限＝付款截止（30分鐘～24小時內），留空＝連結不過期。",
  "　也可加：電話：… / 備註：…）",
].join("\n");

/* 「7/23」「2026-07-23」→ YYYY-MM-DD（JST 基準；M/D 取最近的未來一年內該日）。 */
function parseCmdDate(s, todayISO) {
  const t = String(s || "").trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    return isRealDate(iso) ? iso : null;
  }
  m = t.match(/^(\d{1,2})[\/月](\d{1,2})日?$/);
  if (!m) return null;
  const year = Number(todayISO.slice(0, 4));
  for (const y of [year, year + 1]) {
    const iso = `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    // 允許回收日往前 2 天（同 create-recovery-booking 的窗），過去太多就滾到明年。
    if (isRealDate(iso) && Date.parse(iso) >= Date.parse(todayISO) - 2 * 86400000) return iso;
  }
  return null;
}

/* 「7/19 12:00」「12:00」（＝今天）→ epoch 秒（JST）。格式錯回 null。 */
function parseCmdExpires(s, todayISO) {
  const t = String(s || "").trim();
  let m = t.match(/^(?:(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/月]\d{1,2}日?)\s+)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const date = m[1] ? parseCmdDate(m[1], todayISO) : todayISO;
  if (!date) return null;
  const hh = m[2].padStart(2, "0");
  if (Number(hh) > 23 || Number(m[3]) > 59) return null;
  const epoch = Date.parse(`${date}T${hh}:${m[3]}:00+09:00`);
  return isNaN(epoch) ? null : Math.floor(epoch / 1000);
}

/* 指令全文 → {ok:true, value, expiresAt} 或 {ok:false, error}。
 * now = Date.now()（測試可注入）；todayISO = JST 今天（YYYY-MM-DD）。 */
function parseRecoveryLinkCommand(text, todayISO, now) {
  const t = String(text || "").trim();
  if (!/^\/?回收連結/.test(t)) return null; // 不是這個指令
  const rest = t.replace(/^\/?回收連結\s*/, "");
  if (!rest.trim()) return { ok: false, error: "template" };

  const fields = {};
  const LABELS = {
    "姓名": "name", "金額": "amount", "回收日": "date", "日期": "date",
    "地址": "address", "品項": "items", "電梯": "elevator",
    "期限": "expires", "電話": "phone", "備註": "note",
  };
  for (const line of rest.split("\n")) {
    const m = line.match(/^\s*(姓名|金額|回收日|日期|地址|品項|電梯|期限|電話|備註)\s*[:：]\s*(.*)$/);
    if (m) fields[LABELS[m[1]]] = m[2].trim();
  }

  const missing = [];
  if (!fields.name) missing.push("姓名");
  if (!fields.amount) missing.push("金額");
  if (!fields.date) missing.push("回收日");
  if (!fields.address) missing.push("地址");
  if (missing.length) return { ok: false, error: `缺欄位：${missing.join("、")}` };

  const amount = parseInt(String(fields.amount).replace(/[,，¥\s]/g, ""), 10);
  if (!amount || amount <= 0) return { ok: false, error: `金額看不懂：「${fields.amount}」（要日圓整數）` };

  const date = parseCmdDate(fields.date, todayISO);
  if (!date) return { ok: false, error: `回收日看不懂：「${fields.date}」（用 7/23 或 2026-07-23）` };

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

  return {
    ok: true,
    expiresAt,
    value: {
      name: fields.name, amount, date, address: fields.address,
      items: fields.items || "", elevator, phone: fields.phone || "",
      note: fields.note || "", lang: "zh",
    },
  };
}

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
function mdLabel(iso) {
  // 民用日的星期跟時區無關：直接用 UTC 午夜算。
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}（${WEEKDAY[dow]}）`;
}

/* 給客人的 LINE 訊息文字（老闆整段複製貼上）。 */
function buildCustomerMessage(v, url, expiresAt) {
  const yen = "¥" + Number(v.amount).toLocaleString("ja-JP");
  const lines = [
    "🐻 KUMAGO 期滿回收 付款連結",
    "",
    `金額：${yen}（回收處理費）`,
    `回收日：${mdLabel(v.date)}`,
    `收取地址：${v.address}`,
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
  lines.push(url, "", "付款完成後系統會自動通知我們，回收當天若時間有異動會再與您聯繫🙇");
  return lines.filter((l) => l !== null).join("\n");
}

module.exports = {
  buildRecoveryMeta,
  itemNameFor,
  createRecoveryLink,
  parseRecoveryLinkCommand,
  parseCmdDate,
  parseCmdExpires,
  buildCustomerMessage,
  mdLabel,
  CMD_TEMPLATE,
  isRealDate,
};
