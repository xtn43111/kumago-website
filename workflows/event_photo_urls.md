# 交接文件：加入行程時，圖片用「網址」表示

> **一句話**：行事曆事件裡**不塞圖片檔**，只放一條**點得開的圖片網址**。
> 圖存在 Telegram，網址存在事件內文，任何有連結的人免登入就能看圖。

---

## 為什麼用網址，不直接放圖

- Google 行事曆事件本體不適合塞大圖；手機版對很長的網址還會截斷。
- 所以我們統一：**圖片 → 一條網址 → 放進事件備註**。
- 圖片實體留在 Telegram，我方伺服器當「代理」轉出來，**bot token 不外洩**。

---

## 網址長怎樣

```
https://kumago.7-mori.com/api/tg-photo?id=<telegram_file_id>
```

- `<telegram_file_id>` 是 Telegram 給每張圖的一串亂碼代號，猜不到。
- 點開 → 我方伺服器 `api/tg-photo.js` 拿 bot token 去 Telegram 抓原圖 → 直接顯示。
- 事件內文裡是**可點的連結**（HTML `<a>`），不是一長串裸網址：

  ```
  🖼 照片：點此查看
  ```

  （手機版行事曆會截斷裸網址的尾巴 → 圖打不開；用 `<a href>` 就安全。）

---

## 兩種加行程的方式，圖片怎麼帶

### 1) 最常用：Telegram 傳訊息給 bot（老闆日常用這個）

在同一則訊息**直接附一張照片**（文字可打在照片的說明/caption 裡）：

```
標題：庭綺 回收
日期：7/5
時間：14:00-16:00
地址：大阪市東成区…
（照片直接附上）
```

系統會**自動**把照片轉成上面的網址，塞進事件的「🖼 照片」那行。你什麼都不用做。
> 細節：webhook 取「最高解析度那張」的 file_id → 組出 `/api/tg-photo?id=…` 網址。

### 2) 本機/手動：用工具指令加事件，圖片用現成網址帶入

若圖片已經有一條網址（例如先前事件裡的 `tg-photo` 連結、或任何公開圖片網址），
可以直接 `--photo` 帶進去：

```bash
node tools/manual_event.js --create "標題：庭綺 回收\n日期：7/5\n時間：14:00-16:00" \
  --photo "https://kumago.7-mori.com/api/tg-photo?id=<file_id>"
```

事件內文就會出現同樣的「🖼 照片：點此查看」連結。
> 沒有網址、只有本機圖檔時：先在 Telegram 傳給 bot（方式 1），系統會生出一條
> `tg-photo` 網址，之後就能重複拿來用。

### 3) 幫既有事件加照片（2026-07-06 加）

事件已存在、想補照片：附新照片＋說明打 `加照片：7/5 庭綺`
（日期必填，關鍵字選填）。新照片**併入**原有照片成同一個連結：
合併後 1 張是 `tg-photo`、2 張以上是一條 `tg-gallery`，原有照片不會被蓋掉。
詳見 `workflows/manual_telegram_event.md`。

---

## 一個事件、多張照片 → 同一個相簿連結

要一次帶**多張**照片時，在 Telegram 用**相簿**（一次選多張一起送），並把
標題／日期那段文字打在**相簿的說明（caption）**裡。系統會：

- 把整組照片存成**一條相簿連結**：`/api/tg-gallery?ids=<id1>,<id2>,...`
- 事件內文只出現一行「🖼 照片：點此查看」，點開是一頁**看到全部照片**。
- bot 只會回**一則**確認（不會每張回一次）。

原理：Telegram 的相簿會拆成多則更新、共用一個 `media_group_id`。webhook 用這個
id 當事件鍵，把每張的 `file_id` **累加**進同一條相簿連結（存在事件的
`extendedProperties`，所以後續照片是乾淨地併入，不會重建）。

注意事項：
- **文字要放在相簿說明裡**（放在其中一張的 caption）；沒有文字的純照片相簿無法
  建立事件（缺標題／日期）。
- webhook 以 `max_connections=1` 註冊，讓相簿的多則更新**依序**進來，累加不會打架。
  改了這個設定後要重跑 `node tools/manual_event.js --set-webhook` 才生效。
- 單張照片維持原樣（走 `/api/tg-photo` 直連），不受影響。

---

## 相關檔案（誰做什麼）

| 檔案 | 角色 |
|------|------|
| `api/tg-photo.js` | 照片代理：收 `?id=<file_id>`，伺服器端抓圖回傳。token 不外洩。 |
| `api/tg-gallery.js` | **相簿頁**：收 `?ids=id1,id2,...`，把多張圖用 `tg-photo` 逐一內嵌成一頁。 |
| `api/telegram-webhook.js` | 收訊息 → 單張組 `/api/tg-photo`；相簿則用 `media_group_id` 累加成 `/api/tg-gallery`。 |
| `lib/tg_event.js` | 把網址寫進事件內文的「🖼 照片」那行（`photoDescLine`，用 `<a href>` 避免截斷）。 |
| `lib/gcal.js` | `getEvent` / `patchEvent`：相簿累加時讀回事件、併入新 `file_id`。 |
| `tools/manual_event.js` | 本機手動加事件；`--set-webhook`（含 `max_connections=1`）。 |

需要的環境變數：`TELEGRAM_BOT_TOKEN`（抓圖）、`PUBLIC_BASE_URL`（組網址，＝
`https://kumago.7-mori.com`）。兩者 `.env` 與 Vercel 都要有。

---

## ⚠️ 照片來源的教訓（2026-07-03）

- **絕不要從月份 PDF 抽圖當事件照片**：老闆的筆記匯出成 PDF 時，照片會被壓成
  ~192px 縮圖（實測 2025年6~10月 PDF 全是縮圖），上傳後完全模糊、無法辨識。
- 高解析度原圖只存在 **iCloud 筆記本體**。要批次抓圖一律走
  `tools/note_capture.js`（需使用者先開 debug Chrome：port 9222、登入 iCloud、
  打開該月筆記），它直接抓 blob 原始 bytes，解析度完整（1000~2500px）。
- 已上傳的模糊照片要重弄：建 mapping 後跑
  `node tools/attach_note_photos.js <mapping.json> --apply --replace`
  （`--replace` 會覆蓋既有相簿；原 description 仍備份在 `<mapping>.backup.json`）。
- 全事件照片解析度盤點結果存在 `.tmp/photo_audit.json`（2026-07-03 產出：
  76/84 個事件是模糊縮圖，集中 2025-06→2025-10，另含 2026-06-27 一筆）。

## 注意

- **連結＝免登入可看**：拿到網址的人都能看那張圖（行事曆連結本來就要免登入打開）。
  不能外洩的是 bot token，這點已經做到（圖是經我方伺服器轉出，token 不出現在網址）。
- 圖片**永久**：同一個 file_id 對應的圖不會變，網址可長期使用、可重複貼到別的事件。
- 更完整的手動事件流程另見 `workflows/manual_telegram_event.md`。
