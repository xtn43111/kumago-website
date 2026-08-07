/* 渲染 rich menu「右下橫條」(1667x562) → PNG，用於合成到原選單圖。
 * 右下橫條 = 新增「年租回收」(亮綠 #06C755) + 縮小的既有「搬家服務」(中綠 #05A848)。
 * 左下「家電回收」與上半部沿用原圖像素，不在此渲染。
 * 每格可各自設字級與是否斷行，長字（引越しサービス / Moving Service）用 <br> 斷行。
 * 跑：node tools/render_richmenu_strips.js  → 產出 .tmp/richmenu/strip_{zh,ja,en}.png */
"use strict";
const path = require("path");
const puppeteer = require(path.resolve(__dirname, "../node_modules/puppeteer-core"));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = path.resolve(__dirname, "../.tmp/richmenu");

// 原圖色票（取樣自現有選單）
const BRIGHT = "#06C755"; // 年租方案 / 新按鈕
const MED = "#05A848";    // 搬家服務（原色保留）

// 每語言：字型、字重，及兩格（new=年租回收 / move=搬家服務）各自的標題(HTML)、副標、字級。
const LANGS = {
  zh: {
    font: "'Noto Sans TC'", weight: 900,
    newT: "年租回收", newS: "點此預約 →", newSize: 150,
    moveT: "搬家服務", moveS: "點此查看 →", moveSize: 150,
  },
  ja: {
    font: "'Noto Sans JP'", weight: 900,
    newT: "満了回収", newS: "予約する →", newSize: 150,
    moveT: "引越し<br>サービス", moveS: "詳細はこちら →", moveSize: 128,
  },
  en: {
    font: "'Baloo 2'", weight: 700,
    newT: "Rental<br>Return", newS: "Book now →", newSize: 108,
    moveT: "Moving<br>Service", moveS: "Learn more →", moveSize: 108,
  },
};

function html(cfg) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Noto+Sans+JP:wght@500;900&family=Noto+Sans+TC:wght@500;900&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  html,body{width:1667px;height:562px;overflow:hidden;}
  .strip{display:flex;width:1667px;height:562px;}
  .cell{height:562px;display:flex;flex-direction:column;justify-content:center;
        padding-left:130px;padding-right:55px;color:#fff;
        font-family:${cfg.font},sans-serif;}
  .new{width:834px;background:${BRIGHT};}
  .move{width:833px;background:${MED};}
  .title{font-weight:${cfg.weight};line-height:1.04;letter-spacing:.5px;}
  .sub{font-weight:${cfg.font.includes("Baloo") ? 600 : 500};font-size:46px;margin-top:20px;opacity:.96;white-space:nowrap;}
</style></head>
<body>
  <div class="strip">
    <div class="cell new"><div class="title" style="font-size:${cfg.newSize}px">${cfg.newT}</div><div class="sub">${cfg.newS}</div></div>
    <div class="cell move"><div class="title" style="font-size:${cfg.moveSize}px">${cfg.moveT}</div><div class="sub">${cfg.moveS}</div></div>
  </div>
</body></html>`;
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] });
  for (const [lang, cfg] of Object.entries(LANGS)) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1667, height: 562, deviceScaleFactor: 1 });
    await page.setContent(html(cfg), { waitUntil: "networkidle0" });
    await page.evaluate(async () => { await document.fonts.ready; });
    await new Promise((r) => setTimeout(r, 300));
    const out = path.join(OUT, `strip_${lang}.png`);
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1667, height: 562 } });
    console.log("✓", out);
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
