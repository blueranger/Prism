# Phase 7b Implementation Plan — Unified Search

## Goal
Users can search across ALL content in Prism — both imported conversations (from Phase 7a) and native Prism conversations — using full-text search. Results are ranked by relevance, filterable by platform/date/model, and clickable to navigate directly to the matching conversation.

## Prerequisites
- Phase 7a must be completed (imported_conversations + imported_messages tables exist and are populated)

---

## Step 1: Enable SQLite FTS5

**File:** `apps/api/src/memory/db.ts`

Add FTS5 virtual tables AFTER the `imported_messages` table creation (from Phase 7a):

```sql
-- FTS5 index for imported messages
CREATE VIRTUAL TABLE IF NOT EXISTS imported_messages_fts USING fts5(
  content,
  content=imported_messages,
  content_rowid=rowid,
  tokenize='unicode61'
);

-- FTS5 index for imported conversation titles
CREATE VIRTUAL TABLE IF NOT EXISTS imported_conversations_fts USING fts5(
  title,
  content=imported_conversations,
  content_rowid=rowid,
  tokenize='unicode61'
);

-- FTS5 index for native Prism messages
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content=messages,
  content_rowid=rowid,
  tokenize='unicode61'
);
```

Add triggers to keep FTS indexes in sync:

```sql
-- Triggers for imported_messages_fts
CREATE TRIGGER IF NOT EXISTS imported_messages_ai AFTER INSERT ON imported_messages BEGIN
  INSERT INTO imported_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS imported_messages_ad AFTER DELETE ON imported_messages BEGIN
  INSERT INTO imported_messages_fts(imported_messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS imported_messages_au AFTER UPDATE ON imported_messages BEGIN
  INSERT INTO imported_messages_fts(imported_messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO imported_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Triggers for imported_conversations_fts
CREATE TRIGGER IF NOT EXISTS imported_conversations_ai AFTER INSERT ON imported_conversations BEGIN
  INSERT INTO imported_conversations_fts(rowid, title) VALUES (new.rowid, new.title);
END;

CREATE TRIGGER IF NOT EXISTS imported_conversations_ad AFTER DELETE ON imported_conversations BEGIN
  INSERT INTO imported_conversations_fts(imported_conversations_fts, rowid, title) VALUES('delete', old.rowid, old.title);
END;

CREATE TRIGGER IF NOT EXISTS imported_conversations_au AFTER UPDATE ON imported_conversations BEGIN
  INSERT INTO imported_conversations_fts(imported_conversations_fts, rowid, title) VALUES('delete', old.rowid, old.title);
  INSERT INTO imported_conversations_fts(rowid, title) VALUES (new.rowid, new.title);
END;

-- Triggers for messages_fts
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

**IMPORTANT — Backfill existing data into FTS indexes:**

Add this at the end of the DB initialization (after all CREATE statements), to populate FTS from existing data:

```typescript
// Backfill FTS indexes from existing data (safe to run multiple times)
try {
  const importedMsgCount = (db.prepare('SELECT COUNT(*) as c FROM imported_messages').get() as any).c;
  const ftsCount = (db.prepare('SELECT COUNT(*) as c FROM imported_messages_fts').get() as any).c;
  if (importedMsgCount > 0 && ftsCount === 0) {
    console.log('[db] Backfilling imported_messages_fts...');
    db.exec('INSERT INTO imported_messages_fts(rowid, content) SELECT rowid, content FROM imported_messages');
    console.log(`[db] Backfilled ${importedMsgCount} imported messages into FTS`);
  }

  const importedConvCount = (db.prepare('SELECT COUNT(*) as c FROM imported_conversations').get() as any).c;
  const convFtsCount = (db.prepare('SELECT COUNT(*) as c FROM imported_conversations_fts').get() as any).c;
  if (importedConvCount > 0 && convFtsCount === 0) {
    console.log('[db] Backfilling imported_conversations_fts...');
    db.exec('INSERT INTO imported_conversations_fts(rowid, title) SELECT rowid, title FROM imported_conversations');
    console.log(`[db] Backfilled ${importedConvCount} imported conversations into FTS`);
  }

  const msgCount = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as any).c;
  const msgFtsCount = (db.prepare('SELECT COUNT(*) as c FROM messages_fts').get() as any).c;
  if (msgCount > 0 && msgFtsCount === 0) {
    console.log('[db] Backfilling messages_fts...');
    db.exec('INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages');
    console.log(`[db] Backfilled ${msgCount} messages into FTS`);
  }
} catch (err) {
  console.warn('[db] FTS backfill warning:', err);
}
```

---

## Step 2: Shared Types

**File:** `packages/shared/src/types.ts`

Add search-related types:

```typescript
/* ===== Phase 7b: Unified Search ===== */

export type SearchResultSource = 'imported' | 'native';

export interface SearchResult {
  id: string;                           // message id
  conversationId: string;               // imported_conversation.id or session.id
  conversationTitle: string;
  source: SearchResultSource;           // 'imported' or 'native'
  sourcePlatform?: ImportPlatform;      // for imported: 'chatgpt' | 'claude' | 'gemini'
  role: MessageRole;
  content: string;                       // full message content
  snippet: string;                       // highlighted snippet with match context
  sourceModel?: string;
  timestamp: string;
  rank: number;                          // FTS5 rank score
}

export interface SearchQuery {
  query: string;
  filters?: {
    source?: SearchResultSource;         // 'imported' | 'native' | undefined (both)
    platform?: ImportPlatform;           // filter by original platform
    dateFrom?: string;                   // ISO date
    dateTo?: string;                     // ISO date
    role?: MessageRole;                  // 'user' | 'assistant'
    model?: string;                      // filter by source model
  };
  limit?: number;
  offset?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  queryTimeMs: number;
}
```

---

## Step 3: Search Service

**New file:** `apps/api/src/services/search-service.ts`

```typescript
import { getDb } from '../memory/db';
import { SearchQuery, SearchResponse, SearchResult } from '@prism/shared';

export class SearchService {
  search(query: SearchQuery): SearchResponse {
    const startTime = Date.now();
    const db = getDb();
    const results: SearchResult[] = [];
    const limit = query.limit || 30;
    const offset = query.offset || 0;

    const ftsQuery = this.buildFtsQuery(query.query);

    // Search imported messages
    if (!query.filters?.source || query.filters.source === 'imported') {
      const importedResults = this.searchImported(db, ftsQuery, query, limit, offset);
      results.push(...importedResults);
    }

    // Search native Prism messages
    if (!query.filters?.source || query.filters.source === 'native') {
      const nativeResults = this.searchNative(db, ftsQuery, query, limit, offset);
      results.push(...nativeResults);
    }

    // Sort all results by rank (FTS5 rank is negative; more negative = better match)
    results.sort((a, b) => a.rank - b.rank);

    // Apply overall limit
    const sliced = results.slice(0, limit);

    return {
      results: sliced,
      total: results.length,
      queryTimeMs: Date.now() - startTime,
    };
  }

  private searchImported(db: any, ftsQuery: string, query: SearchQuery, limit: number, offset: number): SearchResult[] {
    const conditions: string[] = [];
    const params: any[] = [ftsQuery];

    if (query.filters?.platform) {
      conditions.push('c.source_platform = ?');
      params.push(query.filters.platform);
    }
    if (query.filters?.dateFrom) {
      conditions.push('m.timestamp >= ?');
      params.push(query.filters.dateFrom);
    }
    if (query.filters?.dateTo) {
      conditions.push('m.timestamp <= ?');
      params.push(query.filters.dateTo);
    }
    if (query.filters?.role) {
      conditions.push('m.role = ?');
      params.push(query.filters.role);
    }
    if (query.filters?.model) {
      conditions.push('m.source_model = ?');
      params.push(query.filters.model);
    }

    const extraWhere = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';

    const sql = `
      SELECT
        m.id, m.conversation_id, c.title as conversation_title,
        'imported' as source, c.source_platform,
        m.role, m.content, m.source_model, m.timestamp,
        rank
      FROM imported_messages_fts fts
      JOIN imported_messages m ON m.rowid = fts.rowid
      JOIN imported_conversations c ON c.id = m.conversation_id
      WHERE imported_messages_fts MATCH ?
      ${extraWhere}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);
    const rows = db.prepare(sql).all(...params) as any[];

    return rows.map(r => ({
      id: r.id,
      conversationId: r.conversation_id,
      conversationTitle: r.conversation_title,
      source: 'imported' as const,
      sourcePlatform: r.source_platform,
      role: r.role,
      content: r.content,
      snippet: this.extractSnippet(r.content, query.query),
      sourceModel: r.source_model,
      timestamp: r.timestamp,
      rank: r.rank,
    }));
  }

  private searchNative(db: any, ftsQuery: string, query: SearchQuery, limit: number, offset: number): SearchResult[] {
    const conditions: string[] = [];
    const params: any[] = [ftsQuery];

    if (query.filters?.dateFrom) {
      conditions.push('m.timestamp >= ?');
      params.push(query.filters.dateFrom);
    }
    if (query.filters?.dateTo) {
      conditions.push('m.timestamp <= ?');
      params.push(query.filters.dateTo);
    }
    if (query.filters?.role) {
      conditions.push('m.role = ?');
      params.push(query.filters.role);
    }
    if (query.filters?.model) {
      conditions.push('m.source_model = ?');
      params.push(query.filters.model);
    }

    const extraWhere = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';

    const sql = `
      SELECT
        m.id, m.session_id, s.title as session_title,
        'native' as source,
        m.role, m.content, m.source_model, m.timestamp,
        rank
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      LEFT JOIN sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH ?
      ${extraWhere}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);
    const rows = db.prepare(sql).all(...params) as any[];

    return rows.map(r => ({
      id: r.id,
      conversationId: r.session_id,
      conversationTitle: r.session_title || 'Prism Session',
      source: 'native' as const,
      role: r.role,
      content: r.content,
      snippet: this.extractSnippet(r.content, query.query),
      sourceModel: r.source_model,
      timestamp: r.timestamp,
      rank: r.rank,
    }));
  }

  /**
   * Build FTS5 query string from user input.
   * Handles basic quoting and escaping for safety.
   */
  private buildFtsQuery(userQuery: string): string {
    // For simple queries, just wrap each term with quotes for exact matching
    // FTS5 supports: AND, OR, NOT, "phrase", NEAR(), prefix*
    const trimmed = userQuery.trim();
    if (!trimmed) return '""';

    // If user already uses FTS syntax (quotes, AND, OR), pass through
    if (/["*]|AND|OR|NOT|NEAR/.test(trimmed)) {
      return trimmed;
    }

    // Otherwise, treat as a simple phrase search or multi-word OR
    // Split into words and join with implicit AND
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length === 1) return `"${words[0]}"*`; // prefix match for single word
    return words.map(w => `"${w}"`).join(' ');        // AND semantics (FTS5 default)
  }

  /**
   * Extract a snippet around the first match occurrence.
   */
  private extractSnippet(content: string, query: string, contextChars: number = 100): string {
    const lowerContent = content.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const words = lowerQuery.split(/\s+/).filter(Boolean);

    // Find the first matching word position
    let matchPos = -1;
    for (const word of words) {
      const pos = lowerContent.indexOf(word);
      if (pos !== -1 && (matchPos === -1 || pos < matchPos)) {
        matchPos = pos;
      }
    }

    if (matchPos === -1) {
      // No direct match found (FTS may have matched via stemming)
      return content.slice(0, contextChars * 2) + (content.length > contextChars * 2 ? '...' : '');
    }

    const start = Math.max(0, matchPos - contextChars);
    const end = Math.min(content.length, matchPos + contextChars);

    let snippet = '';
    if (start > 0) snippet += '...';
    snippet += content.slice(start, end);
    if (end < content.length) snippet += '...';

    return snippet;
  }
}

export const searchService = new SearchService();
```

---

## Step 4: API Routes

**New file:** `apps/api/src/routes/search.ts`

```typescript
import { Router } from 'express';
import { searchService } from '../services/search-service';
import { SearchQuery } from '@prism/shared';

const router = Router();

// POST /api/search — Full-text search across all conversations
router.post('/', (req, res) => {
  try {
    const body = req.body as SearchQuery;
    if (!body.query || !body.query.trim()) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    const result = searchService.search(body);
    res.json(result);
  } catch (err: any) {
    console.error('[search] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/search?q=...&platform=...&source=... — Simple GET search
router.get('/', (req, res) => {
  try {
    const q = req.query.q as string;
    if (!q || !q.trim()) {
      return res.status(400).json({ error: 'Search query (q) is required' });
    }

    const query: SearchQuery = {
      query: q,
      filters: {},
      limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string) : undefined,
    };

    if (req.query.source) query.filters!.source = req.query.source as any;
    if (req.query.platform) query.filters!.platform = req.query.platform as any;
    if (req.query.dateFrom) query.filters!.dateFrom = req.query.dateFrom as string;
    if (req.query.dateTo) query.filters!.dateTo = req.query.dateTo as string;
    if (req.query.role) query.filters!.role = req.query.role as any;
    if (req.query.model) query.filters!.model = req.query.model as string;

    const result = searchService.search(query);
    res.json(result);
  } catch (err: any) {
    console.error('[search] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
```

**Register in `apps/api/src/index.ts`:**

```typescript
import searchRouter from './routes/search';
// ... after other app.use() calls:
app.use('/api/search', searchRouter);
```

---

## Step 5: Frontend — API Client

**File:** `apps/web/src/lib/api.ts`

Add:

```typescript
/* ===== Unified Search ===== */

export async function searchAll(params: {
  query: string;
  source?: 'imported' | 'native';
  platform?: string;
  dateFrom?: string;
  dateTo?: string;
  role?: string;
  model?: string;
  limit?: number;
  offset?: number;
}): Promise<{ results: any[]; total: number; queryTimeMs: number }> {
  const urlParams = new URLSearchParams();
  urlParams.set('q', params.query);
  if (params.source) urlParams.set('source', params.source);
  if (params.platform) urlParams.set('platform', params.platform);
  if (params.dateFrom) urlParams.set('dateFrom', params.dateFrom);
  if (params.dateTo) urlParams.set('dateTo', params.dateTo);
  if (params.role) urlParams.set('role', params.role);
  if (params.model) urlParams.set('model', params.model);
  if (params.limit) urlParams.set('limit', String(params.limit));
  if (params.offset) urlParams.set('offset', String(params.offset));

  const res = await fetch(`${API_BASE}/api/search?${urlParams}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
```

---

## Step 6: Frontend — Store Updates

**File:** `apps/web/src/stores/chat-store.ts`

Add search-related state:

```typescript
// Add to state interface:
searchQuery: string;
searchResults: SearchResult[];
searchTotal: number;
searchTimeMs: number;
searchLoading: boolean;
searchFilters: {
  source?: 'imported' | 'native';
  platform?: ImportPlatform;
  dateFrom?: string;
  dateTo?: string;
};

// Add actions:
setSearchQuery: (q: string) => void;
setSearchFilters: (filters: Partial<typeof searchFilters>) => void;
performSearch: () => Promise<void>;
clearSearch: () => void;
```

---

## Step 7: Frontend — Search UI Components

### 7a. Global Search Bar

**New file:** `apps/web/src/components/SearchBar.tsx`

A persistent search bar at the top of the app (visible in all modes):
- Search input with magnifying glass icon
- Debounced search (300ms delay after typing stops)
- Shows result count and query time
- Clicking a result navigates to that conversation
- Keyboard shortcut: Cmd+K or Ctrl+K to focus

Place this component in `page.tsx`, above the mode-specific content.

### 7b. SearchResults Panel

**New file:** `apps/web/src/components/SearchResults.tsx`

Displayed when search is active (searchQuery is non-empty):
- Takes over the main content area (temporarily replaces the current mode view)
- Filter chips at top: Source (All / Imported / Native), Platform (ChatGPT / Claude / Gemini), Date range
- Result cards showing:
  - Conversation title (clickable → navigates to conversation)
  - Platform icon + model name
  - Timestamp
  - Highlighted snippet with search terms emphasized (bold or yellow background)
  - Role badge (user/assistant)
- Pagination: "Load more" button or infinite scroll
- Empty state: "No results found for {query}"
- Press Escape to clear search and return to normal mode

### 7c. Update page.tsx

**File:** `apps/web/src/app/page.tsx`

Add search bar and conditional search results rendering:

```tsx
<SearchBar />
{searchQuery ? (
  <SearchResults />
) : (
  // ... existing mode rendering (parallel, handoff, etc.)
)}
```

### 7d. Search Result Navigation

When a user clicks a search result:
- **Imported conversation**: Switch to `library` mode, select that conversation
- **Native conversation**: Switch to the appropriate mode, load that session via `switchSession(sessionId)`

Add navigation logic in the store or as a utility:

```typescript
navigateToSearchResult: (result: SearchResult) => {
  if (result.source === 'imported') {
    set({ mode: 'library' });
    get().selectLibraryConversation(result.conversationId);
  } else {
    set({ mode: 'parallel' }); // or whatever mode that session was
    get().switchSession(result.conversationId);
  }
  get().clearSearch();
}
```

---

## Step 8: Enhance Library View with Search

**File:** `apps/web/src/components/LibraryView.tsx` (from Phase 7a)

Update the library's existing title search to use FTS5 instead of LIKE:

- The library's search input should also call the search API with `source: 'imported'` filter
- This provides much better search quality (matches message content, not just titles)

---

## Step 9: Testing Checklist

1. **Basic search**: Type a keyword, verify results appear from both imported and native conversations
2. **Phrase search**: Use quotes "exact phrase", verify exact match
3. **Filter by platform**: Select "ChatGPT only", verify only ChatGPT results
4. **Filter by source**: Toggle "Imported" / "Native" / "All"
5. **Filter by date range**: Set date range, verify results within range
6. **Snippet highlighting**: Search for a word, verify the snippet shows context around the match
7. **Navigation**: Click an imported result → goes to Library mode. Click a native result → loads that session
8. **Performance**: With 10,000+ imported messages, search should return in < 200ms
9. **Empty query**: Verify no request is made with empty search
10. **Keyboard shortcut**: Press Cmd+K, verify search bar focuses
11. **FTS backfill**: After importing new conversations, verify they are searchable immediately (triggers handle this)
12. **Escape to close**: Press Escape while search results are shown, verify it returns to previous mode

---

## Files Created/Modified Summary

| Action | Path |
|--------|------|
| MODIFY | `apps/api/src/memory/db.ts` — Add FTS5 tables, triggers, backfill |
| MODIFY | `packages/shared/src/types.ts` — Add search types |
| CREATE | `apps/api/src/services/search-service.ts` |
| CREATE | `apps/api/src/routes/search.ts` |
| MODIFY | `apps/api/src/index.ts` — Register search route |
| MODIFY | `apps/web/src/lib/api.ts` — Add search API function |
| MODIFY | `apps/web/src/stores/chat-store.ts` — Add search state |
| CREATE | `apps/web/src/components/SearchBar.tsx` |
| CREATE | `apps/web/src/components/SearchResults.tsx` |
| MODIFY | `apps/web/src/app/page.tsx` — Add SearchBar + conditional rendering |
| MODIFY | `apps/web/src/components/LibraryView.tsx` — Use FTS for library search |
