import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../memory/db';
import { chunkText, type TextChunkData } from './chunking-service';
import { getEmbeddings, embeddingToBuffer } from './embedding-service';

const LOG_PREFIX = '[rag-indexer]';

/**
 * RAG index statistics
 */
export interface RAGIndexStats {
  totalChunks: number;
  totalEmbeddings: number;
  indexedFiles: number;
  indexedSessions: number;
  indexedLibrary: number;
  embeddingModel: string;
}

/**
 * Index an uploaded file by chunking and embedding its extracted text
 * @param fileId - ID of the file in uploaded_files table
 * @returns Number of chunks indexed
 */
export async function indexUploadedFile(fileId: string): Promise<number> {
  const db = getDb();

  try {
    // Get file from uploaded_files
    const file = db
      .prepare(
        `SELECT id, extracted_text, session_id FROM uploaded_files
         WHERE id = ? AND status = 'done' AND extracted_text IS NOT NULL`
      )
      .get(fileId) as { id: string; extracted_text: string; session_id: string } | undefined;

    if (!file) {
      console.log(`${LOG_PREFIX} File ${fileId} not found or not ready for indexing`);
      return 0;
    }

    // Check if already indexed
    const existing = db
      .prepare(
        `SELECT COUNT(*) as count FROM text_chunks
         WHERE source_type = 'uploaded_file' AND source_id = ?`
      )
      .get(fileId) as { count: number };

    if (existing.count > 0) {
      console.log(`${LOG_PREFIX} File ${fileId} already indexed (${existing.count} chunks), skipping`);
      return 0;
    }

    // Chunk the text
    const chunks = chunkText(file.extracted_text, {
      maxTokens: 512,
      overlapTokens: 64,
    });

    if (chunks.length === 0) {
      console.log(`${LOG_PREFIX} No chunks generated for file ${fileId}`);
      return 0;
    }

    // Start transaction
    const insertChunk = db.prepare(
      `INSERT INTO text_chunks
       (id, source_type, source_id, session_id, chunk_index, content, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertEmbedding = db.prepare(
      `INSERT INTO chunk_embeddings
       (chunk_id, embedding, model, dimensions, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );

    const transaction = db.transaction(() => {
      const chunkIds: string[] = [];
      const chunkTexts: string[] = [];

      // Insert chunks and collect for embedding
      chunks.forEach((chunk: TextChunkData, index: number) => {
        const chunkId = uuidv4();
        chunkIds.push(chunkId);
        chunkTexts.push(chunk.content);

        insertChunk.run(
          chunkId,
          'uploaded_file',
          fileId,
          file.session_id,
          index,
          chunk.content,
          chunk.tokenCount || 0,
          Date.now()
        );
      });

      return { chunkIds, chunkTexts };
    });

    const { chunkIds, chunkTexts } = transaction();

    // Generate embeddings
    let embeddings: Float32Array[] = [];
    try {
      embeddings = await getEmbeddings(chunkTexts);
    } catch (error) {
      console.error(
        `${LOG_PREFIX} Failed to generate embeddings for file ${fileId}:`,
        error instanceof Error ? error.message : String(error)
      );
      // Continue anyway — chunks are stored and can be used for FTS
      console.log(`${LOG_PREFIX} Continuing without embeddings for file ${fileId}`);
      return chunkIds.length;
    }

    // Insert embeddings in transaction
    const embeddingTransaction = db.transaction(() => {
      const embeddingModel = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

      embeddings.forEach((embedding, index) => {
        const embeddingBuffer = embeddingToBuffer(embedding);
        insertEmbedding.run(
          chunkIds[index],
          embeddingBuffer,
          embeddingModel,
          embedding.length,
          Date.now()
        );
      });
    });

    embeddingTransaction();

    console.log(`${LOG_PREFIX} Indexed file ${fileId} into ${chunkIds.length} chunks with embeddings`);
    return chunkIds.length;
  } catch (error) {
    console.error(`${LOG_PREFIX} Error indexing file ${fileId}:`, error);
    throw error;
  }
}

/**
 * Index all messages in a session by chunking and embedding them
 * @param sessionId - Session ID
 * @returns Number of chunks indexed
 */
export async function indexSessionMessages(sessionId: string): Promise<number> {
  const db = getDb();

  try {
    // Get all messages for this session, ordered by timestamp
    const messages = db
      .prepare(
        `SELECT role, content, timestamp FROM messages
         WHERE session_id = ?
         ORDER BY timestamp ASC`
      )
      .all(sessionId) as Array<{ role: string; content: string; timestamp: number }>;

    if (messages.length === 0) {
      console.log(`${LOG_PREFIX} No messages found for session ${sessionId}`);
      return 0;
    }

    // Concatenate messages into single text
    const concatenatedText = messages.map((msg) => `[${msg.role}] ${msg.content}`).join('\n\n');

    // Check if already indexed for this session
    const existing = db
      .prepare(
        `SELECT COUNT(*) as count FROM text_chunks
         WHERE source_type = 'message' AND session_id = ?`
      )
      .get(sessionId) as { count: number };

    if (existing.count > 0) {
      console.log(`${LOG_PREFIX} Session ${sessionId} already indexed (${existing.count} chunks), removing old index`);

      // Remove old index
      const oldChunks = db
        .prepare(`SELECT id FROM text_chunks WHERE source_type = 'message' AND session_id = ?`)
        .all(sessionId) as Array<{ id: string }>;

      const deleteEmbedding = db.prepare(`DELETE FROM chunk_embeddings WHERE chunk_id = ?`);
      const deleteChunk = db.prepare(`DELETE FROM text_chunks WHERE id = ?`);

      const removeTransaction = db.transaction(() => {
        oldChunks.forEach((chunk) => {
          deleteEmbedding.run(chunk.id);
          deleteChunk.run(chunk.id);
        });
      });

      removeTransaction();
      console.log(`${LOG_PREFIX} Removed ${oldChunks.length} old chunks for session ${sessionId}`);
    }

    // Chunk the concatenated text
    const chunks = chunkText(concatenatedText, {
      maxTokens: 512,
      overlapTokens: 64,
    });

    if (chunks.length === 0) {
      console.log(`${LOG_PREFIX} No chunks generated for session ${sessionId}`);
      return 0;
    }

    const insertChunk = db.prepare(
      `INSERT INTO text_chunks
       (id, source_type, source_id, session_id, chunk_index, content, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertEmbedding = db.prepare(
      `INSERT INTO chunk_embeddings
       (chunk_id, embedding, model, dimensions, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );

    // Insert chunks
    const transaction = db.transaction(() => {
      const chunkIds: string[] = [];
      const chunkTexts: string[] = [];

      chunks.forEach((chunk: TextChunkData, index: number) => {
        const chunkId = uuidv4();
        chunkIds.push(chunkId);
        chunkTexts.push(chunk.content);

        insertChunk.run(
          chunkId,
          'message',
          sessionId,
          sessionId,
          index,
          chunk.content,
          chunk.tokenCount || 0,
          Date.now()
        );
      });

      return { chunkIds, chunkTexts };
    });

    const { chunkIds, chunkTexts } = transaction();

    // Generate embeddings
    let embeddings: Float32Array[] = [];
    try {
      embeddings = await getEmbeddings(chunkTexts);
    } catch (error) {
      console.error(
        `${LOG_PREFIX} Failed to generate embeddings for session ${sessionId}:`,
        error instanceof Error ? error.message : String(error)
      );
      console.log(`${LOG_PREFIX} Continuing without embeddings for session ${sessionId}`);
      return chunkIds.length;
    }

    // Insert embeddings
    const embeddingTransaction = db.transaction(() => {
      const embeddingModel = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

      embeddings.forEach((embedding, index) => {
        const embeddingBuffer = embeddingToBuffer(embedding);
        insertEmbedding.run(
          chunkIds[index],
          embeddingBuffer,
          embeddingModel,
          embedding.length,
          Date.now()
        );
      });
    });

    embeddingTransaction();

    console.log(`${LOG_PREFIX} Indexed session ${sessionId} into ${chunkIds.length} chunks with embeddings`);
    return chunkIds.length;
  } catch (error) {
    console.error(`${LOG_PREFIX} Error indexing session ${sessionId}:`, error);
    throw error;
  }
}

/**
 * Index an imported conversation from the Library.
 * Concatenates all imported_messages for the conversation and chunks + embeds them.
 * @param conversationId - The imported_conversations.id
 * @returns Number of chunks indexed
 */
export async function indexImportedConversation(conversationId: string): Promise<number> {
  const db = getDb();

  try {
    // Load conversation
    const conv = db
      .prepare('SELECT id, title FROM imported_conversations WHERE id = ?')
      .get(conversationId) as any;

    if (!conv) {
      console.warn(`${LOG_PREFIX} Imported conversation not found: ${conversationId}`);
      return 0;
    }

    // Load all messages
    const messages = db
      .prepare('SELECT role, content FROM imported_messages WHERE conversation_id = ? ORDER BY timestamp ASC')
      .all(conversationId) as Array<{ role: string; content: string }>;

    if (messages.length === 0) {
      console.log(`${LOG_PREFIX} No messages found for imported conversation ${conversationId}`);
      return 0;
    }

    // Concatenate messages with role attribution
    const concatenatedText = messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n\n');

    // Remove old chunks if re-indexing
    const oldChunks = db
      .prepare('SELECT id FROM text_chunks WHERE source_type = ? AND source_id = ?')
      .all('imported_conversation', conversationId) as Array<{ id: string }>;

    if (oldChunks.length > 0) {
      const deleteEmbedding = db.prepare('DELETE FROM chunk_embeddings WHERE chunk_id = ?');
      const deleteChunk = db.prepare('DELETE FROM text_chunks WHERE id = ?');
      db.transaction(() => {
        oldChunks.forEach((c) => { deleteEmbedding.run(c.id); deleteChunk.run(c.id); });
      })();
      console.log(`${LOG_PREFIX} Removed ${oldChunks.length} old chunks for imported conversation ${conversationId}`);
    }

    // Chunk the text
    const chunks = chunkText(concatenatedText, { maxTokens: 512, overlapTokens: 64 });
    if (chunks.length === 0) return 0;

    const insertChunk = db.prepare(
      `INSERT INTO text_chunks (id, source_type, source_id, session_id, chunk_index, content, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertEmbedding = db.prepare(
      `INSERT INTO chunk_embeddings (chunk_id, embedding, model, dimensions, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );

    // Insert chunks
    const transaction = db.transaction(() => {
      const chunkIds: string[] = [];
      const chunkTexts: string[] = [];

      chunks.forEach((chunk: TextChunkData, index: number) => {
        const chunkId = uuidv4();
        chunkIds.push(chunkId);
        chunkTexts.push(chunk.content);
        insertChunk.run(chunkId, 'imported_conversation', conversationId, null, index, chunk.content, chunk.tokenCount || 0, Date.now());
      });

      return { chunkIds, chunkTexts };
    });

    const { chunkIds, chunkTexts } = transaction();

    // Generate embeddings
    try {
      const embeddings = await getEmbeddings(chunkTexts);
      const embeddingModel = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
      db.transaction(() => {
        embeddings.forEach((embedding, index) => {
          insertEmbedding.run(chunkIds[index], embeddingToBuffer(embedding), embeddingModel, embedding.length, Date.now());
        });
      })();
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to generate embeddings for imported conversation ${conversationId}:`, error instanceof Error ? error.message : String(error));
      return chunkIds.length;
    }

    console.log(`${LOG_PREFIX} Indexed imported conversation "${conv.title}" into ${chunkIds.length} chunks`);
    return chunkIds.length;
  } catch (error) {
    console.error(`${LOG_PREFIX} Error indexing imported conversation ${conversationId}:`, error);
    throw error;
  }
}

/**
 * Remove index for a specific source
 * @param sourceType - Type of source ('uploaded_file' | 'message' | 'imported_conversation')
 * @param sourceId - ID of the source
 */
export async function removeIndex(sourceType: string, sourceId: string): Promise<void> {
  const db = getDb();

  try {
    // Get all chunk IDs for this source
    const chunks = db
      .prepare(`SELECT id FROM text_chunks WHERE source_type = ? AND source_id = ?`)
      .all(sourceType, sourceId) as Array<{ id: string }>;

    if (chunks.length === 0) {
      console.log(`${LOG_PREFIX} No chunks found for ${sourceType} ${sourceId}`);
      return;
    }

    const deleteEmbedding = db.prepare(`DELETE FROM chunk_embeddings WHERE chunk_id = ?`);
    const deleteChunk = db.prepare(`DELETE FROM text_chunks WHERE id = ?`);

    const transaction = db.transaction(() => {
      chunks.forEach((chunk) => {
        deleteEmbedding.run(chunk.id);
        deleteChunk.run(chunk.id);
      });
    });

    transaction();

    console.log(
      `${LOG_PREFIX} Removed index for ${sourceType} ${sourceId} (${chunks.length} chunks deleted)`
    );
  } catch (error) {
    console.error(`${LOG_PREFIX} Error removing index for ${sourceType} ${sourceId}:`, error);
    throw error;
  }
}

/**
 * Get RAG index statistics
 * @returns Index statistics
 */
export function getIndexStats(): RAGIndexStats {
  const db = getDb();

  try {
    const totalChunks = db
      .prepare(`SELECT COUNT(*) as count FROM text_chunks`)
      .get() as { count: number };

    const totalEmbeddings = db
      .prepare(`SELECT COUNT(*) as count FROM chunk_embeddings`)
      .get() as { count: number };

    const indexedFiles = db
      .prepare(
        `SELECT COUNT(DISTINCT source_id) as count FROM text_chunks
         WHERE source_type = 'uploaded_file'`
      )
      .get() as { count: number };

    const indexedSessions = db
      .prepare(
        `SELECT COUNT(DISTINCT session_id) as count FROM text_chunks
         WHERE source_type = 'message'`
      )
      .get() as { count: number };

    const indexedLibrary = db
      .prepare(
        `SELECT COUNT(DISTINCT source_id) as count FROM text_chunks
         WHERE source_type = 'imported_conversation'`
      )
      .get() as { count: number };

    const embeddingModel = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

    return {
      totalChunks: totalChunks.count,
      totalEmbeddings: totalEmbeddings.count,
      indexedFiles: indexedFiles.count,
      indexedSessions: indexedSessions.count,
      indexedLibrary: indexedLibrary.count,
      embeddingModel,
    };
  } catch (error) {
    console.error(`${LOG_PREFIX} Error fetching index stats:`, error);
    return {
      totalChunks: 0,
      totalEmbeddings: 0,
      indexedFiles: 0,
      indexedSessions: 0,
      indexedLibrary: 0,
      embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    };
  }
}
