/* KUMAGO — order email builder + sender (Gmail SMTP via nodemailer).
 *
 * Sends two emails when an order is paid:
 *   1. Owner notification  → OWNER_EMAIL (the shop)
 *   2. Customer confirmation → the buyer's email (if they gave one)
 *
 * Credentials come from env vars (never committed):
 *   SMTP_USER, SMTP_APP_PASSWORD (Gmail 16-char app password),
 *   MAIL_FROM_NAME, OWNER_EMAIL.
 * If SMTP is not configured the senders no-op safely (return false) so a missing
 * config never breaks the paid order — the money is already captured by Stripe.
 */

const nodemailer = require("nodemailer");

const BRAND = {
  green: "#8CC63F",
  greenDeep: "#76b02f",
  charcoal: "#3B3B3B",
  cream: "#EFE3D2",
  offwhite: "#FAF6EF",
  brown: "#A9794F",
};

// LINE official account for customer follow-up (mirror order.js LINE_OA_BASIC_ID).
const LINE_OA_BASIC_ID = "@kumago";
const LINE_URL = "https://line.me/R/ti/p/" + encodeURIComponent(LINE_OA_BASIC_ID);

const PLAN_NAME = { A: "A 套組", B: "B 套組", C: "C 套組" };

const ADDON_NAME = {
  floor_mat: "地板保護墊", kettle: "熱水壺", ceiling_light: "可調光吸頂燈",
  curtain: "4 片窗簾組", vacuum: "吸塵器", fan: "電風扇",
  clothes_rack: "室內掛衣架", desk: "桌椅組", low_table: "和式桌（75×50×31.5cm）",
  rice_cooker: "電飯鍋", pot: "鍋具組", clothesline: "曬衣桿",
};

// meta.area now carries the postal-derived city/region string directly; this map
// only covers any legacy key still in old sessions. Unknown keys display as-is.
const AREA_NAME = { osaka: "大阪市內", nara: "奈良", kyoto: "京都", hyogo: "兵庫（神戶）" };

const TIME_LABEL = {
  "09-1130": "09:00–11:30", "1230-16": "12:30–16:00",
  // legacy keys (older sessions)
  "10-12": "10:00–12:00", "12-14": "12:00–14:00",
  "14-16": "14:00–16:00", "any": "時間不限",
};

function yen(n) {
  return "¥" + Number(n || 0).toLocaleString("ja-JP");
}

// Escape customer-controlled values before putting them in email HTML (name,
// address, note, contact, map URL all come straight from the buyer). Mail
// clients sandbox scripts, but unescaped `<`/`"` still break layout and enable
// lookalike-link injection into the owner's own inbox.
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function durationLabel(d) {
  if (d === "半年") return "半年";
  if (d === "1年") return "1 年";
  if (d === "2年") return "2 年";
  return String(d || "").replace("個月", " 個月");
}

function isConfigured() {
  return !!(process.env.SMTP_USER && process.env.SMTP_APP_PASSWORD);
}

/* ---- normalise the data both emails share ---- */
function orderView(meta, lineItems, amountTotal) {
  meta = meta || {};
  const items = (Array.isArray(lineItems) ? lineItems : []).map((li) => ({
    label: li.description || (li.price && li.price.product) || "—",
    amount: li.amount_total != null ? li.amount_total : (li.amount || 0),
    qty: li.quantity || 1,
  }));
  const total =
    amountTotal != null ? amountTotal : items.reduce((s, i) => s + i.amount, 0);

  const addonKeys = (meta.addons || "").split(",").map((s) => s.trim())
    .filter((k) => k && k !== "(none)");
  const addonNames = addonKeys.map((k) => ADDON_NAME[k] || k);

  return {
    name: meta.customer_name || "",
    contact: meta.customer_contact || "",
    lineName: meta.line_display_name || "",
    lineUserId: meta.line_user_id || "",
    planName: PLAN_NAME[meta.plan] || meta.plan || "",
    duration: durationLabel(meta.duration),
    addonNames,
    areaName: AREA_NAME[meta.area] || meta.area || "",
    moveInDate: meta.move_in_date || "",
    deliveryTime: TIME_LABEL[meta.delivery_time] || meta.delivery_time || "",
    postal: meta.postal || "",
    address: meta.address || "",
    building: meta.building || "",
    mapUrl: meta.map_url || "",
    elevator: meta.elevator || "",
    note: meta.note || "",
    items,
    total,
  };
}

/* =========================== CUSTOMER EMAIL =========================== */
function row(label, value, opts) {
  opts = opts || {};
  const color = opts.color || BRAND.charcoal;
  const weight = opts.bold ? "bold" : "normal";
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
    `<tr><td style="font-size:14px;color:#8a8170;padding:5px 0;vertical-align:top;">${label}</td>` +
    `<td align="right" style="font-size:15px;color:${color};font-weight:${weight};padding:5px 0;">${value}</td>` +
    "</tr></table>"
  );
}

function buildCustomerEmail(v) {
  const itemRows = v.items
    .map((i) => row(esc(i.label), yen(i.amount)))
    .join("");
  const addonLine = v.addonNames.length ? v.addonNames.join("、") : "—";
  const fullAddr = `〒${v.postal} ${v.address}${v.building ? " " + v.building : ""}`.trim();

  const html = `<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:${BRAND.offwhite};font-family:-apple-system,'PingFang TC','Microsoft JhengHei',sans-serif;color:${BRAND.charcoal};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.offwhite};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.08);">

        <tr><td style="background:linear-gradient(135deg,${BRAND.green} 0%,${BRAND.greenDeep} 100%);padding:34px 28px;text-align:center;">
          <div style="font-size:26px;font-weight:bold;color:#ffffff;letter-spacing:1px;">KUMAGO 🐻🏠</div>
          <div style="color:#eaf7d8;font-size:14px;margin-top:6px;">家具家電租賃 ・ 訂單確認</div>
        </td></tr>

        <tr><td style="padding:30px 28px 6px;text-align:center;">
          <div style="font-size:50px;line-height:1;">✨</div>
          <h1 style="font-size:24px;margin:12px 0 4px;color:${BRAND.greenDeep};">訂購完成！</h1>
          <p style="font-size:15px;color:#666;margin:0;">${esc(v.name)} 您好，感謝您選擇 KUMAGO，我們會盡快為您安排配送 🌿</p>
        </td></tr>

        <tr><td style="padding:18px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.offwhite};border:1px solid ${BRAND.cream};border-radius:16px;">
            <tr><td style="padding:22px 24px;">
              <div style="font-size:13px;color:#a99;letter-spacing:2px;margin-bottom:10px;">YOUR ORDER</div>
              ${itemRows}
              <div style="border-top:1px dashed #d8cfbe;margin:14px 0;"></div>
              ${row("合計（已付款）", yen(v.total), { color: BRAND.greenDeep, bold: true })}
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:6px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f8e6;border-radius:14px;">
            <tr><td style="padding:18px 22px;font-size:14px;line-height:1.9;color:${BRAND.charcoal};">
              📦 <b>配送資訊</b><br>
              配送地區：${esc(v.areaName)}<br>
              配送日：${esc(v.moveInDate)}　${esc(v.deliveryTime)}<br>
              地址：${esc(fullAddr)}<br>
              電梯：${esc(v.elevator)}　加購：${esc(addonLine)}${v.note ? `<br>備註：${esc(v.note)}` : ""}
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:18px 28px 6px;">
          <div style="font-size:16px;font-weight:bold;color:${BRAND.greenDeep};margin-bottom:8px;">【接下來】</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.7;color:#333;">
            <tr><td style="padding:5px 0;vertical-align:top;width:24px;"><b>1.</b></td>
                <td style="padding:5px 0;">我們會在配送日前與您確認到貨時間與細節。</td></tr>
            <tr><td style="padding:5px 0;vertical-align:top;"><b>2.</b></td>
                <td style="padding:5px 0;">大阪市內配送、安裝、期滿回收皆免費。</td></tr>
            <tr><td style="padding:5px 0;vertical-align:top;"><b>3.</b></td>
                <td style="padding:5px 0;">有任何問題，歡迎透過官方 LINE 與我們聯絡：<br>
                  <a href="${LINE_URL}" style="display:inline-block;margin-top:8px;padding:11px 20px;background:#06c755;color:#fff;text-decoration:none;border-radius:999px;font-weight:bold;">💬 加入官方 LINE</a>
                </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:22px 28px 30px;text-align:center;">
          <div style="font-size:16px;color:#444;">守護每一個溫暖的家 🐻</div>
          <div style="font-size:12px;color:#aaa;margin-top:14px;">此信為系統自動寄送　・　KUMAGO 家具家電租賃</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
    `KUMAGO 訂購完成！\n\n${v.name} 您好，感謝您的訂購。\n\n` +
    v.items.map((i) => `${i.label}　${yen(i.amount)}`).join("\n") +
    `\n合計（已付款）：${yen(v.total)}\n\n` +
    `配送地區：${v.areaName}\n配送日：${v.moveInDate} ${v.deliveryTime}\n` +
    `地址：${fullAddr}\n電梯：${v.elevator}\n加購：${addonLine}\n` +
    (v.note ? `備註：${v.note}\n` : "") +
    `\n官方 LINE：${LINE_URL}\n\nKUMAGO 家具家電租賃`;

  const subject = `【KUMAGO】訂購確認 — ${v.planName} ${v.duration}`;
  return { subject, html, text };
}

/* ============================ OWNER EMAIL ============================ */
function buildOwnerEmail(v) {
  const addonLine = v.addonNames.length ? v.addonNames.join("、") : "（無）";
  const itemsText = v.items.map((i) => `  ・${i.label}　${yen(i.amount)}`).join("\n");
  const fullAddr = `〒${v.postal} ${v.address}${v.building ? " " + v.building : ""}`.trim();

  const text =
    `🔔 KUMAGO 新訂單成交！\n\n` +
    `方案：${v.planName} × ${v.duration}\n` +
    `加購：${addonLine}\n` +
    `明細：\n${itemsText}\n` +
    `合計（已付款）：${yen(v.total)}\n\n` +
    `── 配送 ──\n` +
    `地區：${v.areaName}\n` +
    `配送日：${v.moveInDate}　${v.deliveryTime}\n` +
    `地址：${fullAddr}\n` +
    `電梯：${v.elevator}\n` +
    (v.mapUrl ? `地圖：${v.mapUrl}\n` : "") +
    `\n── 客人 ──\n` +
    `姓名：${v.name}\n` +
    `聯絡：${v.contact}\n` +
    (v.note ? `\n── 備註 ──\n${v.note}\n` : "");

  const html =
    `<h2 style="color:${BRAND.greenDeep};font-family:sans-serif;">🔔 KUMAGO 新訂單成交</h2>` +
    `<pre style="font-size:14px;line-height:1.75;font-family:-apple-system,'PingFang TC',monospace;background:${BRAND.offwhite};padding:16px 18px;border-radius:12px;border:1px solid ${BRAND.cream};white-space:pre-wrap;">${esc(text)}</pre>` +
    (v.mapUrl ? `<p><a href="${esc(v.mapUrl)}" style="color:${BRAND.greenDeep};">📍 在 Google 地圖開啟配送位置</a></p>` : "");

  const subject = `🔔 新訂單 — ${v.planName} ${v.duration}（${v.name}）${yen(v.total)}`;
  return { subject, html, text };
}

/* =========================== RENEWAL EMAILS =========================== */
/* v = lib/renewal.js renewalView()：name/contact/planName/duration/
 * renewalStart/newExpiry/itemsNote/items/total/note。續租沒有配送段，
 * 改列「續約租期」；品項是既有家具家電續用，不重列配送明細。 */

function buildRenewalCustomerEmail(v) {
  const itemRows = v.items.map((i) => row(esc(i.label), yen(i.amount))).join("");
  const period = `${esc(v.renewalStart)} ～ ${esc(v.newExpiry)}`;

  const html = `<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:${BRAND.offwhite};font-family:-apple-system,'PingFang TC','Microsoft JhengHei',sans-serif;color:${BRAND.charcoal};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.offwhite};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.08);">

        <tr><td style="background:linear-gradient(135deg,${BRAND.green} 0%,${BRAND.greenDeep} 100%);padding:34px 28px;text-align:center;">
          <div style="font-size:26px;font-weight:bold;color:#ffffff;letter-spacing:1px;">KUMAGO 🐻🏠</div>
          <div style="color:#eaf7d8;font-size:14px;margin-top:6px;">家具家電租賃 ・ 續租確認</div>
        </td></tr>

        <tr><td style="padding:30px 28px 6px;text-align:center;">
          <div style="font-size:50px;line-height:1;">🔁</div>
          <h1 style="font-size:24px;margin:12px 0 4px;color:${BRAND.greenDeep};">續租完成！</h1>
          <p style="font-size:15px;color:#666;margin:0;">${esc(v.name)} 您好，感謝您繼續選擇 KUMAGO，現有家具家電請安心續用 🌿</p>
        </td></tr>

        <tr><td style="padding:18px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.offwhite};border:1px solid ${BRAND.cream};border-radius:16px;">
            <tr><td style="padding:22px 24px;">
              <div style="font-size:13px;color:#a99;letter-spacing:2px;margin-bottom:10px;">YOUR RENEWAL</div>
              ${itemRows}
              <div style="border-top:1px dashed #d8cfbe;margin:14px 0;"></div>
              ${row("合計（已付款）", yen(v.total), { color: BRAND.greenDeep, bold: true })}
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:6px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f8e6;border-radius:14px;">
            <tr><td style="padding:18px 22px;font-size:14px;line-height:1.9;color:${BRAND.charcoal};">
              🗓 <b>續約租期</b><br>
              租期：${period}（${esc(v.duration)}）<br>
              ${v.itemsNote ? `品項：${esc(v.itemsNote)}（現有品項續用）<br>` : ""}到期日前我們會再與您聯絡，確認回收或再續租。
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:18px 28px 6px;text-align:center;">
          <a href="${LINE_URL}" style="display:inline-block;padding:11px 20px;background:#06c755;color:#fff;text-decoration:none;border-radius:999px;font-weight:bold;">💬 有問題？官方 LINE 找我們</a>
        </td></tr>

        <tr><td style="padding:22px 28px 30px;text-align:center;">
          <div style="font-size:16px;color:#444;">守護每一個溫暖的家 🐻</div>
          <div style="font-size:12px;color:#aaa;margin-top:14px;">此信為系統自動寄送　・　KUMAGO 家具家電租賃</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
    `KUMAGO 續租完成！\n\n${v.name} 您好，感謝您繼續選擇 KUMAGO。\n\n` +
    v.items.map((i) => `${i.label}　${yen(i.amount)}`).join("\n") +
    `\n合計（已付款）：${yen(v.total)}\n\n` +
    `續約租期：${v.renewalStart} ～ ${v.newExpiry}（${v.duration}）\n` +
    (v.itemsNote ? `品項：${v.itemsNote}（現有品項續用）\n` : "") +
    `到期日前我們會再與您聯絡，確認回收或再續租。\n` +
    `\n官方 LINE：${LINE_URL}\n\nKUMAGO 家具家電租賃`;

  const subject = `【KUMAGO】續租確認 — ${v.planName} ${v.duration}`;
  return { subject, html, text };
}

function buildRenewalOwnerEmail(v) {
  const fullAddr = `${v.postal ? "〒" + v.postal + " " : ""}${v.address}`.trim();
  const text =
    `🔁 KUMAGO 續租成交！\n\n` +
    `方案：${v.planName} × ${v.duration}（續租）\n` +
    (v.itemsNote ? `品項：${v.itemsNote}\n` : "") +
    `合計（已付款）：${yen(v.total)}\n` +
    `新租期：${v.renewalStart} ～ ${v.newExpiry}\n\n` +
    `── 客人 ──\n` +
    `姓名：${v.name}\n` +
    `聯絡：${v.contact}\n` +
    (v.phone && v.phone !== v.contact ? `電話：${v.phone}\n` : "") +
    (fullAddr ? `地址：${fullAddr}\n` : "") +
    (v.note ? `\n── 備註 ──\n${v.note}\n` : "") +
    `\n（行事曆【到期】事件已自動順延至 ${v.newExpiry}）`;

  const html =
    `<h2 style="color:${BRAND.greenDeep};font-family:sans-serif;">🔁 KUMAGO 續租成交</h2>` +
    `<pre style="font-size:14px;line-height:1.75;font-family:-apple-system,'PingFang TC',monospace;background:${BRAND.offwhite};padding:16px 18px;border-radius:12px;border:1px solid ${BRAND.cream};white-space:pre-wrap;">${esc(text)}</pre>`;

  const subject = `🔁 續租 — ${v.planName} ${v.duration}（${v.name}）${yen(v.total)}`;
  return { subject, html, text };
}

/* 續租版寄信：老闆一封、客人（contact 是 email 才寄）一封。
 * 同 sendOrderEmails 的韌性契約：永不 throw，回報告。 */
async function sendRenewalEmails(v) {
  const report = { owner: false, customer: false, skipped: false, errors: [] };
  if (!isConfigured()) {
    report.skipped = true;
    return report;
  }
  const owner = (process.env.OWNER_EMAIL || "").trim();
  if (owner) {
    try { await send(owner, buildRenewalOwnerEmail(v)); report.owner = true; }
    catch (e) { report.errors.push("owner: " + e.message); }
  }
  const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.contact);
  if (isEmail) {
    try { await send(v.contact, buildRenewalCustomerEmail(v)); report.customer = true; }
    catch (e) { report.errors.push("customer: " + e.message); }
  }
  return report;
}

/* ============================== SEND ============================== */
function transport() {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_APP_PASSWORD },
  });
}

async function send(to, mail) {
  const from = {
    name: process.env.MAIL_FROM_NAME || "KUMAGO",
    address: process.env.SMTP_USER,
  };
  await transport().sendMail({
    from, to, subject: mail.subject, text: mail.text, html: mail.html,
  });
}

/* Send owner + customer emails for a paid order. Never throws — returns a
 * {owner, customer} report of what was sent so the webhook stays resilient. */
async function sendOrderEmails(meta, lineItems, amountTotal) {
  const report = { owner: false, customer: false, skipped: false, errors: [] };
  if (!isConfigured()) {
    report.skipped = true;
    return report;
  }
  const v = orderView(meta, lineItems, amountTotal);

  const owner = (process.env.OWNER_EMAIL || "").trim();
  if (owner) {
    try { await send(owner, buildOwnerEmail(v)); report.owner = true; }
    catch (e) { report.errors.push("owner: " + e.message); }
  }

  const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.contact);
  if (isEmail) {
    try { await send(v.contact, buildCustomerEmail(v)); report.customer = true; }
    catch (e) { report.errors.push("customer: " + e.message); }
  }
  return report;
}

module.exports = {
  isConfigured, orderView, buildOwnerEmail, buildCustomerEmail, sendOrderEmails,
  buildRenewalCustomerEmail, buildRenewalOwnerEmail, sendRenewalEmails,
};
