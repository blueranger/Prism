import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import os from 'os';
import { importService } from '../services/import-service';
import {
  listImportedConversations,
  getImportedConversation,
  getImportedMessages,
  getImportStats,
  deleteImportBatch,
  deleteImportedConversation,
  listImportProjects,
  listImportSyncRuns,
  getImportSyncRun,
  recordImportSyncRun,
  updateImportedConversationTitle,
} from '../memory/import-store';
import { ChatGPTSyncRequest, ClaudeSyncRequest, GeminiSyncRequest, ImportPlatform } from '@prism/shared';
import { getDb } from '../memory/db';
import {
  decorateKnowledgeNoteWithCompilerArtifacts,
  generateActionItemsFromConversation,
  generateKnowledgeNoteFromConversation,
  normalizeKnowledgeDestination,
} from '../services/import-transform-service';
import { runCompilerForImportedConversation } from '../services/compiler-service';

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

    const projectName = typeof req.body.projectName === 'string' ? req.body.projectName.trim() : '';
    const result = await importService.importFileWithOptions(req.file.path, platform, {
      originalFilename: req.file.originalname,
      projectName: projectName || null,
    });
    res.json(result);

    if (result.status === 'completed' && result.batchId) {
      queueBatchPostProcessing(result.batchId);
    }
  } catch (err: any) {
    console.error('[import] Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/import/projects — List existing Prism sessions as import targets
router.get('/projects', (_req, res) => {
  const projects = listImportProjects();
  res.json({ projects });
});

router.get('/chatgpt-sync/history', (req, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '10'), 10) || 10, 1), 100);
  res.json({ runs: listImportSyncRuns(limit) });
});

router.get('/chatgpt-sync/latest', (_req, res) => {
  const [latest] = listImportSyncRuns(1);
  res.json({ run: latest ?? null });
});

router.get('/claude-sync/history', (req, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '10'), 10) || 10, 1), 100);
  res.json({ runs: listImportSyncRuns(limit).filter((run) => run.sourceKind === 'claude_browser_sync') });
});

router.get('/claude-sync/latest', (_req, res) => {
  const latest = listImportSyncRuns(50).find((run) => run.sourceKind === 'claude_browser_sync') ?? null;
  res.json({ run: latest });
});

router.get('/gemini-sync/history', (req, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '10'), 10) || 10, 1), 100);
  res.json({ runs: listImportSyncRuns(limit).filter((run) => run.sourceKind === 'gemini_browser_sync') });
});

router.get('/gemini-sync/latest', (_req, res) => {
  const latest = listImportSyncRuns(50).find((run) => run.sourceKind === 'gemini_browser_sync') ?? null;
  res.json({ run: latest });
});

// POST /api/import/chatgpt-sync — Sync raw ChatGPT conversations from the browser extension
router.post('/chatgpt-sync', async (req, res) => {
  const body = req.body as ChatGPTSyncRequest;
  const syncRunId = typeof body?.syncRunId === 'string' && body.syncRunId.trim() ? body.syncRunId.trim() : null;
  const syncBatchIndex = typeof body?.syncBatchIndex === 'number' ? body.syncBatchIndex : 1;
  const syncBatchCount = typeof body?.syncBatchCount === 'number' ? body.syncBatchCount : 1;
  try {
    const projectName = typeof body?.projectName === 'string' ? body.projectName.trim() : '';
    const conversations = Array.isArray(body?.conversations) ? body.conversations : [];

    if (conversations.length === 0) {
      return res.status(400).json({ error: 'conversations must be a non-empty array' });
    }

    for (const [index, conv] of conversations.entries()) {
      if (!conv || typeof conv.id !== 'string' || !conv.id.trim()) {
        return res.status(400).json({ error: `conversations[${index}].id is required` });
      }
      if (!conv.mapping || typeof conv.mapping !== 'object') {
        return res.status(400).json({ error: `conversations[${index}].mapping is required` });
      }
    }

    const result = await importService.importChatGPTSync(conversations, {
      projectName: projectName || null,
    });

    const run = syncRunId
      ? recordImportSyncRun({
          id: syncRunId,
          sourcePlatform: 'chatgpt',
          sourceKind: 'chatgpt_browser_sync',
          projectName: projectName || null,
          batchCount: syncBatchCount,
          batchIndex: syncBatchIndex,
          status: 'completed',
          requestedConversations: conversations.length,
          processedConversations: result.processedConversations,
          importedConversations: result.importedConversations ?? 0,
          overwrittenConversations: result.overwrittenConversations ?? 0,
          skippedConversations: result.skippedConversations ?? 0,
          failedConversations: 0,
          totalMessages: result.totalMessages,
          metadata: {
            batchId: result.batchId,
            platform: result.platform,
          },
        })
      : null;
    res.json({ ...result, syncRun: run });

    if (result.status === 'completed' && result.batchId) {
      queueBatchPostProcessing(result.batchId);
    }
  } catch (err: any) {
    console.error('[import] ChatGPT sync error:', err);
    if (syncRunId) {
      try {
        recordImportSyncRun({
          id: syncRunId,
          sourcePlatform: 'chatgpt',
          sourceKind: 'chatgpt_browser_sync',
          projectName: typeof body?.projectName === 'string' ? body.projectName.trim() : null,
          batchCount: syncBatchCount,
          batchIndex: syncBatchIndex,
          status: 'failed',
          requestedConversations: Array.isArray(body?.conversations) ? body.conversations.length : 0,
          processedConversations: 0,
          importedConversations: 0,
          overwrittenConversations: 0,
          skippedConversations: 0,
          failedConversations: Array.isArray(body?.conversations) ? body.conversations.length : 0,
          totalMessages: 0,
          metadata: {
            error: err.message,
          },
        });
      } catch (recordErr) {
        console.error('[import] Failed to record sync run error:', recordErr);
      }
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/import/claude-sync — Sync raw Claude conversations from the browser extension
router.post('/claude-sync', async (req, res) => {
  const body = req.body as ClaudeSyncRequest;
  const syncRunId = typeof body?.syncRunId === 'string' && body.syncRunId.trim() ? body.syncRunId.trim() : null;
  const syncBatchIndex = typeof body?.syncBatchIndex === 'number' ? body.syncBatchIndex : 1;
  const syncBatchCount = typeof body?.syncBatchCount === 'number' ? body.syncBatchCount : 1;
  try {
    const projectName = typeof body?.projectName === 'string' ? body.projectName.trim() : '';
    const conversations = Array.isArray(body?.conversations) ? body.conversations : [];

    if (conversations.length === 0) {
      return res.status(400).json({ error: 'conversations must be a non-empty array' });
    }

    for (const [index, conv] of conversations.entries()) {
      if (!conv || typeof conv.uuid !== 'string' || !conv.uuid.trim()) {
        return res.status(400).json({ error: `conversations[${index}].uuid is required` });
      }
      if (!Array.isArray(conv.chat_messages)) {
        return res.status(400).json({ error: `conversations[${index}].chat_messages is required` });
      }
    }

    const result = await importService.importClaudeSync(conversations, {
      projectName: projectName || null,
    });

    const run = syncRunId
      ? recordImportSyncRun({
          id: syncRunId,
          sourcePlatform: 'claude',
          sourceKind: 'claude_browser_sync',
          projectName: projectName || null,
          batchCount: syncBatchCount,
          batchIndex: syncBatchIndex,
          status: 'completed',
          requestedConversations: conversations.length,
          processedConversations: result.processedConversations,
          importedConversations: result.importedConversations ?? 0,
          overwrittenConversations: result.overwrittenConversations ?? 0,
          skippedConversations: result.skippedConversations ?? 0,
          failedConversations: 0,
          totalMessages: result.totalMessages,
          metadata: {
            batchId: result.batchId,
            platform: result.platform,
          },
        })
      : null;
    res.json({ ...result, syncRun: run });

    if (result.status === 'completed' && result.batchId) {
      queueBatchPostProcessing(result.batchId);
    }
  } catch (err: any) {
    console.error('[import] Claude sync error:', err);
    if (syncRunId) {
      try {
        recordImportSyncRun({
          id: syncRunId,
          sourcePlatform: 'claude',
          sourceKind: 'claude_browser_sync',
          projectName: typeof body?.projectName === 'string' ? body.projectName.trim() : null,
          batchCount: syncBatchCount,
          batchIndex: syncBatchIndex,
          status: 'failed',
          requestedConversations: Array.isArray(body?.conversations) ? body.conversations.length : 0,
          processedConversations: 0,
          importedConversations: 0,
          overwrittenConversations: 0,
          skippedConversations: 0,
          failedConversations: Array.isArray(body?.conversations) ? body.conversations.length : 0,
          totalMessages: 0,
          metadata: {
            error: err.message,
          },
        });
      } catch (recordErr) {
        console.error('[import] Failed to record Claude sync run error:', recordErr);
      }
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/import/gemini-sync — Sync raw Gemini conversations from the browser extension
router.post('/gemini-sync', async (req, res) => {
  const body = req.body as GeminiSyncRequest;
  const syncRunId = typeof body?.syncRunId === 'string' && body.syncRunId.trim() ? body.syncRunId.trim() : null;
  const syncBatchIndex = typeof body?.syncBatchIndex === 'number' ? body.syncBatchIndex : 1;
  const syncBatchCount = typeof body?.syncBatchCount === 'number' ? body.syncBatchCount : 1;
  try {
    const projectName = typeof body?.projectName === 'string' ? body.projectName.trim() : '';
    const conversations = Array.isArray(body?.conversations) ? body.conversations : [];

    if (conversations.length === 0) {
      return res.status(400).json({ error: 'conversations must be a non-empty array' });
    }

    for (const [index, conv] of conversations.entries()) {
      if (!conv || typeof conv.id !== 'string' || !conv.id.trim()) {
        return res.status(400).json({ error: `conversations[${index}].id is required` });
      }
      if (!Array.isArray(conv.chunks) || conv.chunks.length === 0) {
        return res.status(400).json({ error: `conversations[${index}].chunks is required` });
      }
    }

    const result = await importService.importGeminiSync(conversations, {
      projectName: projectName || null,
    });

    const run = syncRunId
      ? recordImportSyncRun({
          id: syncRunId,
          sourcePlatform: 'gemini',
          sourceKind: 'gemini_browser_sync',
          projectName: projectName || null,
          batchCount: syncBatchCount,
          batchIndex: syncBatchIndex,
          status: 'completed',
          requestedConversations: conversations.length,
          processedConversations: result.processedConversations,
          importedConversations: result.importedConversations ?? 0,
          overwrittenConversations: result.overwrittenConversations ?? 0,
          skippedConversations: result.skippedConversations ?? 0,
          failedConversations: 0,
          totalMessages: result.totalMessages,
          metadata: {
            batchId: result.batchId,
            platform: result.platform,
          },
        })
      : null;
    res.json({ ...result, syncRun: run });

    if (result.status === 'completed' && result.batchId) {
      queueBatchPostProcessing(result.batchId);
    }
  } catch (err: any) {
    console.error('[import] Gemini sync error:', err);
    if (syncRunId) {
      try {
        recordImportSyncRun({
          id: syncRunId,
          sourcePlatform: 'gemini',
          sourceKind: 'gemini_browser_sync',
          projectName: typeof body?.projectName === 'string' ? body.projectName.trim() : null,
          batchCount: syncBatchCount,
          batchIndex: syncBatchIndex,
          status: 'failed',
          requestedConversations: Array.isArray(body?.conversations) ? body.conversations.length : 0,
          processedConversations: 0,
          importedConversations: 0,
          overwrittenConversations: 0,
          skippedConversations: 0,
          failedConversations: Array.isArray(body?.conversations) ? body.conversations.length : 0,
          totalMessages: 0,
          metadata: {
            error: err.message,
          },
        });
      } catch (recordErr) {
        console.error('[import] Failed to record Gemini sync run error:', recordErr);
      }
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/import/reset-all — Reset imported library + knowledge + provenance + KB/RAG index
router.post('/reset-all', (_req, res) => {
  try {
    const db = getDb();

    const resetAll = db.transaction(() => {
      db.prepare('DELETE FROM chunk_embeddings').run();
      db.prepare('DELETE FROM text_chunks').run();

      db.prepare('DELETE FROM content_provenance').run();

      db.prepare('DELETE FROM entity_relations').run();
      db.prepare('DELETE FROM entity_mentions').run();
      db.prepare('DELETE FROM conversation_tags').run();
      db.prepare('DELETE FROM session_tags').run();
      db.prepare('DELETE FROM knowledge_entities').run();
      db.prepare('DELETE FROM tags').run();
      db.prepare('DELETE FROM compiler_runs').run();

      db.prepare('DELETE FROM import_sync_state').run();
      db.prepare('DELETE FROM import_sync_runs').run();
      db.prepare('DELETE FROM imported_messages').run();
      db.prepare('DELETE FROM imported_conversations').run();
    });

    resetAll();
    res.json({ ok: true });
  } catch (err: any) {
    console.error('[import] Reset-all error:', err);
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

router.post('/conversations/:id/create-knowledge-note', async (req, res) => {
  try {
    const conversation = getImportedConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: 'Imported conversation not found' });
    }
    const messages = getImportedMessages(req.params.id);
    if (messages.length === 0) {
      return res.status(400).json({ error: 'Imported conversation has no messages' });
    }
    const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : undefined;
    const routing = normalizeKnowledgeDestination(typeof req.body?.destinationType === 'string' ? req.body.destinationType : undefined);
    const generated = await generateKnowledgeNoteFromConversation(conversation, messages, model, routing.destinationType);
    const compilerRun = await runCompilerForImportedConversation({
      conversationId: conversation.id,
      destinationType: routing.destinationType,
      model: model ?? 'gpt-5.4',
    });
    const decoratedContent = decorateKnowledgeNoteWithCompilerArtifacts(generated.content, compilerRun.artifacts, routing.destinationType);
    res.json({
      ok: true,
      conversationId: conversation.id,
      title: conversation.title,
      content: decoratedContent,
      model: model ?? 'gpt-5.4',
      destinationType: routing.destinationType,
      knowledgeMaturity: generated.knowledgeMaturity,
      compilerRun,
    });
  } catch (error: any) {
    console.error('[import] create knowledge note failed:', error);
    res.status(500).json({ error: error.message || 'Failed to create knowledge note' });
  }
});

router.post('/conversations/:id/create-action-items', async (req, res) => {
  try {
    const conversation = getImportedConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: 'Imported conversation not found' });
    }
    const messages = getImportedMessages(req.params.id);
    if (messages.length === 0) {
      return res.status(400).json({ error: 'Imported conversation has no messages' });
    }
    const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : undefined;
    const content = await generateActionItemsFromConversation(conversation, messages, model);
    res.json({
      ok: true,
      conversationId: conversation.id,
      title: conversation.title,
      content,
      model: model ?? 'gpt-5.4',
    });
  } catch (error: any) {
    console.error('[import] create action items failed:', error);
    res.status(500).json({ error: error.message || 'Failed to create action items' });
  }
});

// PATCH /api/import/conversations/:id/title — Manually rename an imported conversation
router.patch('/conversations/:id/title', (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  const updated = updateImportedConversationTitle(req.params.id, title);
  if (!updated) {
    return res.status(404).json({ error: 'Imported conversation not found' });
  }

  res.json({ ok: true });
});

// DELETE /api/import/conversations/:id — Delete a single imported conversation
router.delete('/conversations/:id', (req, res) => {
  const deleted = deleteImportedConversation(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: 'Imported conversation not found' });
  }
  res.json({ ok: true });
});

// POST /api/import/conversations/:id/regenerate-title — Force AI regeneration for one imported conversation title
router.post('/conversations/:id/regenerate-title', async (req, res) => {
  try {
    const { importTitleService } = await import('../services/import-title-service');
    const updated = await importTitleService.generateForConversationId(req.params.id, { force: true });
    if (!updated) {
      return res.status(404).json({ error: 'Imported conversation not found or title could not be regenerated' });
    }
    res.json({ ok: true });
  } catch (err: any) {
    console.error('[import] Regenerate title error:', err);
    res.status(500).json({ error: err.message });
  }
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

function queueBatchPostProcessing(batchId: string) {
  (async () => {
    try {
      const { indexImportedConversation } = await import('../services/rag-indexer');
      const { importTitleService } = await import('../services/import-title-service');
      const db = (await import('../memory/db')).getDb();

      const conversations = db
        .prepare('SELECT id, title FROM imported_conversations WHERE import_batch_id = ?')
        .all(batchId) as Array<{ id: string; title: string }>;

      if (conversations.length === 0) {
        console.log(`[import] No conversations found for batch ${batchId}`);
        return;
      }

      await importTitleService.generateForConversationIds(conversations.map((conv) => conv.id));

      console.log(`[import] Starting RAG indexing for ${conversations.length} imported conversations from batch ${batchId}`);

      let indexedCount = 0;
      let failedCount = 0;

      for (const conv of conversations) {
        try {
          await indexImportedConversation(conv.id);
          indexedCount++;
        } catch (err: any) {
          console.error(`[import] Failed to index conversation ${conv.id} ("${conv.title}"):`, err.message);
          failedCount++;
        }
      }

      console.log(`[import] RAG indexing complete for batch ${batchId}: ${indexedCount} indexed, ${failedCount} failed`);
    } catch (err: any) {
      console.error(`[import] Error during RAG indexing for batch ${batchId}:`, err.message);
    }
  })();
}
