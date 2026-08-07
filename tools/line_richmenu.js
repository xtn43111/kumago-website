/* KUMAGO — LINE 圖文選單（Rich Menu）管理工具。
 *
 * 用途：查詢 / 建立 / 上傳圖 / 設為預設 / 刪除 圖文選單。
 * Token：從專案根目錄 .env 讀 LINE_CHANNEL_ACCESS_TOKEN（Messaging API channel）。
 * 絕不印出 token。
 *
 * 子命令：
 *   node tools/line_richmenu.js inspect [outDir]
 *       列出所有 rich menu、標出目前「所有人預設」，並把每張選單圖下載到 outDir。
 *       輸出一份 JSON（含每顆按鈕的 bounds 座標與 action），方便重建時原樣保留。
 *   node tools/line_richmenu.js create <menu.json>      → 印出新 richMenuId
 *   node tools/line_richmenu.js upload <richMenuId> <image.(png|jpg)>
 *   node tools/line_richmenu.js setdefault <richMenuId>
 *   node tools/line_richmenu.js delete <richMenuId>
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/* 從 .env 讀單一 key，不依賴 dotenv 套件，不印出值。 */
function readEnv(key) {
  const p = path.join(ROOT, ".env");
  let txt = "";
  try { txt = fs.readFileSync(p, "utf8"); } catch { return null; }
  for (const raw of txt.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
  }
  return null;
}

const TOKEN = readEnv("LINE_CHANNEL_ACCESS_TOKEN");
if (!TOKEN) {
  console.error("❌ .env 找不到 LINE_CHANNEL_ACCESS_TOKEN");
  process.exit(1);
}
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const API = "https://api.line.me/v2/bot";
const DATA = "https://api-data.line.me/v2/bot";

async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json() : await r.text();
  return { ok: r.ok, status: r.status, body };
}

async function listMenus() {
  const r = await api(`${API}/richmenu/list`, { headers: AUTH });
  if (!r.ok) throw new Error(`list 失敗 ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.richmenus || [];
}

async function getDefaultId() {
  const r = await api(`${API}/user/all/richmenu`, { headers: AUTH });
  if (r.status === 404) return null;               // 尚未設定任何預設
  if (!r.ok) throw new Error(`get default 失敗 ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.richMenuId || null;
}

async function downloadImage(richMenuId, outPath) {
  const r = await fetch(`${DATA}/richmenu/${richMenuId}/content`, { headers: AUTH });
  if (!r.ok) return { ok: false, status: r.status };
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  const ct = r.headers.get("content-type") || "";
  return { ok: true, bytes: buf.length, contentType: ct };
}

async function inspect(outDir) {
  outDir = outDir || path.join(ROOT, ".tmp", "richmenu");
  fs.mkdirSync(outDir, { recursive: true });
  const [menus, defaultId] = await Promise.all([listMenus(), getDefaultId()]);

  const report = { count: menus.length, defaultRichMenuId: defaultId, menus: [] };
  console.log(`\n共 ${menus.length} 張 rich menu；目前所有人預設 = ${defaultId || "（無）"}\n`);

  for (const m of menus) {
    const isDefault = m.richMenuId === defaultId;
    const imgName = `menu_${m.richMenuId.slice(-8)}${isDefault ? "_DEFAULT" : ""}.png`;
    const imgPath = path.join(outDir, imgName);
    const dl = await downloadImage(m.richMenuId, imgPath);
    console.log(`${isDefault ? "★ [預設] " : "  "}${m.name}  (${m.richMenuId})`);
    console.log(`    尺寸 ${m.size.width}x${m.size.height}  chatBarText="${m.chatBarText}"  selected=${m.selected}`);
    console.log(`    按鈕 ${m.areas.length} 顆：`);
    m.areas.forEach((a, i) => {
      const act = a.action || {};
      const detail = act.uri || act.text || act.data || act.label || JSON.stringify(act);
      console.log(`      #${i + 1} [x=${a.bounds.x} y=${a.bounds.y} w=${a.bounds.width} h=${a.bounds.height}]  ${act.type} → ${detail}`);
    });
    console.log(`    圖：${dl.ok ? imgPath + ` (${dl.bytes} bytes, ${dl.contentType})` : "下載失敗 " + dl.status}`);
    console.log("");
    report.menus.push({ ...m, isDefault, image: dl.ok ? imgPath : null });
  }

  const jsonPath = path.join(outDir, "richmenu_report.json");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`完整結構已存：${jsonPath}`);
  return report;
}

async function create(jsonPath) {
  const menu = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const r = await api(`${API}/richmenu`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(menu),
  });
  if (!r.ok) throw new Error(`create 失敗 ${r.status}: ${JSON.stringify(r.body)}`);
  console.log(r.body.richMenuId);
  return r.body.richMenuId;
}

async function upload(richMenuId, imgPath) {
  const ext = path.extname(imgPath).toLowerCase();
  const ct = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  const buf = fs.readFileSync(imgPath);
  const r = await fetch(`${DATA}/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": ct },
    body: buf,
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`upload 失敗 ${r.status}: ${body}`);
  console.log(`✓ 已上傳圖片 (${buf.length} bytes, ${ct}) → ${richMenuId}`);
}

async function setDefault(richMenuId) {
  const r = await api(`${API}/user/all/richmenu/${richMenuId}`, { method: "POST", headers: AUTH });
  if (!r.ok) throw new Error(`setdefault 失敗 ${r.status}: ${JSON.stringify(r.body)}`);
  console.log(`✓ 已設為所有人預設：${richMenuId}`);
}

async function listAliases() {
  const r = await api(`${API}/richmenu/alias/list`, { headers: AUTH });
  if (!r.ok) throw new Error(`alias list 失敗 ${r.status}: ${JSON.stringify(r.body)}`);
  const aliases = r.body.aliases || [];
  console.log(`\n共 ${aliases.length} 個 rich menu alias（別名 → 選單 id）：`);
  for (const a of aliases) console.log(`  ${a.richMenuAliasId}  →  ${a.richMenuId}`);
  if (!aliases.length) console.log("  （無 alias — 語言切換不是靠 alias）");
  return aliases;
}

// 舊/新選單 id → 人類可讀標籤（診斷用）
const MENU_LABELS = {
  "richmenu-9f909a0ad8250721f1e13c7b1b412c04": "舊·中",
  "richmenu-61d1235cbbe8dd48681af7bae4746fcc": "舊·日",
  "richmenu-dafa9d6f62ea0aa6f0d13d3ca0a35d20": "舊·英",
  "richmenu-0f5cb03f660f6fe57ac9060f77374037": "新·中(預設)",
  "richmenu-743e8f9193f8cf070b3cb4e110185c69": "新·日",
  "richmenu-bb03bd9d7c271c485e403e6008cb7815": "新·英",
};

// 抽樣 follower，看每人「個別指派」到哪張選單（或吃預設）。只回統計，不印 userId。
async function diag(sampleN) {
  sampleN = Number(sampleN) || 20;
  const r = await api(`${API}/followers/ids?limit=1000`, { headers: AUTH });
  if (!r.ok) {
    console.log(`followers/ids 取得失敗 ${r.status}: ${JSON.stringify(r.body)}`);
    console.log("（此端點需 OA 具備權限；若不行，改用單一 userId 診斷：node tools/line_richmenu.js userlink <userId>）");
    return;
  }
  const ids = r.body.userIds || [];
  console.log(`follower 總數（本頁）≈ ${ids.length}${r.body.next ? "（還有更多頁）" : ""}，抽樣前 ${Math.min(sampleN, ids.length)} 位：`);
  const tally = {};
  for (const uid of ids.slice(0, sampleN)) {
    const rr = await api(`${API}/user/${uid}/richmenu`, { headers: AUTH });
    let key;
    if (rr.status === 404) key = "吃預設（無個別指派）";
    else if (rr.ok) key = MENU_LABELS[rr.body.richMenuId] || ("其他:" + rr.body.richMenuId);
    else key = "查詢失敗 " + rr.status;
    tally[key] = (tally[key] || 0) + 1;
  }
  console.log("個別指派分佈：");
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${v} 位 → ${k}`);
}

// 查單一 userId 目前被指派到哪張選單
async function userlink(uid) {
  const r = await api(`${API}/user/${uid}/richmenu`, { headers: AUTH });
  if (r.status === 404) return console.log("此 user 無個別指派 → 吃預設（新·中）");
  if (!r.ok) return console.log(`查詢失敗 ${r.status}: ${JSON.stringify(r.body)}`);
  console.log(`此 user 被個別指派 → ${MENU_LABELS[r.body.richMenuId] || r.body.richMenuId}`);
}

async function deploy(jsonPath, imgPath, makeDefault) {
  const id = await create(jsonPath);      // prints id
  await upload(id, imgPath);
  if (makeDefault) await setDefault(id);
  console.log(`DEPLOYED ${path.basename(jsonPath)} → ${id}${makeDefault ? " (預設)" : ""}`);
  return id;
}

async function del(richMenuId) {
  const r = await api(`${API}/richmenu/${richMenuId}`, { method: "DELETE", headers: AUTH });
  if (!r.ok) throw new Error(`delete 失敗 ${r.status}: ${JSON.stringify(r.body)}`);
  console.log(`✓ 已刪除：${richMenuId}`);
}

const [cmd, ...args] = process.argv.slice(2);
(async () => {
  try {
    switch (cmd) {
      case "inspect": await inspect(args[0]); break;
      case "aliases": await listAliases(); break;
      case "diag": await diag(args[0]); break;
      case "userlink": await userlink(args[0]); break;
      case "create": await create(args[0]); break;
      case "deploy": await deploy(args[0], args[1], args[2] === "default"); break;
      case "upload": await upload(args[0], args[1]); break;
      case "setdefault": await setDefault(args[0]); break;
      case "delete": await del(args[0]); break;
      default:
        console.error("用法：inspect [outDir] | create <json> | upload <id> <img> | setdefault <id> | delete <id>");
        process.exit(1);
    }
  } catch (e) {
    console.error("❌", e.message);
    process.exit(1);
  }
})();
