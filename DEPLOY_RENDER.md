# Render 部署說明

## 1. 部署前準備

- 建立 GitHub repository，將專案推上 GitHub。
- 確認不要 commit `.env`、SQLite DB 檔、`node_modules/`。
- 確認 `package.json` 有 `start` script：`npm run start` 會執行 `node server.js`。
- 正式部署必須設定 `ADMIN_PIN`，不得使用預設 `1234`。

## 2. Render 建立 Web Service

### A. 使用 `render.yaml` Blueprint

1. 在 Render 建立 Blueprint。
2. 連接 GitHub repository。
3. Render 會讀取 `render.yaml`，建立 Node Web Service。
4. 在 Render 的 Environment Variables 設定正式 `ADMIN_PIN`。
5. 確認 Persistent Disk 掛載在 `/var/data`，`DB_PATH=/var/data/queue.db`。

`render.yaml` 內含：

- Environment: Node
- Build Command: `npm install`
- Start Command: `npm run start`
- Health Check Path: `/health`
- `NODE_ENV=production`
- `DB_PATH=/var/data/queue.db`
- Persistent Disk: `/var/data`, 1GB

`plan: starter` 可依 Render UI 當下方案調整。正式考場用途不要使用 free instance；請選擇付費、always-on 的 Web Service。

### B. 使用 Render UI 手動建立 Web Service

設定建議：

- Environment: Node
- Build Command: `npm install`
- Start Command: `npm run start`
- Health Check Path: `/health`
- Environment Variables:
  - `NODE_ENV=production`
  - `ADMIN_PIN=自行設定`
  - `DB_PATH=/var/data/queue.db`
- Persistent Disk:
  - Mount Path: `/var/data`
  - Size: 1GB

SQLite 必須搭配 Persistent Disk。若未設定 Persistent Disk，redeploy 或 restart 後資料可能遺失。

## 3. 部署後測試網址

假設 Render 網址是：

```text
https://your-app.onrender.com
```

測試：

- `https://your-app.onrender.com/health`
- `https://your-app.onrender.com/admin.html`
- `https://your-app.onrender.com/display.html`
- `https://your-app.onrender.com/public.html`
- `https://your-app.onrender.com/api/state`

## 4. 正式使用網址分工

- `admin.html`：只給工作人員。
- `display.html`：現場大螢幕。
- `public.html`：民眾 QR Code 只讀頁。

## 5. QR Code

QR Code 應指向：

```text
https://your-app.onrender.com/public.html
```

不要指向：

- `admin.html`
- `display.html`

## 6. 現場注意事項

- admin PIN 不得外流。
- `display.html` 開在現場大螢幕。
- `public.html` 給民眾掃。
- Render 若服務重啟，display/public 會自動重新連線並讀 `/api/state`。
- SQLite 資料保存依 Persistent Disk。
- 若未設定 Persistent Disk，資料可能因 redeploy / restart 遺失。

## 7. 驗收清單

- `/health` 回 `ok: true`。
- `/api/state` 回 `ok: true`。
- `admin.html` 可登入。
- 未授權 admin API 回 401。
- `display.html` 可更新。
- `public.html` 可更新。
- 後台順號後 display/public 都同步。
- 50 人 smoke test 可在雲端網址調整後執行：

```bash
BASE_URL=https://your-app.onrender.com ADMIN_PIN=你的PIN npm run smoke:50
```
