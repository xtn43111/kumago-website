# KUMAGO 網站 — DNS / 自訂網域交接文件

> 目的：把 KUMAGO 網站的所有部署資訊整理給「另一個負責設定 Cloudflare DNS 的 session」。
> 建立日期：2026-06-26。本文件不含任何密鑰，可安全傳閱。

---

## 1. 任務目標
把使用者**自己的 Cloudflare 網域**接到這個網站的 Vercel 部署上。
- 要設定**根網域 + www 兩個都要**（例如 `kumago.com` 與 `www.kumago.com`），其中一個當主網域、另一個自動轉址。
- 使用者決定**自己在瀏覽器手動點 DNS**，由 AI 在旁邊指引 + 驗證（不交出 Cloudflare 帳號，也不用 API token）。
- ⚠️ 使用者的實際網域名稱**尚未提供** —— 接手後第一件事就是請使用者打出網域名稱。

---

## 2. 專案基本資料
| 項目 | 內容 |
|------|------|
| 本機路徑 | `/Users/peter/kumago website` |
| GitHub repo | https://github.com/xtn43111/kumago-website （**public**，remote 名 `origin`） |
| 分支 | `main`，目前與 `origin/main` **完全同步** |
| 最新 commit | `7de3709` — “Add postal-code shipping zones, two delivery slots, live LINE account”（2026-06-26 20:53 +0900） |
| 部署平台 | **Vercel**，每次 push 到 `main` 自動重新部署 |
| 使用者 Vercel | 已登入後台 |
| 使用者 GitHub | xtn43111 / 信箱 xtn43111@gmail.com |

**目前還不知道線上 Vercel 網址**（`*.vercel.app`）。本機沒有 `.vercel` 連結檔、沒裝 vercel CLI；試過 `kumago-website.vercel.app` 等都 404，代表 Vercel 專案名稱跟猜測不同。→ 接手後請使用者從 Vercel 後台「Visit / Settings → Domains」把實際網址貼出來。

---

## 3. 這不是純靜態站 —— 有 Serverless Functions（重要）
CLAUDE.md 寫「靜態站、無 build step」，但 repo 實際上含 Vercel serverless API：
- `api/create-checkout-session.js` — Stripe 結帳
- `api/stripe-webhook.js` — Stripe webhook 接收
- `lib/mailer.js` — nodemailer 寄信

前端檔案：`index.html` `styles.css` `script.js`、`order.html/.css/.js`、`success.html`、`assets/`。
設定檔：`vercel.json`（`cleanUrls: true`、assets 長快取）。
相依：`nodemailer`、`puppeteer-core`（puppeteer 只是本機截圖工具，部署用不到，已 gitignore `node_modules/`）。

**換網域對 Stripe 的影響 —— 一定要提醒使用者：**
網站用到的環境變數（值存在 Vercel 後台，不在 repo）：
`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`SMTP_USER`、`SMTP_APP_PASSWORD`、`MAIL_FROM_NAME`、`OWNER_EMAIL`、`PORT`

➡️ **若 Stripe webhook 的 endpoint 目前指向舊的 `*.vercel.app` 網址，換成自訂網域後，要去 Stripe 後台把 webhook URL 改成新網域**（例如 `https://kumago.com/api/stripe-webhook`），否則付款通知會收不到。設完 DNS 後記得檢查這一項。

---

## 4. DNS 設定步驟（交給此 session 執行指引）

### 步驟 1 — Vercel 加網域
Vercel → KUMAGO 專案 → **Settings → Domains** → 輸入網域 Add；根網域與 `www.` 兩個都加（或選「Add www and redirect」）。加完會顯示 Invalid Configuration，正常，設完 DNS 就變綠。

### 步驟 2 — Cloudflare 加 DNS 記錄
Cloudflare → 選網域 → **DNS → Records**，新增兩筆：

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| **A** | `@` | `76.76.21.21` | **DNS only（灰雲 ☁️）** |
| **CNAME** | `www` | `cname.vercel-dns.com` | **DNS only（灰雲 ☁️）** |

> 🔑 **最關鍵陷阱**：Proxy 一定要灰雲「DNS only」，**不要橙雲 Proxied**，否則會跟 Vercel SSL 打架（憑證錯誤 / 無限轉址）。
> 🔑 **以 Vercel 畫面顯示的數值為準** —— Vercel 給的 IP / CNAME 偶爾跟上表不同，要照它畫面寫。
> 若 Cloudflare 原本有舊的 `@` 或 `www` 記錄會衝突，需先刪除舊的。

### 步驟 3 — 等生效
回 Vercel Domains 頁，約 1～30 分鐘兩個網域變綠勾，Vercel 自動簽 SSL。

### 步驟 4 — 驗證（AI 可用指令幫忙）
```bash
# 換成實際網域
curl -sI https://kumago.com        | head -5
curl -sI https://www.kumago.com    | head -5
```
看是否 200 / 正常轉址、SSL 是否生效。

### 步驟 5 — 收尾檢查
- [ ] 根網域與 www 都能開、SSL 正常
- [ ] 確認 Stripe webhook endpoint 是否需改新網域（見第 3 節）
- [ ] （選用）日後想開 Cloudflare 加速，再把雲改橙、SSL/TLS 模式設「Full」

---

## 5. 部署 / 推送規則（沿用 CLAUDE.md）
1. **localhost 先驗**：`python3 -m http.server 8080` → http://127.0.0.1:8080
2. 每個視覺改動都要在手機寬度（375/390/768/1440px）確認**零水平溢出**。
3. **未經使用者明說「push」前，絕不 `git push`**（可本機 commit）。
4. 收到「push」：`git add -A` → commit → `git push`，Vercel 自動重部署。
5. 絕不提交密鑰；`.gitignore` 已排除 `.env*`、`credentials.json`、`token.json`、`.claude/settings.local.json`、`node_modules/`、`.tmp/`。
6. GitHub 用 `gh` CLI；若失效用含 `repo`+`read:org` scope 的 classic token 重新登入。
