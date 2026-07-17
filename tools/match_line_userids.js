#!/usr/bin/env node
/* KUMAGO — 年租客人 LINE userId 反查（唯讀）。
 *
 * 讀 .tmp/annual_roster.json（tools/scan_annual_customers.js 產出），對「缺
 * lineUserId」的客人，用名字反查本機 LINE 客服庫 qa.db：
 *   A. customer_alias_index（LINE 顯示名 → userId）
 *   B. customer_message direction='in'（客人自己打過的名字，如訂單全文/自報姓名）
 *
 * 信心分級：
 *   high   = 客人 in 訊息含完整中文名（≥2字）或 alias 顯示名完全等於名字
 *   medium = alias 部分符合 / 訊息含羅馬拼音全名
 * 一位客人若只有一個 high 候選 → auto 欄標 true（可被回寫工具直接採用）。
 * 多候選或只有 medium → 列人工確認。
 *
 *   node tools/match_line_userids.js
 *
 * 產出 .tmp/userid_matches.json。唯讀，不改 qa.db、不改行事曆。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DB = "/Users/peter/projects/line-smart-cs/data/qa.db";
const ROSTER = path.join(ROOT, ".tmp", "annual_roster.json");

function q(sql) {
  const out = execFileSync("sqlite3", ["-json", `file:${DB}?mode=ro`, sql], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  }).trim();
  return out ? JSON.parse(out) : [];
}
function esc(s) { return String(s).replace(/'/g, "''"); }

/* 非名字雜詞：方案/租期/物品字樣絕不可當名字搜（會全庫誤配） */
const TOK_STOP = new Set([
  "一年", "兩年", "二年", "三年", "半年", "年租", "租一年", "租兩年", "租半年",
  "續租", "退租", "套組", "套餐", "方案", "加購", "配送", "入住", "到期", "回收",
  "家電", "傢俱", "家具", "冰箱", "洗衣機", "微波爐", "書桌", "窗簾", "吸頂燈",
  "多筆", "現場", "上午", "下午",
]);

/* 名字 → 查詢 token：完整中文名、去姓名字（3字名→後2字）、羅馬全名、LINE 顯示名 */
function tokensFor(r) {
  const toks = new Set();
  const src = [r.name, r.lineName].filter(Boolean).join(" ");
  for (const m of src.matchAll(/[一-鿿]{2,4}/g)) {
    toks.add(m[0]);
    if (m[0].length >= 3) toks.add(m[0].slice(1)); // 去姓
  }
  for (const m of src.matchAll(/[ぁ-んァ-ヶー]{2,}/g)) toks.add(m[0]);
  for (const m of src.matchAll(/[A-Za-z]{2,}(?:\s+[A-Za-z]{2,})+/g)) toks.add(m[0]);
  for (const m of src.matchAll(/[A-Za-z]{4,}/g)) {
    if (!/^(set|plan|line)$/i.test(m[0])) toks.add(m[0]);
  }
  for (const t of TOK_STOP) toks.delete(t);
  return [...toks].filter((t) => !TOK_STOP.has(t));
}

function main() {
  if (!fs.existsSync(ROSTER)) {
    console.error("先跑 node tools/scan_annual_customers.js 產 roster");
    process.exit(1);
  }
  const roster = JSON.parse(fs.readFileSync(ROSTER, "utf8"));
  const missing = roster.filter((r) => !r.lineUserId);
  const results = [];

  for (const r of missing) {
    const cjkFull = [...String(r.name).matchAll(/[一-鿿]{2,4}/g)].map((m) => m[0]);
    const cands = new Map(); // userId → {via:Set, evidence:[]}
    const add = (uid, via, ev, conf) => {
      if (!/^U[0-9a-f]{32}$/.test(uid)) return;
      const c = cands.get(uid) || { userId: uid, via: new Set(), evidence: [], conf: "medium" };
      c.via.add(via);
      if (ev && c.evidence.length < 3) c.evidence.push(ev);
      if (conf === "high") c.conf = "high";
      cands.set(uid, c);
    };

    for (const tok of tokensFor(r)) {
      const isCjkFull = cjkFull.includes(tok);
      // A. alias 顯示名
      for (const row of q(
        `SELECT display_name, imported_user_id, msg_count FROM customer_alias_index
         WHERE display_name LIKE '%${esc(tok)}%' ORDER BY msg_count DESC LIMIT 5`
      )) {
        const exact = row.display_name === tok || row.display_name === r.name;
        add(row.imported_user_id, "alias",
          `alias「${row.display_name}」(${row.msg_count}訊)`,
          exact && isCjkFull ? "high" : "medium");
      }
      // B. 客人自己打過的訊息（in）
      if (tok.length >= 2 && /[一-鿿ぁ-んァ-ヶ]/.test(tok) ? tok.length >= 2 : tok.length >= 4) {
        for (const row of q(
          `SELECT customer_id, substr(text,1,60) AS t, created_at FROM customer_message
           WHERE direction='in' AND text LIKE '%${esc(tok)}%'
           ORDER BY id DESC LIMIT 5`
        )) {
          add(row.customer_id, "message",
            `in「${row.t.replace(/\n/g, " ")}」@${row.created_at}`,
            isCjkFull && tok.length >= 2 ? "high" : "medium");
        }
      }
    }

    const list = [...cands.values()].map((c) => ({ ...c, via: [...c.via] }));
    list.sort((a, b) => (a.conf === b.conf ? 0 : a.conf === "high" ? -1 : 1));
    const highs = list.filter((c) => c.conf === "high");
    // 補語言偏好
    for (const c of list) {
      const p = q(`SELECT lang FROM customer_pref WHERE customer_id='${esc(c.userId)}'`);
      c.lang = p.length ? p[0].lang : null;
    }
    results.push({
      name: r.name, expiryDate: r.expiryDate, expiryEventId: r.expiryEventId,
      deliveryEventId: r.deliveryEventId, lineName: r.lineName,
      auto: highs.length === 1 ? highs[0].userId : null,
      candidates: list.slice(0, 4),
    });
  }

  const outPath = path.join(ROOT, ".tmp", "userid_matches.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const auto = results.filter((x) => x.auto);
  const multi = results.filter((x) => !x.auto && x.candidates.length);
  const none = results.filter((x) => !x.candidates.length);
  console.log(`缺 userId ${missing.length} 位 → 唯一高信心 ${auto.length}／需人工選 ${multi.length}／查無 ${none.length}\n`);
  console.log("✅ 唯一高信心（可自動回寫）：");
  for (const x of auto) console.log(`  ${x.name}  →  ${x.auto.slice(0, 12)}…  ${x.candidates[0].evidence[0] || ""}`);
  console.log("\n⚠️ 多候選/中信心（人工確認）：");
  for (const x of multi) {
    console.log(`  ${x.name}（到期 ${x.expiryDate}）`);
    for (const c of x.candidates) console.log(`     [${c.conf}] ${c.userId.slice(0, 12)}… ${c.via.join("+")} ${c.evidence[0] || ""}`);
  }
  console.log("\n❌ 查無候選：");
  for (const x of none) console.log(`  ${x.name}（到期 ${x.expiryDate}）`);
}

main();
