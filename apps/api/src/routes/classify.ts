import { Router } from 'express';
import { classifyTask } from '../services/task-classifier';

const router = Router();

/**
 * POST /api/classify
 * Classify a prompt and recommend the best model.
 * Body: { prompt: string }
 */
router.post('/', (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    res.status(400).json({ error: 'prompt is required and must be at least 3 characters' });
    return;
  }

  const result = classifyTask(prompt.trim());
  res.json(result);
});

export default router;
