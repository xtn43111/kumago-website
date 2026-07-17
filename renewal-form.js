/* KUMAGO — 續租申請頁（LIFF）前端邏輯。
 * URL 帶 ?eid=<到期事件id>（30 天通知 FLEX 的「我要續租」按鈕產生）。
 * GET /api/renewal-session?eid= → 顯示租約與期間選項（有價=直接刷卡；
 * 無價=人工報價模式）。POST → 有 url 就跳 Stripe，manual 就顯示已收到。 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const LIFF_ID = "2010643698-93v93r0n";
  let lineProfile = null;
  let info = null;
  let chosen = null;

  function L() {
    const active = document.querySelector(".lang-opt.is-active");
    const lang = active && active.dataset.lang;
    return lang === "ja" ? "ja" : lang === "en" ? "en" : "zh";
  }
  const T = (zh, ja, en) => {
    const lang = L();
    if (lang === "ja") return ja;
    if (lang === "en") return en !== undefined ? en : zh;
    return zh;
  };

  async function initLiff() {
    if (!LIFF_ID || !window.liff) return;
    try {
      await liff.init({ liffId: LIFF_ID });
      if (liff.isLoggedIn()) {
        const p = await liff.getProfile();
        lineProfile = { userId: p.userId, displayName: p.displayName };
      }
    } catch (e) {
      console.warn("liff init failed:", e);
    }
  }

  function eid() {
    return new URLSearchParams(location.search).get("eid") || "";
  }

  const yen = (n) => "¥" + Number(n || 0).toLocaleString("ja-JP");

  function monthsLabel(m) {
    if (m === 6) return T("半年", "半年", "6 months");
    if (m % 12 === 0) {
      const y = m / 12;
      return T(`${y} 年`, `${y}年`, y === 1 ? "1 year" : `${y} years`);
    }
    return T(`${m} 個月`, `${m}ヶ月`, `${m} months`);
  }

  function renderOptions() {
    const box = $("#renewOptions");
    box.innerHTML = "";
    const opts = info.options || [6, 12, 24].map((m) => ({ months: m, amount: null }));
    if (!info.options) $("#quoteHint").hidden = false;
    for (const o of opts) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "renew-opt";
      btn.innerHTML =
        `<span class="ro-label">${monthsLabel(o.months)}</span>` +
        `<span class="ro-price">${o.amount ? yen(o.amount) : T("價格另行報價", "料金は別途ご案内", "Price quoted via LINE")}</span>`;
      btn.addEventListener("click", () => {
        chosen = o;
        for (const b of box.children) b.classList.remove("is-active");
        btn.classList.add("is-active");
        const sb = $("#submitBtn");
        sb.disabled = false;
        sb.textContent = o.amount
          ? T(`前往線上刷卡（${yen(o.amount)}）`, `オンライン決済へ（${yen(o.amount)}）`, `Continue to Payment (${yen(o.amount)})`)
          : T("送出續租申請", "継続希望を送信", "Submit Renewal Request");
      });
      box.appendChild(btn);
    }
  }

  async function load() {
    const id = eid();
    if (!id) return showFatal();
    try {
      const res = await fetch("/api/renewal-session?eid=" + encodeURIComponent(id));
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "load_failed");
      info = json;
      $("#planLine").textContent = json.planText;
      $("#expiryLine").textContent =
        T("目前租期到期日：", "現在の満了日：", "Current expiry date: ") + json.expiryDate.replace(/-/g, "/");
      renderOptions();
      $("#renewLoading").hidden = true;
      $("#renewForm").hidden = false;
    } catch (e) {
      console.warn("renewal load failed:", e);
      showFatal();
    }
  }

  function showFatal() {
    $("#renewLoading").hidden = true;
    $("#renewError").hidden = false;
  }

  function showError(msg) {
    const box = $("#formError");
    box.textContent = msg;
    box.hidden = !msg;
  }

  async function onSubmit() {
    if (!chosen) return;
    const btn = $("#submitBtn");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = T("處理中…", "処理中…", "Processing…");
    showError("");
    try {
      const res = await fetch("/api/renewal-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eid: eid(),
          months: chosen.months,
          lang: L(),
          lineUserId: lineProfile ? lineProfile.userId : "",
          lineDisplayName: lineProfile ? lineProfile.displayName : "",
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "submit_failed");
      if (json.url) {
        // 直接進 Stripe 結帳（LIFF 內外都用整頁跳轉）
        location.href = json.url;
        return;
      }
      // 人工報價模式：顯示已收到
      $("#renewForm").hidden = true;
      $("#renewDone").hidden = false;
      $("#renewDone").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      btn.disabled = false;
      btn.textContent = original;
      showError(
        T("送出失敗，請稍後再試，或直接在 LINE 對話告訴我們您要續租。",
          "送信に失敗しました。時間をおいて再度お試しいただくか、LINEでお知らせください。",
          "Something went wrong. Please try again, or tell us via LINE chat that you'd like to renew.")
      );
    }
  }

  function init() {
    initLiff();
    load();
    $("#renewForm").addEventListener("submit", (e) => {
      e.preventDefault();
      onSubmit();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
