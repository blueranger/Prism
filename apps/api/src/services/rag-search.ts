/**
 * RAG Search Service
 *
 * Implements hybrid search combining FTS5 keyword search with vector semantic search.
 * Uses Reciprocal Rank Fusion (RRF) to combine results from both methods.
 *
 * Supports flexible filtering and customizable balance between keyword and semantic matching.
 */

import { getDb } from '../memory/db';
import {
  RAGSearchQuery,
  RAGSearchResponse,
  RAGSearchResult,
  TextChunk,
} from '@prism/shared';
import {
  getEmbedding,
  bufferToEmbedding,
  cosineSimilarity,
} from './embedding-service';

/**
 * Logs a message with rag-search prefix
 */
function log(message: string, ...args: unknown[]): void {
  console.log(`[rag-search] ${message}`, ...args);
}

/**
 * Logs an error with rag-search prefix
 */
function logError(message: string, ...args: unknown[]): void {
  console.error(`[rag-search] ERROR: ${message}`, ...args);
}

/**
 * Converts snake_case database row to camelCase TextChunk interface
 */
function rowToTextChunk(row: any): TextChunk {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sessionId: row.session_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    tokenCount: row.token_count,
    createdAt: row.created_at,
  };
}

/**
 * Generates a snippet from content by finding query terms and extracting context
 *
 * @param content - The full text content
 * @param query - The search query to find in content
 * @param maxLength - Maximum length of the snippet (default 200)
 * @returns Trimmed and ellipsis-marked snippet
 */
export function generateSnippet(
  content: string,
  query: string,
  maxLength: number = 200
): string {
  if (!content) return '';

  // Find the first occurrence of any query word (case-insensitive)
  const queryWords = query.toLowerCase().split(/\s+/);
  let firstMatchIndex = -1;

  for (const word of queryWords) {
    if (word.length > 2) {
      const index = content.toLowerCase().indexOf(word);
      if (index !== -1 && (firstMatchIndex === -1 || index < firstMatchIndex)) {
        firstMatchIndex = index;
      }
    }
  }

  // If no match found, start from beginning
  if (firstMatchIndex === -1) {
    firstMatchIndex = 0;
  }

  // Extract context around the match
  const startIndex = Math.max(0, firstMatchIndex - 50);
  const endIndex = Math.min(content.length, startIndex + maxLength);

  let snippet = content.substring(startIndex, endIndex);

  // Add ellipsis if truncated
  if (startIndex > 0) {
    snippet = '...' + snippet;
  }
  if (endIndex < content.length) {
    snippet = snippet + '...';
  }

  return snippet;
}

/**
 * Performs FTS5 keyword search on text chunks
 *
 * @param query - The search query
 * @param filters - Optional filters (sourceType, sessionId, date range)
 * @returns Array of { chunkId, rank } sorted by rank
 */
function keywordSearch(
  query: string,
  filters?: RAGSearchQuery['filters']
): { chunkId: string; rank: number }[] {
  try {
    const db = getDb();

    // Build the WHERE clause
    let whereClause = '';
    const params: any[] = [query];

    if (filters?.sourceType) {
      whereClause += " AND tc.source_type = ?";
      params.push(filters.sourceType);
    }

    if (filters?.sessionId) {
      whereClause += " AND tc.session_id = ?";
      params.push(filters.sessionId);
    }

    if (filters?.dateFrom) {
      whereClause += " AND tc.created_at >= ?";
      params.push(filters.dateFrom);
    }

    if (filters?.dateTo) {
      whereClause += " AND tc.created_at <= ?";
      params.push(filters.dateTo);
    }

    const sql = `
      SELECT tc.id, rank FROM text_chunks_fts(?)
      JOIN text_chunks tc ON text_chunks_fts.rowid = tc.rowid
      WHERE 1=1 ${whereClause}
      ORDER BY rank ASC
      LIMIT 30
    `;

    const rows = db.prepare(sql).all(...params) as {
      id: string;
      rank: number;
    }[];

    return rows.map((row, index) => ({
      chunkId: row.id,
      rank: index + 1, // Use position in result set as rank
    }));
  } catch (error) {
    logError('Keyword search failed:', error);
    return [];
  }
}

/**
 * Performs vector semantic search on text chunks
 *
 * @param query - The search query
 * @param filters - Optional filters (sourceType, sessionId, date range)
 * @returns Array of { chunkId, similarity } sorted by similarity descending
 */
async function semanticSearch(
  query: string,
  filters?: RAGSearchQuery['filters']
): Promise<{ chunkId: string; similarity: number }[]> {
  try {
    const db = getDb();

    // Get query embedding
    log(`Computing embedding for query: "${query.substring(0, 50)}..."`);
    let queryEmbedding: Float32Array;
    try {
      queryEmbedding = await getEmbedding(query);
    } catch (error) {
      logError('Failed to generate query embedding, skipping semantic search:', error);
      return [];
    }

    // Build filter query
    let whereClause = '';
    const params: any[] = [];

    if (filters?.sourceType) {
      whereClause += " AND tc.source_type = ?";
      params.push(filters.sourceType);
    }

    if (filters?.sessionId) {
      whereClause += " AND tc.session_id = ?";
      params.push(filters.sessionId);
    }

    if (filters?.dateFrom) {
      whereClause += " AND tc.created_at >= ?";
      params.push(filters.dateFrom);
    }

    if (filters?.dateTo) {
      whereClause += " AND tc.created_at <= ?";
      params.push(filters.dateTo);
    }

    // Load all matching embeddings
    const sql = `
      SELECT ce.chunk_id, ce.embedding
      FROM chunk_embeddings ce
      JOIN text_chunks tc ON ce.chunk_id = tc.id
      WHERE 1=1 ${whereClause}
    `;

    const rows = db.prepare(sql).all(...params) as {
      chunk_id: string;
      embedding: Buffer;
    }[];

    if (rows.length === 0) {
      log('No embeddings found for semantic search');
      return [];
    }

    log(`Computing similarity for ${rows.length} chunks`);

    // Compute cosine similarity for each embedding
    const results = rows
      .map((row) => {
        try {
          const embedding = bufferToEmbedding(row.embedding);
          const similarity = cosineSimilarity(queryEmbedding, embedding);
          return { chunkId: row.chunk_id, similarity };
        } catch (error) {
          logError(`Failed to decode embedding for chunk ${row.chunk_id}:`, error);
          return null;
        }
      })
      .filter((r) => r !== null) as { chunkId: string; similarity: number }[];

    // Filter by minimum similarity threshold, sort descending, take top 30
    const MIN_SIMILARITY = 0.3;
    return results
      .filter((r) => r.similarity >= MIN_SIMILARITY)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 30);
  } catch (error) {
    logError('Semantic search failed:', error);
    return [];
  }
}

/**
 * Applies Reciprocal Rank Fusion to combine keyword and semantic results
 *
 * @param keywordResults - Keyword search results
 * @param semanticResults - Semantic search results
 * @param weight - Hybrid weight (0 = pure keyword, 1 = pure semantic, default 0.5)
 * @returns Combined and ranked results
 */
function applyRRF(
  keywordResults: { chunkId: string; rank: number }[],
  semanticResults: { chunkId: string; similarity: number }[],
  weight: number = 0.5
): { chunkId: string; score: number }[] {
  const RRF_K = 60; // Standard RRF constant
  const missingRank = 1000; // High rank for missing results

  // Create maps for quick lookup
  const keywordMap = new Map(keywordResults.map((r) => [r.chunkId, r.rank]));
  const semanticMap = new Map(
    semanticResults.map((r, index) => [r.chunkId, index + 1]) // Convert similarity rank
  );

  // Collect all unique chunk IDs
  const allChunkIds = new Set<string>();
  keywordResults.forEach((r) => allChunkIds.add(r.chunkId));
  semanticResults.forEach((r) => allChunkIds.add(r.chunkId));

  // Calculate RRF score for each chunk
  const scored = Array.from(allChunkIds).map((chunkId) => {
    const keywordRank = keywordMap.get(chunkId) ?? missingRank;
    const semanticRank = semanticMap.get(chunkId) ?? missingRank;

    const keywordScore = 1 / (RRF_K + keywordRank);
    const semanticScore = 1 / (RRF_K + semanticRank);

    const combinedScore = (1 - weight) * keywordScore + weight * semanticScore;

    return { chunkId, score: combinedScore };
  });

  // Sort by score descending
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Main RAG search function implementing hybrid search
 *
 * @param query - The search query with optional filters and parameters
 * @returns Promise resolving to RAGSearchResponse with results, total count, and query time
 */
export async function ragSearch(query: RAGSearchQuery): Promise<RAGSearchResponse> {
  const startTime = Date.now();
  const db = getDb();

  try {
    log(
      `Starting RAG search: "${query.query.substring(0, 50)}..." limit=${query.limit ?? 10}`
    );

    const limit = query.limit ?? 10;
    const hybridWeight = query.hybridWeight ?? 0.5;

    // 1. Perform FTS5 keyword search
    log('Running keyword search...');
    const keywordResults = keywordSearch(query.query, query.filters);
    log(`Keyword search returned ${keywordResults.length} results`);

    // 2. Perform vector semantic search
    log('Running semantic search...');
    let semanticSearchFailed = false;
    let semanticResults: { chunkId: string; similarity: number }[] = [];
    try {
      semanticResults = await semanticSearch(query.query, query.filters);
      log(`Semantic search returned ${semanticResults.length} results`);
      if (semanticResults.length > 0) {
        log(`Top semantic similarity: ${semanticResults[0].similarity.toFixed(4)}`);
      }
    } catch (error) {
      logError('Semantic search threw an error:', error);
      semanticSearchFailed = true;
    }

    // 3. Apply RRF combination
    let combinedResults: { chunkId: string; score: number }[] = [];

    if (keywordResults.length === 0 && semanticResults.length === 0) {
      log('No results from either search method');
    } else if (semanticResults.length === 0) {
      // Fallback to keyword-only search
      log('No semantic results, using keyword search only');
      combinedResults = keywordResults.map((r) => ({
        chunkId: r.chunkId,
        score: 1 / (60 + r.rank),
      }));
    } else {
      // Combine using RRF
      log(`Applying RRF with weight=${hybridWeight}`);
      combinedResults = applyRRF(keywordResults, semanticResults, hybridWeight);
    }

    // 4. Normalize scores to 0-1 range
    if (combinedResults.length > 0) {
      const maxScore = combinedResults[0].score;
      const minScore = combinedResults[combinedResults.length - 1].score;
      const range = maxScore - minScore;
      if (range > 0) {
        combinedResults.forEach((r) => {
          r.score = (r.score - minScore) / range;
        });
      } else {
        // All scores are the same — normalize to 1.0
        combinedResults.forEach((r) => {
          r.score = 1.0;
        });
      }
    }

    // 5. Load full chunks and build results
    const topResults = combinedResults.slice(0, limit);
    const results: RAGSearchResult[] = [];

    for (const combined of topResults) {
      try {
        // Load the full text chunk
        const row = db
          .prepare('SELECT * FROM text_chunks WHERE id = ?')
          .get(combined.chunkId) as any;

        if (!row) {
          logError(`Chunk not found: ${combined.chunkId}`);
          continue;
        }

        const chunk = rowToTextChunk(row);

        // Determine match type
        const inKeyword = keywordResults.some((r) => r.chunkId === combined.chunkId);
        const inSemantic = semanticResults.some((r) => r.chunkId === combined.chunkId);
        const matchType: 'keyword' | 'semantic' | 'hybrid' = inKeyword
          ? inSemantic
            ? 'hybrid'
            : 'keyword'
          : 'semantic';

        // Generate source label
        let sourceLabel = chunk.sourceId;
        if (chunk.sourceType === 'uploaded_file') {
          const fileRow = db
            .prepare('SELECT filename FROM uploaded_files WHERE id = ?')
            .get(chunk.sourceId) as { filename: string } | undefined;
          if (fileRow) {
            sourceLabel = fileRow.filename;
          }
        } else if (chunk.sourceType === 'message') {
          // Session messages — look up session title
          const sid = chunk.sessionId || chunk.sourceId;
          const sessionRow = db
            .prepare('SELECT title FROM sessions WHERE id = ?')
            .get(sid) as { title: string | null } | undefined;
          sourceLabel = sessionRow?.title || `Session ${sid.slice(0, 8)}`;
        } else if (chunk.sourceType === 'imported_conversation') {
          // Library conversations — look up conversation title
          const convRow = db
            .prepare('SELECT title, source_platform FROM imported_conversations WHERE id = ?')
            .get(chunk.sourceId) as { title: string; source_platform: string } | undefined;
          if (convRow) {
            const platformLabel = convRow.source_platform.charAt(0).toUpperCase() + convRow.source_platform.slice(1);
            sourceLabel = `[${platformLabel}] ${convRow.title}`;
          }
        }

        // Generate snippet
        const snippet = generateSnippet(chunk.content, query.query);

        results.push({
          chunk,
          score: combined.score,
          sourceLabel,
          snippet,
          matchType,
        });
      } catch (error) {
        logError(`Failed to process result chunk ${combined.chunkId}:`, error);
      }
    }

    const queryTimeMs = Date.now() - startTime;
    log(
      `RAG search completed: ${results.length} results in ${queryTimeMs}ms`
    );

    return {
      results,
      total: combinedResults.length,
      queryTimeMs,
    };
  } catch (error) {
    logError('RAG search failed:', error);
    const queryTimeMs = Date.now() - startTime;
    return {
      results: [],
      total: 0,
      queryTimeMs,
    };
  }
}
