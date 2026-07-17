#!/usr/bin/env node
/* KUMAGO — 驗證行事曆上的 LINE userId 是否可推播（瑞瑞死 id 事故後的全面檢核）。
 *
 * 背景：qa.db 的 customer_alias_index.imported_user_id 有些是一月歷史匯入產的
 * 「死 id」——不是本 channel 的好友 id，push 回 400。同批匯入通常雙寫：
 * source='imported'（掛死 id）與 source='imported_alias'（掛真 id）內容相同，
 * 可用「同文同時間」對映找回真 id。
 *
 * 流程：讀 .tmp/annual_roster.json 所有有 lineUserId 的客人 →
 *   GET /v2/bot/profile/{id}（200=好友可推、404=死 id/封鎖）→
 *   404 者用 qa.db 對映真 id → 真 id 再驗 → --apply 把行事曆事件
 *   description 的舊 id 全部替換成真 id。
 *
 *   node tools/verify_line_userids.js            # 只驗＋列報告
 *   node tools/verify_line_userids.js --apply    # 連同修行事曆
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
function loadEnv(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(".env");
loadEnv(".env.local");

const { getEvent, patchEvent } = require("../lib/gcal");

const DB = "/Users/peter/projects/line-smart-cs/data/qa.db";
function q(sql) {
  const out = execFileSync("sqlite3", ["-json", `file:${DB}?mode=ro`, sql], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  }).trim();
  return out ? JSON.parse(out) : [];
}
const esc = (s) => String(s).replace(/'/g, "''");

async function profileOk(uid) {
  const r = await fetch(`https://api.line.me/v2/bot/profile/${uid}`, {
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  return r.status === 200;
}

/* 死 id → 真 id 管道一：同批匯入雙寫（imported 同文同時間 imported_alias） */
function mapToRealId(deadId) {
  const rows = q(
    `SELECT DISTINCT b.customer_id AS real_id, COUNT(*) AS n
     FROM customer_message a
     JOIN customer_message b ON a.text = b.text AND a.created_at = b.created_at
     WHERE a.customer_id='${esc(deadId)}' AND a.source='imported'
       AND b.source='imported_alias' AND b.customer_id != a.customer_id
     GROUP BY b.customer_id ORDER BY n DESC`
  );
  return rows.length === 1 ? rows[0].real_id : null; // 多候選不猜
}

/* 管道二：真 id 池（live 訊息＋customer_pref 的 id 都是 bot 實收的真 id）
 * → 逐一 profile API 取「目前 LINE 顯示名」→ 顯示名完全相等且唯一者即真 id。 */
let displayPool = null; // [{id, name}]
async function buildDisplayPool() {
  if (displayPool) return displayPool;
  const ids = q(
    `SELECT DISTINCT customer_id AS id FROM customer_message WHERE source='live'
     UNION SELECT DISTINCT customer_id FROM customer_pref`
  ).map((r) => r.id).filter((id) => /^U[0-9a-f]{32}$/.test(id));
  displayPool = [];
  for (const id of ids) {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${id}`, {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (r.status === 200) {
      const p = await r.json();
      displayPool.push({ id, name: p.displayName });
    }
    await sleep(60);
  }
  return displayPool;
}
async function mapByDisplayName(wantName) {
  if (!wantName) return null;
  const pool = await buildDisplayPool();
  const hits = pool.filter((p) => p.name === wantName);
  return hits.length === 1 ? hits[0].id : null; // 撞名/查無都不猜
}

async function main() {
  const apply = process.argv.includes("--apply");
  const roster = JSON.parse(fs.readFileSync(path.join(ROOT, ".tmp", "annual_roster.json"), "utf8"));
  const withId = roster.filter((r) => r.lineUserId);
  console.log(`${apply ? "APPLY" : "驗證"}：有 userId 的客人 ${withId.length} 位\n`);

  const good = [], fixed = [], dead = [];
  for (const r of withId) {
    if (await profileOk(r.lineUserId)) { good.push(r); await sleep(100); continue; }
    let real = mapToRealId(r.lineUserId);
    if (!(real && (await profileOk(real)))) {
      real = await mapByDisplayName(r.lineName);
    }
    if (real && (await profileOk(real))) {
      fixed.push({ ...r, realId: real });
      console.log(`  🔁 ${r.name}：${r.lineUserId.slice(0, 12)}…（死）→ ${real.slice(0, 12)}…（顯示名「${r.lineName || "?"}」）`);
    } else {
      dead.push(r);
      console.log(`  ❌ ${r.name}：${r.lineUserId.slice(0, 12)}… 不可推播，無法對映真 id`);
    }
    await sleep(100);
  }

  let patched = 0;
  if (apply && fixed.length) {
    for (const f of fixed) {
      for (const evId of [f.expiryEventId, f.deliveryEventId].filter(Boolean)) {
        try {
          const ev = await getEvent(evId);
          if (!ev || !(ev.description || "").includes(f.lineUserId)) continue;
          await patchEvent(evId, {
            description: ev.description.replace(new RegExp(f.lineUserId, "g"), f.realId),
          });
          patched++;
        } catch (e) {
          console.log(`  ⚠️ 修正失敗 ${f.name} ${evId}: ${e.message}`);
        }
      }
    }
  }

  console.log(`\n✅ 可直接推播：${good.length}`);
  console.log(`🔁 死 id 已對映真 id：${fixed.length}${apply ? `（行事曆已修 ${patched} 事件）` : "（--apply 修行事曆）"}`);
  console.log(`❌ 不可推播（封鎖或無法對映）：${dead.length}`);
  for (const d of dead) console.log(`   ${d.name}（到期 ${d.expiryDate}）`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error("失敗：", e.message); process.exit(1); });
