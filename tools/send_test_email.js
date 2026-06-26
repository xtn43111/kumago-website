/* KUMAGO — send a sample order email to verify the Gmail SMTP setup works,
 * without needing a real Stripe payment + webhook. Sends BOTH the owner
 * notification and a customer confirmation using fake order data.
 *
 *   node tools/send_test_email.js               # customer copy → OWNER_EMAIL
 *   node tools/send_test_email.js you@mail.com   # customer copy → you@mail.com
 */
"use strict";
const fs = require("fs");
const path = require("path");

// load .env
const envPath = path.resolve(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i > -1 && !(s.slice(0, i).trim() in process.env)) process.env[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
}

const mailer = require("../lib/mailer.js");

const customerEmail = process.argv[2] || process.env.OWNER_EMAIL;

const meta = {
  plan: "B", duration: "1年",
  addons: "kettle,curtain,vacuum",
  area: "osaka",
  move_in_date: "2026-07-15", delivery_time: "12-14",
  postal: "530-0001", building: "梅田マンション 305",
  address: "大阪府大阪市北区梅田 1-2-3 (room 305)",
  map_url: "https://www.google.com/maps/search/?api=1&query=大阪市北区梅田1-2-3",
  elevator: "有電梯",
  customer_name: "測試 太郎", customer_contact: customerEmail,
  lang: "zh",
};
// Stand-in for the Stripe line items + total (B 套組 1年 + 加購).
const lineItems = [
  { description: "B 套組 × 1 年", amount_total: 55080, quantity: 1 },
  { description: "熱水壺 Kettle", amount_total: 4500, quantity: 1 },
  { description: "4 片窗簾組 Curtains x4", amount_total: 4900, quantity: 1 },
  { description: "吸塵器 Vacuum", amount_total: 4500, quantity: 1 },
];
const amountTotal = 68980;

(async () => {
  if (!mailer.isConfigured()) {
    console.error("SMTP not configured (SMTP_USER / SMTP_APP_PASSWORD missing in .env)");
    process.exit(1);
  }
  console.log("Sending test emails…");
  console.log("  owner →", process.env.OWNER_EMAIL);
  console.log("  customer →", customerEmail);
  const report = await mailer.sendOrderEmails(meta, lineItems, amountTotal);
  console.log("Result:", JSON.stringify(report, null, 2));
  if (report.errors && report.errors.length) process.exit(1);
})();
