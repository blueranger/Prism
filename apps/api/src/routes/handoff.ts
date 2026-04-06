import { Router, Request, Response } from 'express';
import { HandoffRequest, ContextDebugInfo } from '@prism/shared';
import { streamSingleWithTimeout } from '../services/llm-service';
import { saveMessage, createHandoff } from '../memory/conversation';
import { buildHandoffContext } from '../memory/context-builder';
import { setupSSE, sseWrite } from './sse-utils';
import { modelRegistry } from '../services/model-registry';
import { runMemoryPipelineForMessage } from '../services/memory-trigger-pipeline';
import { computeUsageEvent, recordUsageEvent } from '../services/cost-service';

const router = Router();
const LONG_FORM_OUTPUT_MAX_TOKENS = 16384;

function buildHandoffUserPrompt(fromModel: string, toModel: string, instruction?: string): string {
  const fromLabel = modelRegistry.getById(fromModel)?.displayName ?? fromModel;
  const toLabel = modelRegistry.getById(toModel)?.displayName ?? toModel;
  const base = [
    `Continue this shared session as ${toLabel}, taking over from ${fromLabel}.`,
    'Use the conversation context above and produce the next best response or artifact for the same task.',
  ];
  if (instruction?.trim()) {
    base.push(`Specific handoff instruction: ${instruction.trim()}`);
  }
  return base.join('\n');
}

function buildHandoffContinuationPrompt(
  fromModel: string,
  toModel: string,
  partialOutput: string,
  instruction?: string,
): string {
  const fromLabel = modelRegistry.getById(fromModel)?.displayName ?? fromModel;
  const toLabel = modelRegistry.getById(toModel)?.displayName ?? toModel;
  const tail = partialOutput.trim().slice(-1200);
  const lines = [
    `Continue this shared session as ${toLabel}, taking over from ${fromLabel}.`,
    'The previous response was cut off because it hit the output token limit.',
    'Continue exactly from where the previous response stopped.',
    'Do not restart the document, do not repeat earlier sections, and do not add a new introduction.',
    'Resume from the last unfinished block or line and finish the artifact cleanly.',
  ];
  if (instruction?.trim()) {
    lines.push(`Original handoff instruction: ${instruction.trim()}`);
  }
  lines.push('', 'Tail of the partial output to continue from:', tail);
  return lines.join('\n');
}

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

  if (!modelRegistry.getById(toModel)) {
    res.status(400).json({ error: `Unknown target model: ${toModel}` });
    return;
  }

  // Record the handoff event
  const handoff = createHandoff(sessionId, fromModel, toModel, instruction ?? null);

  // Build context for the target model with handoff framing
  const ctx = buildHandoffContext(sessionId, fromModel, toModel, instruction);

  const handoffUserPrompt = buildHandoffUserPrompt(fromModel, toModel, instruction);

  // If the user provided an instruction, save it as a user message tied to this handoff
  if (instruction) {
    saveMessage(sessionId, 'user', instruction, 'user', {
      handoffId: handoff.id,
      handoffFrom: fromModel,
      mode: 'handoff',
    });
  }
  // Always end with a user message so Anthropic-compatible models do not reject the request as assistant prefill.
  ctx.messages.push({ role: 'user', content: handoffUserPrompt });

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
  const contextDebugByModel: Record<string, ContextDebugInfo> = {
    [toModel]: {
      model: toModel,
      budget: { maxTokens: 0, reserveForResponse: 0, reserveForSystem: 0, available: 0 },
      contextTokens: ctx.tokenEstimate,
      promptTokens: handoffUserPrompt.length,
      totalTokens: ctx.tokenEstimate + handoffUserPrompt.length,
      breakdown: ctx.breakdown,
      documents: ctx.documents,
      memoryInjection: ctx.memoryInjection ?? null,
    },
  };
  sseWrite(res, JSON.stringify({ type: 'context_debug', sessionId, byModel: contextDebugByModel }));

  let accumulated = '';
  let accumulatedThinking = '';
  let usageMeta: ReturnType<typeof computeUsageEvent> | null = null;
  const streamStartedAt = Date.now();

  try {
    for await (const chunk of streamSingleWithTimeout(toModel, ctx.messages, undefined, { maxTokens: LONG_FORM_OUTPUT_MAX_TOKENS })) {
      if (chunk.thinkingContent) {
        accumulatedThinking += chunk.thinkingContent;
      }
      if ((chunk as any).timeoutReason) {
        sseWrite(res, JSON.stringify({ type: 'stream_timeout', model: toModel, reason: (chunk as any).timeoutReason }));
      }
      accumulated += chunk.content;
      let outboundChunk = chunk;
      if (chunk.done) {
        usageMeta = computeUsageEvent({
          sessionId,
          provider: chunk.provider,
          model: toModel,
          mode: 'handoff',
          startedAt: streamStartedAt,
          completedAt: Date.now(),
          requestMessages: ctx.messages,
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

  // Save the handoff response — tagged with handoff metadata
  if (accumulated) {
    const provider = modelRegistry.getById(toModel)?.provider ?? 'openai';
    const usage = usageMeta ?? computeUsageEvent({
      sessionId,
      provider,
      model: toModel,
      mode: 'handoff',
      startedAt: streamStartedAt,
      completedAt: Date.now(),
      requestMessages: ctx.messages,
      content: accumulated,
      thinkingContent: accumulatedThinking,
    });
    const assistantMessage = saveMessage(sessionId, 'assistant', accumulated, toModel, {
      handoffId: handoff.id,
      handoffFrom: fromModel,
      mode: 'handoff',
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
      model: toModel,
      mode: 'handoff',
      startedAt: streamStartedAt,
      completedAt: Date.now(),
      requestMessages: ctx.messages,
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
        console.warn('[handoff/stream] Memory pipeline failed for assistant message:', err.message);
      }
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

router.post('/retry-stream', async (req: Request, res: Response) => {
  const {
    sessionId,
    fromModel,
    toModel,
    instruction,
    continuationFrom,
    richOutput,
  }: HandoffRequest & { continuationFrom?: string; richOutput?: boolean } = req.body;

  if (!sessionId || !fromModel || !toModel) {
    res.status(400).json({ error: 'sessionId, fromModel, and toModel are required' });
    return;
  }

  if (!modelRegistry.getById(toModel)) {
    res.status(400).json({ error: `Unknown target model: ${toModel}` });
    return;
  }

  const handoff = createHandoff(sessionId, fromModel, toModel, instruction ?? null);
  const ctx = buildHandoffContext(sessionId, fromModel, toModel, instruction);
  const partialTail = richOutput && continuationFrom?.trim()
    ? continuationFrom
    : (
      ctx.messages
        .filter((m) => m.role === 'assistant')
        .map((m) => m.content)
        .filter(Boolean)
        .at(-1) ?? ''
    );
  const handoffUserPrompt = partialTail
    ? buildHandoffContinuationPrompt(fromModel, toModel, partialTail, instruction)
    : buildHandoffUserPrompt(fromModel, toModel, instruction);
  ctx.messages.push({ role: 'user', content: handoffUserPrompt });

  setupSSE(res);
  sseWrite(res, JSON.stringify({
    type: 'handoff',
    handoffId: handoff.id,
    fromModel,
    toModel,
    tokenEstimate: ctx.tokenEstimate,
    summarizedCount: ctx.summarizedCount,
    totalMessages: ctx.totalMessages,
  }));
  const contextDebugByModel: Record<string, ContextDebugInfo> = {
    [toModel]: {
      model: toModel,
      budget: { maxTokens: 0, reserveForResponse: 0, reserveForSystem: 0, available: 0 },
      contextTokens: ctx.tokenEstimate,
      promptTokens: handoffUserPrompt.length,
      totalTokens: ctx.tokenEstimate + handoffUserPrompt.length,
      breakdown: ctx.breakdown,
      documents: ctx.documents,
      memoryInjection: ctx.memoryInjection ?? null,
    },
  };
  sseWrite(res, JSON.stringify({ type: 'context_debug', sessionId, byModel: contextDebugByModel }));

  let accumulated = '';
  let accumulatedThinking = '';
  let usageMeta: ReturnType<typeof computeUsageEvent> | null = null;
  const streamStartedAt = Date.now();
  try {
    for await (const chunk of streamSingleWithTimeout(toModel, ctx.messages, undefined, { maxTokens: LONG_FORM_OUTPUT_MAX_TOKENS })) {
      if (chunk.thinkingContent) {
        accumulatedThinking += chunk.thinkingContent;
      }
      if ((chunk as any).timeoutReason) {
        sseWrite(res, JSON.stringify({ type: 'stream_timeout', model: toModel, reason: (chunk as any).timeoutReason }));
      }
      accumulated += chunk.content;
      let outboundChunk = chunk;
      if (chunk.done) {
        usageMeta = computeUsageEvent({
          sessionId,
          provider: chunk.provider,
          model: toModel,
          mode: 'handoff',
          startedAt: streamStartedAt,
          completedAt: Date.now(),
          requestMessages: ctx.messages,
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
    const provider = modelRegistry.getById(toModel)?.provider ?? 'openai';
    const usage = usageMeta ?? computeUsageEvent({
      sessionId,
      provider,
      model: toModel,
      mode: 'handoff',
      startedAt: streamStartedAt,
      completedAt: Date.now(),
      requestMessages: ctx.messages,
      content: accumulated,
      thinkingContent: accumulatedThinking,
    });
    const assistantMessage = saveMessage(sessionId, 'assistant', accumulated, toModel, {
      handoffId: handoff.id,
      handoffFrom: fromModel,
      mode: 'handoff',
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
      model: toModel,
      mode: 'handoff',
      startedAt: streamStartedAt,
      completedAt: Date.now(),
      requestMessages: ctx.messages,
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
        console.warn('[handoff/retry-stream] Memory pipeline failed for assistant message:', err.message);
      }
    });
  }

  sseWrite(res, '[DONE]');
  res.end();
});

export default router;
