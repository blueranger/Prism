import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { PromptRequest, MODELS } from '@prism/shared';
import { streamParallel } from '../services/llm-service';
import { saveMessage } from '../memory/conversation';
import { buildSessionContext } from '../memory/context-builder';
import { setupSSE, sseWrite } from './sse-utils';

const router = Router();

router.post('/stream', async (req: Request, res: Response) => {
  const { prompt, models, sessionId, thinking }: PromptRequest = req.body;

  if (!prompt || !models || models.length === 0) {
    res.status(400).json({ error: 'prompt and models[] are required' });
    return;
  }

  // Validate models
  for (const model of models) {
    if (!MODELS[model]) {
      res.status(400).json({ error: `Unknown model: ${model}` });
      return;
    }
  }

  const sid = sessionId ?? uuid();

  // Set up SSE — disable all forms of buffering
  setupSSE(res);

  // Send session ID as first event
  sseWrite(res, JSON.stringify({ type: 'session', sessionId: sid }));

  // Save user message
  saveMessage(sid, 'user', prompt, 'user');

  // Build per-model context from conversation history (token-budget-aware)
  console.log(`[prompt/stream] Building context for models: ${models.join(', ')} (session: ${sid})`);
  if (thinking) {
    const thinkingModels = Object.entries(thinking).filter(([, c]) => c.enabled).map(([m]) => m);
    if (thinkingModels.length > 0) {
      console.log(`[prompt/stream] Thinking enabled for: ${thinkingModels.join(', ')}`);
    }
  }

  const contextPerModel: Record<string, { role: 'user' | 'assistant' | 'system'; content: string }[]> = {};
  for (const model of models) {
    try {
      const ctx = buildSessionContext(sid, model);
      contextPerModel[model] = ctx.messages;
      console.log(`[prompt/stream] Context for ${model}: ${ctx.messages.length} messages`);
    } catch (ctxErr: any) {
      console.error(`[prompt/stream] Context build failed for ${model}:`, ctxErr.message);
      contextPerModel[model] = [];
    }
  }

  // Accumulate full responses per model for saving
  const accumulated: Record<string, string> = {};
  let chunksSent = 0;

  try {
    console.log(`[prompt/stream] Starting streamParallel for ${models.length} models`);
    for await (const chunk of streamParallel(prompt, models, { contextPerModel, thinking })) {
      const key = chunk.model;
      if (!accumulated[key]) accumulated[key] = '';
      accumulated[key] += chunk.content;

      sseWrite(res, JSON.stringify(chunk));
      chunksSent++;
    }
    console.log(`[prompt/stream] streamParallel completed, ${chunksSent} chunks sent to client`);
  } catch (err: any) {
    console.error(`[prompt/stream] streamParallel error:`, err.message);
    sseWrite(res, JSON.stringify({ error: err.message }));
  }

  // Save assistant messages
  for (const [model, content] of Object.entries(accumulated)) {
    if (content) {
      saveMessage(sid, 'assistant', content, model);
    }
  }

  // Fire-and-forget: auto-index session messages for RAG
  import('../services/rag-indexer').then(({ indexSessionMessages }) => {
    indexSessionMessages(sid).then((n) => {
      if (n > 0) console.log(`[prompt/stream] RAG indexed ${n} chunks for session ${sid}`);
    }).catch((err) => {
      console.warn(`[prompt/stream] RAG session indexing failed (non-critical):`, err.message);
    });
  }).catch(() => { /* rag-indexer not available, skip */ });

  sseWrite(res, '[DONE]');
  res.end();
});

export default router;
