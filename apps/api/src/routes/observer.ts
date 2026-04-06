import { Router, type Request, type Response } from 'express';
import type {
  ContextDebugInfo,
  ObserverActionRequest,
  ObserverTurnRequest,
  ThinkingConfig,
} from '@prism/shared';
import { modelRegistry } from '../services/model-registry';
import { buildSessionContext } from '../memory/context-builder';
import { getSessionMessages, saveMessage } from '../memory/conversation';
import {
  createTopicSession,
  getObserverConfig,
  getSession,
  listObserverSnapshots,
  saveObserverSnapshot,
  updateObserverConfig,
} from '../memory/session';
import { collectSingle, streamSingleWithTimeout, type ChatMessage } from '../services/llm-service';
import { setupSSE, sseWrite } from './sse-utils';
import { buildUrlContextMessage, buildUrlContextPreview, resolveUrlsFromPrompt } from '../services/url-reader';
import { runMemoryPipelineForMessage } from '../services/memory-trigger-pipeline';
import { computeUsageEvent, recordUsageEvent } from '../services/cost-service';

const router = Router();
const LONG_FORM_OUTPUT_MAX_TOKENS = 8192;

function buildContentPreview(content: string): { head: string; tail: string } {
  const normalized = content.replace(/\r\n/g, '\n');
  return {
    head: normalized.slice(0, 500),
    tail: normalized.slice(-500),
  };
}

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

type SnapshotPayload = {
  summary: string;
  risks: string[];
  disagreements: string[];
  suggestedFollowUp: string | null;
};

function sanitizeObserverModels(activeModel: string, observerModels: string[]): string[] {
  return Array.from(new Set(observerModels.filter((model) => model && model !== activeModel)));
}

function buildSnapshotPrompt(activeModel: string, activeContent: string): string {
  return [
    `You are an observer reviewing the latest answer from ${activeModel}.`,
    'Return strict JSON with keys: summary, risks, disagreements, suggestedFollowUp.',
    'Rules:',
    '- summary: one short paragraph',
    '- risks: array of short strings',
    '- disagreements: array of short strings',
    '- suggestedFollowUp: one short string or null',
    '- no markdown, no extra prose',
    '',
    'Latest answer:',
    activeContent,
  ].join('\n');
}

function safeParseSnapshot(raw: string): SnapshotPayload {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const extractField = (field: string): string | null => {
    const match = cleaned.match(new RegExp(`"${field}"\\s*:\\s*"([\\s\\S]*?)(?:"\\s*,\\s*"|\"\\s*}\\s*$|$)`, 'i'));
    if (!match?.[1]) return null;
    return match[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .trim();
  };

  try {
    const parsed = JSON.parse(cleaned);
    return {
      summary: String(parsed.summary ?? '').trim() || 'No summary provided.',
      risks: Array.isArray(parsed.risks) ? parsed.risks.map((v: unknown) => String(v).trim()).filter(Boolean).slice(0, 4) : [],
      disagreements: Array.isArray(parsed.disagreements) ? parsed.disagreements.map((v: unknown) => String(v).trim()).filter(Boolean).slice(0, 4) : [],
      suggestedFollowUp: parsed.suggestedFollowUp ? String(parsed.suggestedFollowUp).trim() : null,
    };
  } catch {
    const text = extractField('summary') || cleaned;
    return {
      summary: text.slice(0, 280) || 'No summary provided.',
      risks: [],
      disagreements: [],
      suggestedFollowUp: null,
    };
  }
}

function buildObserverActionPrompt(
  action: ObserverActionRequest['action'],
  activeModel: string,
  activeContent: string,
  snapshots: ReturnType<typeof listObserverSnapshots>,
  instruction?: string,
): string {
  const snapshotSection = snapshots.length === 0
    ? 'No observer snapshots available.'
    : snapshots.map((snapshot) => [
        `Observer: ${snapshot.model}`,
        `Summary: ${snapshot.summary}`,
        snapshot.risks.length ? `Risks: ${snapshot.risks.join('; ')}` : null,
        snapshot.disagreements.length ? `Disagreements: ${snapshot.disagreements.join('; ')}` : null,
        snapshot.suggestedFollowUp ? `Suggested follow-up: ${snapshot.suggestedFollowUp}` : null,
      ].filter(Boolean).join('\n')).join('\n\n');

  const defaultInstruction =
    action === 'review'
      ? 'Review the active answer. Call out strengths, risks, and anything that seems wrong or missing.'
      : action === 'alternative'
        ? 'Provide an alternative answer to the same problem, using the full context and differing where useful.'
        : 'Synthesize the active answer with the observer snapshots into one best next-step answer.';

  return [
    `${instruction?.trim() || defaultInstruction}`,
    '',
    `Active model: ${activeModel}`,
    'Active answer:',
    activeContent,
    '',
    'Observer snapshots:',
    snapshotSection,
  ].join('\n');
}

router.get('/:sessionId', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.json({
    config: getObserverConfig(req.params.sessionId),
    snapshots: listObserverSnapshots(req.params.sessionId),
  });
});

router.post('/stream', async (req: Request, res: Response) => {
  const { prompt, sessionId, activeModel, observerModels, thinking }: ObserverTurnRequest = req.body;

  if (!prompt?.trim() || !activeModel) {
    res.status(400).json({ error: 'prompt and activeModel are required' });
    return;
  }

  if (!modelRegistry.getById(activeModel)) {
    res.status(400).json({ error: `Unknown model: ${activeModel}` });
    return;
  }

  const cleanObservers = sanitizeObserverModels(activeModel, observerModels ?? []);
  for (const model of cleanObservers) {
    if (!modelRegistry.getById(model)) {
      res.status(400).json({ error: `Unknown model: ${model}` });
      return;
    }
  }

  let session = sessionId ? getSession(sessionId) : undefined;
  if (!session) {
    session = createTopicSession({
      interactionMode: 'observer',
      activeModel,
      observerModels: cleanObservers,
    });
  } else {
    session = updateObserverConfig(session.id, {
      interactionMode: 'observer',
      activeModel,
      observerModels: cleanObservers,
    });
  }

  if (!session) {
    res.status(500).json({ error: 'Failed to create or update session' });
    return;
  }

  setupSSE(res);
  sseWrite(res, JSON.stringify({ type: 'session', sessionId: session.id }));

  const userMessage = saveMessage(session.id, 'user', prompt.trim(), 'user', { mode: 'observer' });
  const activeContext = buildSessionContext(session.id, activeModel);
  const resolvedUrls = await resolveUrlsFromPrompt(prompt.trim());
  const urlContextMessage = buildUrlContextMessage(resolvedUrls);
  if (resolvedUrls.length > 0) {
    console.log(`[observer] Resolved ${resolvedUrls.length} URL(s) from prompt`);
    for (const block of buildUrlContextPreview(resolvedUrls)) {
      console.log(`[observer] URL context preview >>>\n${block}\n<<< [end url context preview]`);
    }
  }
  if (urlContextMessage) {
    console.log(`[observer] ${activeModel} urlContextMessage head >>>\n${urlContextMessage.slice(0, 700)}\n<<< [end urlContext head]`);
  }
  const activeMessages: ChatMessage[] = [
    ...activeContext.messages,
    ...(urlContextMessage ? [{ role: 'system' as const, content: urlContextMessage }] : []),
    { role: 'user', content: prompt.trim() },
  ];
  const contextDebugByModel: Record<string, ContextDebugInfo> = {
    [activeModel]: {
      model: activeModel,
      budget: { maxTokens: 0, reserveForResponse: 0, reserveForSystem: 0, available: 0 },
      contextTokens: activeContext.tokenEstimate,
      promptTokens: prompt.trim().length,
      totalTokens: activeContext.tokenEstimate + prompt.trim().length,
      breakdown: activeContext.breakdown,
      documents: activeContext.documents,
      memoryInjection: activeContext.memoryInjection ?? null,
    },
  };
  sseWrite(res, JSON.stringify({ type: 'context_debug', sessionId: session.id, byModel: contextDebugByModel }));
  const activeThinking = (thinking?.[activeModel] ?? undefined) as ThinkingConfig | undefined;

  let activeContent = '';
  let activeError: string | null = null;
  let activeStopReason: string | null = null;
  let activeChunkCount = 0;
  let activeContentChars = 0;
  let activeThinkingChars = 0;
  let firstContentChunk: string | null = null;
  let accumulatedThinking = '';
  const streamStartedAt = Date.now();

  try {
    for await (const chunk of streamSingleWithTimeout(activeModel, activeMessages, activeThinking, { maxTokens: LONG_FORM_OUTPUT_MAX_TOKENS })) {
      activeChunkCount += 1;
      if ((chunk as any).timeoutReason) {
        sseWrite(res, JSON.stringify({ type: 'stream_timeout', model: activeModel, reason: (chunk as any).timeoutReason }));
      }
      if (chunk.error) {
        activeError = chunk.error;
      }
      if (chunk.stopReason) {
        activeStopReason = chunk.stopReason;
      }
      if (!firstContentChunk && chunk.content) {
        firstContentChunk = chunk.content;
      }
      activeContent += chunk.content;
      if (chunk.thinkingContent) {
        accumulatedThinking += chunk.thinkingContent;
      }
      activeContentChars += chunk.content.length;
      activeThinkingChars += chunk.thinkingContent?.length ?? 0;
      let outboundChunk = chunk;
      if (chunk.done) {
        const computed = computeUsageEvent({
          sessionId: session.id,
          provider: chunk.provider,
          model: activeModel,
          mode: 'observer',
          startedAt: streamStartedAt,
          completedAt: Date.now(),
          requestMessages: activeMessages,
          content: activeContent,
          thinkingContent: accumulatedThinking,
          usage: chunk.usage,
        });
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
      sseWrite(res, JSON.stringify(outboundChunk));
    }
  } catch (error) {
    console.error(`[observer] ${activeModel} stream crashed`, {
      sessionId: session.id,
      chunkCount: activeChunkCount,
      contentChars: activeContentChars,
      thinkingChars: activeThinkingChars,
      error: error instanceof Error ? error.message : String(error),
    });
    sseWrite(res, JSON.stringify({
      type: 'stream_debug',
      target: 'observer',
      model: activeModel,
      phase: 'exception',
      chunkCount: activeChunkCount,
      contentChars: activeContentChars,
      thinkingChars: activeThinkingChars,
      error: error instanceof Error ? error.message : String(error),
      note: 'Observer stream threw before a visible assistant response was finalized.',
    }));
    sseWrite(res, JSON.stringify({ model: activeModel, done: true, error: error instanceof Error ? error.message : String(error) }));
    sseWrite(res, '[DONE]');
    res.end();
    return;
  }

  console.log(`[observer] ${activeModel} stream finished`, {
    sessionId: session.id,
    chunkCount: activeChunkCount,
    contentChars: activeContentChars,
    thinkingChars: activeThinkingChars,
    stopReason: activeStopReason,
    error: activeError,
    hasVisibleContent: Boolean(activeContent.trim()),
  });
  if (firstContentChunk !== null) {
    console.log(`[observer] ${activeModel} first content chunk >>>\n${firstContentChunk}\n<<< [end first chunk]`);
  }
  if (activeContent.trim()) {
    const preview = buildContentPreview(activeContent);
    console.log(`[observer] ${activeModel} activeContent preview (head) >>>\n${preview.head}\n<<< [end head]`);
    console.log(`[observer] ${activeModel} activeContent preview (tail) >>>\n${preview.tail}\n<<< [end tail]`);
  }
  sseWrite(res, JSON.stringify({
    type: 'stream_debug',
    target: 'observer',
    model: activeModel,
    phase: activeContent.trim() ? 'complete' : 'empty',
    chunkCount: activeChunkCount,
    contentChars: activeContentChars,
    thinkingChars: activeThinkingChars,
    stopReason: activeStopReason,
    error: activeError,
    note: activeContent.trim()
      ? 'Observer stream completed with visible assistant content.'
      : 'Observer stream completed without visible assistant content.',
  }));

  if (!activeContent.trim()) {
    sseWrite(res, JSON.stringify({
      model: activeModel,
      done: true,
      error: activeError || 'The active model returned an empty response.',
      ...(activeStopReason ? { stopReason: activeStopReason } : {}),
    }));
    for (const observerModel of cleanObservers) {
      const snapshot = saveObserverSnapshot({
        sessionId: session.id,
        model: observerModel,
        activeModel,
        userMessageId: userMessage.id,
        activeMessageId: userMessage.id,
        summary: activeError
          ? `The latest answer from the active model failed: ${activeError}`
          : 'The latest answer from the active model was empty or missing.',
        risks: [activeError || 'No actual answer content was generated.'],
        disagreements: [],
        suggestedFollowUp: 'Retry the response or regenerate it with a clearer instruction.',
        status: 'error',
        error: activeError || 'Active model returned an empty response.',
        capturedAt: Date.now(),
      });
      sseWrite(res, JSON.stringify({ type: 'observer_snapshot', snapshot }));
    }
    sseWrite(res, '[DONE]');
    res.end();
    return;
  }

  const provider = modelRegistry.getById(activeModel)?.provider ?? 'openai';
  const activeUsage = computeUsageEvent({
    sessionId: session.id,
    provider,
    model: activeModel,
    mode: 'observer',
    startedAt: streamStartedAt,
    completedAt: Date.now(),
    requestMessages: activeMessages,
    content: activeContent,
    thinkingContent: accumulatedThinking,
  });
  const activeMessage = saveMessage(session.id, 'assistant', activeContent, activeModel, {
    mode: 'observer',
    usage: {
      promptTokens: activeUsage.promptTokens,
      completionTokens: activeUsage.completionTokens,
      reasoningTokens: activeUsage.reasoningTokens,
      cachedTokens: activeUsage.cachedTokens,
    },
    estimatedCostUsd: activeUsage.estimatedCostUsd,
    pricingSource: activeUsage.pricingSource,
  });
  recordUsageEvent({
    sessionId: session.id,
    messageId: activeMessage.id,
    provider,
    model: activeModel,
    mode: 'observer',
    startedAt: streamStartedAt,
    completedAt: Date.now(),
    requestMessages: activeMessages,
    content: activeContent,
    thinkingContent: accumulatedThinking,
    usage: {
      promptTokens: activeUsage.promptTokens,
      completionTokens: activeUsage.completionTokens,
      reasoningTokens: activeUsage.reasoningTokens,
      cachedTokens: activeUsage.cachedTokens,
      totalTokens: activeUsage.totalTokens,
    },
  });
  void Promise.resolve().then(() => {
    try {
      runMemoryPipelineForMessage(session.id, userMessage.id, 'auto_post_response');
      runMemoryPipelineForMessage(session.id, activeMessage.id, 'auto_post_response');
    } catch (err: any) {
      console.warn('[observer/stream] Memory pipeline failed:', err.message);
    }
  });

  for (const observerModel of cleanObservers) {
    try {
      sseWrite(res, JSON.stringify({ type: 'observer_status', model: observerModel, status: 'syncing' }));
      const observerContext = buildSessionContext(session.id, observerModel);
      const { content, error } = await collectSingle(observerModel, [
        ...observerContext.messages,
        { role: 'user', content: buildSnapshotPrompt(activeModel, activeContent) },
      ]);

      const parsed = safeParseSnapshot(content);
      const snapshot = saveObserverSnapshot({
        sessionId: session.id,
        model: observerModel,
        activeModel,
        userMessageId: userMessage.id,
        activeMessageId: activeMessage.id,
        summary: parsed.summary,
        risks: parsed.risks,
        disagreements: parsed.disagreements,
        suggestedFollowUp: parsed.suggestedFollowUp,
        status: error ? 'error' : 'ready',
        error: error ?? null,
        capturedAt: Date.now(),
      });
      sseWrite(res, JSON.stringify({ type: 'observer_snapshot', snapshot }));
    } catch (error) {
      const snapshot = saveObserverSnapshot({
        sessionId: session.id,
        model: observerModel,
        activeModel,
        userMessageId: userMessage.id,
        activeMessageId: activeMessage.id,
        summary: 'Observer snapshot failed.',
        risks: [],
        disagreements: [],
        suggestedFollowUp: null,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        capturedAt: Date.now(),
      });
      sseWrite(res, JSON.stringify({ type: 'observer_snapshot', snapshot }));
    }
  }

  sseWrite(res, '[DONE]');
  res.end();
});

router.post('/retry-stream', async (req: Request, res: Response) => {
  const {
    sessionId,
    activeModel,
    observerModels,
    thinking,
    continuationFrom,
    richOutput,
  }: ObserverTurnRequest & { continuationFrom?: string; richOutput?: boolean } = req.body;
  if (!sessionId || !activeModel) {
    res.status(400).json({ error: 'sessionId and activeModel are required' });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const allMessages = getSessionMessages(sessionId);
  const latestUserIndex = [...allMessages].map((m, i) => ({ m, i })).reverse().find(({ m }) => m.role === 'user')?.i;
  if (latestUserIndex === undefined) {
    res.status(400).json({ error: 'No prior user prompt found to retry' });
    return;
  }

  const prompt = allMessages[latestUserIndex].content;
  const historyMessages = allMessages.slice(0, latestUserIndex).map((m) => ({ role: m.role, content: m.content })) as ChatMessage[];
  const existingObserverConfig = getObserverConfig(sessionId);
  const cleanObservers = sanitizeObserverModels(activeModel, observerModels ?? existingObserverConfig?.observerModels ?? []);

  setupSSE(res);
  sseWrite(res, JSON.stringify({ type: 'session', sessionId }));

  const effectivePrompt = richOutput && continuationFrom?.trim()
    ? buildStructuredContinuationPrompt(continuationFrom)
    : prompt;
  const resolvedUrls = await resolveUrlsFromPrompt(prompt);
  const urlContextMessage = buildUrlContextMessage(resolvedUrls);
  if (resolvedUrls.length > 0) {
    console.log(`[observer/retry] Resolved ${resolvedUrls.length} URL(s) from prompt`);
    for (const block of buildUrlContextPreview(resolvedUrls)) {
      console.log(`[observer/retry] URL context preview >>>\n${block}\n<<< [end url context preview]`);
    }
  }
  if (urlContextMessage) {
    console.log(`[observer/retry] ${activeModel} urlContextMessage head >>>\n${urlContextMessage.slice(0, 700)}\n<<< [end urlContext head]`);
  }
  const activeMessages: ChatMessage[] = [
    ...historyMessages,
    ...(urlContextMessage ? [{ role: 'system' as const, content: urlContextMessage }] : []),
    { role: 'user', content: effectivePrompt },
  ];
  const activeThinking = (thinking?.[activeModel] ?? undefined) as ThinkingConfig | undefined;
  let activeContent = '';
  let activeError: string | null = null;
  let activeStopReason: string | null = null;
  let activeChunkCount = 0;
  let activeContentChars = 0;
  let activeThinkingChars = 0;
  let firstContentChunk: string | null = null;
  let accumulatedThinking = '';
  const streamStartedAt = Date.now();

  try {
    for await (const chunk of streamSingleWithTimeout(activeModel, activeMessages, activeThinking, { maxTokens: LONG_FORM_OUTPUT_MAX_TOKENS })) {
      activeChunkCount += 1;
      if ((chunk as any).timeoutReason) {
        sseWrite(res, JSON.stringify({ type: 'stream_timeout', model: activeModel, reason: (chunk as any).timeoutReason }));
      }
      if (chunk.error) {
        activeError = chunk.error;
      }
      if (chunk.stopReason) {
        activeStopReason = chunk.stopReason;
      }
      if (!firstContentChunk && chunk.content) {
        firstContentChunk = chunk.content;
      }
      activeContent += chunk.content;
      if (chunk.thinkingContent) {
        accumulatedThinking += chunk.thinkingContent;
      }
      activeContentChars += chunk.content.length;
      activeThinkingChars += chunk.thinkingContent?.length ?? 0;
      let outboundChunk = chunk;
      if (chunk.done) {
        const computed = computeUsageEvent({
          sessionId,
          provider: chunk.provider,
          model: activeModel,
          mode: 'observer',
          startedAt: streamStartedAt,
          completedAt: Date.now(),
          requestMessages: activeMessages,
          content: activeContent,
          thinkingContent: accumulatedThinking,
          usage: chunk.usage,
        });
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
      sseWrite(res, JSON.stringify(outboundChunk));
    }
  } catch (error) {
    console.error(`[observer/retry] ${activeModel} stream crashed`, {
      sessionId,
      chunkCount: activeChunkCount,
      contentChars: activeContentChars,
      thinkingChars: activeThinkingChars,
      error: error instanceof Error ? error.message : String(error),
    });
    sseWrite(res, JSON.stringify({
      type: 'stream_debug',
      target: 'observer',
      model: activeModel,
      phase: 'exception',
      chunkCount: activeChunkCount,
      contentChars: activeContentChars,
      thinkingChars: activeThinkingChars,
      error: error instanceof Error ? error.message : String(error),
      note: 'Observer retry stream threw before a visible assistant response was finalized.',
    }));
    sseWrite(res, JSON.stringify({ model: activeModel, done: true, error: error instanceof Error ? error.message : String(error) }));
    sseWrite(res, '[DONE]');
    res.end();
    return;
  }

  console.log(`[observer/retry] ${activeModel} stream finished`, {
    sessionId,
    chunkCount: activeChunkCount,
    contentChars: activeContentChars,
    thinkingChars: activeThinkingChars,
    stopReason: activeStopReason,
    error: activeError,
    hasVisibleContent: Boolean(activeContent.trim()),
  });
  if (firstContentChunk !== null) {
    console.log(`[observer/retry] ${activeModel} first content chunk >>>\n${firstContentChunk}\n<<< [end first chunk]`);
  }
  if (activeContent.trim()) {
    const preview = buildContentPreview(activeContent);
    console.log(`[observer/retry] ${activeModel} activeContent preview (head) >>>\n${preview.head}\n<<< [end head]`);
    console.log(`[observer/retry] ${activeModel} activeContent preview (tail) >>>\n${preview.tail}\n<<< [end tail]`);
  }
  sseWrite(res, JSON.stringify({
    type: 'stream_debug',
    target: 'observer',
    model: activeModel,
    phase: activeContent.trim() ? 'complete' : 'empty',
    chunkCount: activeChunkCount,
    contentChars: activeContentChars,
    thinkingChars: activeThinkingChars,
    stopReason: activeStopReason,
    error: activeError,
    note: activeContent.trim()
      ? 'Observer retry completed with visible assistant content.'
      : 'Observer retry completed without visible assistant content.',
  }));

  const latestUserMessage = allMessages[latestUserIndex];

  if (!activeContent.trim()) {
    sseWrite(res, JSON.stringify({
      model: activeModel,
      done: true,
      error: activeError || 'The active model returned an empty response.',
      ...(activeStopReason ? { stopReason: activeStopReason } : {}),
    }));
    for (const observerModel of cleanObservers) {
      const snapshot = saveObserverSnapshot({
        sessionId,
        model: observerModel,
        activeModel,
        userMessageId: latestUserMessage.id,
        activeMessageId: latestUserMessage.id,
        summary: activeError
          ? `The latest answer from the active model failed: ${activeError}`
          : 'The latest answer from the active model was empty or missing.',
        risks: [activeError || 'No actual answer content was generated.'],
        disagreements: [],
        suggestedFollowUp: 'Retry the response or regenerate it with a clearer instruction.',
        status: 'error',
        error: activeError || 'Active model returned an empty response.',
        capturedAt: Date.now(),
      });
      sseWrite(res, JSON.stringify({ type: 'observer_snapshot', snapshot }));
    }
    sseWrite(res, '[DONE]');
    res.end();
    return;
  }

  const providerRetry = modelRegistry.getById(activeModel)?.provider ?? 'openai';
  const retryUsage = computeUsageEvent({
    sessionId,
    provider: providerRetry,
    model: activeModel,
    mode: 'observer',
    startedAt: streamStartedAt,
    completedAt: Date.now(),
    requestMessages: activeMessages,
    content: activeContent,
    thinkingContent: accumulatedThinking,
  });
  const activeMessage = saveMessage(sessionId, 'assistant', activeContent, activeModel, {
    mode: 'observer',
    usage: {
      promptTokens: retryUsage.promptTokens,
      completionTokens: retryUsage.completionTokens,
      reasoningTokens: retryUsage.reasoningTokens,
      cachedTokens: retryUsage.cachedTokens,
    },
    estimatedCostUsd: retryUsage.estimatedCostUsd,
    pricingSource: retryUsage.pricingSource,
  });
  recordUsageEvent({
    sessionId,
    messageId: activeMessage.id,
    provider: providerRetry,
    model: activeModel,
    mode: 'observer',
    startedAt: streamStartedAt,
    completedAt: Date.now(),
    requestMessages: activeMessages,
    content: activeContent,
    thinkingContent: accumulatedThinking,
    usage: {
      promptTokens: retryUsage.promptTokens,
      completionTokens: retryUsage.completionTokens,
      reasoningTokens: retryUsage.reasoningTokens,
      cachedTokens: retryUsage.cachedTokens,
      totalTokens: retryUsage.totalTokens,
    },
  });
  void Promise.resolve().then(() => {
    try {
      runMemoryPipelineForMessage(sessionId, latestUserMessage.id, 'auto_post_response');
      runMemoryPipelineForMessage(sessionId, activeMessage.id, 'auto_post_response');
    } catch (err: any) {
      console.warn('[observer/retry-stream] Memory pipeline failed:', err.message);
    }
  });

  for (const observerModel of cleanObservers) {
    try {
      sseWrite(res, JSON.stringify({ type: 'observer_status', model: observerModel, status: 'syncing' }));
      const observerContext = buildSessionContext(sessionId, observerModel);
      const { content, error } = await collectSingle(observerModel, [
        ...observerContext.messages,
        { role: 'user', content: buildSnapshotPrompt(activeModel, activeContent) },
      ]);
      const parsed = safeParseSnapshot(content);
      const snapshot = saveObserverSnapshot({
        sessionId,
        model: observerModel,
        activeModel,
        userMessageId: latestUserMessage.id,
        activeMessageId: activeMessage.id,
        summary: parsed.summary,
        risks: parsed.risks,
        disagreements: parsed.disagreements,
        suggestedFollowUp: parsed.suggestedFollowUp,
        status: error ? 'error' : 'ready',
        error: error ?? null,
        capturedAt: Date.now(),
      });
      sseWrite(res, JSON.stringify({ type: 'observer_snapshot', snapshot }));
    } catch (error) {
      const snapshot = saveObserverSnapshot({
        sessionId,
        model: observerModel,
        activeModel,
        userMessageId: latestUserMessage.id,
        activeMessageId: activeMessage.id,
        summary: 'Observer snapshot failed.',
        risks: [],
        disagreements: [],
        suggestedFollowUp: null,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        capturedAt: Date.now(),
      });
      sseWrite(res, JSON.stringify({ type: 'observer_snapshot', snapshot }));
    }
  }

  sseWrite(res, '[DONE]');
  res.end();
});

router.post('/:sessionId/:action', async (req, res) => {
  const action = String(req.params.action) as ObserverActionRequest['action'];
  if (!['review', 'alternative', 'synthesize'].includes(action)) {
    res.status(400).json({ error: 'Unsupported observer action' });
    return;
  }

  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const model = String(req.body.model ?? '').trim();
  if (!model || !modelRegistry.getById(model)) {
    res.status(400).json({ error: 'Valid model is required' });
    return;
  }

  const messages = buildSessionContext(session.id, model).messages;
  const activeModel = session.activeModel ?? model;
  const latestActive = [...getSessionMessages(session.id)]
    .reverse()
    .find((message) => message.role === 'assistant' && message.sourceModel === activeModel && message.mode === 'observer');

  if (!latestActive) {
    res.status(400).json({ error: 'No active answer available to review' });
    return;
  }

  const prompt = buildObserverActionPrompt(
    action,
    activeModel,
    latestActive.content,
    listObserverSnapshots(session.id),
    typeof req.body.instruction === 'string' ? req.body.instruction : undefined,
  );

  const result = await collectSingle(model, [
    ...messages,
    { role: 'user', content: prompt },
  ]);

  if (result.error && !result.content) {
    res.status(500).json({ error: result.error });
    return;
  }

  const mode =
    action === 'review'
      ? 'observer_review'
      : action === 'alternative'
        ? 'observer_alternative'
        : 'observer_synthesize';
  const message = saveMessage(session.id, 'assistant', result.content, model, { mode });
  res.status(201).json({ sessionId: session.id, model, action, messageId: message.id });
});

export default router;
