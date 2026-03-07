import { Router } from 'express';
import { modelRegistry } from '../services/model-registry';

const router = Router();

/** GET /api/models — returns all available models with pricing info */
router.get('/', (_req, res) => {
  const all = modelRegistry.getAll();
  const models = Object.entries(all).map(([id, config]) => ({
    id,
    ...config,
  }));
  const info = modelRegistry.getInfo();
  res.json({ models, registry: info });
});

/** POST /api/models/refresh — manually trigger model discovery */
router.post('/refresh', async (_req, res) => {
  try {
    const result = await modelRegistry.refresh();
    const info = modelRegistry.getInfo();
    res.json({ success: true, ...result, registry: info });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
