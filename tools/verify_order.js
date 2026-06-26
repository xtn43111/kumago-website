/* Puppeteer check: map-confirm UX (checkmark on "correct", custom field on
 * "incorrect") + that "前往付款" navigates to Stripe's hosted checkout. */
"use strict";
const puppeteer = require("puppeteer-core");
const path = require("path");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:3000";
const OUT = path.resolve(__dirname, "..", ".tmp");
require("fs").mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--window-size=900,1400"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 1400, deviceScaleFactor: 2 });
  const results = {};

  await page.goto(`${BASE}/order`, { waitUntil: "networkidle0" });

  // select plan B + duration 1年
  await page.click('[data-plan="B"]');
  await sleep(150);
  await page.click('[data-dur="1年"]');
  await sleep(150);

  // fill address
  await page.type("#fAddr1", "大阪府大阪市北区梅田");
  await page.type("#fBanchi", "1-2-3");
  await sleep(300);

  results.mapUrlLineVisible = await page.$eval("#mapUrlLine", (el) => el.offsetParent !== null);
  results.mapCheckVisible = await page.$eval("#mapCheck", (el) => el.offsetParent !== null);
  results.okHiddenBeforeChoice = await page.$eval("#mapUrlOk", (el) => el.offsetParent === null);

  // click 位置正確 (correct)
  await page.click('#mapConfirmSeg [data-val="correct"]');
  await sleep(150);
  results.okVisibleAfterCorrect = await page.$eval("#mapUrlOk", (el) => el.offsetParent !== null);
  results.customHiddenAfterCorrect = await page.$eval("#mapCustomWrap", (el) => el.offsetParent === null);
  await page.screenshot({ path: path.join(OUT, "map_correct.png") });

  // click 位置不正確 (incorrect)
  await page.click('#mapConfirmSeg [data-val="incorrect"]');
  await sleep(150);
  results.okHiddenAfterIncorrect = await page.$eval("#mapUrlOk", (el) => el.offsetParent === null);
  results.customVisibleAfterIncorrect = await page.$eval("#mapCustomWrap", (el) => el.offsetParent !== null);
  await page.screenshot({ path: path.join(OUT, "map_incorrect.png") });

  // editing the address resets the confirmation
  await page.type("#fBanchi", "4");
  await sleep(200);
  results.okHiddenAfterEdit = await page.$eval("#mapUrlOk", (el) => el.offsetParent === null);
  results.customHiddenAfterEdit = await page.$eval("#mapCustomWrap", (el) => el.offsetParent === null);

  // ---- full pay flow: re-confirm correct, fill rest, click pay ----
  await page.click('#mapConfirmSeg [data-val="correct"]');
  await page.evaluate(() => {
    document.querySelector("#fDate").value = "2026-07-20";
    document.querySelector("#fTime").value = "12-14";
    document.querySelector("#fRoom").value = "305";
  });
  await page.click('#fElevator [data-val="有"]');
  await page.type("#fName", "測試太郎");
  await page.type("#fContact", "test@example.com");
  await sleep(150);

  await page.click("#payBtn");
  try {
    await page.waitForFunction(() => location.host.includes("stripe.com"), { timeout: 20000 });
    results.reachedStripe = true;
    results.stripeUrl = page.url().slice(0, 70);
    await sleep(2500); // let Stripe's checkout render
    await page.screenshot({ path: path.join(OUT, "stripe_checkout.png") });
  } catch (e) {
    results.reachedStripe = false;
    const err = await page.$eval("#formError", (el) => (el.hidden ? "" : el.textContent)).catch(() => "");
    results.formError = err;
    await page.screenshot({ path: path.join(OUT, "pay_failed.png") });
  }

  console.log(JSON.stringify(results, null, 2));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
