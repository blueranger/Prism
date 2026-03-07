# Phase 6: Communication Tools Integration — Architecture Design

## 概述

將 Prism 從 Multi-LLM Orchestrator 擴展為通訊助手。對接 Outlook（含 Teams）、Line 等通訊工具，監控訊息/郵件，主動推薦回覆，並學習使用者的回覆習慣。

前端新增 `communication` mode，與現有 Parallel、Handoff、Compare、Synthesize、Agents 並列。

---

## 1. 整體架構

```
┌──────────────────────────────────────────────┐
│  Frontend — Communication Mode               │
│  ThreadList │ ThreadDetail │ RuleBuilder      │
├──────────────────────────────────────────────┤
│  Connector Service (polling + webhook)        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │ Outlook  │ │  Teams   │ │   Line   │     │
│  │(Graph API)│ │(Graph API)│ │(Msg API) │     │
│  └──────────┘ └──────────┘ └──────────┘     │
├──────────────────────────────────────────────┤
│  Agent Layer                                  │
│  ReplyDraftAgent │ MessageMonitorAgent        │
├──────────────────────────────────────────────┤
│  Reply Learning │ Monitor Rules Engine        │
├──────────────────────────────────────────────┤
│  Memory Layer (existing + 6 new tables)       │
└──────────────────────────────────────────────┘
```

---

## 2. Connector Layer

### 2a. Base Interface

```
apps/api/src/connectors/
├── base-connector.ts    # abstract class
├── outlook.ts           # Microsoft Graph (Outlook + Teams)
├── line.ts              # LINE Messaging API (Phase 6b)
└── registry.ts          # connector 管理
```

BaseConnector 定義統一介面：

```typescript
abstract class BaseConnector {
  abstract provider: 'outlook' | 'teams' | 'line';
  abstract getOAuthUrl(): string;
  abstract exchangeCodeForToken(code: string): Promise<void>;
  abstract refreshToken(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract fetchThreads(since?: number): Promise<ExternalThread[]>;
  abstract fetchThreadMessages(threadId: string, limit?: number): Promise<ExternalMessage[]>;
  abstract sendReply(threadId: string, content: string, replyToId?: string): Promise<void>;
}
```

所有外部訊息正規化為 `ExternalMessage`：

```typescript
interface ExternalMessage {
  externalId: string;           // 該平台的原始 ID
  provider: 'outlook' | 'teams' | 'line';
  threadId: string;             // 對話串/郵件串 ID
  senderId: string;
  senderName: string;
  senderEmail?: string;
  subject?: string;             // 郵件主旨
  content: string;              // 純文字內容
  timestamp: number;
  isInbound: boolean;           // true = 別人寄的, false = 我寄的
  metadata: Record<string, any>;
}
```

### 2b. Outlook Connector（Graph API）

- OAuth 2.0：Microsoft Identity Platform
- Scope：`Mail.ReadWrite`, `Mail.Send`, `User.Read`
- 郵件讀取：`GET /me/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime desc`
- 郵件回覆：`POST /me/messages/{id}/reply`
- Teams 訊息也走 Graph API：`GET /me/chats/{chatId}/messages`
- Token 自動 refresh（過期前 5 分鐘）

### 2c. 監控方式（Webhook + Polling 並行）

**Webhook（主要）：**
- Microsoft Graph 支援 Change Notifications（Subscriptions）
- `POST /subscriptions`，訂閱 `/me/mailFolders/inbox/messages`
- 新郵件時 Graph 推送到 Prism 的 webhook endpoint
- 需要公開 URL（開發時用 ngrok）
- 訂閱有效期最長 3 天，需定期 renew

**Polling（備援）：**
- 每 5 分鐘輪詢一次 inbox
- 用 `$filter=receivedDateTime ge {lastSyncedAt}` 只拿新的
- 如果 webhook 訂閱失效，自動 fallback 到 polling
- 也用於初始同步（第一次拉歷史訊息）

---

## 3. Agent 設計

### 3a. ReplyDraftAgent

```typescript
class ReplyDraftAgent extends BaseAgent {
  name = 'reply_draft';
  description = 'Drafts a reply to an external message. ' +
    'Considers thread context, sender patterns, and user tone preferences.';

  inputSchema = {
    threadId: string,       // required
    messageId: string,      // 要回覆的特定訊息
    provider: string,       // 'outlook' | 'teams' | 'line'
    tone?: string,          // 'formal' | 'casual' | 'auto'（auto = 從學習資料推斷）
    model?: string,         // 用哪個 LLM 起草，預設 Claude Sonnet
    instruction?: string,   // 使用者額外指示，例如「委婉拒絕」
  };
}
```

執行流程：
1. 從 `external_messages` 載入整串對話歷史
2. 從 `reply_learning` 查這個 sender 的回覆模式
3. 組裝 system prompt：
   ```
   You are drafting a reply on behalf of the user.

   Sender: {senderName} ({senderEmail})
   Thread subject: {subject}

   User's communication style with this sender:
   - Tone: {learned tone}
   - Average length: {learned length} chars
   - Common patterns: {learned patterns}

   User instruction: {instruction}

   Draft a reply that matches the user's style.
   ```
4. 呼叫 LLM 生成草稿
5. 儲存到 `draft_replies` table，status = 'pending'
6. 回傳 AgentResult 包含草稿內容

### 3b. MessageMonitorAgent

```typescript
class MessageMonitorAgent extends BaseAgent {
  name = 'message_monitor';
  description = 'Monitors external messages and evaluates them against user rules. ' +
    'Can trigger notifications or auto-draft replies.';

  inputSchema = {
    provider: string,       // 'outlook' | 'teams' | 'line'
    action: string,         // 'sync' | 'evaluate_rules'
  };
}
```

執行流程：
1. `sync`：透過 connector 拉新訊息，存入 `external_messages`
2. `evaluate_rules`：拿新訊息逐一比對 `monitor_rules`
3. 命中規則時：
   - action = `notify` → 發 WebSocket 事件到前端
   - action = `draft_reply` → 呼叫 ReplyDraftAgent
   - action = `draft_and_notify` → 起草 + 通知使用者審核

---

## 4. Reply Learning System

### 4a. 資料收集時機

當使用者透過 Prism 送出回覆（approve draft 或手動回覆）時，記錄：

```typescript
interface ReplyLearning {
  id: string;
  provider: string;
  senderId: string;              // 對方是誰
  senderName: string;
  contextMessage: string;        // 對方說了什麼
  userReply: string;             // 我回了什麼
  tone: string;                  // 自動分析：formal / casual / friendly / technical
  replyLengthChars: number;
  containsQuestion: boolean;
  containsActionItem: boolean;
  wasEditedFromDraft: boolean;   // 使用者有沒有修改 AI 草稿
  createdAt: number;
}
```

### 4b. 語氣分析（Reply Analyzer）

```
apps/api/src/services/reply-analyzer.ts
```

用 keyword-based heuristic（跟 Task Classifier 一樣的思路，不呼叫 LLM）：

- Formal markers: `Dear`, `Best regards`, `Please find`, `I would like to`
- Casual markers: `Hey`, `Thanks!`, `Sure`, `No worries`, `lol`
- Technical markers: `implementation`, `API`, `deploy`, `bug`, `PR`

### 4c. 整合到 Reply Draft

查 `reply_learning` 取得該 sender 的統計：
```sql
SELECT tone, AVG(reply_length_chars), COUNT(*)
FROM reply_learning
WHERE provider = ? AND sender_id = ?
GROUP BY tone
ORDER BY COUNT(*) DESC
```

結果注入 system prompt 作為 few-shot style guidance。

### 4d. 與 Decision Memory 的關係

Decision Memory = 使用者主動設定的全局偏好（「所有回覆都用正式語氣」）
Reply Learning = 系統自動學習的 per-sender 模式（「對 Alice 通常用 casual」）

兩者都會被注入 system prompt。Decision Memory 優先級更高（使用者明確意圖 > 自動學習）。

---

## 5. Monitor Rules Engine

### 5a. Rule Schema

```typescript
interface MonitorRule {
  id: string;
  provider: 'outlook' | 'teams' | 'line' | 'all';
  ruleName: string;
  enabled: boolean;
  conditions: {
    keywords?: string[];          // 內容包含任一關鍵字
    senders?: string[];           // 來自特定寄件人（email 或 ID）
    subjectContains?: string[];   // 主旨包含
    isGroup?: boolean;            // 群組 / 個人
    timeRange?: {                 // 只在特定時段觸發
      startHour: number;          // 0-23
      endHour: number;
    };
  };
  action: 'notify' | 'draft_reply' | 'draft_and_notify';
  actionConfig?: {
    model?: string;               // 起草用哪個 LLM
    tone?: string;
    instruction?: string;         // 附加指示
  };
  createdAt: number;
  updatedAt: number;
}
```

### 5b. Rule 比對邏輯

```typescript
function matchesRule(msg: ExternalMessage, rule: MonitorRule): boolean {
  const c = rule.conditions;

  // provider filter
  if (rule.provider !== 'all' && msg.provider !== rule.provider) return false;

  // 所有 conditions 都是 AND 關係（全部都要 match）
  if (c.keywords?.length) {
    const lower = msg.content.toLowerCase();
    if (!c.keywords.some(kw => lower.includes(kw.toLowerCase()))) return false;
  }

  if (c.senders?.length) {
    const senderMatch = c.senders.some(s =>
      msg.senderEmail?.toLowerCase() === s.toLowerCase() ||
      msg.senderId === s
    );
    if (!senderMatch) return false;
  }

  if (c.subjectContains?.length && msg.subject) {
    const lower = msg.subject.toLowerCase();
    if (!c.subjectContains.some(s => lower.includes(s.toLowerCase()))) return false;
  }

  if (c.timeRange) {
    const hour = new Date(msg.timestamp).getHours();
    if (hour < c.timeRange.startHour || hour > c.timeRange.endHour) return false;
  }

  return true;
}
```

### 5c. 通知機制

前端透過 WebSocket 接收即時通知：

```typescript
// 後端
wss.emit('comm:notification', {
  type: 'rule_matched',
  ruleId: rule.id,
  ruleName: rule.ruleName,
  message: { sender: msg.senderName, subject: msg.subject, preview: msg.content.slice(0, 100) },
  action: rule.action,
  draftId: draft?.id,  // 如果有起草
});

// 前端
// 在 Header 顯示通知 badge，點擊切到 Communication mode
```

---

## 6. Session 整合

### 6a. Thread → Session 映射

每個外部對話串（email thread / chat thread）對應一個 Prism session：

```
external_threads.session_id → sessions.id
```

- 第一次收到某 thread 的訊息時，自動建立 session
- Session title = `[Outlook] {subject}` 或 `[Line] {senderName}`
- 外部訊息存入 `external_messages` table（不存 `messages` table）
- AI 草稿存入 `draft_replies` table + 同時存入 `messages` table（source_model = 'reply_draft_agent'）
- 這樣 Unified Timeline 可以顯示：外部訊息 + AI 草稿 + 使用者指示

### 6b. Context Builder 整合

當 ReplyDraftAgent 需要 LLM 起草回覆時，Context Builder 組裝的 messages 包含：

1. System prompt（Decision Memory + Reply Learning）
2. 外部對話歷史（從 `external_messages` 載入，格式化為 user/assistant 角色）
3. 使用者的額外指示（如果有）

不需要修改現有的 `buildContext()`，因為 ReplyDraftAgent 自己組裝 prompt 直接呼叫 LLM adapter。

---

## 7. Database Schema（6 張新 table）

```sql
-- 1. Connector 設定（OAuth tokens）
CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  config TEXT NOT NULL,        -- JSON: { accessToken, refreshToken, expiresAt, scope }
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 2. 外部對話串
CREATE TABLE external_threads (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  session_id TEXT,             -- FK → sessions.id（Prism session）
  display_name TEXT NOT NULL,
  subject TEXT,
  sender_name TEXT,
  sender_email TEXT,
  is_group INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  last_message_at INTEGER,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, external_id)
);

-- 3. 外部訊息
CREATE TABLE external_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,     -- FK → external_threads.id
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  sender_email TEXT,
  subject TEXT,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  is_inbound INTEGER DEFAULT 1,
  metadata TEXT,               -- JSON
  created_at INTEGER NOT NULL,
  UNIQUE(provider, external_id)
);

-- 4. 回覆學習
CREATE TABLE reply_learning (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  context_message TEXT NOT NULL,
  user_reply TEXT NOT NULL,
  tone TEXT,
  reply_length_chars INTEGER,
  contains_question INTEGER DEFAULT 0,
  contains_action_item INTEGER DEFAULT 0,
  was_edited_from_draft INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 5. 監控規則
CREATE TABLE monitor_rules (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'all',
  rule_name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  conditions TEXT NOT NULL,    -- JSON
  action TEXT NOT NULL,        -- 'notify' | 'draft_reply' | 'draft_and_notify'
  action_config TEXT,          -- JSON
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 6. 回覆草稿
CREATE TABLE draft_replies (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,     -- FK → external_threads.id
  message_id TEXT NOT NULL,    -- 回覆哪則外部訊息
  provider TEXT NOT NULL,
  draft_content TEXT NOT NULL,
  model_used TEXT NOT NULL,
  tone TEXT,
  instruction TEXT,
  status TEXT DEFAULT 'pending',  -- pending | approved | sent | rejected
  triggered_by TEXT,              -- 'user' | rule ID
  sent_at INTEGER,
  user_edit TEXT,                 -- 使用者修改後的版本（用於學習）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

---

## 8. API Endpoints

### Connector 管理
```
GET    /api/connectors                         → 列出所有 connector 狀態
POST   /api/connectors/:provider/auth-url      → 取得 OAuth 授權 URL
POST   /api/connectors/:provider/callback      → OAuth callback（交換 token）
POST   /api/connectors/:provider/disconnect    → 斷開連接
POST   /api/connectors/:provider/sync          → 手動觸發同步
```

### Webhook
```
POST   /api/webhooks/graph                     → Microsoft Graph change notification
POST   /api/webhooks/line                      → LINE webhook
```

### Thread & Message
```
GET    /api/comm/threads                       → 列出所有外部對話串
GET    /api/comm/threads/:id                   → 單一對話串詳情 + 訊息
GET    /api/comm/threads/:id/messages          → 對話串的訊息列表
POST   /api/comm/threads/:id/draft             → 主動請求起草回覆
POST   /api/comm/threads/:id/reply             → 直接送出回覆（不經草稿）
```

### Draft
```
GET    /api/comm/drafts                        → 所有待審核草稿
GET    /api/comm/drafts/:id                    → 單一草稿
POST   /api/comm/drafts/:id/approve            → 核准並寄出
POST   /api/comm/drafts/:id/reject             → 拒絕（可附上使用者的修改版本用於學習）
PUT    /api/comm/drafts/:id                    → 編輯草稿內容
```

### Monitor Rules
```
GET    /api/comm/rules                         → 列出所有規則
POST   /api/comm/rules                         → 建立規則
PUT    /api/comm/rules/:id                     → 更新規則
DELETE /api/comm/rules/:id                     → 刪除規則
POST   /api/comm/rules/:id/test                → 測試規則（用最近 N 則訊息模擬）
```

### Reply Learning
```
GET    /api/comm/learning/senders              → 列出有學習資料的 sender 統計
GET    /api/comm/learning/senders/:id          → 特定 sender 的回覆模式
DELETE /api/comm/learning/senders/:id          → 清除某 sender 的學習資料
```

---

## 9. 前端元件

### 9a. Communication Mode 主畫面

```
apps/web/src/components/
├── CommunicationView.tsx      # Communication mode 主容器
├── ThreadList.tsx             # 左側：對話串列表（按 provider 分群）
├── ThreadDetail.tsx           # 右側：對話內容 + 草稿區
├── DraftEditor.tsx            # 草稿編輯器（顯示 AI 草稿 + 編輯 + 送出）
├── MonitorRuleBuilder.tsx     # 規則建立/編輯 modal
├── ConnectorSetup.tsx         # Connector OAuth 設定面板
├── CommNotificationBadge.tsx  # Header 通知 badge
└── ReplyLearningPanel.tsx     # 學習資料面板（顯示 per-sender 統計）
```

### 9b. 畫面佈局

```
┌─────────────────────────────────────────────────────┐
│ Header: [Prism] [+ New] [Sessions] [Link] [🔔 3]   │
│ Mode: [Parallel] [Handoff] [Compare] [...] [Comms]  │
├──────────────┬──────────────────────────────────────┤
│ Thread List  │  Thread Detail                       │
│              │                                      │
│ 📧 Outlook   │  From: Alice Chen                    │
│  └ Project X │  Subject: Q1 Review                  │
│  └ Meeting   │                                      │
│              │  [Alice]: Can you review the Q1...    │
│ 💬 Teams     │  [You]: Sure, I'll take a look...    │
│  └ Dev Chat  │  [Alice]: Great, deadline is Friday  │
│              │                                      │
│ 🟢 Line     │  ┌─── AI Draft ────────────────────┐ │
│  └ John     │  │ Thanks Alice, I'll have the     │ │
│              │  │ review ready by Thursday...     │ │
│              │  │                                 │ │
│              │  │ [Approve] [Edit] [Reject]       │ │
│              │  └─────────────────────────────────┘ │
│              │                                      │
│ [⚙ Rules]   │  [Draft Reply] [Manual Reply]        │
│ [🔌 Connect] │                                      │
├──────────────┴──────────────────────────────────────┤
│ [Prompt Input: "Reply to Alice, politely decline"]  │
└─────────────────────────────────────────────────────┘
```

### 9c. Zustand Store 擴展

```typescript
// 新增到 chat-store.ts 或獨立 communication-store.ts
interface CommState {
  threads: ExternalThread[];
  selectedThreadId: string | null;
  threadMessages: ExternalMessage[];
  drafts: DraftReply[];
  rules: MonitorRule[];
  connectors: ConnectorStatus[];
  notifications: CommNotification[];
  unreadCount: number;
  ruleBuilderOpen: boolean;
  connectorSetupOpen: boolean;
}
```

---

## 10. 新增檔案清單

### Backend
```
apps/api/src/connectors/base-connector.ts
apps/api/src/connectors/outlook.ts
apps/api/src/connectors/registry.ts
apps/api/src/agents/reply-draft.ts
apps/api/src/agents/message-monitor.ts
apps/api/src/services/connector-service.ts
apps/api/src/services/reply-analyzer.ts
apps/api/src/services/monitor-engine.ts
apps/api/src/routes/connectors.ts
apps/api/src/routes/comm.ts
apps/api/src/routes/webhooks.ts
```

### Frontend
```
apps/web/src/components/CommunicationView.tsx
apps/web/src/components/ThreadList.tsx
apps/web/src/components/ThreadDetail.tsx
apps/web/src/components/DraftEditor.tsx
apps/web/src/components/MonitorRuleBuilder.tsx
apps/web/src/components/ConnectorSetup.tsx
apps/web/src/components/CommNotificationBadge.tsx
apps/web/src/components/ReplyLearningPanel.tsx
```

### Shared Types
```
packages/shared/src/types.ts  → 新增 ExternalMessage, ExternalThread,
                                 MonitorRule, DraftReply, ReplyLearning,
                                 ConnectorStatus, CommNotification
```

---

## 11. 實作順序

### Step 1：基礎建設
- DB schema（6 張新 table）
- BaseConnector + ConnectorRegistry
- Connector API routes（auth-url, callback, disconnect, sync）
- ConnectorSetup.tsx（OAuth 流程 UI）

### Step 2：Outlook Connector
- OutlookConnector（Graph API 實作）
- OAuth 2.0 flow（MSAL）
- 讀取 inbox、threads、messages
- 回覆郵件
- Polling service（5 分鐘間隔）

### Step 3：Communication Mode UI
- CommunicationView + ThreadList + ThreadDetail
- ModeSelector 新增 'communication' option
- Thread ↔ Session 映射
- CommNotificationBadge

### Step 4：Reply Draft Agent
- ReplyDraftAgent 實作
- 串接 LLM Layer（Claude Sonnet）
- DraftEditor（審核/編輯/送出）
- 主動模式：使用者在 prompt input 下指令

### Step 5：Reply Learning
- ReplyAnalyzer（tone detection）
- reply_learning 資料收集（approve/reject 時記錄）
- 注入 system prompt
- ReplyLearningPanel（查看統計）

### Step 6：Monitor Rules Engine
- MonitorRule CRUD
- Rule 比對引擎
- Webhook 接收（Graph change notifications）
- WebSocket 通知前端
- MonitorRuleBuilder UI

### Step 7：Polish
- 錯誤處理（token 過期、API 限流）
- Webhook subscription 自動 renew
- Polling fallback
- 通知歷史紀錄
