# Teams Web Connector — 重新設計

## 為什麼不能直接抄 LINE

| | LINE Chrome Extension | Teams Web |
|---|---|---|
| DOM 結構 | CSS Modules, 穩定 class name | React SPA, 混淆 class, 經常更新 |
| 資料取得 | 只能靠 DOM (Extension 沒 API) | Web 內部有 REST API, 回傳 JSON |
| 瀏覽器共享 | 各自的 singleton Page | 跟 LINE 搶同一個 Chrome (port 9222) |
| 渲染速度 | 快, 5 秒 | SPA 慢, 動態載入, 不確定何時完成 |
| Selector 穩定性 | `[data-mid]`, `chatlistItem-module` 穩 | `data-tid` 會隨版本變, 不可靠 |

**結論**：Teams 應該用 **Network Interception** 而不是 DOM Scraping。

---

## 新架構總覽

```
┌─────────────────────────────────────────────────┐
│  SharedBrowserManager (singleton)               │
│  連接 Chrome:9222, 管理所有 Page                  │
│  ├── getPage('line')  → LINE Extension tab      │
│  └── getPage('teams') → Teams Web tab           │
└──────────────┬──────────────────────────────────┘
               │
  ┌────────────┴────────────┐
  │                         │
  ▼                         ▼
line-puppeteer.ts     teams-puppeteer.ts (重寫)
(不動, 維持 DOM 方式)    │
                         ├── 1. Network Interception
                         │   page.on('response') 攔截:
                         │   - Chat list API → 結構化 JSON
                         │   - Messages API  → 結構化 JSON
                         │   - 同時擷取 Auth header (Bearer token)
                         │
                         ├── 2. Direct API Caller
                         │   用攔截到的 token 直接呼叫 Teams API
                         │   不需要 Puppeteer 持續操作頁面
                         │   Token 過期 → 重新從瀏覽器擷取
                         │
                         └── 3. DOM (僅發送訊息)
                             找 compose box → type → Enter
```

---

## 檔案結構 (新增/修改)

```
apps/api/src/
├── services/
│   ├── shared-browser.ts       ← 新增: 共享 Browser 管理
│   ├── teams-puppeteer.ts      ← 重寫: Network Interception
│   └── line-puppeteer.ts       ← 小改: 改用 SharedBrowserManager
├── connectors/
│   └── teams.ts                ← 重寫: 適配新 puppeteer 層
├── agents/
│   └── teams-monitor.ts        ← 小改: 邏輯不變, 只是簡化
└── routes/
    └── connectors.ts           ← 已加, 微調
```

---

## 各層設計

### Layer 1: SharedBrowserManager (`shared-browser.ts`)

解決 LINE 和 Teams 搶 Chrome 連線的問題。

```typescript
// 單例, 管理一個 Browser 連線和多個 Page
class SharedBrowserManager {
  private browser: Browser | null;
  private pages: Map<string, Page>;  // 'line' → Page, 'teams' → Page

  async connect(): Promise<Browser>
  // 連接 Chrome:9222, 或回傳已有連線

  async getOrCreatePage(key: string, url?: string): Promise<Page>
  // 如果已有 page 且未關閉, 直接回傳
  // 否則 browser.newPage() + goto(url)

  async closePage(key: string): Promise<void>
  // 關閉特定 page

  isPageAlive(key: string): boolean
  // 檢查 page 是否存活

  async disconnectAll(): Promise<void>
  // 全部關閉 (但不關 Chrome 本體)
}

export const sharedBrowser = new SharedBrowserManager();
```

**LINE 改動**：`line-puppeteer.ts` 的 `connectToLine()` 改為：
```typescript
// Before:
browser = await puppeteer.connect({ browserURL: CHROME_DEBUG_URL });
linePage = await browser.newPage();

// After:
linePage = await sharedBrowser.getOrCreatePage('line', LINE_CHATS_URL);
```

### Layer 2: teams-puppeteer.ts (重寫 — Network Interception)

**核心思路**：不讀 DOM, 攔截 Teams Web 自己的 API Response。

```typescript
// === 狀態 ===
interface TeamsApiCache {
  chatList: TeamsChatItem[];          // 攔截到的聊天列表
  messages: Map<string, TeamsMsg[]>;  // 每個 chat 的訊息
  authToken: string | null;           // Bearer token
  authHeaders: Record<string, string>;// 完整 headers (for direct calls)
  lastChatListUpdate: number;         // 上次更新時間
}

const cache: TeamsApiCache = { ... };

// === 連線 + 設定攔截 ===
async function connectToTeams(): Promise<void> {
  const page = await sharedBrowser.getOrCreatePage('teams', TEAMS_CHAT_URL);
  setupNetworkInterception(page);
  await waitForInitialLoad(page);
}

function setupNetworkInterception(page: Page): void {
  page.on('response', async (response) => {
    const url = response.url();
    const status = response.status();
    if (status !== 200) return;

    // 攔截聊天列表
    if (matchesChatListPattern(url)) {
      const json = await response.json();
      cache.chatList = parseChatListResponse(json);
      cache.lastChatListUpdate = Date.now();
    }

    // 攔截訊息
    if (matchesMessagesPattern(url)) {
      const json = await response.json();
      const chatId = extractChatIdFromUrl(url);
      cache.messages.set(chatId, parseMessagesResponse(json));
    }

    // 擷取 Auth header
    const authHeader = response.request().headers()['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      cache.authToken = authHeader.replace('Bearer ', '');
      cache.authHeaders = { ...response.request().headers() };
    }
  });
}

// === URL Pattern 匹配 ===
// Teams Web 的 API 路徑 (需要實際觀察確認):
const CHAT_LIST_PATTERNS = [
  /\/api\/csa.*\/threads/i,
  /\/v1\/users\/ME\/conversations/i,
  /chatsvc.*\/threads/i,
];

const MESSAGES_PATTERNS = [
  /\/api\/csa.*\/messages/i,
  /\/v1\/users\/ME\/conversations\/.*\/messages/i,
  /chatsvc.*\/messages/i,
];

// === 公開 API ===

// 讀聊天列表: 優先用 cache, 過期則觸發 page 重新載入
async function readChatList(): Promise<TeamsChatItem[]> {
  const age = Date.now() - cache.lastChatListUpdate;
  if (cache.chatList.length > 0 && age < 60_000) {
    return cache.chatList;  // Cache 有效
  }

  // 觸發 Teams 重新載入聊天列表
  // 方法 A: reload page
  // 方法 B: 用 authToken 直接 fetch
  if (cache.authToken) {
    return await fetchChatListDirect(cache.authToken);
  }

  // Fallback: reload page, 等待攔截
  await refreshPage();
  await sleep(5000);
  return cache.chatList;
}

// 直接用 token 呼叫 API (不需要 Puppeteer)
async function fetchChatListDirect(token: string): Promise<TeamsChatItem[]> {
  const resp = await fetch(TEAMS_CHAT_API_URL, {
    headers: { Authorization: `Bearer ${token}`, ...REQUIRED_HEADERS }
  });
  if (resp.status === 401) {
    // Token 過期, 重新從瀏覽器擷取
    cache.authToken = null;
    await refreshPage();
    throw new Error('Token expired, refreshing...');
  }
  const json = await resp.json();
  return parseChatListResponse(json);
}

// 發送訊息: 唯一需要 DOM 的地方
async function sendMessage(text: string): Promise<boolean> {
  const page = sharedBrowser.getPage('teams');
  // 找 compose box → type → Enter
  // (跟之前一樣, 但有 authToken 時也可以改用 API)
}
```

**關鍵設計**：
- 攔截階段是被動的 (監聽 Teams 自己的 API call)
- 一旦拿到 `authToken`, 後續 polling 就用 direct fetch, 不需要動 Puppeteer page
- Token 過期時才需要 Puppeteer (reload page 讓 Teams 自動 refresh)

### Layer 3: API Discovery 機制

因為我們不確定 Teams Web 目前用的 API endpoint 長什麼樣, 需要一個 discovery 階段:

```typescript
// 首次連線時, 記錄所有 Teams API 呼叫
function setupDiscoveryMode(page: Page): void {
  page.on('response', async (response) => {
    const url = response.url();
    // 只記錄 teams.microsoft.com 相關的 API
    if (!url.includes('teams.microsoft.com') &&
        !url.includes('chatsvcagg') &&
        !url.includes('api.spaces')) return;

    const contentType = response.headers()['content-type'] || '';
    if (!contentType.includes('json')) return;

    console.log(`[teams-discovery] ${response.request().method()} ${url}`);
    // 記錄到 discoveredEndpoints Map
    // 用 heuristic 分析哪些是 chat list, 哪些是 messages
  });
}
```

**首次連線流程**:
1. 開啟 Teams Web, 啟動 discovery mode
2. 等待 Teams 載入 → 自動攔截 API 呼叫
3. 從攔截結果中識別 chat list / messages endpoint
4. 儲存到 DB (`connectors.config.discoveredEndpoints`)
5. 後續 polling 直接用已知 endpoint + token

### Layer 4: Teams Connector (`teams.ts` 重寫)

Connector 本身的邏輯不大變, 但 `fetchThreads()` 和 `fetchThreadMessages()` 改為呼叫新的 teams-puppeteer:

```typescript
async fetchThreads(): Promise<ExternalThread[]> {
  await this.ensureValidToken();
  const chatItems = await readChatList();
  // ... 同步到 DB (跟之前一樣)
}

async fetchThreadMessages(threadId: string): Promise<ExternalMessage[]> {
  await this.ensureValidToken();
  // 優先: 用 direct API 取得 (如果有 token + endpoint)
  // 備援: 透過 Puppeteer 導航到該 chat, 攔截 messages response
  const messages = await readMessages(chatId);
  // ... 同步到 DB
}
```

### Layer 5: TeamsMonitorAgent (小改)

邏輯不變, 但因為 teams-puppeteer 改為 API-based, polling 更輕量:
- 之前: 每 30 秒 → Puppeteer DOM scraping (慢, 可能干擾 LINE)
- 之後: 每 30 秒 → direct HTTP fetch (快, 不佔 Puppeteer)

---

## 共存設計 (LINE + Teams)

```
Chrome (port 9222)
├── Tab 1: LINE Extension (chrome-extension://...)
│   └── line-puppeteer.ts 獨佔操作
│
├── Tab 2: Teams Web (https://teams.microsoft.com)
│   └── teams-puppeteer.ts
│       - 連線時: 攔截 API + 擷取 token
│       - Polling: 用 token 直接 HTTP fetch (不碰 tab)
│       - 發送: 切到此 tab 操作 DOM
│
└── SharedBrowserManager
    - 確保只有一個 browser 連線
    - 管理 page lifecycle
    - 避免 LINE/Teams 互相干擾
```

**關鍵**: Teams polling 用 direct HTTP, 不需要切換 tab。
只有「發送訊息」才需要操作 Teams tab, 避免跟 LINE 搶 focus。

---

## 實作順序

1. `shared-browser.ts` — 共享 Browser 管理 (LINE 也改用它)
2. `teams-puppeteer.ts` — 重寫: Network Interception + Direct API + Discovery
3. `teams.ts` — 重寫: Connector 適配新 API
4. `teams-monitor.ts` — 小改: 邏輯相同但更輕量
5. `line-puppeteer.ts` — 改用 SharedBrowserManager
6. `connectors.ts` — 路由微調
7. 前端 ConnectorSetup — 加 Teams 入口

---

## 風險與備案

| 風險 | 備案 |
|------|------|
| Teams API endpoint 無法自動辨識 | 手動配置 endpoint (儲存在 connector config) |
| Token 過期頻繁 | 在 polling 中自動偵測 401 → 觸發 page reload 重新取 token |
| 某些 API 需要 CORS/特殊 header | 用 Puppeteer page.evaluate() 在 Teams 頁面內 fetch |
| 發送訊息的 DOM 變更 | 備案: 攔截 send message API, 用 token 直接 POST |
