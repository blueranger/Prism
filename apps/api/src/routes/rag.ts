import { Router, Request, Response } from 'express';
import { ragSearch } from '../services/rag-search';
import {
  indexUploadedFile,
  indexSessionMessages,
  indexImportedConversation,
  getIndexStats,
} from '../services/rag-indexer';
import { summarizeTextWithLLM } from '../utils/vision';
import type {
  RAGSearchQuery,
  RAGSearchResponse,
  RAGAskQuery,
  RAGAskResponse,
  RAGIndexStats,
} from '@prism/shared';

const router = Router();

/**
 * POST /search
 * Search the RAG index with a query
 */
router.post('/search', async (req: Request, res: Response) => {
  try {
    const { query, filters, limit, hybridWeight } = req.body as RAGSearchQuery;

    // Validate input
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      res.status(400).json({ error: 'Query must be a non-empty string' });
      return;
    }

    const searchResponse = await ragSearch({
      query: query.trim(),
      filters,
      limit,
      hybridWeight,
    });

    res.status(200).json(searchResponse);
  } catch (error) {
    console.error('Error in RAG search:', error);
    res.status(500).json({
      error: 'Failed to search RAG index',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /ask
 * Search RAG index and generate an answer using an LLM
 */
router.post('/ask', async (req: Request, res: Response) => {
  try {
    const {
      query,
      model,
      filters,
      maxChunks,
      sessionId,
    } = req.body as RAGAskQuery;

    // Validate input
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      res.status(400).json({ error: 'Query must be a non-empty string' });
      return;
    }

    // Step 1: Search RAG index
    const searchResponse = await ragSearch({
      query: query.trim(),
      filters,
      limit: maxChunks ?? 10,
    });

    // Step 2: Build RAG context from numbered search results
    let ragContext = `You are a knowledge assistant. Answer the user's question based ONLY on the following numbered reference materials.
If the information is not found in the references, say so clearly.

IMPORTANT: You MUST respond in valid JSON format with this exact structure:
{
  "answer": "Your answer text with inline citations like [1], [2]...",
  "citations": {
    "1": "exact excerpt from reference [1] that you used",
    "2": "exact excerpt from reference [2] that you used"
  }
}

Citation rules:
- Place citations like [1], [2] immediately after the sentence or claim that uses that reference.
- A single sentence may have multiple citations, e.g. "This is true [1][3]."
- Every factual claim in your answer MUST have at least one citation.
- Only cite references that you actually use.
- In the "citations" object, include ONLY the references you actually cited in the answer.
- Each citation excerpt should be the EXACT text copied from the reference material (1-3 sentences, the key passage you relied on).

=== Reference Materials ===\n`;

    if (searchResponse.results.length > 0) {
      ragContext += searchResponse.results
        .map(
          (result, index) =>
            `[${index + 1}] Source: ${result.sourceLabel}\n${result.chunk.content}\n---`
        )
        .join('\n');
    } else {
      ragContext += '(No relevant materials found)\n---';
    }

    // Append the user query
    ragContext += `\n\nUser Question: ${query}`;

    // Step 3: Call LLM to generate answer (JSON with citations)
    const systemPrompt =
      'You are a knowledge assistant. Answer the user\'s question based ONLY on the provided numbered reference materials. If information is not found, say so clearly. You MUST respond in valid JSON with keys "answer" (string with [1],[2] inline citations) and "citations" (object mapping citation number to the exact excerpt used from that reference). Do NOT wrap the JSON in markdown code blocks.';

    const rawAnswer = await summarizeTextWithLLM(ragContext, systemPrompt);

    // Step 3b: Parse structured response
    let answerText = rawAnswer;
    let citationExcerpts: Record<string, string> = {};

    try {
      // Strip markdown code block if present
      let jsonStr = rawAnswer.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```$/, '');
      }
      const parsed = JSON.parse(jsonStr);
      if (parsed.answer && typeof parsed.answer === 'string') {
        answerText = parsed.answer;
        // Log citation info for debugging
        const foundCitations = answerText.match(/\[(\d+)\]/g);
        console.log(`[rag/ask] Parsed JSON answer. Citations in text: ${JSON.stringify(foundCitations)}`);
        console.log(`[rag/ask] Citation excerpts keys: ${JSON.stringify(Object.keys(parsed.citations ?? {}))}`);
        console.log(`[rag/ask] Answer preview: ${answerText.slice(-100)}`);
        citationExcerpts = parsed.citations ?? {};
      }
    } catch (parseErr) {
      // If JSON parsing fails, use raw text as-is (backward compatible)
      console.warn('[rag/ask] Failed to parse JSON response, using raw text:', (parseErr as Error).message);
    }

    // Step 4: Build response
    const response: RAGAskResponse = {
      answer: answerText,
      citations: citationExcerpts,
      model: model || process.env.FILE_ANALYSIS_TEXT_MODEL || 'gpt-4o-mini',
      sources: searchResponse.results,
      queryTimeMs: searchResponse.queryTimeMs,
    };

    res.status(200).json(response);
  } catch (error) {
    console.error('Error in RAG ask:', error);
    res.status(500).json({
      error: 'Failed to generate RAG answer',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /index/file/:fileId
 * Index an uploaded file
 */
router.post('/index/file/:fileId', async (req: Request, res: Response) => {
  try {
    const { fileId } = req.params;

    if (!fileId || typeof fileId !== 'string' || fileId.trim().length === 0) {
      res.status(400).json({ error: 'fileId must be a non-empty string' });
      return;
    }

    const chunksIndexed = await indexUploadedFile(fileId.trim());

    res.status(200).json({
      success: true,
      chunksIndexed,
    });
  } catch (error) {
    console.error('Error indexing file:', error);
    res.status(500).json({
      error: 'Failed to index file',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /index/session/:sessionId
 * Index messages from a session
 */
router.post('/index/session/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    if (
      !sessionId ||
      typeof sessionId !== 'string' ||
      sessionId.trim().length === 0
    ) {
      res.status(400).json({ error: 'sessionId must be a non-empty string' });
      return;
    }

    const chunksIndexed = await indexSessionMessages(sessionId.trim());

    res.status(200).json({
      success: true,
      chunksIndexed,
    });
  } catch (error) {
    console.error('Error indexing session:', error);
    res.status(500).json({
      error: 'Failed to index session',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /index/library/:conversationId
 * Index an imported Library conversation
 */
router.post('/index/library/:conversationId', async (req: Request, res: Response) => {
  try {
    const { conversationId } = req.params;

    if (!conversationId || typeof conversationId !== 'string' || conversationId.trim().length === 0) {
      res.status(400).json({ error: 'conversationId must be a non-empty string' });
      return;
    }

    const chunksIndexed = await indexImportedConversation(conversationId.trim());

    res.status(200).json({
      success: true,
      chunksIndexed,
    });
  } catch (error) {
    console.error('Error indexing imported conversation:', error);
    res.status(500).json({
      error: 'Failed to index imported conversation',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /index-all
 * Index all unindexed items: sessions, uploaded files, and library conversations
 */
router.post('/index-all', async (req: Request, res: Response) => {
  try {
    const db = (await import('../memory/db')).getDb();

    const errors: string[] = [];
    let indexedSessions = 0;
    let indexedFiles = 0;
    let indexedLibrary = 0;
    let totalChunks = 0;

    // Find all sessions with messages that haven't been indexed
    const unindexedSessions = db.prepare(`
      SELECT DISTINCT s.id
      FROM sessions s
      INNER JOIN messages m ON m.session_id = s.id
      WHERE NOT EXISTS (
        SELECT 1 FROM text_chunks tc
        WHERE tc.source_type = 'message' AND tc.session_id = s.id
      )
    `).all() as any[];

    for (const session of unindexedSessions) {
      try {
        const chunksIndexed = await indexSessionMessages(session.id);
        indexedSessions++;
        totalChunks += chunksIndexed;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to index session ${session.id}: ${errMsg}`);
      }
    }

    // Find all uploaded files that haven't been indexed (with analysis_status='done')
    const unindexedFiles = db.prepare(`
      SELECT uf.id
      FROM uploaded_files uf
      WHERE uf.status = 'done'
      AND NOT EXISTS (
        SELECT 1 FROM text_chunks tc
        WHERE tc.source_type = 'uploaded_file' AND tc.source_id = uf.id
      )
    `).all() as any[];

    for (const file of unindexedFiles) {
      try {
        const chunksIndexed = await indexUploadedFile(file.id);
        indexedFiles++;
        totalChunks += chunksIndexed;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to index file ${file.id}: ${errMsg}`);
      }
    }

    // Find all imported conversations that haven't been indexed
    const unindexedLibrary = db.prepare(`
      SELECT ic.id
      FROM imported_conversations ic
      WHERE NOT EXISTS (
        SELECT 1 FROM text_chunks tc
        WHERE tc.source_type = 'imported_conversation' AND tc.source_id = ic.id
      )
    `).all() as any[];

    for (const conv of unindexedLibrary) {
      try {
        const chunksIndexed = await indexImportedConversation(conv.id);
        indexedLibrary++;
        totalChunks += chunksIndexed;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to index imported conversation ${conv.id}: ${errMsg}`);
      }
    }

    res.status(200).json({
      indexedSessions,
      indexedFiles,
      indexedLibrary,
      totalChunks,
      errors,
    });
  } catch (error) {
    console.error('Error in batch index-all:', error);
    res.status(500).json({
      error: 'Failed to run batch indexing',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /stats
 * Get RAG index statistics
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await getIndexStats();
    res.status(200).json(stats);
  } catch (error) {
    console.error('Error fetching RAG stats:', error);
    res.status(500).json({
      error: 'Failed to fetch RAG statistics',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /inventory
 * Returns KB coverage: ALL sessions (with messages & files) + imported Library conversations.
 * Sorted by most recent first.
 */
router.get('/inventory', async (_req: Request, res: Response) => {
  try {
    const db = (await import('../memory/db')).getDb();

    // ── Part 1: All sessions (not just those with files) ──

    const sessions = db.prepare(`
      SELECT s.id, s.title, s.created_at, s.updated_at
      FROM sessions s
      ORDER BY s.updated_at DESC
    `).all() as any[];

    const fileStmt = db.prepare(`
      SELECT uf.id, uf.filename, uf.mime_type, uf.file_size, uf.status as analysis_status,
             uf.analyzed_by, uf.created_at, uf.updated_at,
             CASE WHEN EXISTS (
               SELECT 1 FROM text_chunks tc WHERE tc.source_type = 'uploaded_file' AND tc.source_id = uf.id
             ) THEN 1 ELSE 0 END as is_indexed,
             (SELECT COUNT(*) FROM text_chunks tc WHERE tc.source_type = 'uploaded_file' AND tc.source_id = uf.id) as chunk_count,
             (SELECT COUNT(*) FROM chunk_embeddings ce
               INNER JOIN text_chunks tc ON tc.id = ce.chunk_id
               WHERE tc.source_type = 'uploaded_file' AND tc.source_id = uf.id) as embedding_count
      FROM uploaded_files uf
      WHERE uf.session_id = ?
      ORDER BY uf.created_at DESC
    `);

    const sessionChunkStmt = db.prepare(`
      SELECT COUNT(*) as chunk_count FROM text_chunks
      WHERE source_type = 'message' AND session_id = ?
    `);

    const sessionEmbeddingStmt = db.prepare(`
      SELECT COUNT(*) as cnt FROM chunk_embeddings ce
      INNER JOIN text_chunks tc ON tc.id = ce.chunk_id
      WHERE tc.source_type = 'message' AND tc.session_id = ?
    `);

    const msgCountStmt = db.prepare(`
      SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?
    `);

    const sessionResults = sessions.map((s: any) => {
      const files = fileStmt.all(s.id) as any[];
      const msgChunks = (sessionChunkStmt.get(s.id) as any)?.chunk_count ?? 0;
      const msgEmbeddings = (sessionEmbeddingStmt.get(s.id) as any)?.cnt ?? 0;
      const msgCount = (msgCountStmt.get(s.id) as any)?.cnt ?? 0;

      return {
        sessionId: s.id,
        sessionTitle: s.title || `Session ${s.id.slice(0, 8)}`,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        messages: {
          count: msgCount,
          chunksIndexed: msgChunks,
          embeddingsIndexed: msgEmbeddings,
          isIndexed: msgChunks > 0,
        },
        files: files.map((f: any) => ({
          id: f.id,
          filename: f.filename,
          mimeType: f.mime_type,
          fileSize: f.file_size,
          analysisStatus: f.analysis_status,
          analyzedBy: f.analyzed_by,
          isIndexed: f.is_indexed === 1,
          chunkCount: f.chunk_count,
          embeddingCount: f.embedding_count,
          createdAt: f.created_at,
          updatedAt: f.updated_at,
        })),
      };
    });

    // ── Part 2: Imported Library conversations ──

    const importedConvs = db.prepare(`
      SELECT ic.id, ic.title, ic.source_platform, ic.created_at, ic.updated_at,
             ic.message_count, ic.import_batch_id
      FROM imported_conversations ic
      ORDER BY ic.created_at DESC
    `).all() as any[];

    const importedChunkStmt = db.prepare(`
      SELECT COUNT(*) as chunk_count FROM text_chunks
      WHERE source_type = 'imported_conversation' AND source_id = ?
    `);

    const importedEmbeddingStmt = db.prepare(`
      SELECT COUNT(*) as cnt FROM chunk_embeddings ce
      INNER JOIN text_chunks tc ON tc.id = ce.chunk_id
      WHERE tc.source_type = 'imported_conversation' AND tc.source_id = ?
    `);

    const libraryResults = importedConvs.map((ic: any) => {
      const chunks = (importedChunkStmt.get(ic.id) as any)?.chunk_count ?? 0;
      const embeddings = (importedEmbeddingStmt.get(ic.id) as any)?.cnt ?? 0;

      return {
        conversationId: ic.id,
        title: ic.title,
        sourcePlatform: ic.source_platform,
        messageCount: ic.message_count ?? 0,
        createdAt: ic.created_at,
        updatedAt: ic.updated_at,
        importBatchId: ic.import_batch_id,
        isIndexed: chunks > 0,
        chunkCount: chunks,
        embeddingCount: embeddings,
      };
    });

    res.status(200).json({
      sessions: sessionResults,
      library: libraryResults,
    });
  } catch (error) {
    console.error('Error fetching RAG inventory:', error);
    res.status(500).json({
      error: 'Failed to fetch RAG inventory',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
