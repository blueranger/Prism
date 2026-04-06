import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { PromptRequest, ContextDebugInfo } from '@prism/shared';
import { streamParallel, streamSingleWithTimeout } from '../services/llm-service';
import { getSessionMessages, saveMessage } from '../memory/conversation';
import { buildSessionContext } from '../memory/context-builder';
import { computeBudget, estimateMessageTokens } from '../memory/token-estimator';
import { setupSSE, sseWrite } from './sse-utils';
import { buildUrlContextMessage, buildUrlContextPreview, resolveUrlPreview, resolveUrlsFromPrompt } from '../services/url-reader';
import { modelRegistry } from '../services/model-registry';
import { runMemoryPipelineForMessage } from '../services/memory-trigger-pipeline';
import { computeUsageEvent, recordUsageEvent } from '../services/cost-service';

const router = Router();
const LONG_FORM_OUTPUT_MAX_TOKENS = 16384;

function buildStructuredContinuationPrompt(partialOutput: string): string {
  const tail = partialOutput.trim().slice(-1600);
  return [
    'Continue the previous rich HTML/SVG artifact from where it stopped.',
    'Do not restart the document, do not repeat earlier sections, and do not add a new introduction or explanation.',
    'Resume from the last unfinished block or line and finish the artifact cleanly.',
    '',
    'Tail of the partial output to continue from:',
    tail,
  ].join('\n');
}

router.post('/url-preview', async (req: Request, res: Response) => {
  const prompt = String(req.body.prompt ?? '');
  const urls = prompt.match(/https?:\/\/[^\s)]+/gi) ?? [];
  const previews = await Promise.all(urls.slice(0, 3).map(async (url) => {
    const preview = await resolveUrlPreview(url);
    return preview?.page ?? null;
  }));
  res.json({ previews: previews.filter(Boolean) });
});

router.post('/stream', async (req: Request, res: Response) => {
  const { prompt, models, sessionId, thinking }: PromptRequest = req.body;

  if (!prompt || !models || models.length === 0) {
    res.status(400).json({ error: 'prompt and models[] are required' });
    return;
  }

  // Validate models
  for (const model of models) {
    if (!modelRegistry.getById(model)) {
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
  const savedUserMessage = saveMessage(sid, 'user', prompt, 'user');

  // Build per-model context from conversation history (token-budget-aware)
  console.log(`[prompt/stream] Building context for models: ${models.join(', ')} (session: ${sid})`);
  if (thinking) {
    const thinkingModels = Object.entries(thinking).filter(([, c]) => c.enabled).map(([m]) => m);
    if (thinkingModels.length > 0) {
      console.log(`[prompt/stream] Thinking enabled for: ${thinkingModels.join(', ')}`);
    }
  }

  const resolvedUrls = await resolveUrlsFromPrompt(prompt);
  const urlContextMessage = buildUrlContextMessage(resolvedUrls);
  const urlContextTokens = urlContextMessage ? estimateMessageTokens('system', urlContextMessage) : 0;
  const promptTokens = estimateMessageTokens('user', prompt);
  if (resolvedUrls.length > 0) {
    console.log(`[prompt/stream] Resolved ${resolvedUrls.length} URL(s) from prompt`);
    for (const block of buildUrlContextPreview(resolvedUrls)) {
      console.log(`[prompt/stream] URL context preview >>>\n${block}\n<<< [end url context preview]`);
    }
  }

  const contextPerModel: Record<string, { role: 'user' | 'assistant' | 'system'; content: string }[]> = {};
  const contextDebugByModel: Record<string, ContextDebugInfo> = {};
  for (const model of models) {
    try {
      const ctx = buildSessionContext(sid, model);
      const breakdown = [...ctx.breakdown];
      if (urlContextTokens > 0) {
        breakdown.push({
          key: 'url_context',
          label: 'Detected URLs',
          tokens: urlContextTokens,
          count: resolvedUrls.length,
        });
      }
      breakdown.push({
        key: 'current_prompt',
        label: 'Current prompt',
        tokens: promptTokens,
        count: 1,
      });
      const budget = computeBudget(model);
      contextPerModel[model] = urlContextMessage
        ? [...ctx.messages, { role: 'system', content: urlContextMessage }]
        : ctx.messages;
      if (urlContextMessage) {
        console.log(`[prompt/stream] ${model} urlContextMessage head >>>\n${urlContextMessage.slice(0, 700)}\n<<< [end urlContext head]`);
      }
      contextDebugByModel[model] = {
        model,
        budget,
        contextTokens: ctx.tokenEstimate + urlContextTokens,
        promptTokens,
        totalTokens: ctx.tokenEstimate + urlContextTokens + promptTokens,
        breakdown: breakdown.sort((a, b) => b.tokens - a.tokens),
        documents: ctx.documents,
        memoryInjection: ctx.memoryInjection ?? null,
      };
      console.log(`[prompt/stream] Context for ${model}: ${ctx.messages.length} messages`);
    } catch (ctxErr: any) {
      console.error(`[prompt/stream] Context build failed for ${model}:`, ctxErr.message);
      contextPerModel[model] = urlContextMessage
        ? [{ role: 'system', content: urlContextMessage }]
        : [];
      contextDebugByModel[model] = {
        model,
        budget: computeBudget(model),
        contextTokens: urlContextTokens,
        promptTokens,
        totalTokens: urlContextTokens + promptTokens,
        breakdown: [
          ...(urlContextTokens > 0 ? [{
            key: 'url_context',
            label: 'Detected URLs',
            tokens: urlContextTokens,
            count: resolvedUrls.length,
          }] : []),
          {
            key: 'current_prompt',
            label: 'Current prompt',
            tokens: promptTokens,
            count: 1,
          },
        ],
        documents: [],
        memoryInjection: null,
      };
    }
  }

  sseWrite(res, JSON.stringify({ type: 'context_debug', sessionId: sid, byModel: contextDebugByModel }));

  // Accumulate full responses per model for saving
  const accumulated: Record<string, string> = {};
  const thinkingAccumulated: Record<string, string> = {};
  const usageMetaByModel: Record<string, ReturnType<typeof computeUsageEvent>> = {};
  const streamStartedAt = Date.now();
  let chunksSent = 0;

  try {
    console.log(`[prompt/stream] Starting streamParallel for ${models.length} models`);
    for await (const chunk of streamParallel(prompt, models, { contextPerModel, thinking })) {
      const key = chunk.model;
      if (!accumulated[key]) accumulated[key] = '';
      if (!thinkingAccumulated[key]) thinkingAccumulated[key] = '';
      accumulated[key] += chunk.content;
      if (chunk.thinkingContent) {
        thinkingAccumulated[key] += chunk.thinkingContent;
      }

      let outboundChunk = chunk;
      if (chunk.done) {
        const computed = computeUsageEvent({
          sessionId: sid,
          provider: chunk.provider,
          model: key,
          mode: 'parallel',
          startedAt: streamStartedAt,
          completedAt: Date.now(),
          requestMessages: [...contextPerModel[key], { role: 'user', content: prompt }],
          content: accumulated[key],
          thinkingContent: thinkingAccumulated[key],
          usage: chunk.usage,
        });
        usageMetaByModel[key] = computed;
        outboundChunk = {
          ...chunk,
          usage: {
            ...chunk.usage,
            promptTokens: computed.promptTokens,
            completionTokens: computed.completionTokens,
            reasoningTokens: computed.reasoningTokens,
            cachedTokens: computed.cachedTokens,
            totalTokens: computed.totalTokens,
          },
          estimatedCostUsd: computed.estimatedCostUsd,
          pricingSource: computed.pricingSource,
        };
      }

      if ((chunk as any).timeoutReason) {
        sseWrite(res, JSON.stringify({ type: 'stream_timeout', model: chunk.model, reason: (chunk as any).timeoutReason }));
      }
      sseWrite(res, JSON.stringify(outboundChunk));
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
      const usage = usageMetaByModel[model];
      const provider = modelRegistry.getById(model)?.provider ?? 'openai';
      const assistantMessage = saveMessage(sid, 'assistant', content, model, {
        mode: 'parallel',
        usage: usage ? {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          reasoningTokens: usage.reasoningTokens,
          cachedTokens: usage.cachedTokens,
        } : undefined,
        estimatedCostUsd: usage?.estimatedCostUsd,
        pricingSource: usage?.pricingSource,
      });
      recordUsageEvent({
        sessionId: sid,
        messageId: assistantMessage.id,
        provider,
        model,
        mode: 'parallel',
        startedAt: streamStartedAt,
        completedAt: Date.now(),
        requestMessages: [...contextPerModel[model], { role: 'user', content: prompt }],
        content,
        thinkingContent: thinkingAccumulated[model],
        usage: usage ? {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          reasoningTokens: usage.reasoningTokens,
          cachedTokens: usage.cachedTokens,
          totalTokens: usage.totalTokens,
        } : undefined,
      });
      void Promise.resolve().then(() => {
        try {
          runMemoryPipelineForMessage(sid, assistantMessage.id, 'auto_post_response');
        } catch (err: any) {
          console.warn('[prompt/stream] Memory pipeline failed for assistant message:', err.message);
        }
      });
    }
  }

  void Promise.resolve().then(() => {
    try {
      runMemoryPipelineForMessage(sid, savedUserMessage.id, 'auto_post_response');
    } catch (err: any) {
      console.warn('[prompt/stream] Memory pipeline failed for user message:', err.message);
    }
  });

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

router.post('/retry-stream', async (req: Request, res: Response) => {
  const { sessionId, models, thinking, continuationFrom, richOutput }: PromptRequest & { continuationFrom?: string; richOutput?: boolean } = req.body;
  if (!sessionId || !models || models.length === 0) {
    res.status(400).json({ error: 'sessionId and models[] are required' });
    return;
  }

  for (const model of models) {
    if (!modelRegistry.getById(model)) {
      res.status(400).json({ error: `Unknown model: ${model}` });
      return;
    }
  }

  const allMessages = getSessionMessages(sessionId);
  const latestUserIndex = [...allMessages].map((m, i) => ({ m, i })).reverse().find(({ m }) => m.role === 'user')?.i;
  if (latestUserIndex === undefined) {
    res.status(400).json({ error: 'No prior user prompt found to retry' });
    return;
  }

  const prompt = allMessages[latestUserIndex].content;
  const history = allMessages.slice(0, latestUserIndex).map((m) => ({ role: m.role, content: m.content }));
  const effectivePrompt = richOutput && continuationFrom?.trim()
    ? buildStructuredContinuationPrompt(continuationFrom)
    : prompt;

  setupSSE(res);
  sseWrite(res, JSON.stringify({ type: 'session', sessionId }));

  const accumulated: Record<string, string> = {};
  const thinkingAccumulated: Record<string, string> = {};
  const usageMetaByModel: Record<string, ReturnType<typeof computeUsageEvent>> = {};
  const streamStartedAt = Date.now();
  try {
    if (models.length === 1) {
      const model = models[0];
      const retryMessages = [...history, { role: 'user' as const, content: effectivePrompt }];
      const retryThinking = thinking?.[model];
      for await (const chunk of streamSingleWithTimeout(model, retryMessages, retryThinking, {
        maxTokens: richOutput ? LONG_FORM_OUTPUT_MAX_TOKENS : undefined,
      })) {
        if (!accumulated[model]) accumulated[model] = '';
        if (!thinkingAccumulated[model]) thinkingAccumulated[model] = '';
        accumulated[model] += chunk.content;
        if (chunk.thinkingContent) {
          thinkingAccumulated[model] += chunk.thinkingContent;
        }
        let outboundChunk = chunk;
        if (chunk.done) {
          const computed = computeUsageEvent({
            sessionId,
            provider: chunk.provider,
            model,
            mode: 'parallel',
            startedAt: streamStartedAt,
            completedAt: Date.now(),
            requestMessages: retryMessages,
            content: accumulated[model],
            thinkingContent: thinkingAccumulated[model],
            usage: chunk.usage,
          });
          usageMetaByModel[model] = computed;
          outboundChunk = {
            ...chunk,
            usage: {
              ...chunk.usage,
              promptTokens: computed.promptTokens,
              completionTokens: computed.completionTokens,
              reasoningTokens: computed.reasoningTokens,
              cachedTokens: computed.cachedTokens,
              totalTokens: computed.totalTokens,
            },
            estimatedCostUsd: computed.estimatedCostUsd,
            pricingSource: computed.pricingSource,
          };
        }
        if ((chunk as any).timeoutReason) {
          sseWrite(res, JSON.stringify({ type: 'stream_timeout', model: chunk.model, reason: (chunk as any).timeoutReason }));
        }
        sseWrite(res, JSON.stringify(outboundChunk));
      }
    } else {
      for await (const chunk of streamParallel(effectivePrompt, models, { history, thinking })) {
        const key = chunk.model;
        if (!accumulated[key]) accumulated[key] = '';
        if (!thinkingAccumulated[key]) thinkingAccumulated[key] = '';
        accumulated[key] += chunk.content;
        if (chunk.thinkingContent) {
          thinkingAccumulated[key] += chunk.thinkingContent;
        }
        let outboundChunk = chunk;
        if (chunk.done) {
          const requestMessages = [...history, { role: 'user' as const, content: effectivePrompt }];
          const computed = computeUsageEvent({
            sessionId,
            provider: chunk.provider,
            model: key,
            mode: 'parallel',
            startedAt: streamStartedAt,
            completedAt: Date.now(),
            requestMessages,
            content: accumulated[key],
            thinkingContent: thinkingAccumulated[key],
            usage: chunk.usage,
          });
          usageMetaByModel[key] = computed;
          outboundChunk = {
            ...chunk,
            usage: {
              ...chunk.usage,
              promptTokens: computed.promptTokens,
              completionTokens: computed.completionTokens,
              reasoningTokens: computed.reasoningTokens,
              cachedTokens: computed.cachedTokens,
              totalTokens: computed.totalTokens,
            },
            estimatedCostUsd: computed.estimatedCostUsd,
            pricingSource: computed.pricingSource,
          };
        }
        if ((chunk as any).timeoutReason) {
          sseWrite(res, JSON.stringify({ type: 'stream_timeout', model: chunk.model, reason: (chunk as any).timeoutReason }));
        }
        sseWrite(res, JSON.stringify(outboundChunk));
      }
    }
  } catch (err: any) {
    sseWrite(res, JSON.stringify({ error: err.message }));
  }

  for (const [model, content] of Object.entries(accumulated)) {
    if (content) {
      const usage = usageMetaByModel[model];
      const provider = modelRegistry.getById(model)?.provider ?? 'openai';
      const requestMessages = models.length === 1
        ? [...history, { role: 'user' as const, content: effectivePrompt }]
        : [...history, { role: 'user' as const, content: effectivePrompt }];
      const assistantMessage = saveMessage(sessionId, 'assistant', content, model, {
        mode: 'parallel',
        usage: usage ? {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          reasoningTokens: usage.reasoningTokens,
          cachedTokens: usage.cachedTokens,
        } : undefined,
        estimatedCostUsd: usage?.estimatedCostUsd,
        pricingSource: usage?.pricingSource,
      });
      recordUsageEvent({
        sessionId,
        messageId: assistantMessage.id,
        provider,
        model,
        mode: 'parallel',
        startedAt: streamStartedAt,
        completedAt: Date.now(),
        requestMessages,
        content,
        thinkingContent: thinkingAccumulated[model],
        usage: usage ? {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          reasoningTokens: usage.reasoningTokens,
          cachedTokens: usage.cachedTokens,
          totalTokens: usage.totalTokens,
        } : undefined,
      });
      void Promise.resolve().then(() => {
        try {
          runMemoryPipelineForMessage(sessionId, assistantMessage.id, 'auto_post_response');
        } catch (err: any) {
          console.warn('[prompt/retry-stream] Memory pipeline failed for assistant message:', err.message);
        }
      });
    }
  }

  sseWrite(res, '[DONE]');
  res.end();
});

export default router;
