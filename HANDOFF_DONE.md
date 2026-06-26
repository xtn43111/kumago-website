# KUMAGO 網站上線交接文件 ✅

> 本文件記錄 KUMAGO 網站從部署到正式收款的完整設定狀態，供後續維護 / 接手使用。

---

## 🎉 全部設定完成

| 項目 | 狀態 |
|------|------|
| 網站上線 https://kumago.7-mori.com | ✅ 200 OK、SSL 正常 |
| Vercel 部署（最新含環境變數） | ✅ Ready / Production |
| Cloudflare DNS（CNAME 灰雲，沒動根網域） | ✅ |
| 7 個環境變數（全部 Sensitive） | ✅ 已填、已重新部署生效 |
| Stripe 正式模式金鑰（sk_live / pk_live） | ✅ 已設 |
| Stripe Webhook → /api/stripe-webhook | ✅ 已建、endpoint 回應正確（405/POST） |

---

## ⚠️ 最後一步：實測結帳（強烈建議你做）

技術設定都通了，但因為現在是正式模式、會收真錢，**不會也不該幫你跑一筆真實付款**。建議自己做一次端到端測試：

1. 開 https://kumago.7-mori.com ，走完整下單流程到 Stripe 結帳頁
2. 用真實的卡下一筆小額訂單（或先下單到結帳頁、確認金額/運費正確）
3. 付款後檢查：
   - 是否跳轉到 `success.html` 成功頁
   - `OWNER_EMAIL` 信箱有沒有收到訂單通知信（這驗證 webhook + SMTP 都通）
   - Stripe 後台 → Developers → Webhooks → 你的 endpoint 是否顯示 event 成功送達（綠勾、200）

> 如果通知信沒收到，通常是 `STRIPE_WEBHOOK_SECRET` 或 SMTP 設定問題，到 Stripe webhook 頁看 event 回應碼就能定位。

---

## 📌 幾個提醒

- **付款是真錢**：現在每筆都是實際扣款，測試完記得處理測試訂單（如需退款在 Stripe 後台操作）。
- **本機 `.env` 還是 test 金鑰**：本機開發仍用 test 沒問題；只有 Vercel 上是 live。
- **根網域 `7-mori.com` 完全沒動**，原本的服務不受影響。

---

## 🔧 技術設定明細（供 debug 參考）

### 部署
- 正式網址：https://kumago.7-mori.com
- Vercel 專案：`kumago-website`（Hobby 方案）
- GitHub repo：`xtn43111/kumago-website`（推 main 自動重新部署）
- DNS：Cloudflare `kumago` CNAME → `cname.vercel-dns.com`（灰雲 DNS only）
- SSL：Let's Encrypt 自動簽發

### 環境變數（存在 Vercel，皆 Sensitive / Production+Preview）
- `STRIPE_SECRET_KEY`（sk_live）
- `STRIPE_PUBLISHABLE_KEY`（pk_live）
- `STRIPE_WEBHOOK_SECRET`（whsec_...）
- `SMTP_USER`
- `SMTP_APP_PASSWORD`
- `MAIL_FROM_NAME`
- `OWNER_EMAIL`

### Serverless API
- `api/create-checkout-session.js` — Stripe 結帳
- `api/stripe-webhook.js` — 處理 `checkout.session.completed`，驗簽後寄訂單信
- `lib/mailer.js` — nodemailer 寄信

### Stripe Webhook
- Endpoint URL：`https://kumago.7-mori.com/api/stripe-webhook`
- 訂閱事件：`checkout.session.completed`
- 驗證：對 `STRIPE_WEBHOOK_SECRET` 驗簽
- 健康檢查：`curl -sI https://kumago.7-mori.com/api/stripe-webhook` → 應回 `HTTP/2 405`、`allow: POST`

---

## 🩺 常見問題排查

| 症狀 | 可能原因 | 檢查方式 |
|------|----------|----------|
| 訂單通知信沒收到 | `STRIPE_WEBHOOK_SECRET` 不符 | Stripe → Webhooks → event 回應碼非 200 |
| 訂單通知信沒收到 | SMTP 帳密 / app password 錯 | Vercel 部署 Logs 看寄信錯誤 |
| 結帳頁打不開 | env 缺 `STRIPE_SECRET_KEY` | Vercel → Settings → Environment Variables |
| 金額/運費錯 | 前端方案設定 | 結帳頁金額對照備忘錄 |
| 網站打不開 | DNS / 部署 | `curl -sI https://kumago.7-mori.com` 應回 200 |

---

## 接手者下一步

- [ ] 自行做一次端到端實測結帳（見上方「最後一步」）
- [ ] 確認 success 頁、通知信、Stripe webhook 綠勾三者皆通
- [ ] 測試訂單若為真實扣款，於 Stripe 後台退款處理

---

_文件產生日期：2026-06-27_
