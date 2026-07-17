/* KUMAGO — 續租自助端點（LIFF /renewal 頁專用）。
 *
 * GET  ?eid=<到期事件id>
 *   → { ok, name, planText, expiryDate, origMonths, options }
 *     options = [{months, amount}]（自動計價成功）或 null（人工報價模式）。
 *
 * POST { eid, months, lineUserId, lineDisplayName, lang }
 *   自動計價成功 → 建 Stripe Checkout Session（metadata kumago_renewal=1，
 *   付款後 stripe-webhook 全自動：順延到期、寄信、LINE/TG 通知）→ { ok, url }。
 *   算不出價 → 到期事件加註＋Telegram 通知老闆人工報價 → { ok, manual:true }。
 *
 * 安全：eid 本身是不可猜測的 capability token（Google Calendar 事件 id），
 * 端點只讀該事件＋建「未付款」session，無資料外洩面。到期事件已結案或
 * 不存在一律 404。
 */
"use strict";

const { getEvent, patchEvent, listEvents, jstToday } = require("../lib/gcal.js");
const { classify, planMonths, nameFrags, DONE_RE } = require("../lib/recovery.js");
const { parseLineFromDesc } = require("../lib/renewal_notice.js");
const {
  computeRenewalPrice, createRenewalCheckout, durationLabel,
} = require("../lib/stripe_renewal.js");
const { sendTelegram } = require("../lib/telegram.js");

const SITE_ORIGIN = "https://kumago.7-mori.com";
const OFFER_MONTHS = [6, 12, 24];

function addDaysISO(iso, n) {
  return new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}
function eventDate(e) {
  const s = e.start || {};
  return s.date || (s.dateTime || "").slice(0, 10) || null;
}
function intersects(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/* 到期事件 → 同一客人的配送事件（明細計價用）。找不到回 null。 */
async function findDeliveryFor(expiryEvent) {
  const today = jstToday();
  const timeMin = addDaysISO(today, -800) + "T00:00:00+09:00";
  const timeMax = addDaysISO(today, 30) + "T00:00:00+09:00";
  const events = await listEvents(timeMin, timeMax);
  const { deliveries } = classify(events);
  const names = nameFrags(expiryEvent.summary || "");
  if (!names.size) return null;
  const hits = deliveries.filter((d) => intersects(names, d.names));
  if (!hits.length) return null;
  // 多筆取最新（同客人補寄/換品以最後一筆為準）
  hits.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return hits[0];
}

/* 共用：載入到期事件＋基本資料；問題回 {error, status} */
async function loadExpiry(eid) {
  if (!eid || typeof eid !== "string" || eid.length > 200) {
    return { error: "bad_eid", status: 400 };
  }
  let ev;
  try { ev = await getEvent(eid); } catch (e) { return { error: "load_failed", status: 500 }; }
  if (!ev) return { error: "not_found", status: 404 };
  const title = ev.summary || "";
  if (!title.includes("到期")) return { error: "not_expiry_event", status: 404 };
  if (DONE_RE.test(title)) return { error: "already_closed", status: 409 };
  const expiryDate = eventDate(ev);
  if (!expiryDate) return { error: "no_date", status: 500 };
  return { ev, title, expiryDate };
}

function contactFromDesc(desc) {
  const d = String(desc || "");
  const email = (d.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0] || "";
  let phone = "";
  for (const line of d.split("\n")) {
    const m = line.match(/^\s*(?:聯絡|電話)[：:]\s*(.+)$/);
    if (m && !m[1].includes("@")) {
      const digits = m[1].trim().replace(/[\s\-()（）]/g, "");
      if (/^\+?\d{8,15}$/.test(digits)) { phone = m[1].trim(); break; }
    }
  }
  return { email, phone };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const loaded = await loadExpiry((req.query && req.query.eid) || "");
      if (loaded.error) return res.status(loaded.status).json({ ok: false, error: loaded.error });
      const { ev, title, expiryDate } = loaded;
      const origMonths = planMonths(title + "\n" + (ev.description || ""));
      const delivery = await findDeliveryFor(ev);
      let options = null;
      if (delivery) {
        const opts = OFFER_MONTHS.map((m) => {
          const p = computeRenewalPrice(delivery.desc, origMonths, m);
          return p ? { months: m, amount: p.amount } : null;
        }).filter(Boolean);
        if (opts.length === OFFER_MONTHS.length) options = opts;
      }
      const planText = title.replace(/【到期】/g, "").trim();
      return res.status(200).json({
        ok: true, planText, expiryDate, origMonths, options,
      });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const loaded = await loadExpiry(body.eid || "");
      if (loaded.error) return res.status(loaded.status).json({ ok: false, error: loaded.error });
      const { ev, title, expiryDate } = loaded;
      const months = parseInt(body.months, 10);
      if (!OFFER_MONTHS.includes(months)) {
        return res.status(400).json({ ok: false, error: "bad_months" });
      }
      const lang = ["zh", "ja", "en"].includes(body.lang) ? body.lang : "zh";
      const reqUserId = /^U[0-9a-f]{32}$/.test(String(body.lineUserId || "")) ? body.lineUserId : "";
      const reqDisplay = String(body.lineDisplayName || "").trim().slice(0, 60);

      const desc = ev.description || "";
      const paired = parseLineFromDesc(desc);
      const { email, phone } = contactFromDesc(desc);
      const planText = title.replace(/【到期】/g, "").trim();
      const name = planText.replace(/[（(][^）)]*[）)]/g, "").replace(/[ABCabc]\s*(方案|套組|套餐|set).*/g, "").trim();
      const origMonths = planMonths(title + "\n" + desc);
      const renewalStart = addDaysISO(expiryDate, 1);

      const delivery = await findDeliveryFor(ev);
      const price = delivery ? computeRenewalPrice(delivery.desc, origMonths, months) : null;

      // 身分不符提示（不擋單——可能家人代操作）
      const idMismatch = reqUserId && paired.userId && reqUserId !== paired.userId;

      if (!price) {
        // 人工報價：事件加註＋通知老闆
        const stamp = `\n\n📩 ${jstToday()} 客人自助申請續租 ${durationLabel(months)}（LIFF），待人工報價${reqDisplay ? `／LINE：${reqDisplay}` : ""}`;
        try { if (!desc.includes("待人工報價")) await patchEvent(ev.id, { description: desc + stamp }); } catch (e) {}
        await sendTelegram(
          `📩 續租申請（需人工報價）\n客人：${name}\n目前方案：${planText}\n到期：${expiryDate}\n想續：${durationLabel(months)}（${renewalStart} 起）\n` +
          (reqDisplay ? `LINE：${reqDisplay} ${reqUserId ? reqUserId.slice(0, 12) + "…" : ""}\n` : "") +
          `⚠️ 無法自動計價（原單無明細）。請用 tools/create_renewal_link.js 產連結。`
        );
        return res.status(200).json({ ok: true, manual: true });
      }

      const meta = {
        kumago_renewal: "1",
        plan: ((title.match(/([ABC])\s*(方案|套組|套餐|set)/i) || [])[1] || "").toUpperCase(),
        duration: durationLabel(months),
        renewal_months: String(months),
        renewal_start: renewalStart,
        new_expiry: "",
        expiry_event_id: ev.id,
        customer_name: name,
        customer_contact: email || phone || "",
        customer_phone: phone,
        line_display_name: reqDisplay || paired.display || "",
        line_user_id: reqUserId || paired.userId || "",
        postal: "",
        address: ((desc.match(/^地址[：:]\s*(.+)$/m) || [])[1] || "").slice(0, 200),
        items_note: ((desc.match(/^品項[：:]\s*(.+)$/m) || [])[1] || "").slice(0, 200),
        note: `LIFF 自助續租（${jstToday()}）`,
        lang,
      };

      const secret = process.env.STRIPE_SECRET_KEY;
      if (!secret) return res.status(500).json({ ok: false, error: "stripe_not_configured" });
      const session = await createRenewalCheckout(meta, price.amount, SITE_ORIGIN, secret);

      await sendTelegram(
        `🔁 續租自助下單（已給付款連結）\n客人：${name}\n目前方案：${planText}\n續租：${durationLabel(months)}（${renewalStart} 起）\n金額：¥${price.amount.toLocaleString("ja-JP")}（原價 ¥${price.baseAmount.toLocaleString("ja-JP")} × ${months}/${origMonths}）\n` +
        (idMismatch ? `⚠️ 操作者 LINE 與配對不符：${reqDisplay}\n` : "") +
        `付款後全自動（順延到期/寄信/LINE確認）。未付款則連結 24h 失效。`
      );
      return res.status(200).json({ ok: true, url: session.url, amount: price.amount });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  } catch (e) {
    console.error("renewal-session error:", e);
    return res.status(500).json({ ok: false, error: "internal" });
  }
};
