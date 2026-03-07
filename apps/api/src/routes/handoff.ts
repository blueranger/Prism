import { Router, Request, Response } from 'express';
import { HandoffRequest, MODELS } from '@prism/shared';
import { streamSingle } from '../services/llm-service';
import { saveMessage, createHandoff } from '../memory/conversation';
import { buildHandoffContext } from '../memory/context-builder';
import { setupSSE, sseWrite } from './sse-utils';

const router = Router();

/**
 * POST /api/handoff/stream
 *
 * Performs a handoff: takes context from the current session (which may include
 * messages from the fromModel) and streams a response from the toModel.
 *
 * Body: { sessionId, fromModel, toModel, instruction? }
 */
router.post('/stream', async (req: Request, res: Response) => {
  const { sessionId, fromModel, toModel, instruction }: HandoffRequest = req.body;

  if (!sessionId || !fromModel || !toModel) {
    res.status(400).json({ error: 'sessionId, fromModel, and toModel are required' });
    return;
  }

  if (!MODELS[toModel]) {
    res.status(400).json({ error: `Unknown target model: ${toModel}` });
    return;
  }

  // Record the handoff event
  const handoff = createHandoff(sessionId, fromModel, toModel, instruction ?? null);

  // Build context for the target model with handoff framing
  const ctx = buildHandoffContext(sessionId, fromModel, toModel, instruction);

  // If the user provided an instruction, save it as a user message tied to this handoff
  if (instruction) {
    saveMessage(sessionId, 'user', instruction, 'user', {
      handoffId: handoff.id,
      handoffFrom: fromModel,
      mode: 'handoff',
    });
    // Add the instruction to context messages
    ctx.messages.push({ role: 'user', content: instruction });
  }

  // Set up SSE
  setupSSE(res);

  // Send handoff metadata
  sseWrite(res, JSON.stringify({
    type: 'handoff',
    handoffId: handoff.id,
    fromModel,
    toModel,
    tokenEstimate: ctx.tokenEstimate,
    summarizedCount: ctx.summarizedCount,
    totalMessages: ctx.totalMessages,
  }));

  let accumulated = '';

  try {
    for await (const chunk of streamSingle(toModel, ctx.messages)) {
      accumulated += chunk.content;
      sseWrite(res, JSON.stringify(chunk));
    }
  } catch (err: any) {
    sseWrite(res, JSON.stringify({ error: err.message }));
  }

  // Save the handoff response — tagged with handoff metadata
  if (accumulated) {
    saveMessage(sessionId, 'assistant', accumulated, toModel, {
      handoffId: handoff.id,
      handoffFrom: fromModel,
      mode: 'handoff',
    });
  }

  // Fire-and-forget: auto-index session messages for RAG
  import('../services/rag-indexer').then(({ indexSessionMessages }) => {
    indexSessionMessages(sessionId).then((n) => {
      if (n > 0) console.log(`[handoff/stream] RAG indexed ${n} chunks for session ${sessionId}`);
    }).catch((err) => {
      console.warn(`[handoff/stream] RAG session indexing failed (non-critical):`, err.message);
    });
  }).catch(() => {});

  sseWrite(res, '[DONE]');
  res.end();
});

export default router;
