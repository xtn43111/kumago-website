/* KUMAGO — 期滿回收預約表單（客人自助）前端邏輯。
 * 驗證 → POST /api/create-recovery-booking → 成功切換到感謝畫面。
 * 版面/語言切換沿用 script.js；此檔只補「placeholder 中日切換」與表單流程。 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);

  /* ---- LIFF：LINE 內開啟時自動取得客人身分 ----
   * LIFF_ID 由 LINE Developers console（LINE Login channel > LIFF）取得；
   * 留空 = 停用，頁面退回一般瀏覽器模式（成功頁請客人手動把預約內容傳到 LINE）。 */
  const LIFF_ID = ""; // TODO: 建好 LIFF app 後填入（形如 "2001234567-AbcdEfgh"）
  const OA_MSG_URL = "https://line.me/R/oaMessage/@967bmevi/?";
  let lineProfile = null; // { userId, displayName }；取不到維持 null

  async function initLiff() {
    if (!LIFF_ID || !window.liff) return;
    try {
      await liff.init({ liffId: LIFF_ID });
      if (liff.isLoggedIn()) {
        const p = await liff.getProfile();
        lineProfile = { userId: p.userId, displayName: p.displayName };
      }
    } catch (e) {
      // LIFF 掛掉不影響表單本體（localhost、外部瀏覽器都會走到這）。
      console.warn("liff init failed:", e);
    }
  }

  /* 目前語言：讀 header 上 active 的 .lang-opt（script.js 維護）。 */
  function L() {
    const active = document.querySelector(".lang-opt.is-active");
    const lang = active && active.dataset.lang;
    if (lang === "ja") return "ja";
    if (lang === "en") return "en";
    return "zh";
  }
  // Third arg (en) is optional — omit it to safely fall back to the zh string
  // (never renders undefined/blank for strings we haven't translated yet).
  const T = (zh, ja, en) => {
    const lang = L();
    if (lang === "ja") return ja;
    if (lang === "en") return en !== undefined ? en : zh;
    return zh;
  };

  // 語言切換（含 placeholder）統一由 script.js 的 in-place 模式處理
  // （<html data-i18n="inplace">）。此檔只保留 L()/T() 供動態字串取用。

  /* 回收日期不能選過去（以瀏覽器本地日期為準即可，實際時間人工再確認）。 */
  function todayLocalISO() {
    const now = new Date();
    const off = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - off).toISOString().slice(0, 10);
  }

  function showError(msg) {
    const box = $("#formError");
    box.textContent = msg;
    box.hidden = !msg;
    if (msg) box.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function collect() {
    return {
      name: $("#fName").value.trim(),
      phone: $("#fPhone").value.trim(),
      address: $("#fAddress").value.trim(),
      date: $("#fDate").value.trim(),
      slot: $("#fSlot").value,
      note: $("#fNote").value.trim(),
      lang: L(),
      lineUserId: lineProfile ? lineProfile.userId : "",
      lineDisplayName: lineProfile ? lineProfile.displayName : "",
    };
  }

  /* 時段 key → 各語顯示標籤（組 LINE 訊息用；與 recovery.html option 文字一致）。 */
  const SLOT_TEXT = {
    "09-1130": { zh: "上午 09:00–11:30", ja: "午前 09:00〜11:30", en: "Morning 09:00–11:30" },
    "1230-16": { zh: "下午 12:30–16:00", ja: "午後 12:30〜16:00", en: "Afternoon 12:30–16:00" },
    any: { zh: "整天皆可", ja: "終日OK", en: "Any time" },
  };

  /* 預約內容 → 一段可貼進 LINE 的文字（自動代發與手動預填共用）。 */
  function bookingMessage(d) {
    const slot = (SLOT_TEXT[d.slot] || {})[L()] || d.slot;
    return [
      T("【期滿回收預約】", "【満了回収予約】", "[End-of-Rental Pickup Booking]"),
      T("姓名：", "お名前：", "Name: ") + d.name,
      T("電話：", "電話番号：", "Phone: ") + d.phone,
      T("希望回收：", "回収希望：", "Preferred: ") + d.date + "　" + slot,
      T("存放地址：", "保管先住所：", "Address: ") + d.address,
      d.note ? T("備註：", "備考：", "Note: ") + d.note : null,
      T("（物品現況照片接著傳送）", "（現況写真はこのあと送ります）", "(Photos of current condition to follow)"),
    ].filter(Boolean).join("\n");
  }

  /* 預約內容進 LINE：LIFF 內以客人身分自動代發（聊天串因此必定建立、後台一定
   * 找得到人）；非 LINE 內或代發失敗 → 成功頁改成「必須手動傳送」模式。 */
  async function sendToLine(d) {
    const msg = bookingMessage(d);
    let autoSent = false;
    if (lineProfile && window.liff && liff.isInClient()) {
      try {
        await liff.sendMessages([{ type: "text", text: msg }]);
        autoSent = true;
      } catch (e) {
        console.warn("liff sendMessages failed:", e);
      }
    }
    const status = $("#doneLineStatus");
    const btn = $("#doneLineBtn");
    if (autoSent) {
      if (status) {
        status.hidden = false;
        status.textContent = T(
          "✅ 預約內容已自動傳送到 LINE 聊天室，接著請傳物品現況照片。",
          "✅ 予約内容はLINEトークに自動送信されました。続けて現況写真をお送りください。",
          "✅ Your booking details were sent to the LINE chat automatically. Please follow up with photos."
        );
      }
      return; // 按鈕維持預設「傳現況照片」
    }
    if (status) {
      status.hidden = false;
      status.classList.add("is-warn");
      status.textContent = T(
        "⚠️ 請務必點下方按鈕，把預約內容傳送到 LINE——我們收到訊息才算完成預約。",
        "⚠️ 必ず下のボタンから予約内容をLINEでお送りください。メッセージ受信をもって予約完了となります。",
        "⚠️ Please tap the button below to send your booking details on LINE — the booking is only complete once we receive your message."
      );
    }
    if (btn) {
      btn.href = OA_MSG_URL + encodeURIComponent(msg);
      const span = btn.querySelector("span");
      if (span) {
        span.textContent = T(
          "傳送預約內容到 LINE（必須）",
          "予約内容をLINEで送信（必須）",
          "Send Booking Details on LINE (Required)"
        );
      }
    }
  }

  function validate(d) {
    const miss = [];
    if (!d.name) miss.push(T("姓名", "お名前", "Name"));
    if (!d.phone) miss.push(T("電話", "電話番号", "Phone"));
    if (!d.date) miss.push(T("希望回收日期", "回収希望日", "Preferred pickup date"));
    if (!d.slot) miss.push(T("希望時段", "時間帯", "Preferred time slot"));
    if (!d.address) miss.push(T("物品存放地址", "保管先住所", "Storage address"));
    return miss;
  }

  async function onSubmit() {
    const d = collect();
    const miss = validate(d);
    if (miss.length) {
      showError(T("還缺：", "未入力：", "Missing: ") + miss.join("、"));
      return;
    }
    showError("");

    const btn = $("#submitBtn");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = T("送出中…", "送信中…", "Submitting…");
    try {
      const res = await fetch("/api/create-recovery-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(d),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error((json && json.error) || "submit_failed");
      // 成功：預約內容送進 LINE（自動或改手動模式），再切感謝畫面。
      await sendToLine(d);
      $("#recoveryForm").hidden = true;
      $("#recoveryDone").hidden = false;
      $("#recoveryDone").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      btn.disabled = false;
      btn.textContent = original;
      showError(
        T("送出失敗，請稍後再試，或直接在 LINE 對話中告訴我們您要預約回收。",
          "送信に失敗しました。時間をおいて再度お試しいただくか、LINEのトークから回収予約をお知らせください。",
          "Submission failed. Please try again later, or let us know directly via LINE chat that you'd like to book a pickup.")
      );
    }
  }

  function init() {
    initLiff(); // 非同步暖身；送出前有拿到 profile 就帶上，沒有也不擋
    const dateEl = $("#fDate");
    if (dateEl) dateEl.min = todayLocalISO();
    // submit 事件統一接手：按鈕（type=submit）點擊與文字欄按 Enter 都走這裡。
    $("#recoveryForm").addEventListener("submit", (e) => {
      e.preventDefault();
      onSubmit();
    });
    // 初始載入即為中文預設，placeholder 無需套用；語言切換由 script.js 統一處理。
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
