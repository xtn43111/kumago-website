/* KUMAGO 中古家電 — landing page interactions */
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

  /* ---- language toggle (zh-Hant ⇄ ja) ----
     Chinese is the default content in the markup; Japanese strings live in
     data-ja / data-ja-html / data-ja-ph attributes. We cache the original
     Chinese on first switch so toggling back is lossless. */
  const langBtn = document.getElementById("langToggle");
  const HTML_LANG = { zh: "zh-Hant", ja: "ja" };
  let currentLang = "zh";

  const applyLang = (lang) => {
    if (lang === currentLang) return;
    const toJa = lang === "ja";

    document.querySelectorAll("[data-ja]").forEach((el) => {
      if (el.dataset.zhCache === undefined) el.dataset.zhCache = el.textContent;
      el.textContent = toJa ? el.dataset.ja : el.dataset.zhCache;
    });
    document.querySelectorAll("[data-ja-html]").forEach((el) => {
      if (el.dataset.zhCacheHtml === undefined) el.dataset.zhCacheHtml = el.innerHTML;
      el.innerHTML = toJa ? el.dataset.jaHtml : el.dataset.zhCacheHtml;
    });
    document.querySelectorAll("[data-ja-ph]").forEach((el) => {
      if (el.dataset.zhCachePh === undefined) el.dataset.zhCachePh = el.placeholder;
      el.placeholder = toJa ? el.dataset.jaPh : el.dataset.zhCachePh;
    });

    document.documentElement.lang = HTML_LANG[lang];
    langBtn.querySelectorAll(".lang-opt").forEach((o) =>
      o.classList.toggle("is-active", o.dataset.lang === lang)
    );
    currentLang = lang;
  };

  if (langBtn) {
    langBtn.addEventListener("click", () =>
      applyLang(currentLang === "zh" ? "ja" : "zh")
    );
  }

  /* ---- scroll reveal ---- */
  const revealTargets = document.querySelectorAll(
    ".section-head, .cat-card, .feature, .step, .product, .quote, .stats, .hero-copy, .hero-visual, .cta-text, .cta-form"
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

  /* ---- demo form handler ---- */
  const form = document.querySelector(".cta-form");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const btn = form.querySelector("button[type=submit]");
      const original = btn.textContent;
      btn.textContent = currentLang === "ja" ? "受け付けました！" : "已收到，謝謝你！";
      btn.style.background = "#3B3B3B";
      form.reset();
      setTimeout(() => {
        btn.textContent = original;
        btn.style.background = "";
      }, 2600);
    });
  }
})();
