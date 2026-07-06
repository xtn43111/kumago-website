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

  /* ---- language toggle ----
     Two modes:
     • Landing pages (/ , /ja, /en) each live at their own crawlable URL, so the
       toggle NAVIGATES between them.
     • Form pages (order / recovery) opt into IN-PLACE switching via
       <html data-i18n="inplace">. Navigating away there would throw away a
       half-filled order (H1), so instead we swap strings/placeholders in place
       and flip <html lang> — which order.js/recovery-form.js observe to re-render
       their JS-generated strings. These pages only offer zh⇄ja. */
  const langBtn = document.getElementById("langToggle");
  const LANG_PATH = { zh: "/", ja: "/ja", en: "/en" };
  const LANG_ATTR = { zh: "zh-Hant", ja: "ja", en: "en" };
  const inPlace = document.documentElement.dataset.i18n === "inplace";
  let currentLang = { "zh-Hant": "zh", ja: "ja", en: "en" }[document.documentElement.lang] || "zh";

  // Reversibly localise static [data-ja] text and [data-ja-ph] placeholders,
  // capturing the original zh once so we can switch back.
  function applyStaticI18n(lang) {
    const ja = lang === "ja";
    document.querySelectorAll("[data-ja]").forEach((el) => {
      if (el.dataset.zh === undefined) el.dataset.zh = el.textContent;
      el.textContent = ja ? el.dataset.ja : el.dataset.zh;
    });
    document.querySelectorAll("[data-ja-ph]").forEach((el) => {
      if (el.dataset.zhPh === undefined) el.dataset.zhPh = el.getAttribute("placeholder") || "";
      el.setAttribute("placeholder", ja ? el.dataset.jaPh : el.dataset.zhPh);
    });
  }

  function switchInPlace(lang) {
    applyStaticI18n(lang);
    // Flip <html lang> last so the page's MutationObserver re-renders dynamic
    // strings against the already-updated static content.
    document.documentElement.lang = LANG_ATTR[lang] || "zh-Hant";
    langBtn.querySelectorAll(".lang-opt").forEach((o) =>
      o.classList.toggle("is-active", o.dataset.lang === lang)
    );
    currentLang = lang;
  }

  if (langBtn) {
    langBtn.querySelectorAll(".lang-opt").forEach((opt) =>
      opt.addEventListener("click", () => {
        const lang = opt.dataset.lang;
        if (lang === currentLang) return;
        if (inPlace) {
          switchInPlace(lang);
        } else {
          if (!LANG_PATH[lang]) return;
          window.location.href = LANG_PATH[lang] + window.location.hash;
        }
      })
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
