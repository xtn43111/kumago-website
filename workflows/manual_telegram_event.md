# 手動 Telegram → Google 行事曆 事件 SOP

> **目標**：除了線上付款自動建立的「入住配送」事件之外，老闆能直接在 Telegram
> 打一則訊息（可附一張照片）給 `@littleBKbear_bot`，就把行程加到 KUMAGO 行事曆。
> 照片會用**不外洩 token 的網址**存進事件內文，跟訂單存 Google 地圖連結一樣。

---

## 老闆怎麼用

### 自由格式（2026-07-15 起，推薦）

直接把資訊貼給 bot，**不用標籤**，只要內容裡有日期。全文自動抓：
日期（`7/17`、`2026-07-17`、`7月17日`、今天/明天/後天）、時間（`14:00-16:00`、
`下午2點半`、`早上9點`）、地址（帶日本地址特徵的行：丁目/番地/号室/〒/都府県市区）、
電話、Email、URL（當地圖連結）。第一行（去掉日期時間碎片後）當標題，其餘行全進備註。

```
湯睿心 加購冷氣安裝
7/17早上9點
大阪府大阪市住之江区中加賀屋4丁目5-20 303號室
09045743629
期滿要跟家電傢俱一起回收
```

解析器仍是純 regex（`freeFormScan`，無 AI、無網路）。測試：`node tools/test_tg_event.js`。

### 標籤格式（仍可用，要精準指定欄位時）

傳一則訊息給 bot，用固定欄位（全形 `：` 或半形 `:` 都可）：

```
標題：庭綺 回收
日期：2026-07-05
時間：14:00-16:00
地址：大阪市東成区大今里南6丁目15-21
聯絡：080-1234-5678
備註：3樓無電梯
```

- **必填**：`標題`、`日期`。其餘可省略。
- **第一行沒寫 `標題：`** 也行 → 會把第一行當標題。
- `日期`：`2026-07-05`、`2026/7/5`、`7月5日`、`7/5` 都可。沒寫年份時，自動取
  「今年的這天，若已過則明年」。
- `時間`：`14:00-16:00`（區間）或 `14:00`（只給開始 → 自動 +1 小時）。
  **不寫時間 = 整天事件**。`~`、`～`、`到` 也可當區間分隔。
- **照片**：直接在同一則訊息附一張照片（或把文字打在照片的說明/caption 裡）。
  事件內文會出現 `🖼 照片：https://kumago.7-mori.com/api/tg-photo?id=...`，
  點開就看得到圖。
- 欄位別名：標題=主題/事件/姓名/名字/title/name；地址=住址/address；
  地圖=地點/連結/map；聯絡=電話/phone；備註=注/note/memo。
  標題類標籤同時出現多個時，先到先贏，後到的整行進備註。
- 有打任何標籤（標題/日期/時間/地址/聯絡/備註）就走標籤解析，不會混用自由格式。

bot 會回一則確認（標題、日期、時間、是否附照片、行事曆連結）。
缺欄位時會回「還缺：日期」並附上格式範本。

---

## 幫既有行程加照片（2026-07-06 加）

老闆附**新照片**＋在說明打指令，新照片就**併入既有事件**的照片連結
（原有照片不動、合成同一個連結；不會建新事件）：

```
加照片：7/5 庭綺
（照片直接附上；多張用相簿）
```

- 指令別名：`加照片` / `新增照片` / `補照片` / `更新照片` / `換照片` / `改照片` / `照片更新`
  （全部都是**加**的語意，沒有取代）。
- **日期必填**；後面可加**標題關鍵字**鎖定是哪一筆（比對事件標題、不分大小寫）。
- 無年份日期＝**今年**（不像新增事件會滾到明年——加照片的對象常是已過的行程）。
- 該天只有一筆時關鍵字可省略；多筆命中會回清單請補關鍵字；找不到會明講。
- **合併規則**：先讀事件的 `extendedProperties.private.galleryIds`；沒有（舊事件）
  就從 🖼 那行的 `tg-photo?id=` / `tg-gallery?ids=` 連結把舊 file_id 挖回來，
  再把新照片接在後面。合併後 1 張 → `tg-photo` 直連；2 張以上 → 一條 `tg-gallery`。
- **相簿**：caption 那張把 `media_group_id` 蓋章到目標事件的
  `extendedProperties.private.mgid`，後續無 caption 的照片用 Calendar API 的
  `privateExtendedProperty` 搜尋找回目標事件、逐張併入。
- 例外：照片行若是**非本站代理的外部網址**（手動 `--photo` 帶進來的公開圖），
  挖不出 file_id、無法併入 gallery，會被新連結取代。
- 事件其他內容（地址/備註/時間…）一律不動；只打指令沒附照片會回「要附照片」。

實作：`lib/tg_event.js` `parsePhotoUpdate()`（純解析、可單測）＋
`api/telegram-webhook.js` 加照片分支（`photoIdsFromEvent()` 合併）＋
`lib/gcal.js` `findEventsByPrivateProp()`。

---

## 架構（檔案）

| 檔案 | 角色 |
|------|------|
| `api/telegram-webhook.js` | 接收 Telegram 更新 → 解析 → 寫月曆 → 回覆。**只認** `TELEGRAM_CHAT_ID`（老闆）的訊息，並用 secret header 擋外人。 |
| `lib/tg_event.js` | **純解析器**（無 AI、無網路）：把帶標籤的訊息變成 Calendar event。可單測。 |
| `lib/gcal.js` → `insertEvent()` | 通用寫入；用 `chat+message_id` 算出的固定 event id 做冪等 upsert（Telegram 重送不會重複建）。 |
| `api/tg-photo.js` | 照片代理：用 `?id=<telegram_file_id>`，伺服器端拿 bot token 去 Telegram 抓圖回傳。token 不外洩。 |
| `tools/manual_event.js` | 本機測試 / 設定 webhook 的工具。 |

手動事件也會**自動進每日 Telegram 行程摘要**（`lib/telegram.js` 讀全部事件），
照片連結會原樣顯示。

---

## 環境變數（`.env` 本機 + Vercel 都要設）

| 變數 | 說明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | （已有）BotFather token。 |
| `TELEGRAM_CHAT_ID` | （已有）老闆私訊 chat id；只處理這個人的訊息。 |
| `TELEGRAM_WEBHOOK_SECRET` | **新增**。Telegram 每次呼叫會帶 `X-Telegram-Bot-Api-Secret-Token`，比對失敗就 401。`.env` 已產一組。 |
| `PUBLIC_BASE_URL` | **新增**。`https://kumago.7-mori.com`，用來組照片代理網址。 |
| `GOOGLE_OAUTH_*` | （已有）寫月曆用，scope `calendar.events`。 |

---

## 上線步驟（順序很重要）

1. **先把 `TELEGRAM_WEBHOOK_SECRET`、`PUBLIC_BASE_URL` 加到 Vercel**
   （Project → Settings → Environment Variables，Production）。
2. `git push`（Vercel 自動部署）。**端點必須先上線**，否則下一步會把 Telegram
   指到一個還不存在的 404。
3. 註冊 webhook：`node tools/manual_event.js --set-webhook`
   （會印出結果；`drop_pending_updates` 會清掉測試期間累積的舊訊息）。
4. 用手機傳一則上面的格式給 bot，確認回覆 + 月曆出現事件 + 照片點得開。

查狀態：`node tools/manual_event.js --webhook-info`
移除：`node tools/manual_event.js --delete-webhook`

---

## 本機測試（不碰 Telegram）

```bash
# 只解析、印出 event JSON（不寫月曆）
node tools/manual_event.js --parse "標題：庭綺 回收\n日期：7/5\n時間：14:00-16:00"

# 真的寫進月曆（測完記得去月曆刪掉）
node tools/manual_event.js --create "標題：【測試】\n日期：2030-12-31"
```

模擬 Telegram 打進 webhook（需先跑 `PORT=8099 node tools/dev_server.js`）：

```bash
SECRET=$(grep '^TELEGRAM_WEBHOOK_SECRET=' .env | cut -d= -f2)
CHAT=$(grep '^TELEGRAM_CHAT_ID=' .env | cut -d= -f2)
curl -X POST localhost:8099/api/telegram-webhook \
  -H "X-Telegram-Bot-Api-Secret-Token: $SECRET" -H "Content-Type: application/json" \
  -d "{\"message\":{\"message_id\":1,\"chat\":{\"id\":$CHAT},\"text\":\"標題：x\\n日期：7/5\"}}"
```

---

## 注意 / 已知行為

- **冪等**：event id = `sha1(tg-<chat>-<message_id>)`。Telegram 重送同一則 →
  409 → 當成成功，不會重複建事件。
- **照片是 capability URL**：`file_id` 很長、不可猜，但**任何拿到連結的人都能看圖**
  （月曆連結本來就要免登入打開）。不外洩 bot token 是重點，已達成。
- webhook **永遠回 200**（處理完才回），避免 Telegram 不斷重送。內部錯誤會回一則
  Telegram 訊息告知老闆，不會 500。
- 一個 bot 不能同時用 webhook 和 getUpdates。本專案目前沒有別處在 poll，安全。
- 解析失敗時 bot 會回範本，不會默默吃掉訊息。
