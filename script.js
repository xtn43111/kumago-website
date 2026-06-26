/* KUMAGO 家具家電租賃 — landing page interactions */
(function () {
  "use strict";

  /* ---- sticky header shadow ---- */
  const header = document.querySelector(".site-header");
  const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 8);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---- mobile nav toggle ---- */
  const toggle = document.getElementById("navToggle");
  const nav = document.getElementById("nav");
  const closeNav = () => {
    nav.classList.remove("open");
    toggle.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
  };
  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    toggle.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
  });
  nav.querySelectorAll("a").forEach((a) => a.addEventListener("click", closeNav));

  /* ---- language toggle (zh-Hant ⇄ ja ⇄ en) ----
     Chinese is the default content in the markup; Japanese and English strings
     live in data-ja/data-en (text), data-ja-html/data-en-html (rich markup).
     We cache the original Chinese on first switch so returning to 中 is lossless.
     Any missing translation falls back to the cached Chinese. */
  const langBtn = document.getElementById("langToggle");
  const HTML_LANG = { zh: "zh-Hant", ja: "ja", en: "en" };
  let currentLang = "zh";

  const applyLang = (lang) => {
    if (lang === currentLang || !HTML_LANG[lang]) return;

    document.querySelectorAll("[data-ja], [data-en]").forEach((el) => {
      if (el.dataset.zhCache === undefined) el.dataset.zhCache = el.textContent;
      const next = lang === "zh" ? el.dataset.zhCache : el.dataset[lang];
      el.textContent = next != null ? next : el.dataset.zhCache;
    });
    document.querySelectorAll("[data-ja-html], [data-en-html]").forEach((el) => {
      if (el.dataset.zhCacheHtml === undefined) el.dataset.zhCacheHtml = el.innerHTML;
      const key = lang === "ja" ? "jaHtml" : lang === "en" ? "enHtml" : null;
      const next = key ? el.dataset[key] : null;
      el.innerHTML = next != null ? next : el.dataset.zhCacheHtml;
    });

    document.documentElement.lang = HTML_LANG[lang];
    langBtn.querySelectorAll(".lang-opt").forEach((o) =>
      o.classList.toggle("is-active", o.dataset.lang === lang)
    );
    currentLang = lang;
  };

  if (langBtn) {
    langBtn.querySelectorAll(".lang-opt").forEach((opt) =>
      opt.addEventListener("click", () => applyLang(opt.dataset.lang))
    );
  }

  /* ---- scroll reveal ---- */
  const revealTargets = document.querySelectorAll(
    ".section-head, .cat-card, .feature, .step, .product, .quote, .stats, .hero-copy, .hero-visual, .cta-text, .cta-line-card"
  );
  revealTargets.forEach((el, i) => {
    el.classList.add("reveal");
    el.style.transitionDelay = (i % 4) * 70 + "ms";
  });

  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            obs.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    revealTargets.forEach((el) => io.observe(el));
  } else {
    revealTargets.forEach((el) => el.classList.add("in"));
  }

})();
