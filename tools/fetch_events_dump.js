#!/usr/bin/env node
/* 一次性：抓 KUMAGO 行事曆指定期間全部事件，落地 .tmp/ 供決算清單分析。
 * 用法：node tools/fetch_events_dump.js 2025-07-01 2026-07-01 */
const fs = require("fs");
const path = require("path");

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

const { listEvents } = require("../lib/gcal");

(async () => {
  const from = process.argv[2] || "2025-07-01";
  const to = process.argv[3] || "2026-07-01";
  const items = await listEvents(`${from}T00:00:00+09:00`, `${to}T00:00:00+09:00`);
  const slim = items.map((e) => ({
    id: e.id,
    status: e.status,
    summary: e.summary || "",
    start: e.start,
    end: e.end,
    description: e.description || "",
    location: e.location || "",
  }));
  const outDir = path.join(ROOT, ".tmp");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `gcal_events_${from}_${to}.json`);
  fs.writeFileSync(out, JSON.stringify(slim, null, 1));
  console.log(`events=${slim.length} -> ${out}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
