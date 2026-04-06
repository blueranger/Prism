import { Router } from 'express';
import type { MemoryType, OperationMode } from '@prism/shared';
import {
  archiveMemoryItem,
  confirmMemoryCandidate,
  createMemoryCandidate,
  getMemoryGraph,
  getMemoryItem,
  getMemoryTimeline,
  listMemory,
  listMemoryCandidates,
  rejectMemoryCandidate,
  resetAllMemory,
  updateMemoryItem,
} from '../memory/memory-store';
import { listMemoryExtractionRunItems, listMemoryExtractionRuns, listMemoryUsageRunItems, listMemoryUsageRuns } from '../memory/memory-observability-store';
import { buildMemoryInjectionPreview } from '../memory/memory-context-service';
import { listWorkingMemory } from '../memory/working-memory-store';
import { runMemoryPipelineForMessage, runMemoryPipelineForSession } from '../services/memory-trigger-pipeline';

const router = Router();

router.get('/', (req, res) => {
  const type = req.query.type as MemoryType | undefined;
  const status = (req.query.status as any) ?? 'all';
  const search = req.query.search as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
  res.json(listMemory({ type, status, search, limit, offset }));
});

router.get('/review-queue', (_req, res) => {
  res.json({ candidates: listMemoryCandidates('pending') });
});

router.get('/relationship-candidates', (_req, res) => {
  res.json({
    candidates: listMemoryCandidates('pending').filter((candidate) => candidate.memoryType === 'relationship'),
  });
});

router.get('/graph', (_req, res) => {
  res.json(getMemoryGraph());
});

router.get('/timeline', (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  res.json({ events: getMemoryTimeline(limit) });
});

router.get('/working', (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
  res.json({ items: listWorkingMemory(sessionId ?? null) });
});

router.get('/extraction-runs', (_req, res) => {
  res.json({ runs: listMemoryExtractionRuns() });
});

router.get('/extraction-runs/:id', (req, res) => {
  res.json({ items: listMemoryExtractionRunItems(req.params.id) });
});

router.get('/usage-runs', (_req, res) => {
  res.json({ runs: listMemoryUsageRuns() });
});

router.get('/usage-runs/:id', (req, res) => {
  res.json({ items: listMemoryUsageRunItems(req.params.id) });
});

router.get('/context-preview', (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
  const model = typeof req.query.model === 'string' ? req.query.model : 'gpt-5.4';
  const mode = typeof req.query.mode === 'string' ? req.query.mode : null;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  const preview = buildMemoryInjectionPreview({
    sessionId,
    model,
    mode: mode as OperationMode | null,
    promptPreview: typeof req.query.prompt === 'string' ? req.query.prompt : '',
  });
  return res.json(preview);
});

router.post('/extract/session/:id', (req, res) => {
  try {
    const result = runMemoryPipelineForSession(req.params.id, 'manual_extract_session');
    res.json({
      status: 'ok',
      extracted: result.added,
      skippedDuplicates: result.skippedDuplicates,
      candidates: result.candidates,
      run: result.run,
      triggerCandidates: result.triggerCandidates,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/reset', (_req, res) => {
  try {
    resetAllMemory();
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/promote', (req, res) => {
  try {
    const { sessionId, messageId, typeHint, content, title, summary } = req.body as {
      sessionId?: string;
      messageId?: string;
      typeHint?: MemoryType;
      content?: string;
      title?: string;
      summary?: string;
    };

    if (sessionId && messageId) {
      const result = runMemoryPipelineForMessage(sessionId, messageId, 'manual_promote', typeHint);
      return res.json({
        status: 'ok',
        added: result.added,
        skippedDuplicates: result.skippedDuplicates,
        candidates: result.candidates,
        run: result.run,
        triggerCandidates: result.triggerCandidates,
      });
    }

    if (content && title && summary) {
      const result = createMemoryCandidate({
        sessionId: sessionId ?? null,
        messageId: messageId ?? null,
        scopeType: typeHint === 'situation' ? 'session' : 'workspace',
        memoryType: typeHint ?? 'claim',
        title,
        summary,
        sourceKind: 'manual',
        payload: { sources: [{ sessionId: sessionId ?? null, messageId: messageId ?? null, excerpt: content }] },
      });
      return res.json({
        status: 'ok',
        added: result.created ? 1 : 0,
        skippedDuplicates: result.created ? 0 : 1,
        candidates: result.created ? [result.candidate] : [],
      });
    }

    return res.status(400).json({ error: 'Missing promotion payload' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  const item = getMemoryItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Memory not found' });
  res.json(item);
});

router.post('/:id/confirm', (req, res) => {
  const item = confirmMemoryCandidate(req.params.id);
  if (!item) return res.status(404).json({ error: 'Memory candidate not found' });
  res.json(item);
});

router.post('/:id/reject', (req, res) => {
  rejectMemoryCandidate(req.params.id);
  res.json({ status: 'ok' });
});

router.post('/:id/archive', (req, res) => {
  const item = archiveMemoryItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Memory not found' });
  res.json(item);
});

router.patch('/:id', (req, res) => {
  const item = updateMemoryItem(req.params.id, req.body ?? {});
  if (!item) return res.status(404).json({ error: 'Memory not found' });
  res.json(item);
});

export default router;
