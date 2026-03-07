# Phase 7a Implementation Plan — Import Engine

## Goal
Users can upload exported conversation archives from ChatGPT, Claude, and Gemini. Prism parses these files, stores conversations in the database, and displays them in a new "Library" mode where users can browse all imported conversations.

---

## Step 1: New Database Tables

**File:** `apps/api/src/memory/db.ts`

Add the following tables AFTER the existing `CREATE TABLE` statements (before the migration/ALTER section):

```sql
CREATE TABLE IF NOT EXISTS imported_conversations (
  id TEXT PRIMARY KEY,
  source_platform TEXT NOT NULL,        -- 'chatgpt' | 'claude' | 'gemini'
  original_id TEXT,                      -- ID from the original platform
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,              -- ISO 8601
  updated_at TEXT,                       -- ISO 8601
  message_count INTEGER DEFAULT 0,
  session_id TEXT,                       -- linked Prism session (nullable, for future use)
  import_batch_id TEXT NOT NULL,         -- groups files from same upload
  metadata TEXT,                         -- JSON blob for platform-specific extras
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS imported_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,                    -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  source_model TEXT,                     -- 'gpt-4', 'claude-3-opus', etc. (if available)
  timestamp TEXT NOT NULL,               -- ISO 8601
  token_count INTEGER,
  parent_message_id TEXT,               -- for ChatGPT's tree structure
  metadata TEXT,                         -- JSON blob
  FOREIGN KEY (conversation_id) REFERENCES imported_conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_imported_conversations_source ON imported_conversations(source_platform);
CREATE INDEX IF NOT EXISTS idx_imported_conversations_batch ON imported_conversations(import_batch_id);
CREATE INDEX IF NOT EXISTS idx_imported_conversations_created ON imported_conversations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_imported_messages_conversation ON imported_messages(conversation_id, timestamp);
```

---

## Step 2: Shared Types

**File:** `packages/shared/src/types.ts`

Add the following types at the end:

```typescript
/* ===== Phase 7: Import Engine ===== */

export type ImportPlatform = 'chatgpt' | 'claude' | 'gemini';

export interface ImportedConversation {
  id: string;
  sourcePlatform: ImportPlatform;
  originalId?: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  messageCount: number;
  sessionId?: string;
  importBatchId: string;
  metadata?: Record<string, any>;
}

export interface ImportedMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  sourceModel?: string;
  timestamp: string;
  tokenCount?: number;
  parentMessageId?: string;
  metadata?: Record<string, any>;
}

export interface ImportBatch {
  id: string;
  platform: ImportPlatform;
  filename: string;
  totalConversations: number;
  totalMessages: number;
  importedAt: string;
  status: 'processing' | 'completed' | 'failed';
  error?: string;
}

export interface ImportProgress {
  batchId: string;
  platform: ImportPlatform;
  status: 'processing' | 'completed' | 'failed';
  totalConversations: number;
  processedConversations: number;
  totalMessages: number;
  error?: string;
}
```

Also add `'library'` to the `OperationMode` type:

```typescript
export type OperationMode = 'parallel' | 'handoff' | 'compare' | 'synthesize' | 'agents' | 'flow' | 'communication' | 'library';
```

---

## Step 3: Parsers

Create a new directory: `apps/api/src/parsers/`

### 3a. Parser Interface

**New file:** `apps/api/src/parsers/base-parser.ts`

```typescript
import { ImportedConversation, ImportedMessage, ImportPlatform } from '@prism/shared';

export interface ParseResult {
  conversations: ImportedConversation[];
  messages: ImportedMessage[];
}

export interface ConversationParser {
  platform: ImportPlatform;
  /**
   * Parse the extracted file content into normalized conversations + messages.
   * @param data - The raw JSON data (already parsed from file)
   */
  parse(data: any, batchId: string): ParseResult;
}
```

### 3b. ChatGPT Parser

**New file:** `apps/api/src/parsers/chatgpt-parser.ts`

ChatGPT export format (from "Settings → Data controls → Export data"):
- ZIP file containing `conversations.json`
- `conversations.json` is an array of conversation objects
- Each conversation has a `mapping` object (tree structure, not flat array)
- Each mapping node has: `id`, `message` (with `author.role`, `content.parts[]`, `create_time`), `parent`, `children[]`

Implementation:
```typescript
import { v4 as uuid } from 'uuid';
import { ImportedConversation, ImportedMessage } from '@prism/shared';
import { ConversationParser, ParseResult } from './base-parser';

export class ChatGPTParser implements ConversationParser {
  platform = 'chatgpt' as const;

  parse(data: any[], batchId: string): ParseResult {
    const conversations: ImportedConversation[] = [];
    const messages: ImportedMessage[] = [];

    for (const conv of data) {
      const convId = uuid();
      const convMessages = this.flattenMapping(conv.mapping, convId);

      conversations.push({
        id: convId,
        sourcePlatform: 'chatgpt',
        originalId: conv.id,
        title: conv.title || 'Untitled',
        createdAt: new Date((conv.create_time || 0) * 1000).toISOString(),
        updatedAt: conv.update_time
          ? new Date(conv.update_time * 1000).toISOString()
          : undefined,
        messageCount: convMessages.length,
        importBatchId: batchId,
        metadata: {
          conversationTemplateId: conv.conversation_template_id,
          defaultModelSlug: conv.default_model_slug,
        },
      });

      messages.push(...convMessages);
    }
    return { conversations, messages };
  }

  private flattenMapping(
    mapping: Record<string, any>,
    conversationId: string
  ): ImportedMessage[] {
    // Walk the tree from root, following the main branch (first child path)
    const messages: ImportedMessage[] = [];
    const nodeMap = mapping;

    // Find root node (node with no parent or parent not in mapping)
    let rootId: string | null = null;
    for (const [id, node] of Object.entries(nodeMap)) {
      if (!node.parent || !nodeMap[node.parent]) {
        rootId = id;
        break;
      }
    }

    if (!rootId) return messages;

    // BFS/DFS to linearize the conversation (follow first child for main thread)
    const visited = new Set<string>();
    const queue: string[] = [rootId];

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = nodeMap[nodeId];
      if (!node) continue;

      // Only include nodes that have actual message content
      if (node.message && node.message.content?.parts?.length > 0) {
        const role = node.message.author?.role;
        // Skip 'system' and 'tool' messages; keep 'user' and 'assistant'
        if (role === 'user' || role === 'assistant') {
          const content = node.message.content.parts
            .filter((p: any) => typeof p === 'string')
            .join('\n');

          if (content.trim()) {
            messages.push({
              id: uuid(),
              conversationId,
              role,
              content,
              sourceModel: node.message.metadata?.model_slug || undefined,
              timestamp: node.message.create_time
                ? new Date(node.message.create_time * 1000).toISOString()
                : new Date().toISOString(),
              parentMessageId: node.parent || undefined,
              metadata: {
                originalNodeId: nodeId,
                weight: node.message.weight,
                endTurn: node.message.end_turn,
              },
            });
          }
        }
      }

      // Follow children (first child = main thread)
      if (node.children?.length > 0) {
        queue.push(...node.children);
      }
    }

    return messages;
  }
}
```

### 3c. Claude Parser

**New file:** `apps/api/src/parsers/claude-parser.ts`

Claude export format (from "Settings → Account → Export Data"):
- ZIP containing JSON files
- Main file has an array of conversation objects
- Each conversation: `{ uuid, name, created_at, updated_at, chat_messages: [{ uuid, text, sender, created_at, updated_at, content: [{type, text}], ... }] }`

```typescript
import { v4 as uuid } from 'uuid';
import { ConversationParser, ParseResult } from './base-parser';
import { ImportedConversation, ImportedMessage } from '@prism/shared';

export class ClaudeParser implements ConversationParser {
  platform = 'claude' as const;

  parse(data: any[], batchId: string): ParseResult {
    const conversations: ImportedConversation[] = [];
    const messages: ImportedMessage[] = [];

    for (const conv of data) {
      const convId = uuid();
      const convMessages: ImportedMessage[] = [];

      const chatMessages = conv.chat_messages || [];
      for (const msg of chatMessages) {
        const role = msg.sender === 'human' ? 'user' : 'assistant';
        // Content can be in msg.text or msg.content[].text
        let content = msg.text || '';
        if (!content && Array.isArray(msg.content)) {
          content = msg.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');
        }

        if (content.trim()) {
          convMessages.push({
            id: uuid(),
            conversationId: convId,
            role,
            content,
            timestamp: msg.created_at || conv.created_at || new Date().toISOString(),
            metadata: {
              originalUuid: msg.uuid,
              updatedAt: msg.updated_at,
            },
          });
        }
      }

      conversations.push({
        id: convId,
        sourcePlatform: 'claude',
        originalId: conv.uuid,
        title: conv.name || 'Untitled',
        createdAt: conv.created_at || new Date().toISOString(),
        updatedAt: conv.updated_at,
        messageCount: convMessages.length,
        importBatchId: batchId,
      });

      messages.push(...convMessages);
    }
    return { conversations, messages };
  }
}
```

### 3d. Gemini Parser

**New file:** `apps/api/src/parsers/gemini-parser.ts`

Gemini export format (via Google Takeout → "Gemini Apps"):
- ZIP with a folder structure; conversations may be in individual JSON files or a combined file
- Structure varies; common format has arrays of prompt-response pairs

```typescript
import { v4 as uuid } from 'uuid';
import { ConversationParser, ParseResult } from './base-parser';
import { ImportedConversation, ImportedMessage } from '@prism/shared';

export class GeminiParser implements ConversationParser {
  platform = 'gemini' as const;

  parse(data: any[], batchId: string): ParseResult {
    const conversations: ImportedConversation[] = [];
    const messages: ImportedMessage[] = [];

    // Google Takeout Gemini export: array of conversation objects
    // or MyActivity.json with prompt/response entries
    for (const conv of data) {
      const convId = uuid();
      const convMessages: ImportedMessage[] = [];

      if (conv.chunks) {
        // Format: { title, chunks: [{ type: 'USER'|'MODEL', content }] }
        for (const chunk of conv.chunks) {
          const role = chunk.type === 'USER' ? 'user' : 'assistant';
          const content = typeof chunk.content === 'string'
            ? chunk.content
            : JSON.stringify(chunk.content);

          if (content.trim()) {
            convMessages.push({
              id: uuid(),
              conversationId: convId,
              role,
              content,
              timestamp: chunk.timestamp || conv.createTime || new Date().toISOString(),
            });
          }
        }
      } else if (conv.entries) {
        // Alternative format from MyActivity.json
        for (const entry of conv.entries) {
          if (entry.query) {
            convMessages.push({
              id: uuid(), conversationId: convId, role: 'user',
              content: entry.query, timestamp: entry.timestamp || new Date().toISOString(),
            });
          }
          if (entry.response) {
            convMessages.push({
              id: uuid(), conversationId: convId, role: 'assistant',
              content: entry.response, timestamp: entry.timestamp || new Date().toISOString(),
            });
          }
        }
      }

      if (convMessages.length > 0) {
        conversations.push({
          id: convId,
          sourcePlatform: 'gemini',
          originalId: conv.id || undefined,
          title: conv.title || conv.name || 'Gemini Conversation',
          createdAt: conv.createTime || conv.created || new Date().toISOString(),
          messageCount: convMessages.length,
          importBatchId: batchId,
        });
        messages.push(...convMessages);
      }
    }
    return { conversations, messages };
  }
}
```

### 3e. Parser Registry

**New file:** `apps/api/src/parsers/index.ts`

```typescript
import { ImportPlatform } from '@prism/shared';
import { ConversationParser } from './base-parser';
import { ChatGPTParser } from './chatgpt-parser';
import { ClaudeParser } from './claude-parser';
import { GeminiParser } from './gemini-parser';

const parsers: Record<ImportPlatform, ConversationParser> = {
  chatgpt: new ChatGPTParser(),
  claude: new ClaudeParser(),
  gemini: new GeminiParser(),
};

export function getParser(platform: ImportPlatform): ConversationParser {
  const parser = parsers[platform];
  if (!parser) throw new Error(`Unknown platform: ${platform}`);
  return parser;
}

export { ConversationParser, ParseResult } from './base-parser';
```

---

## Step 4: Import Service

**New file:** `apps/api/src/services/import-service.ts`

This service handles:
1. Receiving the uploaded file (ZIP or JSON)
2. Extracting and detecting the platform format
3. Calling the appropriate parser
4. Batch-inserting into the database

```typescript
import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { getDb } from '../memory/db';
import { getParser } from '../parsers';
import { ImportPlatform, ImportProgress } from '@prism/shared';

export class ImportService {
  /**
   * Import a conversation archive file.
   * @param filePath - Path to the uploaded file (ZIP or JSON)
   * @param platform - Which platform this file is from
   */
  async importFile(filePath: string, platform: ImportPlatform): Promise<ImportProgress> {
    const batchId = uuid();
    const progress: ImportProgress = {
      batchId,
      platform,
      status: 'processing',
      totalConversations: 0,
      processedConversations: 0,
      totalMessages: 0,
    };

    try {
      // 1. Extract data from file
      const rawData = await this.extractData(filePath, platform);

      // 2. Parse
      const parser = getParser(platform);
      const { conversations, messages } = parser.parse(rawData, batchId);

      progress.totalConversations = conversations.length;
      progress.totalMessages = messages.length;

      // 3. Batch insert into DB
      const db = getDb();

      const insertConv = db.prepare(`
        INSERT INTO imported_conversations
        (id, source_platform, original_id, title, created_at, updated_at, message_count, import_batch_id, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertMsg = db.prepare(`
        INSERT INTO imported_messages
        (id, conversation_id, role, content, source_model, timestamp, token_count, parent_message_id, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertAll = db.transaction(() => {
        for (const conv of conversations) {
          insertConv.run(
            conv.id, conv.sourcePlatform, conv.originalId || null,
            conv.title, conv.createdAt, conv.updatedAt || null,
            conv.messageCount, conv.importBatchId,
            conv.metadata ? JSON.stringify(conv.metadata) : null
          );
          progress.processedConversations++;
        }

        for (const msg of messages) {
          insertMsg.run(
            msg.id, msg.conversationId, msg.role, msg.content,
            msg.sourceModel || null, msg.timestamp,
            msg.tokenCount || null, msg.parentMessageId || null,
            msg.metadata ? JSON.stringify(msg.metadata) : null
          );
        }
      });

      insertAll();

      progress.status = 'completed';
      console.log(`[import] Batch ${batchId}: ${conversations.length} conversations, ${messages.length} messages imported from ${platform}`);

    } catch (err: any) {
      progress.status = 'failed';
      progress.error = err.message;
      console.error(`[import] Batch ${batchId} failed:`, err);
    } finally {
      // Clean up uploaded file
      try { fs.unlinkSync(filePath); } catch {}
    }

    return progress;
  }

  private async extractData(filePath: string, platform: ImportPlatform): Promise<any[]> {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.json') {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [parsed];
    }

    if (ext === '.zip') {
      const zip = new AdmZip(filePath);
      const entries = zip.getEntries();

      // ChatGPT: look for conversations.json
      // Claude: look for any JSON file with conversations
      // Gemini: look for JSON files in Takeout structure

      for (const entry of entries) {
        const name = entry.entryName.toLowerCase();
        if (name.endsWith('.json') && !name.startsWith('__MACOSX') && !name.startsWith('.')) {
          // Heuristic: pick the largest JSON file or known filenames
          if (
            name === 'conversations.json' ||                  // ChatGPT
            name.includes('conversations') ||                  // Claude
            name.includes('my_activity') || name.includes('myactivity') ||  // Gemini
            entries.filter(e => e.entryName.endsWith('.json')).length === 1  // Single JSON in ZIP
          ) {
            const content = entry.getData().toString('utf-8');
            const parsed = JSON.parse(content);
            return Array.isArray(parsed) ? parsed : [parsed];
          }
        }
      }

      // Fallback: Gemini Takeout may have multiple JSON files (one per conversation)
      const jsonEntries = entries.filter(e =>
        e.entryName.endsWith('.json') &&
        !e.entryName.startsWith('__MACOSX') &&
        !e.entryName.startsWith('.')
      );
      if (jsonEntries.length > 0) {
        const allData: any[] = [];
        for (const entry of jsonEntries) {
          try {
            const content = entry.getData().toString('utf-8');
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) allData.push(...parsed);
            else allData.push(parsed);
          } catch {}
        }
        return allData;
      }

      throw new Error('No valid JSON files found in ZIP archive');
    }

    throw new Error(`Unsupported file format: ${ext}. Please upload a .json or .zip file.`);
  }
}

export const importService = new ImportService();
```

**Required dependency:**
```bash
cd apps/api && npm install adm-zip && npm install -D @types/adm-zip
```

---

## Step 5: Import Memory Module

**New file:** `apps/api/src/memory/import-store.ts`

Handles all read queries for imported data:

```typescript
import { getDb } from './db';
import { ImportedConversation, ImportedMessage, ImportPlatform } from '@prism/shared';

export function listImportedConversations(opts: {
  platform?: ImportPlatform;
  limit?: number;
  offset?: number;
  search?: string;
}): { conversations: ImportedConversation[]; total: number } {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.platform) {
    conditions.push('source_platform = ?');
    params.push(opts.platform);
  }
  if (opts.search) {
    conditions.push('title LIKE ?');
    params.push(`%${opts.search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM imported_conversations ${where}`).get(...params) as any;
  const total = countRow.total;

  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  const rows = db.prepare(`
    SELECT * FROM imported_conversations ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as any[];

  const conversations: ImportedConversation[] = rows.map(r => ({
    id: r.id,
    sourcePlatform: r.source_platform,
    originalId: r.original_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count,
    sessionId: r.session_id,
    importBatchId: r.import_batch_id,
    metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
  }));

  return { conversations, total };
}

export function getImportedMessages(conversationId: string): ImportedMessage[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM imported_messages
    WHERE conversation_id = ?
    ORDER BY timestamp ASC
  `).all(conversationId) as any[];

  return rows.map(r => ({
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    sourceModel: r.source_model,
    timestamp: r.timestamp,
    tokenCount: r.token_count,
    parentMessageId: r.parent_message_id,
    metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
  }));
}

export function getImportStats(): {
  total: number;
  byPlatform: Record<string, number>;
} {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM imported_conversations').get() as any).c;
  const rows = db.prepare(`
    SELECT source_platform, COUNT(*) as c
    FROM imported_conversations GROUP BY source_platform
  `).all() as any[];

  const byPlatform: Record<string, number> = {};
  for (const r of rows) byPlatform[r.source_platform] = r.c;

  return { total, byPlatform };
}

export function deleteImportBatch(batchId: string): number {
  const db = getDb();
  const convIds = db.prepare(
    'SELECT id FROM imported_conversations WHERE import_batch_id = ?'
  ).all(batchId) as any[];

  const deleteAll = db.transaction(() => {
    for (const { id } of convIds) {
      db.prepare('DELETE FROM imported_messages WHERE conversation_id = ?').run(id);
    }
    const info = db.prepare('DELETE FROM imported_conversations WHERE import_batch_id = ?').run(batchId);
    return info.changes;
  });

  return deleteAll();
}
```

---

## Step 6: API Routes

**New file:** `apps/api/src/routes/import.ts`

```typescript
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import os from 'os';
import { importService } from '../services/import-service';
import {
  listImportedConversations,
  getImportedMessages,
  getImportStats,
  deleteImportBatch,
} from '../memory/import-store';
import { ImportPlatform } from '@prism/shared';

const router = Router();

// Multer config: store uploads in temp dir
const upload = multer({
  dest: path.join(os.tmpdir(), 'prism-uploads'),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
  fileFilter: (_req, file, cb) => {
    const allowed = ['.json', '.zip'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${ext}`));
  },
});

// POST /api/import/upload — Upload and import a conversation archive
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const platform = req.body.platform as ImportPlatform;
    if (!platform || !['chatgpt', 'claude', 'gemini'].includes(platform)) {
      return res.status(400).json({ error: 'Invalid platform. Must be: chatgpt, claude, or gemini' });
    }

    const result = await importService.importFile(req.file.path, platform);
    res.json(result);
  } catch (err: any) {
    console.error('[import] Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/import/conversations — List imported conversations
router.get('/conversations', (req, res) => {
  const { platform, limit, offset, search } = req.query;
  const result = listImportedConversations({
    platform: platform as ImportPlatform | undefined,
    limit: limit ? parseInt(limit as string) : undefined,
    offset: offset ? parseInt(offset as string) : undefined,
    search: search as string | undefined,
  });
  res.json(result);
});

// GET /api/import/conversations/:id/messages — Get messages for a conversation
router.get('/conversations/:id/messages', (req, res) => {
  const messages = getImportedMessages(req.params.id);
  res.json(messages);
});

// GET /api/import/stats — Get import statistics
router.get('/stats', (_req, res) => {
  const stats = getImportStats();
  res.json(stats);
});

// DELETE /api/import/batch/:batchId — Delete an import batch
router.delete('/batch/:batchId', (req, res) => {
  const deleted = deleteImportBatch(req.params.batchId);
  res.json({ deleted });
});

export default router;
```

**Register the route in `apps/api/src/index.ts`:**

```typescript
import importRouter from './routes/import';
// ... after other app.use() calls:
app.use('/api/import', importRouter);
```

**Required dependency:**
```bash
cd apps/api && npm install multer && npm install -D @types/multer
```

---

## Step 7: Frontend — API Client

**File:** `apps/web/src/lib/api.ts`

Add these functions:

```typescript
/* ===== Import Engine ===== */

export async function uploadImportFile(
  file: File,
  platform: 'chatgpt' | 'claude' | 'gemini'
): Promise<any> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('platform', platform);

  const res = await fetch(`${API_BASE}/api/import/upload`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchImportedConversations(opts?: {
  platform?: string;
  limit?: number;
  offset?: number;
  search?: string;
}): Promise<{ conversations: any[]; total: number }> {
  const params = new URLSearchParams();
  if (opts?.platform) params.set('platform', opts.platform);
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.offset) params.set('offset', String(opts.offset));
  if (opts?.search) params.set('search', opts.search);

  const res = await fetch(`${API_BASE}/api/import/conversations?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchImportedMessages(conversationId: string): Promise<any[]> {
  const res = await fetch(`${API_BASE}/api/import/conversations/${conversationId}/messages`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchImportStats(): Promise<any> {
  const res = await fetch(`${API_BASE}/api/import/stats`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteImportBatch(batchId: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/import/batch/${batchId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
```

---

## Step 8: Frontend — Store Updates

**File:** `apps/web/src/stores/chat-store.ts`

Add library-related state to the Zustand store:

```typescript
// Add to state interface:
libraryConversations: ImportedConversation[];
libraryTotal: number;
librarySelectedId: string | null;
libraryMessages: ImportedMessage[];
libraryFilter: { platform?: string; search?: string };
libraryLoading: boolean;
libraryImporting: boolean;
libraryStats: { total: number; byPlatform: Record<string, number> } | null;

// Add actions:
fetchLibrary: (opts?: { platform?: string; search?: string; offset?: number }) => Promise<void>;
selectLibraryConversation: (id: string) => Promise<void>;
importFile: (file: File, platform: ImportPlatform) => Promise<ImportProgress>;
fetchLibraryStats: () => Promise<void>;
```

---

## Step 9: Frontend — Library UI Components

### 9a. LibraryView (main container)

**New file:** `apps/web/src/components/LibraryView.tsx`

Layout: Left sidebar (conversation list with filters) + Right panel (conversation detail)

Features:
- Platform filter tabs: All | ChatGPT | Claude | Gemini
- Title search input
- Import button (opens upload dialog)
- Conversation list with: title, platform icon, date, message count
- Pagination (load more on scroll)
- Selected conversation shows full message history

### 9b. ImportDialog

**New file:** `apps/web/src/components/ImportDialog.tsx`

Modal dialog for uploading files:
- Platform selector (3 buttons with logos: ChatGPT, Claude, Gemini)
- Drag-and-drop zone for file upload (accepts .json, .zip)
- Progress indicator during import
- Success/error result display
- Instructions per platform (how to export from each)

### 9c. Update ModeSelector

**File:** `apps/web/src/components/ModeSelector.tsx`

Add a new mode button for "Library" (📚 icon).

### 9d. Update page.tsx

**File:** `apps/web/src/app/page.tsx`

Add the library mode rendering:
```tsx
{mode === 'library' && <LibraryView />}
```

---

## Step 10: Testing Checklist

After implementation, verify:

1. **ChatGPT import**: Download a ChatGPT export, upload to Prism, verify conversations appear with correct titles, messages, timestamps, and model info
2. **Claude import**: Download a Claude export, upload to Prism, verify same
3. **Gemini import**: Download a Google Takeout Gemini export, verify same
4. **Large files**: Test with a ZIP containing 500+ conversations (should complete in < 30 seconds)
5. **Error handling**: Upload an invalid file format, verify graceful error message
6. **Platform filter**: Filter conversations by platform, verify correct filtering
7. **Title search**: Search by title, verify matching results
8. **Pagination**: With 100+ conversations, verify scroll-based loading
9. **Re-import**: Import the same file twice, verify duplicates are created (no upsert — this is intentional for MVP, dedup comes in 7b)

---

## Dependencies to Install

```bash
cd apps/api
npm install adm-zip multer
npm install -D @types/adm-zip @types/multer
```

---

## Files Created/Modified Summary

| Action | Path |
|--------|------|
| MODIFY | `apps/api/src/memory/db.ts` — Add 2 new tables + indexes |
| MODIFY | `packages/shared/src/types.ts` — Add import types, update OperationMode |
| CREATE | `apps/api/src/parsers/base-parser.ts` |
| CREATE | `apps/api/src/parsers/chatgpt-parser.ts` |
| CREATE | `apps/api/src/parsers/claude-parser.ts` |
| CREATE | `apps/api/src/parsers/gemini-parser.ts` |
| CREATE | `apps/api/src/parsers/index.ts` |
| CREATE | `apps/api/src/services/import-service.ts` |
| CREATE | `apps/api/src/memory/import-store.ts` |
| CREATE | `apps/api/src/routes/import.ts` |
| MODIFY | `apps/api/src/index.ts` — Register import route |
| MODIFY | `apps/web/src/lib/api.ts` — Add import API functions |
| MODIFY | `apps/web/src/stores/chat-store.ts` — Add library state |
| CREATE | `apps/web/src/components/LibraryView.tsx` |
| CREATE | `apps/web/src/components/ImportDialog.tsx` |
| MODIFY | `apps/web/src/components/ModeSelector.tsx` — Add Library mode |
| MODIFY | `apps/web/src/app/page.tsx` — Render LibraryView |
