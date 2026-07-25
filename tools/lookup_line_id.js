#!/usr/bin/env node
/* KUMAGO — 用姓名/電話反查客人 LINE userId（唯讀，供產付款連結帶 --line-user-id）。
 *
 * 四件標準要 LINE 通知客人 → 產連結前需客人 userId。此工具雙源反查＋實測驗證：
 *   來源1（乾淨、同 OA）：掃 KUMAGO Google 行事曆，事件 description 的
 *          「userId：Uxxx」＋同事件的姓名/電話比對。用過 LIFF/被配對的客人在這。
 *   來源2（補洞）：line-smart-cs garden 站 qa.db（唯讀）用顯示名/客人訊息反查。
 *          已實證 garden 與 KUMAGO 同一 LINE provider，userId 互通可推。
 *   驗證：每個候選 userId 用 KUMAGO channel token 打 LINE profile API，
 *          回 200＝確定在 KUMAGO OA 內、push-safe，並取回 displayName。
 *
 * 用法：
 *   node tools/lookup_line_id.js --name 王小明
 *   node tools/lookup_line_id.js --phone 09012345678
 *   node tools/lookup_line_id.js --name Diya --phone 08033716309
 *   [--no-verify]（跳過 LINE profile 實測）[--db <qa.db 路徑>]
 *
 * 唯讀：不改 qa.db、不改行事曆、不發任何訊息給客人（profile 查詢不觸及客人）。
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(".env");
loadEnv(".env.local");

const { listEvents, jstToday } = require(path.join(ROOT, "lib", "gcal.js"));

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "no-verify") { args.noVerify = true; continue; }
    args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return args;
}
function fail(msg) { console.error("❌ " + msg); process.exit(1); }

const UID_RE = /^U[0-9a-f]{32}$/;
function userIdFromDesc(t) { const m = (t || "").match(/userId[：:]\s*(U[0-9a-f]{32})/i); return m ? m[1] : null; }
function digits(s) { return String(s || "").replace(/[\s\-()（）．.]/g, "").replace(/^\+/, ""); }
function addDays(ymd, n) { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// ── 來源1：KUMAGO 行事曆 ──
async function fromCalendar(name, phone) {
  const today = jstToday();
  const events = await listEvents(addDays(today, -800) + "T00:00:00+09:00", addDays(today, 800) + "T00:00:00+09:00");
  const phoneD = phone ? digits(phone) : null;
  const hits = new Map(); // uid → {evidence:[]}
  for (const e of events) {
    const text = (e.summary || "") + "\n" + (e.description || "");
    const uid = userIdFromDesc(text);
    if (!uid) continue;
    const nameOk = name && text.includes(name);
    const phoneOk = phoneD && digits(text).includes(phoneD);
    if (!nameOk && !phoneOk) continue;
    const c = hits.get(uid) || { userId: uid, source: "行事曆", evidence: [] };
    if (c.evidence.length < 3) c.evidence.push(`${e.summary}（${(e.start && (e.start.date || e.start.dateTime)) || "?"}）${nameOk ? "名符" : ""}${phoneOk ? "電話符" : ""}`);
    hits.set(uid, c);
  }
  return [...hits.values()];
}

// ── 來源2：garden qa.db ──
function fromQaDb(name, phone, dbPath) {
  if (!fs.existsSync(dbPath)) return { rows: [], skipped: "qa.db 不存在：" + dbPath };
  const q = (sql) => {
    const out = execFileSync("sqlite3", ["-json", `file:${dbPath}?mode=ro`, sql], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
    return out ? JSON.parse(out) : [];
  };
  const esc = (s) => String(s).replace(/'/g, "''");
  const hits = new Map();
  const add = (uid, ev) => {
    if (!UID_RE.test(uid || "")) return;
    const c = hits.get(uid) || { userId: uid, source: "qa.db", evidence: [] };
    if (ev && c.evidence.length < 3) c.evidence.push(ev);
    hits.set(uid, c);
  };
  try {
    if (name) {
      for (const r of q(`SELECT display_name, imported_user_id, msg_count FROM customer_alias_index WHERE display_name LIKE '%${esc(name)}%' ORDER BY msg_count DESC LIMIT 8`))
        add(r.imported_user_id, `alias「${r.display_name}」(${r.msg_count}訊)`);
      for (const r of q(`SELECT customer_id, substr(text,1,50) AS t, created_at FROM customer_message WHERE direction='in' AND text LIKE '%${esc(name)}%' ORDER BY id DESC LIMIT 8`))
        add(r.customer_id, `訊息「${(r.t || "").replace(/\n/g, " ")}」@${r.created_at}`);
    }
    if (phone) {
      const pd = digits(phone);
      for (const r of q(`SELECT customer_id, substr(text,1,50) AS t, created_at FROM customer_message WHERE direction='in' AND replace(replace(replace(text,'-',''),' ',''),'+','') LIKE '%${esc(pd)}%' ORDER BY id DESC LIMIT 8`))
        add(r.customer_id, `訊息含電話「${(r.t || "").replace(/\n/g, " ")}」@${r.created_at}`);
    }
  } catch (e) {
    return { rows: [], skipped: "qa.db 查詢失敗：" + e.message };
  }
  return { rows: [...hits.values()] };
}

// ── LINE profile 實測 ──
async function verifyUid(uid, token) {
  try {
    const r = await fetch("https://api.line.me/v2/bot/profile/" + uid, { headers: { Authorization: "Bearer " + token } });
    if (r.ok) { const j = await r.json(); return { ok: true, displayName: j.displayName }; }
    return { ok: false, status: r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

(async () => {
  const a = parseArgs(process.argv);
  const name = (a.name || "").trim();
  const phone = (a.phone || "").trim();
  if (!name && !phone) fail("需 --name 或 --phone（可併用）");
  const dbPath = a.db || "/Users/peter/projects/line-smart-cs/data/qa.db";
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  console.log(`══ 反查 LINE userId ══  ${name ? "姓名=" + name : ""} ${phone ? "電話=" + phone : ""}\n`);

  // 合併雙源
  const merged = new Map(); // uid → {userId, sources:Set, evidence:[]}
  const cal = await fromCalendar(name, phone).catch((e) => { console.log("⚠️ 行事曆查詢出錯：" + e.message); return []; });
  const db = fromQaDb(name, phone, dbPath);
  if (db.skipped) console.log("ℹ️ 來源2 略過：" + db.skipped + "\n");
  for (const c of [...cal, ...(db.rows || [])]) {
    const m = merged.get(c.userId) || { userId: c.userId, sources: new Set(), evidence: [] };
    m.sources.add(c.source);
    m.evidence.push(...c.evidence);
    merged.set(c.userId, m);
  }
  const cands = [...merged.values()];
  if (!cands.length) { console.log("❌ 兩個來源都查無 userId。此客人可能沒用過 LIFF 也沒被配對——需其他管道取得。"); return; }

  // 驗證
  for (const c of cands) {
    if (a.noVerify || !token) { c.verify = { skipped: true }; continue; }
    c.verify = await verifyUid(c.userId, token);
  }
  // 排序：驗證通過（行事曆源優先）在前
  cands.sort((x, y) => (Number(!!y.verify.ok) - Number(!!x.verify.ok)) || (y.sources.has("行事曆") - x.sources.has("行事曆")));

  const valid = cands.filter((c) => c.verify.ok);
  const others = cands.filter((c) => !c.verify.ok);

  const show = (c) => {
    const badge = c.verify.skipped ? "（未驗）" : c.verify.ok ? `✅ push-safe　displayName：${c.verify.displayName}` : `⚠️ profile 回 ${c.verify.status || c.verify.error}（不在 KUMAGO OA / 無效）`;
    console.log(`${c.userId}  [${[...c.sources].join("+")}]  ${badge}`);
    c.evidence.slice(0, 3).forEach((ev) => console.log("    · " + ev));
  };

  if (valid.length) { console.log("── ✅ 可用（已 LINE profile 實測） ──"); valid.forEach(show); }
  if (others.length) { console.log((valid.length ? "\n" : "") + "── ⚠️ 候選（未通過/未驗，勿盲用） ──"); others.forEach(show); }

  console.log("");
  if (valid.length === 1) {
    console.log(`→ 直接用：--line-user-id ${valid[0].userId}`);
  } else if (valid.length > 1) {
    console.log("→ 多個 push-safe 候選，看 evidence 挑對的人再帶 --line-user-id。");
  } else {
    console.log("→ 沒有通過實測的候選。" + (a.noVerify || !token ? "（本次未驗；設 LINE_CHANNEL_ACCESS_TOKEN 或拿掉 --no-verify 才實測）" : "別盲用上面候選。"));
  }
})().catch((e) => fail(e.message));
