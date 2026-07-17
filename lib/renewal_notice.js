"use strict";
/*
 * 年租到期前 30 天自動通知（LINE FLEX：續租 or 預約回收）。
 *
 * 掛在每日 cron（api/cron-telegram-deliveries.js）尾端跑：
 *   1. 掃行事曆【到期】事件，到期日落在 today+27 ~ today+30（視窗留 4 天，
 *      單日 cron 失敗不會漏通知）。
 *   2. 已結案（標題含 回收完畢/已完成…）、已通知過（extendedProperties
 *      kumago_renewal_notice）跳過。
 *   3. description 有 LINE userId（配對格式：userId：Uxxx，語言：zh|ja|en）
 *      → push FLEX：按鈕「續租」開 LIFF /renewal?eid=事件id、「預約回收」開
 *      LIFF /recovery。沒有 userId → 只推 Telegram 請老闆手動聯絡。
 *   4. 推完 patch 事件標 kumago_renewal_notice=日期（冪等）。
 *
 * 純函式（buildNoticeTargets / buildRenewalNoticeFlex）與 IO（runRenewalNotices）
 * 分離，離線測試：tools/test_renewal_notice.js。
 */

const { DONE_RE } = require("./recovery.js");

const LIFF_ID = "2010643698-93v93r0n";
const NOTICE_MIN_DAYS = 27; // 視窗下限（含）
const NOTICE_MAX_DAYS = 30; // 視窗上限（含）
const NOTICE_PROP = "kumago_renewal_notice";

function eventDate(e) {
  const s = e.start || {};
  return s.date || (s.dateTime || "").slice(0, 10) || null;
}
function daysBetween(fromISO, toISO) {
  return Math.round(
    (Date.parse(toISO + "T00:00:00Z") - Date.parse(fromISO + "T00:00:00Z")) / 86400000
  );
}

/* description 的 LINE 配對區塊 → {userId, lang, display}（沒有 → userId:null） */
function parseLineFromDesc(desc) {
  const d = String(desc || "");
  const uid = d.match(/userId[：:]\s*(U[0-9a-f]{32})/i);
  const lang = d.match(/語言[：:]\s*(zh|ja|en)/i);
  const disp = d.match(/顯示名[：:]\s*(.+)/) || d.match(/LINE 名稱[：:]\s*(.+)/);
  return {
    userId: uid ? uid[1] : null,
    lang: lang ? lang[1].toLowerCase() : "zh",
    display: disp ? disp[1].trim() : null,
  };
}

/* 到期事件陣列 → 本次要通知的目標清單 */
function buildNoticeTargets(events, todayISO) {
  const out = [];
  for (const e of events) {
    const title = e.summary || "";
    if (!title.includes("到期")) continue;
    if (DONE_RE.test(title)) continue;
    const date = eventDate(e);
    if (!date) continue;
    const daysLeft = daysBetween(todayISO, date);
    if (daysLeft < NOTICE_MIN_DAYS || daysLeft > NOTICE_MAX_DAYS) continue;
    const props = (e.extendedProperties && e.extendedProperties.private) || {};
    if (props[NOTICE_PROP]) continue;
    const line = parseLineFromDesc(e.description);
    out.push({
      eventId: e.id,
      title,
      name: title.replace(/【到期】/g, "").replace(/[（(][^）)]*[）)]/g, "").trim(),
      planText: title.replace(/【到期】/g, "").trim(),
      expiryDate: date,
      daysLeft,
      userId: line.userId,
      lang: line.lang,
      display: line.display,
    });
  }
  return out;
}

const T = {
  zh: {
    alt: (d) => `🐻 KUMAGO：您的年租將於 ${d} 到期`,
    title: "年租到期通知",
    body: (t) =>
      `您好！您向 KUMAGO 租借的家具家電\n（${t.planText}）\n將於 ${t.expiryDate.replace(/-/g, "/")} 到期（剩約 ${t.daysLeft} 天）。\n\n請問您要續租，還是預約回收呢？`,
    renew: "我要續租（線上刷卡）",
    recycle: "預約到期回收",
    foot: "有任何問題也可以直接在此對話詢問 🙌",
  },
  ja: {
    alt: (d) => `🐻 KUMAGO：レンタル期限が ${d} に満了します`,
    title: "年間レンタル満了のお知らせ",
    body: (t) =>
      `いつもありがとうございます。\nご利用中のレンタル（${t.planText}）は ${t.expiryDate.replace(/-/g, "/")} に満了します（残り約 ${t.daysLeft} 日）。\n\n更新（継続）または回収予約をお選びください。`,
    renew: "継続する（オンライン決済）",
    recycle: "回収を予約する",
    foot: "ご不明な点はこのままご返信ください 🙌",
  },
  en: {
    alt: (d) => `🐻 KUMAGO: your rental expires on ${d}`,
    title: "Rental expiry notice",
    body: (t) =>
      `Hello! Your KUMAGO rental\n(${t.planText})\nexpires on ${t.expiryDate.replace(/-/g, "/")} (about ${t.daysLeft} days left).\n\nWould you like to renew, or book a pick-up?`,
    renew: "Renew (pay online)",
    recycle: "Book pick-up",
    foot: "Questions? Just reply in this chat 🙌",
  },
};

/* 通知 FLEX（bubble：說明＋兩顆 URI 按鈕） */
function buildRenewalNoticeFlex(t) {
  const s = T[t.lang] || T.zh;
  const renewUrl = `https://liff.line.me/${LIFF_ID}/renewal?eid=${encodeURIComponent(t.eventId)}`;
  const recycleUrl = `https://liff.line.me/${LIFF_ID}/recovery`;
  return {
    type: "flex",
    altText: s.alt(t.expiryDate.replace(/-/g, "/")),
    contents: {
      type: "bubble",
      body: {
        type: "box", layout: "vertical", spacing: "md",
        contents: [
          { type: "text", text: `🐻 ${s.title}`, weight: "bold", size: "lg", color: "#7A5230" },
          { type: "text", text: s.body(t), wrap: true, size: "sm" },
        ],
      },
      footer: {
        type: "box", layout: "vertical", spacing: "sm",
        contents: [
          { type: "button", style: "primary", color: "#C8A279", height: "sm",
            action: { type: "uri", label: s.renew, uri: renewUrl } },
          { type: "button", style: "secondary", height: "sm",
            action: { type: "uri", label: s.recycle, uri: recycleUrl } },
          { type: "text", text: s.foot, size: "xs", color: "#999999", wrap: true, align: "center" },
        ],
      },
    },
  };
}

/* 老闆 Telegram 報告 */
function buildNoticeOwnerReport(sent, manual, failed) {
  const lines = ["📢 年租 30 天到期通知"];
  if (sent.length) {
    lines.push("", `✅ 已 LINE 通知（${sent.length}）：`);
    for (const t of sent) lines.push(`・${t.name}（到期 ${t.expiryDate}）`);
  }
  if (manual.length) {
    lines.push("", `⚠️ 無 LINE 配對，請手動聯絡（${manual.length}）：`);
    for (const t of manual) lines.push(`・${t.name}（到期 ${t.expiryDate}）`);
  }
  if (failed.length) {
    lines.push("", `❌ 推播失敗（${failed.length}）：`);
    for (const t of failed) lines.push(`・${t.name}：${t.error}`);
  }
  return lines.join("\n");
}

/* 主流程。deps 注入方便測試：{listEvents, patchEvent, sendLinePush, sendTelegram, todayISO} */
async function runRenewalNotices(deps) {
  const { listEvents, patchEvent, sendLinePush, sendTelegram, todayISO } = deps;
  const timeMin = todayISO + "T00:00:00+09:00";
  const maxD = new Date(Date.parse(todayISO + "T00:00:00Z") + (NOTICE_MAX_DAYS + 2) * 86400000);
  const timeMax = maxD.toISOString().slice(0, 10) + "T00:00:00+09:00";
  const events = await listEvents(timeMin, timeMax);
  const targets = buildNoticeTargets(events, todayISO);

  const sent = [], manual = [], failed = [];
  for (const t of targets) {
    if (!t.userId) { manual.push(t); }
    else {
      try {
        const r = await sendLinePush(t.userId, [buildRenewalNoticeFlex(t)]);
        if (r && r.ok) sent.push(t);
        else { t.error = "skipped:" + (r && r.reason); failed.push(t); continue; }
      } catch (e) {
        t.error = e.message; failed.push(t); continue;
      }
    }
    try {
      await patchEvent(t.eventId, {
        extendedProperties: { private: { [NOTICE_PROP]: todayISO } },
      });
    } catch (e) {
      // 標記失敗 → 明天會重推一次；用 Telegram 報告讓老闆知道
      t.error = "mark_failed: " + e.message; failed.push(t);
    }
  }

  if (sent.length || manual.length || failed.length) {
    try { await sendTelegram(buildNoticeOwnerReport(sent, manual, failed)); } catch (e) { /* 報告失敗不擋 */ }
  }
  return { checked: targets.length, sent: sent.length, manual: manual.length, failed: failed.length };
}

module.exports = {
  buildNoticeTargets,
  buildRenewalNoticeFlex,
  buildNoticeOwnerReport,
  parseLineFromDesc,
  runRenewalNotices,
  NOTICE_PROP, NOTICE_MIN_DAYS, NOTICE_MAX_DAYS, LIFF_ID,
};
