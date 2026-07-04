/* KUMAGO — 期滿回收預約表單（客人自助）前端邏輯。
 * 驗證 → POST /api/create-recovery-booking → 成功切換到感謝畫面。
 * 版面/語言切換沿用 script.js；此檔只補「placeholder 中日切換」與表單流程。 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);

  /* 目前語言：讀 header 上 active 的 .lang-opt（script.js 維護）。 */
  function L() {
    const active = document.querySelector(".lang-opt.is-active");
    return active && active.dataset.lang === "ja" ? "ja" : "zh";
  }
  const T = (zh, ja) => (L() === "ja" ? ja : zh);

  /* placeholder 中日切換：script.js 只換 textContent，不管 placeholder，這裡補上。 */
  function applyPlaceholders() {
    const ja = L() === "ja";
    document.querySelectorAll("[data-ja-ph]").forEach((el) => {
      if (el.dataset.zhPhCache === undefined) el.dataset.zhPhCache = el.getAttribute("placeholder") || "";
      el.setAttribute("placeholder", ja ? el.dataset.jaPh : el.dataset.zhPhCache);
    });
  }
  document.querySelectorAll(".lang-opt").forEach((opt) =>
    // script.js 也綁了同一顆按鈕；兩個 handler 各做各的，互不干擾。
    opt.addEventListener("click", applyPlaceholders)
  );

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
    };
  }

  function validate(d) {
    const miss = [];
    if (!d.name) miss.push(T("姓名", "お名前"));
    if (!d.phone) miss.push(T("電話", "電話番号"));
    if (!d.date) miss.push(T("希望回收日期", "回収希望日"));
    if (!d.slot) miss.push(T("希望時段", "時間帯"));
    if (!d.address) miss.push(T("物品存放地址", "保管先住所"));
    return miss;
  }

  async function onSubmit() {
    const d = collect();
    const miss = validate(d);
    if (miss.length) {
      showError(T("還缺：", "未入力：") + miss.join("、"));
      return;
    }
    showError("");

    const btn = $("#submitBtn");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = T("送出中…", "送信中…");
    try {
      const res = await fetch("/api/create-recovery-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(d),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error((json && json.error) || "submit_failed");
      // 成功：收起表單，顯示感謝畫面。
      $("#recoveryForm").hidden = true;
      $("#recoveryDone").hidden = false;
      $("#recoveryDone").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      btn.disabled = false;
      btn.textContent = original;
      showError(
        T("送出失敗，請稍後再試，或直接在 LINE 對話中告訴我們您要預約回收。",
          "送信に失敗しました。時間をおいて再度お試しいただくか、LINEのトークから回収予約をお知らせください。")
      );
    }
  }

  function init() {
    const dateEl = $("#fDate");
    if (dateEl) dateEl.min = todayLocalISO();
    $("#submitBtn").addEventListener("click", onSubmit);
    applyPlaceholders();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
