#!/usr/bin/env node
/**
 * build_i18n.js — generate static /ja and /en pages from zh-Hant source pages.
 *
 * Each source page is the zh-Hant source of truth; every translated string
 * lives in data-ja / data-en (text) or data-ja-html / data-en-html (rich
 * markup) attributes. This tool loads the page in headless Chrome (JS
 * disabled, so script.js can't mutate the DOM first), swaps the strings,
 * localizes <head> metadata + JSON-LD, rewrites internal links to the
 * language-prefixed equivalents, strips the translation attributes, and
 * writes ja/<page> and en/<page>.
 *
 * Re-run after any content change to a source page:  node tools/build_i18n.js
 * (index.html, area/*.html and guide/*.html are all rebuilt every run.)
 */
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const ROOT = path.join(__dirname, "..");
const SITE = "https://kumago.7-mori.com";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/* Language-wide strings shared by every page. */
const LOCALES = {
  ja: {
    htmlLang: "ja",
    ogLocale: "ja_JP",
    prefix: "/ja",
    fontsHref:
      "https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Noto+Sans+JP:wght@400;500;700;900&family=Nunito:wght@400;600;700&family=Quicksand:wght@600;700&display=swap",
    siteName: "KUMAGO 家具家電レンタル",
    brandAriaLabel: "KUMAGO 家具家電レンタル ホーム",
    copyright: "© 2026 KUMAGO 家具家電レンタル. All rights reserved.",
    businessDescription:
      "大阪の家具家電レンタルサービス。ワーホリ・留学・お仕事で大阪に来る方向けに月単位・年単位のレンタルプランを提供。大阪市内は配送・設置・契約満了後の回収まで無料。",
    navAriaLabel: "メインナビゲーション",
    menuAriaLabel: "メニューを開く",
    heroAlt: "KUMAGO のマスコットが温かい家を高く掲げている様子",
    waText: "こんにちは、中古家電について問い合わせたいです",
  },
  en: {
    htmlLang: "en",
    ogLocale: "en_US",
    prefix: "/en",
    fontsHref:
      "https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Nunito:wght@400;600;700&family=Quicksand:wght@600;700&display=swap",
    siteName: "KUMAGO Furniture & Appliance Rental",
    brandAriaLabel: "KUMAGO Furniture & Appliance Rental — Home",
    copyright: "© 2026 KUMAGO Furniture & Appliance Rental. All rights reserved.",
    businessDescription:
      "Furniture and appliance rental in Osaka, Japan, for people arriving on working-holiday visas, as students, or for work. Monthly and yearly plans; delivery, setup, and end-of-term collection are free within Osaka City.",
    navAriaLabel: "Main navigation",
    menuAriaLabel: "Open menu",
    heroAlt: "KUMAGO mascot lifting up a cozy home",
    waText: "Hi, I'd like to ask about used appliances",
  },
};

/* Per-page, per-language head metadata. zhPath is the canonical zh URL path. */
const PAGES = [
  {
    src: "index.html",
    zhPath: "/",
    meta: {
      ja: {
        description:
          "KUMAGO 家具家電レンタル｜ワーホリ・留学・お仕事で大阪へ来る方に。セット1年 ¥45,100〜、大阪市内は配送・設置・満了後の回収無料。ご利用1,000名超・クチコミ200件超。",
        ogTitle: "KUMAGO 家具家電レンタル — 大阪の暮らしをすぐ快適に",
        ogDescription:
          "大阪の家具家電レンタル。セット1年 ¥45,100〜。市内は配送・設置・満了後の回収まで無料。ワーホリ・留学・お仕事の方に安心の選択。",
        serviceDescription:
          "月単位・年単位の家具家電レンタルプラン。大阪市内は配送・設置・満了後の回収まで無料。契約期間は半年・1年・2年、1〜5ヶ月の短期プランもあり。",
      },
      en: {
        description:
          "KUMAGO Furniture & Appliance Rental in Osaka — sets from ¥45,100/yr with free delivery, setup, and end-of-term collection within Osaka City. 1,000+ customers, 200+ Google reviews.",
        ogTitle: "KUMAGO Furniture & Appliance Rental — Your Home in Osaka",
        ogDescription:
          "Furniture & appliance rental in Osaka from ¥45,100/yr. Free delivery, setup, and end-of-term collection within Osaka City.",
        serviceDescription:
          "Monthly and yearly furniture & appliance rental plans. Free delivery, setup, and end-of-term collection within Osaka City. Terms of 6 months, 1 year, or 2 years, plus short 1–5 month plans.",
      },
    },
  },
  {
    src: "area/nara.html",
    zhPath: "/area/nara",
    meta: {
      ja: {
        description:
          "奈良でも KUMAGO の家具家電レンタルが利用可能。奈良市・天理・橿原は配送料 ¥15,800、生駒など近郊は ¥18,000。セット1年 ¥45,100〜、設置・満了後の回収込み。",
        ogTitle: "奈良の家具家電レンタル・配送｜KUMAGO",
        ogDescription: "奈良市・天理・橿原 ¥15,800、生駒など近郊 ¥18,000。セット1年 ¥45,100〜。",
      },
      en: {
        description:
          "KUMAGO delivers rental furniture & appliances to Nara. ¥15,800 delivery to Nara City, Tenri & Kashihara; ¥18,000 to nearby cities. Sets from ¥45,100/yr incl. setup and collection.",
        ogTitle: "Furniture & Appliance Rental in Nara | KUMAGO",
        ogDescription: "Delivery to Nara from ¥15,800. Rental sets from ¥45,100/yr.",
      },
    },
  },
  {
    src: "area/kyoto.html",
    zhPath: "/area/kyoto",
    meta: {
      ja: {
        description:
          "京都でも KUMAGO の家具家電レンタルが利用可能。京都市は配送料 ¥18,000、宇治など近郊は ¥25,000。セット1年 ¥45,100〜、設置・満了後の回収込み。",
        ogTitle: "京都の家具家電レンタル・配送｜KUMAGO",
        ogDescription: "京都市 ¥18,000、宇治など近郊 ¥25,000。セット1年 ¥45,100〜。",
      },
      en: {
        description:
          "KUMAGO delivers rental furniture & appliances to Kyoto. ¥18,000 delivery to Kyoto City; ¥25,000 to nearby cities like Uji. Sets from ¥45,100/yr incl. setup and collection.",
        ogTitle: "Furniture & Appliance Rental in Kyoto | KUMAGO",
        ogDescription: "Delivery to Kyoto from ¥18,000. Rental sets from ¥45,100/yr.",
      },
    },
  },
  {
    src: "area/kobe.html",
    zhPath: "/area/kobe",
    meta: {
      ja: {
        description:
          "神戸・阪神間（尼崎・西宮・芦屋など8市）でも KUMAGO の家具家電レンタルが利用可能。配送料は一律 ¥18,000。セット1年 ¥45,100〜、設置・満了後の回収込み。",
        ogTitle: "神戸・阪神間の家具家電レンタル・配送｜KUMAGO",
        ogDescription: "神戸など阪神間8市へ配送料 ¥18,000。セット1年 ¥45,100〜。",
      },
      en: {
        description:
          "KUMAGO delivers rental furniture & appliances to Kobe and the Hanshin area (8 cities incl. Amagasaki, Nishinomiya, Ashiya) for a flat ¥18,000. Sets from ¥45,100/yr.",
        ogTitle: "Furniture & Appliance Rental in Kobe & Hanshin | KUMAGO",
        ogDescription: "Flat ¥18,000 delivery to Kobe & Hanshin. Sets from ¥45,100/yr.",
      },
    },
  },
  {
    src: "guide/working-holiday-osaka.html",
    zhPath: "/guide/working-holiday-osaka",
    meta: {
      ja: {
        description:
          "ワーホリで大阪へ来る方向け：家具家電はレンタルと購入どちらが得か、費用・リサイクル料・帰国時の処分まで徹底比較。セット1年 ¥45,100〜。",
        ogTitle: "ワーホリで大阪へ：家具家電はレンタル？購入？完全ガイド｜KUMAGO",
        ogDescription: "費用・処分コストで比較するレンタルと購入。セット1年 ¥45,100〜。",
      },
      en: {
        description:
          "Working holiday in Osaka: should you rent or buy furniture & appliances? Full cost comparison including recycling fees and moving-out hassle. Rental sets from ¥45,100/yr.",
        ogTitle: "Working Holiday in Osaka: Rent or Buy Furniture & Appliances? | KUMAGO",
        ogDescription: "Rent vs buy, compared honestly. Sets from ¥45,100/yr.",
      },
    },
  },
  {
    src: "guide/student-checklist.html",
    zhPath: "/guide/student-checklist",
    meta: {
      ja: {
        description:
          "大阪で一人暮らしを始める留学生向け：家具家電のチェックリスト。何をレンタルし、何を買い、何を持って来るべきか。セット1年 ¥45,100〜。",
        ogTitle: "留学生の大阪一人暮らし 家具家電チェックリスト｜KUMAGO",
        ogDescription: "レンタル・購入・持参の判断チェックリスト。セット1年 ¥45,100〜。",
      },
      en: {
        description:
          "Starting student life in Osaka: a furniture & appliance checklist — what to rent, what to buy, what to bring from home. Rental sets from ¥45,100/yr.",
        ogTitle: "Osaka Student Apartment Checklist: Rent, Buy, or Bring | KUMAGO",
        ogDescription: "The rent / buy / bring checklist for students. Sets from ¥45,100/yr.",
      },
    },
  },
];

async function main() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
  try {
    for (const pageCfg of PAGES) {
      const srcPath = path.join(ROOT, pageCfg.src);
      if (!fs.existsSync(srcPath)) {
        console.warn(`SKIP ${pageCfg.src} (source not found)`);
        continue;
      }
      for (const [lang, locale] of Object.entries(LOCALES)) {
        const page = await browser.newPage();
        await page.setJavaScriptEnabled(false); // keep script.js from touching the DOM
        await page.goto("file://" + srcPath, { waitUntil: "load" });

        const cfg = {
          ...locale,
          ...pageCfg.meta[lang],
          zhPath: pageCfg.zhPath,
          langPath: pageCfg.zhPath === "/" ? locale.prefix : locale.prefix + pageCfg.zhPath,
        };
        const cluster = [
          ["zh-Hant", SITE + pageCfg.zhPath],
          ["ja", SITE + (pageCfg.zhPath === "/" ? "/ja" : "/ja" + pageCfg.zhPath)],
          ["en", SITE + (pageCfg.zhPath === "/" ? "/en" : "/en" + pageCfg.zhPath)],
          ["x-default", SITE + pageCfg.zhPath],
        ];

        const { html, missing } = await page.evaluate(buildDom, lang, cfg, cluster, SITE);

        const outPath = path.join(ROOT, lang, pageCfg.src);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, "<!DOCTYPE html>\n" + html + "\n");
        console.log(`${lang}/${pageCfg.src} written (${missing} elements kept zh fallback)`);
        await page.close();
      }
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

  /* 4a. rewrite relative URLs to root-absolute so they resolve under /ja, /en */
  const rewrite = (el, attr) => {
    const v = el.getAttribute(attr);
    if (!v || /^(https?:|\/|#|tel:|mailto:|data:)/.test(v)) return;
    let abs = "/" + v;
    abs = abs.replace(/^\/order\.html/, "/order"); // cleanUrls canonical form
    el.setAttribute(attr, abs);
  };
  document.querySelectorAll("[src]").forEach((el) => rewrite(el, "src"));
  document.querySelectorAll("[href]").forEach((el) => rewrite(el, "href"));

  /* 4b. point internal links at the language-prefixed page so visitors stay
   * in their language. Only pages that exist per-language are prefixed;
   * /order, /recovery, /tokushoho, assets etc. stay language-neutral. */
  const LOCALIZED = /^\/($|#|area\/|guide\/)/;
  document.querySelectorAll("a[href]").forEach((a) => {
    const v = a.getAttribute("href");
    if (!v || v[0] !== "/" || !LOCALIZED.test(v)) return;
    if (v === "/") a.setAttribute("href", "/" + lang);
    else if (v[1] === "#") a.setAttribute("href", "/" + lang + v.slice(1));
    else a.setAttribute("href", "/" + lang + v);
  });

  /* 5. head metadata */
  const set = (sel, attr, val) => {
    const el = document.querySelector(sel);
    if (el && val != null) el.setAttribute(attr, val);
  };
  set('meta[name="description"]', "content", cfg.description);
  set('link[rel="canonical"]', "href", SITE + cfg.langPath);
  set('meta[property="og:title"]', "content", cfg.ogTitle);
  set('meta[property="og:description"]', "content", cfg.ogDescription);
  set('meta[property="og:url"]', "content", SITE + cfg.langPath);
  set('meta[property="og:locale"]', "content", cfg.ogLocale);
  set('meta[name="twitter:title"]', "content", cfg.ogTitle);
  set('meta[name="twitter:description"]', "content", cfg.ogDescription);
  const fonts = document.querySelector('link[href^="https://fonts.googleapis.com/css2"]');
  if (fonts) fonts.setAttribute("href", cfg.fontsHref);
  set('meta[property="og:site_name"]', "content", cfg.siteName);

  /* zh brand strings that live in attributes / untranslated text nodes */
  document.querySelectorAll("a.brand[aria-label], .brand-footer").forEach((el) => {
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
    if (d["@type"] === "Service") {
      if (cfg.zhPath === "/") {
        if (cfg.serviceDescription) d.description = cfg.serviceDescription;
      } else {
        /* subpage Service blocks: reuse the localized meta description and
         * repoint @id/url at the language-prefixed URL */
        d.description = cfg.description;
        if (d["@id"]) d["@id"] = SITE + cfg.langPath + "#service";
        d.url = SITE + cfg.langPath;
      }
    }
    if (d["@type"] === "WebSite") {
      d.inLanguage = cfg.htmlLang;
      d.url = SITE + cfg.langPath;
      d["@id"] = SITE + cfg.langPath + "#website";
    }
    if (d["@type"] === "Article") {
      d.inLanguage = cfg.htmlLang;
      d.headline = document.title.replace(/｜KUMAGO.*$/, "").replace(/ \| KUMAGO.*$/, "");
      d.description = cfg.description;
      if (d.mainEntityOfPage) d.mainEntityOfPage = SITE + cfg.langPath;
      if (d["@id"]) d["@id"] = SITE + cfg.langPath + "#article";
    }
    if (d["@type"] === "BreadcrumbList") {
      /* rebuild names from the localized visible breadcrumb */
      const crumbs = Array.from(document.querySelectorAll(".breadcrumb ol li"));
      if (crumbs.length && Array.isArray(d.itemListElement)) {
        d.itemListElement = crumbs.map((li, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: li.textContent.trim(),
          item: i === 0 ? SITE + "/" + lang : SITE + cfg.langPath,
        }));
      }
      if (d["@id"]) d["@id"] = SITE + cfg.langPath + "#breadcrumb";
    }
    if (d["@type"] === "FAQPage") {
      d["@id"] = SITE + cfg.langPath + "#faq";
      const cards = document.querySelectorAll("#faq .faq-card");
      if (cards.length) {
        /* homepage: rebuild Q&A from the now-localized FAQ cards */
        d.mainEntity = Array.from(cards).map((card) => ({
          "@type": "Question",
          name: card.querySelector("h3").textContent.trim(),
          acceptedAnswer: {
            "@type": "Answer",
            text: Array.from(card.querySelectorAll(".faq-list li"))
              .map((li) => li.textContent.trim().replace(/\s+/g, " "))
              .join(" "),
          },
        }));
      } else {
        /* subpages: rebuild from .faq-q / .faq-a pairs in the prose */
        const qs = Array.from(document.querySelectorAll(".faq-q"));
        if (qs.length) {
          d.mainEntity = qs.map((q) => {
            let a = q.nextElementSibling;
            while (a && !a.classList.contains("faq-a")) a = a.nextElementSibling;
            return {
              "@type": "Question",
              name: q.textContent.trim(),
              acceptedAnswer: {
                "@type": "Answer",
                text: a ? a.textContent.trim().replace(/\s+/g, " ") : "",
              },
            };
          });
        }
      }
    }
    s.textContent = "\n  " + JSON.stringify(d, null, 2).replace(/\n/g, "\n  ") + "\n  ";
  });

  return { html: document.documentElement.outerHTML, missing };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
