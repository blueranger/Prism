import { Router, Request, Response } from 'express';
import { SynthesizeRequest, MODELS } from '@prism/shared';
import { streamSingle, type ChatMessage } from '../services/llm-service';
import { saveMessage, getSessionMessages } from '../memory/conversation';
import { buildSessionContext } from '../memory/context-builder';
import { setupSSE, sseWrite } from './sse-utils';

const router = Router();

/**
 * POST /api/synthesize/stream
 *
 * Synthesize mode: collect the latest responses from multiple models,
 * then send them to a designated synthesizer model to produce a merged
 * best-of response. Streams the synthesis back via SSE.
 *
 * Body: { sessionId, sourceModels, synthesizerModel, instruction? }
 */
router.post('/stream', async (req: Request, res: Response) => {
  const { sessionId, sourceModels, synthesizerModel, instruction }: SynthesizeRequest = req.body;

  if (!sessionId || !sourceModels || sourceModels.length === 0 || !synthesizerModel) {
    res.status(400).json({ error: 'sessionId, sourceModels[], and synthesizerModel are required' });
    return;
  }

  for (const model of [...sourceModels, synthesizerModel]) {
    if (!MODELS[model]) {
      res.status(400).json({ error: `Unknown model: ${model}` });
      return;
    }
  }

  // Gather latest response from each source model
  const allMessages = getSessionMessages(sessionId);
  const sourceResponses: { model: string; displayName: string; content: string }[] = [];

  for (const model of sourceModels) {
    const responses = allMessages.filter(
      (m) => m.role === 'assistant' && m.sourceModel === model
    );
    if (responses.length === 0) continue;
    sourceResponses.push({
      model,
      displayName: MODELS[model].displayName,
      content: responses[responses.length - 1].content,
    });
  }

  if (sourceResponses.length < 2) {
    res.status(400).json({
      error: 'Need responses from at least 2 source models to synthesize. Send a prompt in Parallel mode first.',
    });
    return;
  }

  // Set up SSE
  setupSSE(res);

  // Send metadata
  sseWrite(res, JSON.stringify({
    type: 'synthesize_start',
    sourceModels: sourceResponses.map((r) => r.model),
    synthesizerModel,
  }));

  // Build synthesis prompt
  const synthInstruction = instruction
    ?? 'Synthesize the following responses into a single, comprehensive answer. Take the best elements from each: accuracy, completeness, clarity, and nuance. Resolve any contradictions by choosing the most well-supported position.';

  const responsesBlock = sourceResponses
    .map((r) => `### ${r.displayName}\n${r.content}`)
    .join('\n\n---\n\n');

  // Build context for the synthesizer (includes session history)
  const ctx = buildSessionContext(sessionId, synthesizerModel);

  const synthMessages: ChatMessage[] = [
    ...ctx.messages,
    {
      role: 'user',
      content: [
        'Multiple AI models have produced the following responses to the same question:',
        '',
        responsesBlock,
        '',
        '---',
        '',
        synthInstruction,
      ].join('\n'),
    },
  ];

  let accumulated = '';

  try {
    for await (const chunk of streamSingle(synthesizerModel, synthMessages)) {
      accumulated += chunk.content;
      sseWrite(res, JSON.stringify(chunk));
    }
  } catch (err: any) {
    sseWrite(res, JSON.stringify({ error: err.message }));
  }

  // Save the synthesized response (tagged as synthesize mode)
  if (accumulated) {
    saveMessage(sessionId, 'assistant', accumulated, synthesizerModel, { mode: 'synthesize' });
  }

  // Fire-and-forget: auto-index session messages for RAG
  import('../services/rag-indexer').then(({ indexSessionMessages }) => {
    indexSessionMessages(sessionId).then((n) => {
      if (n > 0) console.log(`[synthesize/stream] RAG indexed ${n} chunks for session ${sessionId}`);
    }).catch((err) => {
      console.warn(`[synthesize/stream] RAG session indexing failed (non-critical):`, err.message);
    });
  }).catch(() => {});

  sseWrite(res, '[DONE]');
  res.end();
});

export default router;
