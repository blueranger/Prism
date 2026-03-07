# Teams Connector 測試步驟

## 前置準備

### Step 0：確認專案可以正常運行

```bash
cd prism
npm run dev          # 同時啟動 web + api
# 確認沒有報錯，然後 Ctrl+C 停掉
```

---

## Phase A：純邏輯測試（不需要 Chrome）

這階段測試 DB 操作、類別邏輯、Agent 註冊，不需要開 Chrome。

### Step 1：執行 --skip-browser 模式

```bash
cd apps/api
npx tsx src/tests/test-teams-connector.ts --skip-browser --verbose
```

**預期結果：**
- ✅ import shared-browser module
- ✅ import teams-puppeteer module
- ✅ TeamsChatItem type shape
- ✅ initialize test DB
- ✅ import TeamsConnector and register type
- ✅ create TeamsConnector instance
- ✅ activateTeamsConnector() persists to DB
- ✅ setChatConfigs() and getChatConfigs()
- ✅ getMonitoredChatNames() filters correctly
- ✅ updateChatConfig() updates single chat
- ✅ import teams-monitor module
- ✅ agent registered in registry
- ✅ isTeamsMonitoringActive() returns false initially
- ✅ startTeamsMonitoring / stopTeamsMonitoring lifecycle
- ✅ startPolling() skips Teams connectors
- ✅ line-puppeteer uses SharedBrowserManager
- ⏭ 所有 requiresBrowser 的測試會顯示 skipped

**如果失敗：**
- DB 相關錯誤 → 檢查 `better-sqlite3` 是否正確安裝：`npm ls better-sqlite3`
- import 錯誤 → 執行 `npx tsc --noEmit 2>&1 | grep "apps/api"` 確認編譯無誤

---

## Phase B：瀏覽器整合測試（需要 Chrome + Teams Web）

### Step 2：啟動 Chrome（Remote Debug 模式）

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/prism-chrome-profile"
```

> ⚠️ 如果 Chrome 已經在運行，必須先完全關閉再用上面的指令重啟。
> 否則 `--remote-debugging-port` 不會生效。

**驗證 Chrome 可以連接：**

```bash
curl -s http://127.0.0.1:9222/json/version | head -5
```

應該看到類似：
```json
{
  "Browser": "Chrome/...",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/..."
}
```

### Step 3：登入 Teams Web

1. 在 Chrome 中打開 `https://teams.microsoft.com`
2. 登入你的帳號
3. 切換到 **Chat** 頁籤
4. 確認可以看到聊天列表（至少要有 1 個聊天）
5. **不要關閉這個 Tab**

### Step 4：（可選）確認 LINE Extension 也在

如果你有 LINE Chrome Extension：
1. 確認 LINE Extension 已安裝並登入
2. 開啟 LINE Extension 頁面（`chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc/index.html`）

> 沒有 LINE Extension 也可以，共存測試會 graceful skip。

### Step 5：執行完整測試

```bash
cd apps/api
npx tsx src/tests/test-teams-connector.ts --verbose
```

**預期結果（新增的瀏覽器測試）：**

```
📦 SharedBrowserManager Tests
  ✅ connect to Chrome
  ✅ isConnected() returns true after connect
  ✅ getPage() returns null for unknown key
  ✅ isPageAlive() returns false for unknown key
  ✅ getOrCreatePage() creates and caches page

🌐 Teams Puppeteer (Network Interception) Tests
  ✅ connectToTeams() and initial interception
  ✅ readChatList() returns TeamsChatItem[]     ← 核心：確認能讀到聊天列表
  ✅ getCachedAuthToken() returns token          ← 確認 token 被攔截
  ✅ getDiscoveryLog() returns API call log      ← 確認有攔截到 API 呼叫
  ✅ getCacheStatus() shows discovered endpoints
  ✅ readChatMessages() for first chat           ← 確認能讀到訊息內容

🟢 LINE / Teams Coexistence Tests
  ✅ SharedBrowserManager has separate pages     ← 兩個 Tab 共存
  ✅ LINE connectToLine() uses SharedBrowserManager
```

**常見問題：**
- `connectToTeams()` 失敗 → Chrome 沒有用 `--remote-debugging-port=9222` 啟動
- `readChatList()` 回傳 0 個 chat → Teams 還在載入中，等幾秒重試
- `getCachedAuthToken()` 為 null → Teams 尚未發出 API 呼叫，重新載入 Teams 頁面後重試

---

## Phase C：API 端點手動測試

### Step 6：啟動 Prism 後端

```bash
cd prism
npm run dev
```

等看到 `API server listening on port 3001`（或你的 API_PORT）。

### Step 7：連接 Teams Connector

```bash
# 連接 Teams
curl -s -X POST http://localhost:3001/api/connectors/connect/teams | jq .
```

**預期結果：**
```json
{
  "ok": true,
  "accounts": [{ "accountId": "<uuid>", "name": "Teams" }],
  "chats": [
    { "name": "某人", "lastMessage": "...", "isGroup": false },
    ...
  ]
}
```

記下 `accountId`，後續步驟會用到（以下用 `$ACCOUNT_ID` 代替）。

### Step 8：確認 Connector 狀態

```bash
# 列出所有 connectors
curl -s http://localhost:3001/api/connectors | jq .

# 詳細狀態
curl -s http://localhost:3001/api/connectors/status | jq .
```

應看到 Teams connector 的 `connected: true`。

### Step 9：讀取 Teams 聊天列表

```bash
curl -s http://localhost:3001/api/connectors/$ACCOUNT_ID/teams/chats | jq .
```

**預期結果：**
```json
{
  "chats": [
    {
      "name": "Alice",
      "lastMessage": "Hi!",
      "isGroup": false,
      "monitored": true,
      "config": null
    },
    ...
  ]
}
```

### Step 10：手動觸發同步

```bash
curl -s -X POST http://localhost:3001/api/connectors/$ACCOUNT_ID/sync | jq .
```

**預期結果：**
```json
{
  "ok": true,
  "threadCount": 5,
  "threads": [...]
}
```

### Step 11：設定 Per-chat Config

```bash
# 設定某個聊天的回覆設定
curl -s -X PUT http://localhost:3001/api/connectors/$ACCOUNT_ID/teams/chat-configs/Alice \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "persona": "Product Manager", "tone": "professional", "language": "zh-TW"}' \
  | jq .

# 讀取所有 chat configs
curl -s http://localhost:3001/api/connectors/$ACCOUNT_ID/teams/chat-configs | jq .
```

### Step 12：控制 Monitor Agent

```bash
# 查看 monitor 狀態
curl -s -X POST http://localhost:3001/api/connectors/$ACCOUNT_ID/teams/monitor \
  -H "Content-Type: application/json" \
  -d '{"action": "status"}' \
  | jq .

# 停止 monitor
curl -s -X POST http://localhost:3001/api/connectors/$ACCOUNT_ID/teams/monitor \
  -H "Content-Type: application/json" \
  -d '{"action": "stop"}' \
  | jq .

# 重新啟動 monitor
curl -s -X POST http://localhost:3001/api/connectors/$ACCOUNT_ID/teams/monitor \
  -H "Content-Type: application/json" \
  -d '{"action": "start"}' \
  | jq .
```

### Step 13：中斷連接

```bash
curl -s -X POST http://localhost:3001/api/connectors/$ACCOUNT_ID/disconnect | jq .
```

**預期結果：** `{ "ok": true }`
確認 monitor 也自動停止（看 terminal log 應有 `[teams-monitor] Stopped`）。

---

## Phase D：前端 UI 測試

### Step 14：打開前端

瀏覽器打開 `http://localhost:3000`

### Step 15：測試 ConnectorSetup UI

1. 點擊左側「通訊」模式（💬）
2. 點擊齒輪圖示打開 **Connect Accounts** 面板
3. 點擊 **+ Teams** 按鈕
4. 預期：
   - 應顯示 "Connecting..." 然後成功
   - Teams 出現在 Connected Accounts 列表
   - 顯示「Connected via Teams Web」
   - 有一個 **藍色 "Chats" 按鈕**（LINE 是綠色）
5. 點擊 **Chats** 按鈕
   - 預期：打開聊天設定面板，顯示聊天列表
6. 點擊 **Sync** 按鈕
   - 預期：同步完成，顯示 thread 數量
7. 點擊 **×** 斷開連接
   - 預期：Teams 從列表消失

### Step 16：LINE + Teams 同時連接

1. 先連接 LINE（如果有 LINE Extension）
2. 再連接 Teams
3. 預期：
   - 兩者都出現在 Connected Accounts
   - LINE 有綠色 "Chats"，Teams 有藍色 "Chats"
   - 兩個都可以獨立 Sync
   - 斷開其中一個，另一個不受影響

---

## 快速指令總結

```bash
# Phase A：純邏輯測試
cd apps/api && npx tsx src/tests/test-teams-connector.ts --skip-browser --verbose

# Phase B：完整整合測試（需要 Chrome + Teams）
cd apps/api && npx tsx src/tests/test-teams-connector.ts --verbose

# Phase C：API 手動測試
curl -X POST http://localhost:3001/api/connectors/connect/teams | jq .
curl http://localhost:3001/api/connectors/status | jq .

# Phase D：前端
open http://localhost:3000
```
