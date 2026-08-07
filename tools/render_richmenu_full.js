/* KUMAGO rich menu — 全新設計（2500x1686），三語。比原本純色平面更有質感：
 *  - 綠色識別保留，但用漸層做出立體，柔和頂部高光 + 底部陰影
 *  - 每格圓角線條圖示（品牌風格）
 *  - 新按鈕「年租回收」= 奶茶暖色 + 「新」標，跳出來
 *  - 熊吉祥物落在主格角落
 *  - 精緻字級層次；CJK 用 Noto Sans TC/JP，英數用 Baloo 2
 * 跑：node tools/render_richmenu_full.js  → .tmp/richmenu/full_{zh,ja,en}.png
 */
"use strict";
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.resolve(__dirname, "../node_modules/puppeteer-core"));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = path.resolve(__dirname, "../.tmp/richmenu");
const BEAR = "data:image/png;base64," + fs.readFileSync(path.resolve(__dirname, "../assets/kumago-logo-mark.png")).toString("base64");

// 圓角線條圖示（24 viewBox，白/炭灰描邊）
const IC = {
  house: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9v11h13V9"/><rect x="10" y="13" width="4" height="7"/>',
  faq: '<path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 21l1.4-4.7A8.5 8.5 0 1 1 20.5 12Z"/><path d="M9.7 9.6a2.4 2.4 0 0 1 4.6.9c0 1.6-2.3 2-2.3 3.4"/><circle cx="12" cy="16.6" r=".2"/>',
  star: '<path d="M12 3.2l2.4 5.3 5.8.6-4.3 3.9 1.2 5.7L12 16.9 6.9 18.6l1.2-5.7L3.8 9l5.8-.6L12 3.2Z"/>',
  trash: '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 12.5h9L17.5 7"/><path d="M10 10.5v6M14 10.5v6"/>',
  calcheck: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.2"/><path d="M3.5 9.5h17"/><path d="M8 3.2v3.6M16 3.2v3.6"/><path d="M8.8 14.3l2.2 2.2 4-4.2"/>',
  truck: '<path d="M3 6.5h10.5v8.5H3z"/><path d="M13.5 9.5h3.7L21 12.8v2.2h-7.5z"/><circle cx="7" cy="17.2" r="1.9"/><circle cx="17.3" cy="17.2" r="1.9"/>',
};

// 6 格版面 + 底色（綠色漸層 / 奶茶新按鈕）+ 圖示 + 文字色
const TILES = [
  { key: "yearly", x: 0, y: 0, w: 1666, h: 1124, from: "#17c765", to: "#06a046", icon: "house", ink: "#fff", hero: true },
  { key: "faq", x: 1666, y: 0, w: 834, h: 562, from: "#0bab4e", to: "#07893d", icon: "faq", ink: "#fff" },
  { key: "why", x: 1666, y: 562, w: 834, h: 562, from: "#0a9c47", to: "#067433", icon: "star", ink: "#fff" },
  { key: "dispose", x: 0, y: 1124, w: 833, h: 562, from: "#0a9c47", to: "#067433", icon: "trash", ink: "#fff" },
  { key: "recycle", x: 833, y: 1124, w: 834, h: 562, from: "#f5ead6", to: "#e7d3b3", icon: "calcheck", ink: "#33322e", isNew: true },
  { key: "moving", x: 1667, y: 1124, w: 833, h: 562, from: "#0bab4e", to: "#07893d", icon: "truck", ink: "#fff" },
];

const LANGS = {
  zh: { font: "'Noto Sans TC'", newBadge: "新", labels: {
    yearly: ["年租方案", "立即看方案"], faq: ["常見問題", "點此查看"], why: ["為什麼選<br>KUMAGO", "點此了解"],
    dispose: ["不用品處分", "點此查看"], recycle: ["年租回收", "立即預約"], moving: ["搬家服務", "點此查看"] } },
  ja: { font: "'Noto Sans JP'", newBadge: "新", labels: {
    yearly: ["年間レンタル", "プランを見る"], faq: ["よくある<br>質問", "詳細はこちら"], why: ["KUMAGO<br>おすすめ", "詳細はこちら"],
    dispose: ["不用品処分", "詳細はこちら"], recycle: ["満了回収", "今すぐ予約"], moving: ["引越し<br>サービス", "詳細はこちら"] } },
  en: { font: "'Baloo 2'", newBadge: "NEW", labels: {
    yearly: ["Yearly Rental", "View plans"], faq: ["FAQ", "Learn more"], why: ["Why<br>KUMAGO", "Learn more"],
    dispose: ["Disposal", "Learn more"], recycle: ["Rental<br>Return", "Book now"], moving: ["Moving<br>Service", "Learn more"] } },
};

const PAD = 82; // 對齊 CSS 水平內距
// 估算一行的字寬（em）：拉丁/數字 0.60、空白 0.30、其餘（中日文）1.0
function lineEm(s) {
  let em = 0;
  for (const c of s) em += /[A-Za-z0-9]/.test(c) ? 0.6 : c === " " ? 0.3 : 1.0;
  return em;
}
// 自動縮放標題字級以貼合格寬（依 <br> 拆行取最寬的一行）
function fitSize(titleHtml, tileW, base) {
  const lines = titleHtml.split(/<br\s*\/?>/i);
  const maxEm = Math.max(...lines.map(lineEm));
  const avail = (tileW - PAD * 2) * 0.96;
  return Math.min(base, Math.floor(avail / maxEm));
}

function tileHtml(t, cfg) {
  const [title, sub] = cfg.labels[t.key];
  const heroSize = t.hero;
  const titleSize = heroSize ? 250 : fitSize(title, t.w, 134);
  const iconSize = heroSize ? 190 : 120;
  const stroke = heroSize ? 2.2 : 2.4;
  const isBaloo = cfg.font.includes("Baloo");
  const arrowCol = t.isNew ? "#0a9c47" : (t.ink === "#fff" ? "rgba(255,255,255,.92)" : t.ink);
  return `<div class="tile ${heroSize ? "hero" : ""} ${t.isNew ? "isnew" : ""}"
      style="left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px;
             background:linear-gradient(150deg,${t.from},${t.to});color:${t.ink};">
    <div class="sheen"></div>
    ${t.hero ? `<img class="bear" src="${BEAR}" alt="">` : ""}
    ${t.isNew ? `<span class="badge">${cfg.newBadge}</span>` : ""}
    <svg class="icon" style="width:${iconSize}px;height:${iconSize}px" viewBox="0 0 24 24" fill="none"
         stroke="${t.isNew ? "#0a9c47" : "currentColor"}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${IC[t.icon]}</svg>
    <div class="txt">
      <div class="title" style="font-size:${titleSize}px;font-weight:${isBaloo ? 800 : 900}">${title}</div>
      <div class="sub" style="color:${arrowCol}">${sub} <span class="arw">→</span></div>
    </div>
  </div>`;
}

function pageHtml(cfg) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Noto+Sans+JP:wght@500;700;900&family=Noto+Sans+TC:wght@500;700;900&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  html,body{width:2500px;height:1686px;overflow:hidden;background:#e7d3b3;font-family:${cfg.font},sans-serif;}
  .menu{position:relative;width:2500px;height:1686px;}
  .tile{position:absolute;overflow:hidden;display:flex;flex-direction:column;justify-content:space-between;
        padding:78px 82px;border:3px solid rgba(255,255,255,.10);}
  .tile.isnew{border-color:rgba(120,90,50,.14);}
  /* 頂部柔光 + 底部陰影，做出立體 */
  .sheen{position:absolute;inset:0;pointer-events:none;
    background:radial-gradient(120% 80% at 15% 0%, rgba(255,255,255,.22), rgba(255,255,255,0) 55%),
              linear-gradient(0deg, rgba(0,0,0,.10), rgba(0,0,0,0) 40%);}
  .tile.isnew .sheen{background:radial-gradient(120% 80% at 15% 0%, rgba(255,255,255,.5), rgba(255,255,255,0) 55%),
              linear-gradient(0deg, rgba(120,90,50,.10), rgba(0,0,0,0) 40%);}
  .icon{position:relative;z-index:2;opacity:.96;}
  .txt{position:relative;z-index:2;}
  .title{line-height:1.05;letter-spacing:.5px;text-shadow:0 2px 10px rgba(0,0,0,.06);}
  .tile.isnew .title{text-shadow:none;}
  .sub{margin-top:20px;font-size:46px;font-weight:${cfg.font.includes("Baloo") ? 600 : 500};letter-spacing:.5px;}
  .hero .sub{font-size:56px;margin-top:26px;}
  .arw{font-weight:700;}
  .bear{position:absolute;right:34px;bottom:-8px;width:486px;height:auto;z-index:1;opacity:.97;
        filter:drop-shadow(0 10px 22px rgba(0,0,0,.16));}
  .badge{position:absolute;top:70px;right:74px;z-index:3;background:#e8402e;color:#fff;font-weight:800;
    font-size:44px;line-height:1;padding:14px 26px;border-radius:999px;letter-spacing:1px;
    box-shadow:0 8px 18px rgba(232,64,46,.35);}
  .hero .title{max-width:1050px;}
</style></head><body>
  <div class="menu">${TILES.map((t) => tileHtml(t, cfg)).join("")}</div>
</body></html>`;
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] });
  const only = process.argv[2]; // 可只跑單一語言：node ... zh
  for (const [lang, cfg] of Object.entries(LANGS)) {
    if (only && lang !== only) continue;
    const page = await browser.newPage();
    await page.setViewport({ width: 2500, height: 1686, deviceScaleFactor: 1 });
    await page.setContent(pageHtml(cfg), { waitUntil: "networkidle0" });
    await page.evaluate(async () => { await document.fonts.ready; });
    await new Promise((r) => setTimeout(r, 350));
    const out = path.join(OUT, `full_${lang}.png`);
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 2500, height: 1686 } });
    console.log("✓", out);
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
