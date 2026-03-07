import { Router } from 'express';
import {
  listDecisions,
  createDecision,
  updateDecision,
  deleteDecision,
} from '../memory/decision';

const router = Router();

/**
 * GET /api/decisions
 * List decisions. Query param ?all=true includes inactive ones.
 */
router.get('/', (req, res) => {
  const activeOnly = req.query.all !== 'true';
  const decisions = listDecisions(activeOnly);
  res.json({ decisions });
});

/**
 * POST /api/decisions
 * Create a new decision.
 * Body: { type: 'preference'|'observation', content: string, model?: string }
 */
router.post('/', (req, res) => {
  const { type, content, model } = req.body;

  if (!content || typeof content !== 'string') {
    res.status(400).json({ error: 'content is required' });
    return;
  }

  const validTypes = ['preference', 'observation'];
  const decisionType = validTypes.includes(type) ? type : 'preference';

  const decision = createDecision(decisionType, content, model);
  res.status(201).json({ decision });
});

/**
 * PATCH /api/decisions/:id
 * Update a decision.
 * Body: { content?, type?, model?, active? }
 */
router.patch('/:id', (req, res) => {
  const updated = updateDecision(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Decision not found' });
    return;
  }
  res.json({ decision: updated });
});

/**
 * DELETE /api/decisions/:id
 * Delete a decision permanently.
 */
router.delete('/:id', (req, res) => {
  deleteDecision(req.params.id);
  res.json({ ok: true });
});

export default router;
