import { Router, Request, Response } from 'express';
import { SynthesizeRequest, ContextDebugInfo } from '@prism/shared';
import { streamSingleWithTimeout, type ChatMessage } from '../services/llm-service';
import { saveMessage, getSessionMessages } from '../memory/conversation';
import { buildSessionContext } from '../memory/context-builder';
import { setupSSE, sseWrite } from './sse-utils';
import { modelRegistry } from '../services/model-registry';
import { runMemoryPipelineForMessage } from '../services/memory-trigger-pipeline';
import { computeUsageEvent, recordUsageEvent } from '../services/cost-service';

const router = Router();
const LONG_FORM_OUTPUT_MAX_TOKENS = 8192;

function buildStructuredContinuationPrompt(partialOutput: string, synthInstruction: string): string {
  const tail = partialOutput.trim().slice(-1600);
  return [
    'Continue the previous structured synthesis artifact from where it stopped.',
    'Do not restart the document, do not repeat earlier sections, and do not add a new introduction or explanation.',
    `Original task: ${synthInstruction}`,
    'Resume from the last unfinished block or line and finish the artifact cleanly.',
    '',
    'Tail of the partial output to continue from:',
    tail,
  ].join('\n');
}

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
    if (!modelRegistry.getById(model)) {
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
    const config = modelRegistry.getById(model);
    sourceResponses.push({
      model,
      displayName: config?.displayName ?? model,
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
  const contextDebugByModel: Record<string, ContextDebugInfo> = {
    [synthesizerModel]: {
      model: synthesizerModel,
      budget: { maxTokens: 0, reserveForResponse: 0, reserveForSystem: 0, available: 0 },
      contextTokens: ctx.tokenEstimate,
      promptTokens: synthInstruction.length + responsesBlock.length,
      totalTokens: ctx.tokenEstimate + synthInstruction.length + responsesBlock.length,
      breakdown: ctx.breakdown,
      documents: ctx.documents,
      memoryInjection: ctx.memoryInjection ?? null,
    },
  };

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

  sseWrite(res, JSON.stringify({ type: 'context_debug', sessionId, byModel: contextDebugByModel }));

  let accumulated = '';
  let accumulatedThinking = '';
  let usageMeta: ReturnType<typeof computeUsageEvent> | null = null;
  const streamStartedAt = Date.now();

  try {
    for await (const chunk of streamSingleWithTimeout(synthesizerModel, synthMessages, undefined, { maxTokens: LONG_FORM_OUTPUT_MAX_TOKENS })) {
      if (chunk.thinkingContent) {
        accumulatedThinking += chunk.thinkingContent;
      }
      if ((chunk as any).timeoutReason) {
        sseWrite(res, JSON.stringify({ type: 'stream_timeout', model: synthesizerModel, reason: (chunk as any).timeoutReason }));
      }
      accumulated += chunk.content;
      let outboundChunk = chunk;
      if (chunk.done) {
        usageMeta = computeUsageEvent({
          sessionId,
          provider: chunk.provider,
          model: synthesizerModel,
          mode: 'synthesize',
          startedAt: streamStartedAt,
          completedAt: Date.now(),
          requestMessages: synthMessages,
          content: accumulated,
          thinkingContent: accumulatedThinking,
          usage: chunk.usage,
        });
        outboundChunk = {
          ...chunk,
          usage: {
            ...chunk.usage,
            promptTokens: usageMeta.promptTokens,
            completionTokens: usageMeta.completionTokens,
            reasoningTokens: usageMeta.reasoningTokens,
            cachedTokens: usageMeta.cachedTokens,
            totalTokens: usageMeta.totalTokens,
          },
          estimatedCostUsd: usageMeta.estimatedCostUsd,
          pricingSource: usageMeta.pricingSource,
        };
      }
      sseWrite(res, JSON.stringify(outboundChunk));
    }
  } catch (err: any) {
    sseWrite(res, JSON.stringify({ error: err.message }));
  }

  // Save the synthesized response (tagged as synthesize mode)
  if (accumulated) {
    const provider = modelRegistry.getById(synthesizerModel)?.provider ?? 'openai';
    const usage = usageMeta ?? computeUsageEvent({
      sessionId,
      provider,
      model: synthesizerModel,
      mode: 'synthesize',
      startedAt: streamStartedAt,
      completedAt: Date.now(),
      requestMessages: synthMessages,
      content: accumulated,
      thinkingContent: accumulatedThinking,
    });
    const assistantMessage = saveMessage(sessionId, 'assistant', accumulated, synthesizerModel, {
      mode: 'synthesize',
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens,
        cachedTokens: usage.cachedTokens,
      },
      estimatedCostUsd: usage.estimatedCostUsd,
      pricingSource: usage.pricingSource,
    });
    recordUsageEvent({
      sessionId,
      messageId: assistantMessage.id,
      provider,
      model: synthesizerModel,
      mode: 'synthesize',
      startedAt: streamStartedAt,
      completedAt: Date.now(),
      requestMessages: synthMessages,
      content: accumulated,
      thinkingContent: accumulatedThinking,
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens,
        cachedTokens: usage.cachedTokens,
        totalTokens: usage.totalTokens,
      },
    });
    void Promise.resolve().then(() => {
      try {
        runMemoryPipelineForMessage(sessionId, assistantMessage.id, 'auto_post_response');
      } catch (err: any) {
        console.warn('[synthesize/stream] Memory pipeline failed for assistant message:', err.message);
      }
    });
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

router.post('/retry-stream', async (req: Request, res: Response) => {
  const {
    sessionId,
    sourceModels,
    synthesizerModel,
    instruction,
    continuationFrom,
    richOutput,
  }: SynthesizeRequest & { continuationFrom?: string; richOutput?: boolean } = req.body;

  if (!sessionId || !sourceModels || sourceModels.length === 0 || !synthesizerModel) {
    res.status(400).json({ error: 'sessionId, sourceModels[], and synthesizerModel are required' });
    return;
  }

  for (const model of [...sourceModels, synthesizerModel]) {
    if (!modelRegistry.getById(model)) {
      res.status(400).json({ error: `Unknown model: ${model}` });
      return;
    }
  }

  const allMessages = getSessionMessages(sessionId);
  const sourceResponses: { model: string; displayName: string; content: string }[] = [];

  for (const model of sourceModels) {
    const responses = allMessages.filter((m) => m.role === 'assistant' && m.sourceModel === model);
    if (responses.length === 0) continue;
    const config = modelRegistry.getById(model);
    sourceResponses.push({
      model,
      displayName: config?.displayName ?? model,
      content: responses[responses.length - 1].content,
    });
  }

  if (sourceResponses.length < 2) {
    res.status(400).json({
      error: 'Need responses from at least 2 source models to synthesize. Send a prompt in Parallel mode first.',
    });
    return;
  }

  const synthInstruction = instruction
    ?? 'Synthesize the following responses into a single, comprehensive answer. Take the best elements from each: accuracy, completeness, clarity, and nuance. Resolve any contradictions by choosing the most well-supported position.';

  const responsesBlock = sourceResponses
    .map((r) => `### ${r.displayName}\n${r.content}`)
    .join('\n\n---\n\n');

  const ctx = buildSessionContext(sessionId, synthesizerModel);
  const contextDebugByModel: Record<string, ContextDebugInfo> = {
    [synthesizerModel]: {
      model: synthesizerModel,
      budget: { maxTokens: 0, reserveForResponse: 0, reserveForSystem: 0, available: 0 },
      contextTokens: ctx.tokenEstimate,
      promptTokens: synthInstruction.length + responsesBlock.length,
      totalTokens: ctx.tokenEstimate + synthInstruction.length + responsesBlock.length,
      breakdown: ctx.breakdown,
      documents: ctx.documents,
      memoryInjection: ctx.memoryInjection ?? null,
    },
  };
  const userPrompt = richOutput && continuationFrom?.trim()
    ? buildStructuredContinuationPrompt(continuationFrom, synthInstruction)
    : [
        'Multiple AI models have produced the following responses to the same question:',
        '',
        responsesBlock,
        '',
        '---',
        '',
        synthInstruction,
      ].join('\n');
  const synthMessages: ChatMessage[] = [
    ...ctx.messages,
    { role: 'user', content: userPrompt },
  ];

  setupSSE(res);
  sseWrite(res, JSON.stringify({
    type: 'synthesize_start',
    sourceModels: sourceResponses.map((r) => r.model),
    synthesizerModel,
  }));
  sseWrite(res, JSON.stringify({ type: 'context_debug', sessionId, byModel: contextDebugByModel }));

  let accumulated = '';
  let accumulatedThinking = '';
  let usageMeta: ReturnType<typeof computeUsageEvent> | null = null;
  const streamStartedAt = Date.now();

  try {
    for await (const chunk of streamSingleWithTimeout(synthesizerModel, synthMessages, undefined, {
      maxTokens: richOutput ? LONG_FORM_OUTPUT_MAX_TOKENS : undefined,
    })) {
      if (chunk.thinkingContent) {
        accumulatedThinking += chunk.thinkingContent;
      }
      if ((chunk as any).timeoutReason) {
        sseWrite(res, JSON.stringify({ type: 'stream_timeout', model: synthesizerModel, reason: (chunk as any).timeoutReason }));
      }
      accumulated += chunk.content;
      let outboundChunk = chunk;
      if (chunk.done) {
        usageMeta = computeUsageEvent({
          sessionId,
          provider: chunk.provider,
          model: synthesizerModel,
          mode: 'synthesize',
          startedAt: streamStartedAt,
          completedAt: Date.now(),
          requestMessages: synthMessages,
          content: accumulated,
          thinkingContent: accumulatedThinking,
          usage: chunk.usage,
        });
        outboundChunk = {
          ...chunk,
          usage: {
            ...chunk.usage,
            promptTokens: usageMeta.promptTokens,
            completionTokens: usageMeta.completionTokens,
            reasoningTokens: usageMeta.reasoningTokens,
            cachedTokens: usageMeta.cachedTokens,
            totalTokens: usageMeta.totalTokens,
          },
          estimatedCostUsd: usageMeta.estimatedCostUsd,
          pricingSource: usageMeta.pricingSource,
        };
      }
      sseWrite(res, JSON.stringify(outboundChunk));
    }
  } catch (err: any) {
    sseWrite(res, JSON.stringify({ error: err.message }));
  }

  if (accumulated) {
    const provider = modelRegistry.getById(synthesizerModel)?.provider ?? 'openai';
    const usage = usageMeta ?? computeUsageEvent({
      sessionId,
      provider,
      model: synthesizerModel,
      mode: 'synthesize',
      startedAt: streamStartedAt,
      completedAt: Date.now(),
      requestMessages: synthMessages,
      content: accumulated,
      thinkingContent: accumulatedThinking,
    });
    const assistantMessage = saveMessage(sessionId, 'assistant', accumulated, synthesizerModel, {
      mode: 'synthesize',
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens,
        cachedTokens: usage.cachedTokens,
      },
      estimatedCostUsd: usage.estimatedCostUsd,
      pricingSource: usage.pricingSource,
    });
    recordUsageEvent({
      sessionId,
      messageId: assistantMessage.id,
      provider,
      model: synthesizerModel,
      mode: 'synthesize',
      startedAt: streamStartedAt,
      completedAt: Date.now(),
      requestMessages: synthMessages,
      content: accumulated,
      thinkingContent: accumulatedThinking,
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens,
        cachedTokens: usage.cachedTokens,
        totalTokens: usage.totalTokens,
      },
    });
    void Promise.resolve().then(() => {
      try {
        runMemoryPipelineForMessage(sessionId, assistantMessage.id, 'auto_post_response');
      } catch (err: any) {
        console.warn('[synthesize/retry-stream] Memory pipeline failed for assistant message:', err.message);
      }
    });
  }

  sseWrite(res, '[DONE]');
  res.end();
});

export default router;
