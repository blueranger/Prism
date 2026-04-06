import { Router } from 'express';
import type { CompiledSourceType } from '@prism/shared';
import { getCompilerRunById, listRecentCompilerRuns, runCompiler } from '../services/compiler-service';
import { normalizeKnowledgeDestination } from '../services/import-transform-service';

const router = Router();

router.post('/run', async (req, res) => {
  try {
    const sourceKind = req.body?.sourceKind === 'native' ? 'native' : 'imported';
    const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId.trim() : '';
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId is required' });
    }
    const routing = normalizeKnowledgeDestination(typeof req.body?.destinationType === 'string' ? req.body.destinationType : undefined);
    const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : undefined;
    const run = await runCompiler({
      sourceKind,
      sourceId,
      destinationType: routing.destinationType,
      model,
    });
    res.json({ ok: true, run });
  } catch (error: any) {
    console.error('[compiler] run failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to run compiler' });
  }
});

router.get('/runs', (req, res) => {
  const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;
  const sourceType = typeof req.query.sourceType === 'string' ? (req.query.sourceType as CompiledSourceType) : undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const runs = listRecentCompilerRuns({ sourceId, sourceType, limit });
  res.json({ runs });
});

router.get('/runs/:id', (req, res) => {
  const run = getCompilerRunById(req.params.id);
  if (!run) {
    return res.status(404).json({ error: 'Compiler run not found' });
  }
  res.json({ run });
});

export default router;
