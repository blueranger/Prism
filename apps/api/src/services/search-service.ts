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

    return rows.map((r: any) => ({
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

    // Native messages use INTEGER timestamps (epoch ms), so convert date filters
    if (query.filters?.dateFrom) {
      conditions.push('m.timestamp >= ?');
      params.push(new Date(query.filters.dateFrom).getTime());
    }
    if (query.filters?.dateTo) {
      conditions.push('m.timestamp <= ?');
      params.push(new Date(query.filters.dateTo).getTime());
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

    return rows.map((r: any) => ({
      id: r.id,
      conversationId: r.session_id,
      conversationTitle: r.session_title || 'Prism Session',
      source: 'native' as const,
      role: r.role,
      content: r.content,
      snippet: this.extractSnippet(r.content, query.query),
      sourceModel: r.source_model,
      // Native timestamps are integers; convert to ISO for consistency
      timestamp: typeof r.timestamp === 'number'
        ? new Date(r.timestamp).toISOString()
        : r.timestamp,
      rank: r.rank,
    }));
  }

  /**
   * Build FTS5 query string from user input.
   */
  private buildFtsQuery(userQuery: string): string {
    const trimmed = userQuery.trim();
    if (!trimmed) return '""';

    // If user already uses FTS syntax (quotes, AND, OR), pass through
    if (/["*]|AND|OR|NOT|NEAR/.test(trimmed)) {
      return trimmed;
    }

    // Otherwise, split into words and join with implicit AND
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
