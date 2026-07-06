#!/usr/bin/env node
/**
 * build_i18n.js — generate static /ja and /en landing pages from index.html.
 *
 * index.html is the zh-Hant source of truth; every translated string lives in
 * data-ja / data-en (text) or data-ja-html / data-en-html (rich markup)
 * attributes. This tool loads index.html in headless Chrome (JS disabled, so
 * script.js can't mutate the DOM first), swaps the strings the same way the
 * old client-side toggle did, localizes <head> metadata + JSON-LD, rewrites
 * relative URLs to root-absolute, strips the translation attributes, and
 * writes ja/index.html and en/index.html.
 *
 * Re-run after any index.html content change:  node tools/build_i18n.js
 */
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const ROOT = path.join(__dirname, "..");
const SITE = "https://kumago.7-mori.com";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const LOCALES = {
  ja: {
    htmlLang: "ja",
    ogLocale: "ja_JP",
    path: "/ja",
    description:
      "KUMAGO 家具家電レンタル｜ワーホリ・留学・お仕事で大阪に来る方へ。月単位・年単位の家具家電レンタルプラン。大阪市内は配送・設置・契約満了後の回収まですべて無料。ご利用1,000名超・Googleクチコミ200件超。",
    ogTitle: "KUMAGO 家具家電レンタル — 大阪の暮らしをすぐ快適に",
    ogDescription:
      "大阪の家具家電レンタル。市内は配送・設置・満了後の回収まで無料。ワーホリ・留学・お仕事の方に安心の選択。",
    fontsHref:
      "https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Noto+Sans+JP:wght@400;500;700;900&family=Nunito:wght@400;600;700&family=Quicksand:wght@600;700&display=swap",
    siteName: "KUMAGO 家具家電レンタル",
    brandAriaLabel: "KUMAGO 家具家電レンタル ホーム",
    copyright: "© 2026 KUMAGO 家具家電レンタル. All rights reserved.",
    businessDescription:
      "大阪の家具家電レンタルサービス。ワーホリ・留学・お仕事で大阪に来る方向けに月単位・年単位のレンタルプランを提供。大阪市内は配送・設置・契約満了後の回収まで無料。",
    serviceDescription:
      "月単位・年単位の家具家電レンタルプラン。大阪市内は配送・設置・満了後の回収まで無料。契約期間は半年・1年・2年、1〜5ヶ月の短期プランもあり。",
    navAriaLabel: "メインナビゲーション",
    menuAriaLabel: "メニューを開く",
    heroAlt: "KUMAGO のマスコットが温かい家を高く掲げている様子",
    waText: "こんにちは、中古家電について問い合わせたいです",
  },
  en: {
    htmlLang: "en",
    ogLocale: "en_US",
    path: "/en",
    description:
      "KUMAGO Furniture & Appliance Rental in Osaka — for working holidays, students, and professionals. Monthly or yearly plans with free delivery, setup, and end-of-term collection within Osaka City. 1,000+ customers served, 200+ Google reviews.",
    ogTitle: "KUMAGO Furniture & Appliance Rental — Your Home in Osaka",
    ogDescription:
      "Furniture & appliance rental in Osaka. Free delivery, setup, and end-of-term collection within Osaka City. A worry-free choice for working holidays, study, and work.",
    fontsHref:
      "https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Nunito:wght@400;600;700&family=Quicksand:wght@600;700&display=swap",
    siteName: "KUMAGO Furniture & Appliance Rental",
    brandAriaLabel: "KUMAGO Furniture & Appliance Rental — Home",
    copyright: "© 2026 KUMAGO Furniture & Appliance Rental. All rights reserved.",
    businessDescription:
      "Furniture and appliance rental in Osaka, Japan, for people arriving on working-holiday visas, as students, or for work. Monthly and yearly plans; delivery, setup, and end-of-term collection are free within Osaka City.",
    serviceDescription:
      "Monthly and yearly furniture & appliance rental plans. Free delivery, setup, and end-of-term collection within Osaka City. Terms of 6 months, 1 year, or 2 years, plus short 1–5 month plans.",
    navAriaLabel: "Main navigation",
    menuAriaLabel: "Open menu",
    heroAlt: "KUMAGO mascot lifting up a cozy home",
    waText: "Hi, I'd like to ask about used appliances",
  },
};

const HREFLANG_CLUSTER = [
  ["zh-Hant", `${SITE}/`],
  ["ja", `${SITE}/ja`],
  ["en", `${SITE}/en`],
  ["x-default", `${SITE}/`],
];

async function main() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
  try {
    for (const [lang, cfg] of Object.entries(LOCALES)) {
      const page = await browser.newPage();
      await page.setJavaScriptEnabled(false); // keep script.js from touching the DOM
      await page.goto("file://" + path.join(ROOT, "index.html"), { waitUntil: "load" });

      const { html, missing } = await page.evaluate(buildDom, lang, cfg, HREFLANG_CLUSTER, SITE);

      const outDir = path.join(ROOT, lang);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "index.html"), "<!DOCTYPE html>\n" + html + "\n");
      console.log(`${lang}/index.html written (${missing} elements had no data-${lang} translation, kept zh fallback)`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

/* Runs inside the browser. Mutates the parsed DOM, returns serialized HTML. */
function buildDom(lang, cfg, cluster, SITE) {
  let missing = 0;

  /* 1. swap translated strings (same semantics as the old applyLang) */
  document.querySelectorAll("[data-ja], [data-en]").forEach((el) => {
    const t = el.dataset[lang];
    if (t != null) el.textContent = t;
    else missing++;
  });
  document.querySelectorAll("[data-ja-html], [data-en-html]").forEach((el) => {
    const t = el.dataset[lang + "Html"];
    if (t != null) el.innerHTML = t;
    else missing++;
  });

  /* 2. strip translation attributes (dead weight on a single-language page) */
  document.querySelectorAll("*").forEach((el) => {
    ["data-ja", "data-en", "data-ja-html", "data-en-html"].forEach((a) => el.removeAttribute(a));
  });

  /* 3. html lang + toggle active state */
  document.documentElement.setAttribute("lang", cfg.htmlLang);
  document.querySelectorAll(".lang-opt").forEach((o) => {
    o.classList.toggle("is-active", o.dataset.lang === lang);
  });

  /* 4. rewrite relative URLs to root-absolute so they resolve under /ja, /en */
  const rewrite = (el, attr) => {
    const v = el.getAttribute(attr);
    if (!v || /^(https?:|\/|#|tel:|mailto:|data:)/.test(v)) return;
    let abs = "/" + v;
    abs = abs.replace(/^\/order\.html/, "/order"); // cleanUrls canonical form
    el.setAttribute(attr, abs);
  };
  document.querySelectorAll("[src]").forEach((el) => rewrite(el, "src"));
  document.querySelectorAll("[href]").forEach((el) => rewrite(el, "href"));

  /* 5. head metadata */
  const set = (sel, attr, val) => {
    const el = document.querySelector(sel);
    if (el) el.setAttribute(attr, val);
  };
  set('meta[name="description"]', "content", cfg.description);
  set('link[rel="canonical"]', "href", SITE + cfg.path);
  set('meta[property="og:title"]', "content", cfg.ogTitle);
  set('meta[property="og:description"]', "content", cfg.ogDescription);
  set('meta[property="og:url"]', "content", SITE + cfg.path);
  set('meta[property="og:locale"]', "content", cfg.ogLocale);
  set('meta[name="twitter:title"]', "content", cfg.ogTitle);
  set('meta[name="twitter:description"]', "content", cfg.ogDescription);
  const fonts = document.querySelector('link[href^="https://fonts.googleapis.com/css2"]');
  if (fonts) fonts.setAttribute("href", cfg.fontsHref);
  set('meta[property="og:site_name"]', "content", cfg.siteName);

  /* zh brand strings that live in attributes / untranslated text nodes */
  document.querySelectorAll('a.brand[aria-label], .brand-footer').forEach((el) => {
    if (el.hasAttribute("aria-label")) el.setAttribute("aria-label", cfg.brandAriaLabel);
  });
  const copyrightP = document.querySelector(".footer-bottom p");
  if (copyrightP) copyrightP.textContent = cfg.copyright;

  /* zh strings that live in other attributes (a11y labels, alt text, WhatsApp
   * prefill) — otherwise they leak Chinese onto the /ja and /en pages. */
  const setAttr = (sel, attr, val) => {
    const el = document.querySelector(sel);
    if (el && val) el.setAttribute(attr, val);
  };
  setAttr("#nav", "aria-label", cfg.navAriaLabel);
  setAttr("#navToggle", "aria-label", cfg.menuAriaLabel);
  // The hero image is the LCP one (fetchpriority="high"); several other imgs
  // reuse the same logo src, so target the hero precisely, not by src.
  setAttr('img[fetchpriority="high"]', "alt", cfg.heroAlt);
  const wa = document.querySelector('a[href*="wa.me"][href*="text="]');
  if (wa && cfg.waText) {
    wa.setAttribute("href", wa.getAttribute("href").replace(/text=[^&]*/, "text=" + encodeURIComponent(cfg.waText)));
  }

  /* 6. hreflang cluster (drop any carried over from the source first) */
  document.querySelectorAll('link[rel="alternate"][hreflang]').forEach((l) => l.remove());
  const canonical = document.querySelector('link[rel="canonical"]');
  cluster.forEach(([hl, href]) => {
    const l = document.createElement("link");
    l.rel = "alternate";
    l.hreflang = hl;
    l.href = href;
    canonical.after(l);
  });

  /* 7. JSON-LD localization */
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    const d = JSON.parse(s.textContent);
    if (d["@type"] === "LocalBusiness") d.description = cfg.businessDescription;
    if (d["@type"] === "Service") d.description = cfg.serviceDescription;
    if (d["@type"] === "WebSite") {
      d.inLanguage = cfg.htmlLang;
      d.url = SITE + cfg.path;
      d["@id"] = SITE + cfg.path + "#website";
    }
    if (d["@type"] === "FAQPage") {
      /* rebuild Q&A from the now-localized FAQ cards */
      d["@id"] = SITE + cfg.path + "#faq";
      d.mainEntity = Array.from(document.querySelectorAll("#faq .faq-card")).map((card) => ({
        "@type": "Question",
        name: card.querySelector("h3").textContent.trim(),
        acceptedAnswer: {
          "@type": "Answer",
          text: Array.from(card.querySelectorAll(".faq-list li"))
            .map((li) => li.textContent.trim().replace(/\s+/g, " "))
            .join(" "),
        },
      }));
    }
    s.textContent = "\n  " + JSON.stringify(d, null, 2).replace(/\n/g, "\n  ") + "\n  ";
  });

  return { html: document.documentElement.outerHTML, missing };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
