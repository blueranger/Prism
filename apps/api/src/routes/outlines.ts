import { Router } from 'express';
import { outlineService } from '../services/outline-service';
import type { LLMProvider } from '@prism/shared';

const router = Router();

// POST /api/outlines/generate
router.post('/generate', async (req, res) => {
  try {
    const { sessionId, sourceType, provider, model } = req.body;

    if (!sessionId || !sourceType) {
      return res.status(400).json({ error: 'sessionId and sourceType are required' });
    }

    if (sourceType !== 'native' && sourceType !== 'imported') {
      return res.status(400).json({ error: 'sourceType must be "native" or "imported"' });
    }

    const outline = await outlineService.generateOutline(
      sessionId,
      sourceType,
      (provider as LLMProvider) || 'openai',
      model || 'gpt-4o-mini'
    );

    res.json({ outline });
  } catch (err: any) {
    console.error('[outlines] generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/outlines/:sessionId/:sourceType
router.get('/:sessionId/:sourceType', (req, res) => {
  try {
    const { sessionId, sourceType } = req.params;

    if (sourceType !== 'native' && sourceType !== 'imported') {
      return res.status(400).json({ error: 'sourceType must be "native" or "imported"' });
    }

    const outline = outlineService.getOutline(sessionId, sourceType);
    if (!outline) {
      return res.status(404).json({ error: 'No outline found' });
    }

    res.json({ outline });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/outlines/:sessionId/:sourceType
router.delete('/:sessionId/:sourceType', (req, res) => {
  try {
    const { sessionId, sourceType } = req.params;

    if (sourceType !== 'native' && sourceType !== 'imported') {
      return res.status(400).json({ error: 'sourceType must be "native" or "imported"' });
    }

    outlineService.deleteOutline(sessionId, sourceType);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
