/* Puppeteer check for the postal-driven shipping + new time slots.
 * Verifies: only two time options; Osaka = free; Sakai = +¥6,600;
 * out-of-area (Tokyo) routes to LINE; and zero horizontal overflow
 * across mobile/desktop widths. */
"use strict";
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:8080";
const OUT = path.resolve(__dirname, "..", ".tmp");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function typePostal(page, zip) {
  await page.evaluate(() => { document.querySelector("#fPostal").value = ""; });
  await page.type("#fPostal", zip); // input listener auto-fires lookup at 7 digits
  await sleep(1200); // wait for zipcloud round-trip
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--window-size=900,1600"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 1600, deviceScaleFactor: 2 });
  const r = {};

  await page.goto(`${BASE}/order.html`, { waitUntil: "networkidle0" });
  await page.click('[data-plan="A"]');
  await sleep(120);
  await page.click('[data-dur="1年"]'); // ¥45,100
  await sleep(120);

  // --- time slots: expect exactly 2 (+ placeholder) ---
  r.timeOptions = await page.$$eval("#fTime option", (os) =>
    os.filter((o) => o.value).map((o) => o.textContent.trim()));

  // --- Osaka City → free ---
  await typePostal(page, "5300001");
  r.osaka_zone = await page.$eval("#shipZone", (e) => e.textContent.trim());
  r.osaka_total = await page.$eval("#sumTotal", (e) => e.textContent.trim());
  r.osaka_hasShipRow = await page.$$eval(".sum-row", (rows) =>
    rows.some((x) => /配送費/.test(x.textContent)));
  await page.screenshot({ path: path.join(OUT, "ship_osaka.png") });

  // --- Sakai → +¥6,600 ---
  await typePostal(page, "5900078");
  r.sakai_zone = await page.$eval("#shipZone", (e) => e.textContent.trim());
  r.sakai_total = await page.$eval("#sumTotal", (e) => e.textContent.trim());
  r.sakai_payBtn = await page.$eval("#payBtn", (e) => e.textContent.trim());
  await page.screenshot({ path: path.join(OUT, "ship_sakai.png") });

  // --- Uji, Kyoto → +¥25,000 ---
  await typePostal(page, "6110021"); // 京都府宇治市
  r.uji_zone = await page.$eval("#shipZone", (e) => e.textContent.trim());
  r.uji_total = await page.$eval("#sumTotal", (e) => e.textContent.trim());

  // --- Ikoma, Nara → +¥18,000 ---
  await typePostal(page, "6300257"); // 奈良県生駒市
  r.ikoma_zone = await page.$eval("#shipZone", (e) => e.textContent.trim());
  r.ikoma_total = await page.$eval("#sumTotal", (e) => e.textContent.trim());

  // --- Himeji, Hyogo → NOT served ---
  await typePostal(page, "6700012"); // 兵庫県姫路市
  r.himeji_zone = await page.$eval("#shipZone", (e) => e.textContent.trim());
  r.himeji_payBtn = await page.$eval("#payBtn", (e) => e.textContent.trim());

  // --- Kobe, Hyogo → still served +¥18,000 ---
  await typePostal(page, "6500001"); // 兵庫県神戸市中央区
  r.kobe_zone = await page.$eval("#shipZone", (e) => e.textContent.trim());
  r.kobe_total = await page.$eval("#sumTotal", (e) => e.textContent.trim());

  // --- Tokyo (out of area) → not served ---
  await typePostal(page, "1600022"); // 東京都新宿区
  r.tokyo_zone = await page.$eval("#shipZone", (e) => e.textContent.trim());
  r.tokyo_payBtn = await page.$eval("#payBtn", (e) => e.textContent.trim());
  r.tokyo_shipNoteShown = await page.$eval("#shipNote", (e) => e.offsetParent !== null);

  // --- horizontal overflow across widths ---
  r.overflow = {};
  for (const w of [375, 390, 768, 1440]) {
    await page.setViewport({ width: w, height: 1400, deviceScaleFactor: 1 });
    await sleep(200);
    r.overflow[w] = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
  }

  console.log(JSON.stringify(r, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
