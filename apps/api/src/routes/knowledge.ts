import { Router } from 'express';
import { extractionService } from '../services/extraction-service';
import {
  listTags, getConversationsByTag,
  listEntities, getEntityDetail,
  getGraphData, getKnowledgeStats,
} from '../memory/knowledge-store';

const router = Router();

// POST /api/knowledge/extract — Trigger entity extraction
router.post('/extract', async (req, res) => {
  try {
    const { provider, model } = req.body;
    // Run extraction in background
    const promise = extractionService.extractAll(provider, model);
    res.json({ status: 'started', message: 'Extraction started in background' });
    promise.catch(err => console.error('[extraction] Background error:', err));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/knowledge/extract/native — Trigger native session extraction
router.post('/extract/native', async (req, res) => {
  try {
    const { provider, model } = req.body;
    const promise = extractionService.extractFromNativeSessions(provider, model);
    res.json({ status: 'started', message: 'Native extraction started in background' });
    promise.catch(err => console.error('[extraction] Native background error:', err));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/knowledge/extract/progress — Get extraction progress
router.get('/extract/progress', (_req, res) => {
  res.json(extractionService.getProgress());
});

// GET /api/knowledge/tags — List all tags
router.get('/tags', (req, res) => {
  const tags = listTags({
    search: req.query.search as string,
    limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
  });
  res.json(tags);
});

// GET /api/knowledge/tags/:id/conversations — Get conversations for a tag
router.get('/tags/:id/conversations', (req, res) => {
  const conversations = getConversationsByTag(req.params.id);
  res.json(conversations);
});

// GET /api/knowledge/entities — List entities
router.get('/entities', (req, res) => {
  const result = listEntities({
    type: req.query.type as any,
    search: req.query.search as string,
    limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
    offset: req.query.offset ? parseInt(req.query.offset as string) : undefined,
  });
  res.json(result);
});

// GET /api/knowledge/entities/:id — Get entity detail
router.get('/entities/:id', (req, res) => {
  const detail = getEntityDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Entity not found' });
  res.json(detail);
});

// GET /api/knowledge/graph — Get graph data for visualization
router.get('/graph', (req, res) => {
  const data = getGraphData({
    entityType: req.query.type as any,
    minMentions: req.query.minMentions ? parseInt(req.query.minMentions as string) : undefined,
    centerEntityId: req.query.center as string,
    maxNodes: req.query.maxNodes ? parseInt(req.query.maxNodes as string) : undefined,
  });
  res.json(data);
});

// GET /api/knowledge/stats — Get knowledge graph statistics
router.get('/stats', (_req, res) => {
  const stats = getKnowledgeStats();
  res.json(stats);
});

export default router;
