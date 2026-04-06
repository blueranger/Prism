import { useChatStore } from '@/stores/chat-store';
import type { AgentPlanStep } from '@/stores/chat-store';
import type { TimelineEntry, AgentTask, FlowGraph, ObserverConfig, ObserverSnapshot, Session, SessionLink, Decision, DecisionType, ClassificationResult, ConnectorStatus, ExternalThread, ExternalMessage, DraftReply, SenderLearningStats, MonitorRule, MonitorRuleConditions, MonitorAction, MonitorRuleActionConfig, CommProvider, UploadedFile, CreateActionRequest, ActionStatus, UrlPreview, WebPagePreviewResponse, WebPageRef, ContextDebugInfo, ChatGPTSyncConversation, ClaudeSyncConversation, GeminiSyncConversation, ImportProjectTarget, ImportProgress, KBSessionBootstrapRequest, KBSessionBootstrapResponse, ObserverActionType, SessionBootstrapRecord, ManualPreviewRequest, RichPreviewArtifact, MemoryCandidate, MemoryGraphEdge, MemoryGraphNode, MemoryItem, MemoryTimelineEvent, MemoryType, MemoryExtractionRun, MemoryExtractionRunItem, MemoryUsageRun, MemoryUsageRunItem, WorkingMemoryItem, MemoryInjectionPreview, TriggerCandidate, TriggerNotification, TriggerRule, TriggerRun, RelationshipEvidence, LLMCostSummary, LLMUsageEvent, ProviderCostRecord } from '@prism/shared';
import type { ImportSyncRun } from '@prism/shared';
import { MODELS } from '@prism/shared';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const SOFT_STALL_MS = 20_000;
const HARD_STALL_MS = 45_000;
let activeStreamAbortController: AbortController | null = null;
let activeStallTimer: ReturnType<typeof setInterval> | null = null;

function clearActiveStreamWatch() {
  if (activeStallTimer) {
    clearInterval(activeStallTimer);
    activeStallTimer = null;
  }
  activeStreamAbortController = null;
}

function startActiveStreamWatch(
  target: 'observer' | 'parallel' | 'compare' | 'synthesize' | 'handoff',
  models: string[],
  controller: AbortController,
) {
  clearActiveStreamWatch();
  activeStreamAbortController = controller;
  activeStallTimer = setInterval(() => {
    const store = useChatStore.getState();
    const responseMap =
      target === 'observer'
        ? store.observerResponses
        : target === 'compare'
        ? store.compareResponses
        : target === 'synthesize'
          ? store.synthesizeResponses
          : target === 'handoff'
            ? store.handoffResponses
            : store.parallelResponses;
    const now = Date.now();
    for (const model of models) {
      const resp = responseMap[model];
      if (!resp || resp.done) continue;
      const lastChunkAt = resp.lastChunkAt ?? now;
      const idleFor = now - lastChunkAt;
      if (idleFor >= SOFT_STALL_MS && resp.streamStatus !== 'stalled') {
        store.markStalled(model, { target, retryable: false });
      }
      if (target !== 'parallel' && idleFor >= HARD_STALL_MS) {
        store.markStalled(model, {
          target,
          retryable: true,
          partialRetained: Boolean(resp.content),
          error: 'Streaming stalled',
        });
      }
    }
  }, 1000);
}

/**
 * Parse an SSE stream and dispatch chunks to the store.
 */
async function consumeSSE(response: Response) {
  const store = useChatStore.getState();

  if (!response.ok || !response.body) {
    console.error('[consumeSSE] Bad response:', response.status, response.statusText);
    // Try to read error body
    try {
      const errData = await response.json();
      const errMsg = errData?.error ?? `HTTP ${response.status}`;
      const targetResponses =
        store.activeStreamTarget === 'observer'
          ? store.observerResponses
          : store.activeStreamTarget === 'compare'
          ? store.compareResponses
          : store.activeStreamTarget === 'synthesize'
            ? store.synthesizeResponses
            : store.activeStreamTarget === 'handoff'
              ? store.handoffResponses
              : store.parallelResponses;
      // Mark all streaming models as errored
      for (const key of Object.keys(targetResponses)) {
        if (!targetResponses[key].done) {
          store.markDone(key, errMsg);
        }
      }
    } catch {
      // Can't parse error body
    }
    clearActiveStreamWatch();
    store.finishStreaming();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalChunks = 0;

  console.log('[consumeSSE] Starting to read SSE stream');

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      console.log(`[consumeSSE] Stream reader done after ${totalChunks} chunks`);
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();

      if (data === '[DONE]') {
        console.log(`[consumeSSE] [DONE] received, ${totalChunks} chunks processed`);
        const latestStore = useChatStore.getState();
        const targetResponses =
          latestStore.activeStreamTarget === 'observer'
            ? latestStore.observerResponses
            : latestStore.activeStreamTarget === 'compare'
            ? latestStore.compareResponses
            : latestStore.activeStreamTarget === 'synthesize'
              ? latestStore.synthesizeResponses
              : latestStore.activeStreamTarget === 'handoff'
                ? latestStore.handoffResponses
                : latestStore.parallelResponses;
        for (const key of Object.keys(targetResponses)) {
          const response = targetResponses[key];
          const shouldForceComplete =
            !response.done ||
            (
              response.streamStatus === 'stalled' &&
              Boolean(response.content) &&
              !response.stopReason &&
              (!response.error || /streaming stalled/i.test(response.error))
            );
          if (shouldForceComplete) {
            store.markDone(key, undefined, {
              promptTokens: response.promptTokens,
              completionTokens: response.completionTokens,
              reasoningTokens: response.reasoningTokens,
              cachedTokens: response.cachedTokens,
              estimatedCostUsd: response.estimatedCostUsd,
              pricingSource: response.pricingSource,
            });
          }
        }
        clearActiveStreamWatch();
        latestStore.finishStreaming();
        // Refresh timeline after streaming completes
        if (latestStore.sessionId) {
          void fetchTimeline(latestStore.sessionId);
        }
        return;
      }

      try {
        const parsed = JSON.parse(data);
        totalChunks++;

        if (totalChunks <= 3) {
          console.log(`[consumeSSE] chunk #${totalChunks}:`, JSON.stringify(parsed).slice(0, 120));
        }

        if (parsed.type === 'session') {
          store.setSessionId(parsed.sessionId);
          continue;
        }

        if (parsed.type === 'context_debug') {
          store.setLastContextDebug((parsed.byModel ?? null) as Record<string, ContextDebugInfo> | null);
          continue;
        }

        if (parsed.type === 'handoff' || parsed.type === 'compare_start' || parsed.type === 'synthesize_start') {
          if (parsed.type === 'compare_start' && parsed.originContent) {
            store.setCompareOrigin(parsed.originModel, parsed.originContent);
          }
          continue;
        }

        if (parsed.type === 'observer_status' && parsed.model && parsed.status) {
          store.setObserverStatus(parsed.model, parsed.status);
          continue;
        }

        if (parsed.type === 'observer_snapshot' && parsed.snapshot) {
          store.upsertObserverSnapshot(parsed.snapshot as ObserverSnapshot);
          continue;
        }

        if (parsed.type === 'stream_debug' && parsed.model) {
          store.setResponseDebug(parsed.model, {
            chunkCount: parsed.chunkCount,
            contentChars: parsed.contentChars,
            thinkingChars: parsed.thinkingChars,
            stopReason: parsed.stopReason,
            providerError: parsed.error,
            lastEvent: parsed.phase,
            note: parsed.note,
          }, parsed.target ?? store.activeStreamTarget ?? 'parallel');
          continue;
        }

        if (parsed.type === 'stream_timeout' && parsed.model) {
          store.markStalled(parsed.model, {
            target: store.activeStreamTarget ?? 'parallel',
            retryable: true,
            partialRetained: true,
            error: parsed.reason === 'idle_timeout' ? 'Streaming stalled' : 'Request timed out',
          });
          continue;
        }

        if (parsed.error && !parsed.model) {
          console.error('[consumeSSE] Global error:', parsed.error);
          const targetResponses =
            store.activeStreamTarget === 'observer'
              ? store.observerResponses
              : store.activeStreamTarget === 'compare'
              ? store.compareResponses
              : store.activeStreamTarget === 'synthesize'
                ? store.synthesizeResponses
                : store.activeStreamTarget === 'handoff'
                  ? store.handoffResponses
                  : store.parallelResponses;
          for (const key of Object.keys(targetResponses)) {
            if (!targetResponses[key].done) {
              store.markDone(key, parsed.error);
            }
          }
          clearActiveStreamWatch();
          store.finishStreaming();
          return;
        }

        if (parsed.done) {
          console.log(`[consumeSSE] ${parsed.model} done (error=${parsed.error ?? 'none'})`);
          store.markDone(parsed.model, parsed.error, {
            stopReason: parsed.stopReason,
            promptTokens: parsed.usage?.promptTokens,
            completionTokens: parsed.usage?.completionTokens,
            reasoningTokens: parsed.usage?.reasoningTokens,
            cachedTokens: parsed.usage?.cachedTokens,
            estimatedCostUsd: parsed.estimatedCostUsd,
            pricingSource: parsed.pricingSource,
          });
        } else if (parsed.thinkingContent) {
          // Thinking / chain-of-thought content — streamed separately
          store.appendThinkingChunk(parsed.model, parsed.thinkingContent);
        } else if (parsed.content) {
          store.appendChunk(parsed.model, parsed.content);
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  console.log('[consumeSSE] Reader loop ended, calling finishStreaming');
  clearActiveStreamWatch();
  store.finishStreaming();
}

/**
 * Send a prompt to multiple models in parallel (Phase 1 flow, now with context).
 */
export async function streamPrompt(prompt: string) {
  const store = useChatStore.getState();
  const { selectedModels, sessionId, thinkingConfig } = store;

  if (selectedModels.length === 0) return;

  store.startStreaming();
  store.setLastParallelPrompt(prompt);

  // Only include thinking config for models that have it enabled
  const activeThinking: Record<string, any> = {};
  for (const model of selectedModels) {
    const tc = thinkingConfig[model];
    if (tc?.enabled) {
      activeThinking[model] = tc;
    }
  }

  try {
    const controller = new AbortController();
    startActiveStreamWatch('parallel', selectedModels, controller);
    const response = await fetch(`${API_BASE}/api/prompt/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        prompt,
        models: selectedModels,
        sessionId,
        ...(Object.keys(activeThinking).length > 0 && { thinking: activeThinking }),
      }),
    });

    await consumeSSE(response);
  } catch (err: any) {
    console.error('[streamPrompt] fetch error:', err);
    clearActiveStreamWatch();
    // Mark all models as errored so UI doesn't stay stuck
    for (const model of selectedModels) {
      if (err?.name === 'AbortError') {
        store.markStalled(model, { target: 'parallel', retryable: true, partialRetained: true, error: 'Streaming stalled' });
      } else {
        store.markDone(model, `Connection failed: ${err.message ?? 'Network error'}`);
      }
    }
    store.finishStreaming();
  }
}

export async function streamObserver(prompt: string) {
  const store = useChatStore.getState();
  const { sessionId, observerActiveModel, observerModels, thinkingConfig } = store;

  if (!observerActiveModel) return;

  const activeThinking: Record<string, any> = {};
  for (const model of [observerActiveModel, ...observerModels]) {
    const tc = thinkingConfig[model];
    if (tc?.enabled) {
      activeThinking[model] = tc;
    }
  }

  store.startStreamingFor([observerActiveModel], 'observer');
  store.setLastObserverPrompt(prompt);
  observerModels.forEach((model) => store.setObserverStatus(model, 'syncing'));

  try {
    const controller = new AbortController();
    startActiveStreamWatch('observer', [observerActiveModel], controller);
    const response = await fetch(`${API_BASE}/api/observer/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        prompt,
        sessionId,
        activeModel: observerActiveModel,
        observerModels,
        ...(Object.keys(activeThinking).length > 0 && { thinking: activeThinking }),
      }),
    });

    await consumeSSE(response);
  } catch (err: any) {
    clearActiveStreamWatch();
    if (err?.name === 'AbortError') {
      store.markStalled(observerActiveModel, { target: 'observer', retryable: true, partialRetained: true, error: 'Streaming stalled' });
    } else {
      store.markDone(observerActiveModel, `Connection failed: ${err.message ?? 'Network error'}`);
    }
    observerModels.forEach((model) => store.setObserverStatus(model, 'error'));
    store.finishStreaming();
  }
}

export async function fetchUrlPreviews(prompt: string): Promise<UrlPreview[]> {
  try {
    const response = await fetch(`${API_BASE}/api/prompt/url-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.previews ?? [];
  } catch {
    return [];
  }
}

export async function fetchWebContextPreview(url: string): Promise<WebPagePreviewResponse | null> {
  try {
    const response = await fetch(`${API_BASE}/api/web-context/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function attachWebPages(sessionId: string, rootUrl: string, selectedUrls: string[]): Promise<WebPageRef[]> {
  try {
    const response = await fetch(`${API_BASE}/api/web-context/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, rootUrl, selectedUrls }),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.pages ?? [];
  } catch {
    return [];
  }
}

export async function fetchWebContext(sessionId: string): Promise<WebPageRef[]> {
  try {
    const response = await fetch(`${API_BASE}/api/web-context/session/${sessionId}`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.pages ?? [];
  } catch {
    return [];
  }
}

export async function deleteWebPageAttachment(id: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/web-context/${id}`, { method: 'DELETE' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Perform a handoff: send context from one model to another.
 */
export async function streamHandoff(instruction?: string) {
  const store = useChatStore.getState();
  const { sessionId, handoffFromModel, handoffToModel } = store;

  if (!sessionId || !handoffFromModel || !handoffToModel) return;

  store.startHandoffStreaming(handoffToModel);
  store.setLastHandoffInstruction(instruction ?? null);

  try {
    const controller = new AbortController();
    startActiveStreamWatch('handoff', [handoffToModel], controller);
    const response = await fetch(`${API_BASE}/api/handoff/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        sessionId,
        fromModel: handoffFromModel,
        toModel: handoffToModel,
        instruction: instruction || undefined,
      }),
    });

    await consumeSSE(response);
  } catch (err: any) {
    clearActiveStreamWatch();
    if (err?.name === 'AbortError') {
      store.markStalled(handoffToModel, { target: 'handoff', retryable: true, partialRetained: true, error: 'Streaming stalled' });
    } else {
      store.markDone(handoffToModel, `Connection failed: ${err.message ?? 'Network error'}`);
    }
    store.finishStreaming();
  }
}

/**
 * Compare mode: send origin model's response to critic models for evaluation.
 */
export async function streamCompare(
  originModel: string,
  criticModels: string[],
  instruction?: string
) {
  const store = useChatStore.getState();
  const { sessionId } = store;

  if (!sessionId || criticModels.length === 0) return;

  store.startStreamingFor(criticModels, 'compare');
  store.setLastCompareRequest({ originModel, criticModels, instruction: instruction || undefined });

  try {
    const controller = new AbortController();
    startActiveStreamWatch('compare', criticModels, controller);
    const response = await fetch(`${API_BASE}/api/compare/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        sessionId,
        originModel,
        criticModels,
        instruction: instruction || undefined,
      }),
    });

    await consumeSSE(response);
  } catch (err: any) {
    clearActiveStreamWatch();
    for (const model of criticModels) {
      if (err?.name === 'AbortError') {
        store.markStalled(model, { target: 'compare', retryable: true, partialRetained: true, error: 'Streaming stalled' });
      } else {
        store.markDone(model, `Connection failed: ${err.message ?? 'Network error'}`);
      }
    }
    store.finishStreaming();
  }
}

/**
 * Synthesize mode: merge responses from multiple models via a synthesizer.
 */
export async function streamSynthesize(
  sourceModels: string[],
  synthesizerModel: string,
  instruction?: string
) {
  const store = useChatStore.getState();
  const { sessionId } = store;

  if (!sessionId || sourceModels.length < 2) return;

  store.startStreamingFor([synthesizerModel], 'synthesize');
  store.setLastSynthesizeRequest({ sourceModels, synthesizerModel, instruction: instruction || undefined });

  try {
    const controller = new AbortController();
    startActiveStreamWatch('synthesize', [synthesizerModel], controller);
    const response = await fetch(`${API_BASE}/api/synthesize/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        sessionId,
        sourceModels,
        synthesizerModel,
        instruction: instruction || undefined,
      }),
    });

    await consumeSSE(response);
  } catch (err: any) {
    clearActiveStreamWatch();
    if (err?.name === 'AbortError') {
      store.markStalled(synthesizerModel, { target: 'synthesize', retryable: true, partialRetained: true, error: 'Streaming stalled' });
    } else {
      store.markDone(synthesizerModel, `Connection failed: ${err.message ?? 'Network error'}`);
    }
    store.finishStreaming();
  }
}

export async function retryModelResponse(
  target: 'observer' | 'parallel' | 'compare' | 'synthesize' | 'handoff',
  model: string,
  options?: {
    continuationFrom?: string;
    richOutput?: boolean;
    auto?: boolean;
  },
) {
  const store = useChatStore.getState();
  const { sessionId, thinkingConfig } = store;
  if (!sessionId) return false;

  if (target === 'parallel') {
    const activeThinking: Record<string, any> = {};
    const tc = thinkingConfig[model];
    if (tc?.enabled) activeThinking[model] = tc;
    store.startStreamingFor([model], 'parallel');
    try {
      const controller = new AbortController();
      startActiveStreamWatch('parallel', [model], controller);
      const response = await fetch(`${API_BASE}/api/prompt/retry-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          sessionId,
          models: [model],
          ...(options?.continuationFrom ? { continuationFrom: options.continuationFrom, richOutput: options.richOutput, autoRetry: options.auto } : {}),
          ...(Object.keys(activeThinking).length > 0 && { thinking: activeThinking }),
        }),
      });
      await consumeSSE(response);
      return true;
    } catch (err: any) {
      clearActiveStreamWatch();
      if (err?.name === 'AbortError') {
        store.markStalled(model, { target: 'parallel', retryable: true, partialRetained: true, error: 'Streaming stalled' });
      } else {
        store.markDone(model, `Connection failed: ${err.message ?? 'Network error'}`);
      }
      store.finishStreaming();
      return false;
    }
  }

  if (target === 'observer') {
    const activeThinking: Record<string, any> = {};
    const tc = thinkingConfig[model];
    if (tc?.enabled) activeThinking[model] = tc;
    store.startStreamingFor([model], 'observer');
    try {
      const controller = new AbortController();
      startActiveStreamWatch('observer', [model], controller);
      const response = await fetch(`${API_BASE}/api/observer/retry-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          sessionId,
          activeModel: model,
          observerModels: store.observerModels,
          ...(options?.continuationFrom ? { continuationFrom: options.continuationFrom, richOutput: options.richOutput, autoRetry: options.auto } : {}),
          ...(Object.keys(activeThinking).length > 0 && { thinking: activeThinking }),
        }),
      });
      await consumeSSE(response);
      return true;
    } catch (err: any) {
      clearActiveStreamWatch();
      if (err?.name === 'AbortError') {
        store.markStalled(model, { target: 'observer', retryable: true, partialRetained: true, error: 'Streaming stalled' });
      } else {
        store.markDone(model, `Connection failed: ${err.message ?? 'Network error'}`);
      }
      store.finishStreaming();
      return false;
    }
  }

  if (target === 'handoff') {
    if (!store.handoffFromModel || !store.handoffToModel) return false;
    store.startHandoffStreaming(store.handoffToModel);
    try {
      const controller = new AbortController();
      startActiveStreamWatch('handoff', [store.handoffToModel], controller);
      const response = await fetch(`${API_BASE}/api/handoff/retry-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          sessionId,
          fromModel: store.handoffFromModel,
          toModel: store.handoffToModel,
          instruction: store.lastHandoffInstruction || undefined,
          ...(options?.continuationFrom ? { continuationFrom: options.continuationFrom, richOutput: options.richOutput, autoRetry: options.auto } : {}),
        }),
      });
      await consumeSSE(response);
      return true;
    } catch (err: any) {
      clearActiveStreamWatch();
      if (err?.name === 'AbortError') {
        store.markStalled(store.handoffToModel, { target: 'handoff', retryable: true, partialRetained: true, error: 'Streaming stalled' });
      } else {
        store.markDone(store.handoffToModel, `Connection failed: ${err.message ?? 'Network error'}`);
      }
      store.finishStreaming();
      return false;
    }
  }

  if (target === 'compare') {
    const req = store.lastCompareRequest;
    if (!req) return false;
    try {
      store.startStreamingFor([model], 'compare');
      const controller = new AbortController();
      startActiveStreamWatch('compare', [model], controller);
      const response = await fetch(`${API_BASE}/api/compare/retry-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          sessionId,
          originModel: req.originModel,
          criticModels: [model],
          instruction: req.instruction,
          ...(options?.continuationFrom ? { continuationFrom: options.continuationFrom, richOutput: options.richOutput, autoRetry: options.auto } : {}),
        }),
      });
      await consumeSSE(response);
      return true;
    } catch (err: any) {
      clearActiveStreamWatch();
      if (err?.name === 'AbortError') {
        store.markStalled(model, { target: 'compare', retryable: true, partialRetained: true, error: 'Streaming stalled' });
      } else {
        store.markDone(model, `Connection failed: ${err.message ?? 'Network error'}`);
      }
      store.finishStreaming();
      return false;
    }
  }

  if (target === 'synthesize') {
    const req = store.lastSynthesizeRequest;
    if (!req || req.synthesizerModel !== model) return false;
    try {
      store.startStreamingFor([model], 'synthesize');
      const controller = new AbortController();
      startActiveStreamWatch('synthesize', [model], controller);
      const response = await fetch(`${API_BASE}/api/synthesize/retry-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          sessionId,
          sourceModels: req.sourceModels,
          synthesizerModel: req.synthesizerModel,
          instruction: req.instruction,
          ...(options?.continuationFrom ? { continuationFrom: options.continuationFrom, richOutput: options.richOutput, autoRetry: options.auto } : {}),
        }),
      });
      await consumeSSE(response);
      return true;
    } catch (err: any) {
      clearActiveStreamWatch();
      if (err?.name === 'AbortError') {
        store.markStalled(model, { target: 'synthesize', retryable: true, partialRetained: true, error: 'Streaming stalled' });
      } else {
        store.markDone(model, `Connection failed: ${err.message ?? 'Network error'}`);
      }
      store.finishStreaming();
      return false;
    }
  }

  return false;
}

/**
 * Fetch the unified timeline for the current session.
 */
export async function fetchTimeline(sessionId: string) {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/timeline`);
    if (!response.ok) return;
    const data = await response.json();
    const store = useChatStore.getState();
    store.setTimeline(data.entries as TimelineEntry[]);
    const session = await fetchSessionApi(sessionId);
    store.setCurrentSession(session);
    if (session?.sessionType === 'topic') {
      store.setTopicActions(await fetchTopicActions(sessionId));
    } else {
      store.setTopicActions([]);
    }
    store.setAttachedWebPages(await fetchWebContext(sessionId));
  } catch {
    // Silently fail — timeline is supplementary
  }
}

/**
 * Restore a session after page refresh.
 *
 * 1. Fetches raw messages from the backend
 * 2. Rebuilds the responses map from the latest assistant messages per model
 * 3. Loads the timeline
 *
 * Returns true if session was restored, false if nothing to restore.
 */
export async function restoreSession(sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`);
    if (!response.ok) return false;
    const data = await response.json();
    const messages: { id: string; role: string; content: string; sourceModel: string; mode?: string; handoffFrom?: string | null }[] = data.messages ?? [];

    if (messages.length === 0) return false;

    const store = useChatStore.getState();
    store.setSessionId(sessionId);
    const session = await fetchSessionApi(sessionId);
    store.setCurrentSession(session);
    if (session?.interactionMode === 'observer') {
      const observerSelection = [
        session.activeModel,
        ...(session.observerModels ?? []),
      ].filter((model): model is string => Boolean(model));
      if (observerSelection.length > 0) {
        store.setSelectedModels(observerSelection);
      }
      store.setObserverConfig(session.activeModel ?? null, session.observerModels ?? []);
      const observerState = await fetchObserverState(sessionId);
      store.setObserverSnapshots(observerState?.snapshots ?? []);
    } else {
      store.setObserverConfig(null, []);
      store.setObserverSnapshots([]);
    }
    if (session?.sessionType === 'topic') {
      store.setTopicActions(await fetchTopicActions(sessionId));
    } else {
      store.setTopicActions([]);
    }
    store.setAttachedWebPages(await fetchWebContext(sessionId));

    // Rebuild responses from the latest assistant messages per provider lane
    const latestByProvider: Record<string, { model: string; content: string; order: number; mode?: string | null; messageId?: string }> = {};
    const latestCompareByModel: Record<string, import('@/stores/chat-store').ModelResponse> = {};
    const latestHandoffByModel: Record<string, import('@/stores/chat-store').ModelResponse> = {};
    const latestSynthesizeByModel: Record<string, import('@/stores/chat-store').ModelResponse> = {};
    let lastSynthesizerModel: string | null = null;
    let lastHandoffFromModel: string | null = null;
    let lastHandoffToModel: string | null = null;
    let latestCompareOriginModel: string | null = null;
    let latestCompareOriginContent: string | null = null;

    messages.forEach((msg, index) => {
      if (msg.role === 'assistant') {
        const provider = MODELS[msg.sourceModel]?.provider ?? msg.sourceModel;
        const current = latestByProvider[provider];
        if (!current || index >= current.order) {
          latestByProvider[provider] = {
            model: msg.sourceModel,
            content: msg.content,
            order: index,
            mode: msg.mode ?? null,
            messageId: msg.id,
          };
        }

        if (msg.mode === 'compare') {
          latestCompareByModel[msg.sourceModel] = {
            model: msg.sourceModel,
            content: msg.content,
            done: true,
            mode: 'compare',
            messageId: msg.id,
            streamStatus: 'completed',
            retryable: false,
            partialRetained: false,
            attempt: 1,
          };
        }

        if (msg.mode === 'handoff') {
          latestHandoffByModel[msg.sourceModel] = {
            model: msg.sourceModel,
            content: msg.content,
            done: true,
            mode: 'handoff',
            messageId: msg.id,
            streamStatus: 'completed',
            retryable: false,
            partialRetained: false,
            attempt: 1,
          };
          lastHandoffToModel = msg.sourceModel;
          lastHandoffFromModel = msg.handoffFrom ?? lastHandoffFromModel;
        }

        if (msg.mode === 'synthesize') {
          latestSynthesizeByModel[msg.sourceModel] = {
            model: msg.sourceModel,
            content: msg.content,
            done: true,
            mode: 'synthesize',
            messageId: msg.id,
            streamStatus: 'completed',
            retryable: false,
            partialRetained: false,
            attempt: 1,
          };
        }

        // Track the most recent synthesize result so we can restore it
        if (msg.mode === 'synthesize') {
          lastSynthesizerModel = msg.sourceModel;
        }
      }
    });

    const compareMessages = messages
      .map((msg, index) => ({ ...msg, order: index }))
      .filter((msg) => msg.role === 'assistant' && msg.mode === 'compare');
    if (compareMessages.length > 0) {
      const firstCompareOrder = compareMessages[0].order;
      const origin = [...messages]
        .slice(0, firstCompareOrder)
        .reverse()
        .find((msg) => msg.role === 'assistant' && msg.mode !== 'compare');
      if (origin) {
        latestCompareOriginModel = origin.sourceModel;
        latestCompareOriginContent = origin.content;
      }
    }

    const responses: Record<string, import('@/stores/chat-store').ModelResponse> = {};
    for (const { model, content, mode, messageId } of Object.values(latestByProvider)) {
      responses[model] = {
        model,
        content,
        done: true,
        mode: mode ?? null,
        messageId,
        streamStatus: 'completed',
        retryable: false,
        partialRetained: false,
        attempt: 1,
      };
    }
    store.clearResponses();
    let observerResponses: Record<string, import('@/stores/chat-store').ModelResponse> = {};
    if (session?.interactionMode === 'observer' && session.activeModel) {
      const latestActiveObserver = [...messages]
        .reverse()
        .find((msg) => msg.role === 'assistant' && msg.sourceModel === session.activeModel && msg.mode === 'observer');
      if (latestActiveObserver) {
        observerResponses = {
          [session.activeModel]: {
            model: session.activeModel,
            content: latestActiveObserver.content,
            done: true,
            mode: latestActiveObserver.mode ?? 'observer',
            messageId: latestActiveObserver.id,
            streamStatus: 'completed',
            retryable: false,
            partialRetained: false,
            attempt: 1,
          },
        };
      }
    }
    // Set responses directly via Zustand set
    useChatStore.setState({
      observerResponses,
      parallelResponses: responses,
      compareResponses: latestCompareByModel,
      synthesizeResponses: latestSynthesizeByModel,
      handoffResponses: latestHandoffByModel,
      activeStreamTarget: null,
      compareOriginModel: latestCompareOriginModel,
      compareOriginContent: latestCompareOriginContent,
      handoffFromModel: lastHandoffFromModel,
      handoffToModel: lastHandoffToModel,
    });

    // Restore synthesizer model if session had a synthesize result
    if (lastSynthesizerModel) {
      store.setSynthesizerModel(lastSynthesizerModel);
    }

    // Also load the timeline
    await fetchTimeline(sessionId);

    return true;
  } catch {
    return false;
  }
}

export async function fetchPreviewArtifact(sessionId: string, messageId: string): Promise<RichPreviewArtifact | null> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages/${messageId}/preview-artifact`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.artifact ?? null;
  } catch {
    return null;
  }
}

export async function savePreviewArtifact(
  sessionId: string,
  messageId: string,
  payload: ManualPreviewRequest,
): Promise<RichPreviewArtifact | null> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages/${messageId}/preview-artifact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.artifact ?? null;
  } catch {
    return null;
  }
}

export async function deletePreviewArtifact(sessionId: string, messageId: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages/${messageId}/preview-artifact`, {
      method: 'DELETE',
    });
    return response.ok;
  } catch {
    return false;
  }
}

// --- Agent APIs ---

/**
 * Fetch the list of registered agents.
 */
export async function fetchAgents(): Promise<{ name: string; description: string; inputSchema: unknown }[]> {
  try {
    const response = await fetch(`${API_BASE}/api/agents`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.agents ?? [];
  } catch {
    return [];
  }
}

/**
 * Execute a single agent directly.
 */
export async function executeAgentDirect(
  sessionId: string,
  agentName: string,
  input: Record<string, unknown>
): Promise<{ taskId: string; result: unknown } | null> {
  try {
    const response = await fetch(`${API_BASE}/api/agents/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, agentName, input }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Execute a plan via the /api/agents/plan SSE endpoint.
 * Streams progress events to the agent store.
 */
export async function streamAgentPlan(
  sessionId: string,
  instruction: string,
  model?: string
) {
  const store = useChatStore.getState();
  store.resetAgentState();
  store.setAgentIsExecuting(true);

  try {
    const response = await fetch(`${API_BASE}/api/agents/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, instruction, model }),
    });

    if (!response.ok || !response.body) {
      store.setAgentIsExecuting(false);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();

        if (data === '[DONE]') {
          store.setAgentIsExecuting(false);
          return;
        }

        try {
          const parsed = JSON.parse(data);

          switch (parsed.type) {
            case 'planning':
              store.setAgentPlanMessage(parsed.message);
              break;

            case 'plan':
              store.setAgentPlanReasoning(parsed.reasoning ?? null);
              store.setAgentPlanSteps(
                (parsed.steps as any[]).map((s) => ({
                  id: s.id,
                  target: s.target,
                  description: s.description,
                  dependsOn: s.dependsOn,
                  status: 'pending' as const,
                }))
              );
              store.setAgentPlanMessage(null);
              break;

            case 'step_start':
              store.updateAgentPlanStep(parsed.stepId, { status: 'running' });
              break;

            case 'step_complete':
              store.updateAgentPlanStep(parsed.stepId, {
                status: parsed.success ? 'completed' : 'failed',
                output: parsed.output,
                artifactCount: parsed.artifactCount,
              });
              break;

            case 'complete':
              store.setAgentFinalResult({
                success: parsed.success,
                totalSteps: parsed.totalSteps,
                artifacts: parsed.artifacts,
              });
              break;

            case 'error':
              store.setAgentPlanMessage(`Error: ${parsed.message}`);
              break;
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
  } catch {
    // Network error
  }

  store.setAgentIsExecuting(false);
}

/**
 * Fetch agent tasks for a session.
 */
export async function fetchAgentTasks(sessionId: string): Promise<AgentTask[]> {
  try {
    const response = await fetch(`${API_BASE}/api/agents/tasks/${sessionId}`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.tasks ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch execution log for a session.
 */
export async function fetchExecutionLog(sessionId: string) {
  try {
    const response = await fetch(`${API_BASE}/api/agents/log/${sessionId}`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.log ?? [];
  } catch {
    return [];
  }
}

// --- Flow Graph API ---

/**
 * Fetch the flow graph for a session.
 */
export async function fetchFlowGraph(sessionId: string): Promise<FlowGraph | null> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/flow`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.graph ?? null;
  } catch {
    return null;
  }
}

// --- Session Management APIs ---

/**
 * Fetch all sessions.
 */
export async function fetchSessions(): Promise<Session[]> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.sessions ?? [];
  } catch {
    return [];
  }
}

/**
 * Delete a session.
 */
export async function deleteSessionApi(id: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${id}`, { method: 'DELETE' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Update a session's title.
 */
export async function updateSessionTitle(id: string, title: string): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
}

/**
 * Fetch linked sessions for a session.
 */
export async function fetchSessionLinks(id: string): Promise<SessionLink[]> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${id}/links`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.links ?? [];
  } catch {
    return [];
  }
}

/**
 * Link another session's context into the current session.
 */
export async function linkSessionApi(id: string, linkedId: string): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${id}/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ linkedSessionId: linkedId }),
  });
}

/**
 * Unlink a session.
 */
export async function unlinkSessionApi(id: string, linkedId: string): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${id}/links/${linkedId}`, { method: 'DELETE' });
}

/**
 * Switch to a different session: update store, restore messages, load links.
 */
export async function switchToSession(id: string): Promise<void> {
  const store = useChatStore.getState();
  store.switchSession(id);
  await restoreSession(id);
  const links = await fetchSessionLinks(id);
  useChatStore.getState().setLinkedSessions(links);
}

export async function fetchSessionApi(id: string): Promise<Session | null> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${id}`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.session ?? null;
  } catch {
    return null;
  }
}

export async function fetchObserverState(sessionId: string): Promise<{ config: ObserverConfig | null; snapshots: ObserverSnapshot[] } | null> {
  try {
    const response = await fetch(`${API_BASE}/api/observer/${sessionId}`);
    if (!response.ok) return null;
    const data = await response.json();
    return {
      config: data.config ?? null,
      snapshots: data.snapshots ?? [],
    };
  } catch {
    return null;
  }
}

export async function updateObserverConfigApi(
  sessionId: string,
  payload: { activeModel: string; observerModels: string[] }
): Promise<Session | null> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/observer-config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interactionMode: 'observer',
        activeModel: payload.activeModel,
        observerModels: payload.observerModels,
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.session ?? null;
  } catch {
    return null;
  }
}

export async function runObserverAction(
  sessionId: string,
  action: ObserverActionType,
  model: string,
  instruction?: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/observer/${sessionId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, instruction }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function fetchTopicActions(sessionId: string): Promise<Session[]> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/actions`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.actions ?? [];
  } catch {
    return [];
  }
}

export async function createActionSession(sessionId: string, payload: CreateActionRequest): Promise<Session | null> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.session ?? null;
  } catch {
    return null;
  }
}

export async function updateActionSessionApi(
  sessionId: string,
  update: { actionStatus?: ActionStatus; actionTitle?: string; actionTarget?: string; resultSummary?: string }
): Promise<Session | null> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/action`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.session ?? null;
  } catch {
    return null;
  }
}

export async function writeBackActionResult(sessionId: string, summary: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/action/writeback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function bootstrapSessionFromKB(
  payload: KBSessionBootstrapRequest
): Promise<KBSessionBootstrapResponse | null> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/bootstrap-from-kb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchSessionBootstrap(sessionId: string): Promise<SessionBootstrapRecord | null> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/bootstrap`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.bootstrap ?? null;
  } catch {
    return null;
  }
}

// --- Decision Memory APIs ---

/**
 * Fetch all decisions (active only by default).
 */
export async function fetchDecisions(all: boolean = false): Promise<Decision[]> {
  try {
    const url = all
      ? `${API_BASE}/api/decisions?all=true`
      : `${API_BASE}/api/decisions`;
    const response = await fetch(url);
    if (!response.ok) return [];
    const data = await response.json();
    return data.decisions ?? [];
  } catch {
    return [];
  }
}

/**
 * Create a new decision.
 */
export async function createDecisionApi(
  type: DecisionType,
  content: string,
  model?: string
): Promise<Decision | null> {
  try {
    const response = await fetch(`${API_BASE}/api/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, content, model: model || undefined }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.decision ?? null;
  } catch {
    return null;
  }
}

/**
 * Update a decision.
 */
export async function updateDecisionApi(
  id: string,
  update: Partial<Pick<Decision, 'content' | 'type' | 'model' | 'active'>>
): Promise<Decision | null> {
  try {
    const response = await fetch(`${API_BASE}/api/decisions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.decision ?? null;
  } catch {
    return null;
  }
}

/**
 * Delete a decision.
 */
export async function deleteDecisionApi(id: string): Promise<void> {
  await fetch(`${API_BASE}/api/decisions/${id}`, { method: 'DELETE' });
}

// --- Task Classification API ---

/**
 * Classify a prompt and get a model recommendation.
 */
export async function classifyPrompt(prompt: string): Promise<ClassificationResult | null> {
  try {
    const response = await fetch(`${API_BASE}/api/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// --- Communication APIs ---

/**
 * Fetch all connector statuses (multi-account: each account is a separate entry).
 */
export async function fetchConnectors(): Promise<ConnectorStatus[]> {
  try {
    const response = await fetch(`${API_BASE}/api/connectors`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.connectors ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch available connector types for "Add Account" UI.
 */
export async function fetchConnectorTypes(): Promise<{ connectorType: string; provider: string; isLocal: boolean; label: string }[]> {
  try {
    const response = await fetch(`${API_BASE}/api/connectors/types`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.types ?? [];
  } catch {
    return [];
  }
}

/**
 * Initiate connection for a connector type.
 * Returns { url, accountId } for OAuth or { ok, accountId } for local.
 */
export async function connectAccount(connectorType: string): Promise<{
  url?: string;
  accountId?: string;
  ok?: boolean;
  error?: string;
  message?: string;
  accounts?: { accountId: string; email: string; name: string }[];
}> {
  try {
    const response = await fetch(`${API_BASE}/api/connectors/connect/${connectorType}`, {
      method: 'POST',
    });
    const data = await response.json();
    if (!response.ok) return { error: data.error ?? 'Connection failed' };
    return data;
  } catch {
    return { error: 'Network error' };
  }
}

/**
 * Disconnect a specific account by accountId.
 */
export async function disconnectConnector(accountId: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/connectors/${accountId}/disconnect`, {
      method: 'POST',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Manually trigger sync for a specific account.
 * Returns full result with ok/error status and threads.
 */
export async function syncConnector(accountId: string): Promise<{
  ok: boolean;
  error?: string;
  threadCount?: number;
  totalThreadCount?: number;
  threads: ExternalThread[];
}> {
  try {
    const response = await fetch(`${API_BASE}/api/connectors/${accountId}/sync`, {
      method: 'POST',
    });
    const data = await response.json();
    return {
      ok: data.ok ?? false,
      error: data.error,
      threadCount: data.threadCount,
      totalThreadCount: data.totalThreadCount,
      threads: data.threads ?? [],
    };
  } catch {
    return { ok: false, error: 'Network error', threads: [] };
  }
}

/**
 * Account sync status for display.
 */
export interface AccountSyncStatus {
  accountId: string;
  provider: CommProvider;
  connectorType: string;
  displayName: string | null;
  email: string | null;
  isLocal: boolean;
  connected: boolean;
  threadCount: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

/**
 * Fetch detailed sync status for all connected accounts.
 */
export async function fetchConnectorStatus(): Promise<AccountSyncStatus[]> {
  try {
    const response = await fetch(`${API_BASE}/api/connectors/status`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.accounts ?? [];
  } catch {
    return [];
  }
}

/**
 * Update a connector's persona description.
 */
export async function updateConnectorPersona(accountId: string, persona: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/connectors/${accountId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch all external threads.
 */
export async function fetchCommThreads(): Promise<ExternalThread[]> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/threads`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.threads ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch messages for a specific thread.
 */
export async function fetchCommThreadMessages(threadId: string): Promise<{ messages: ExternalMessage[]; contentLoading: boolean }> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/threads/${threadId}/messages`);
    if (!response.ok) return { messages: [], contentLoading: false };
    const data = await response.json();
    return {
      messages: data.messages ?? [],
      contentLoading: data.contentLoading ?? false,
    };
  } catch {
    return { messages: [], contentLoading: false };
  }
}

/**
 * Trigger AI draft generation for a thread.
 */
export async function createDraft(
  threadId: string,
  opts?: { messageId?: string; tone?: string; language?: string; model?: string; instruction?: string }
): Promise<{ draft: DraftReply | null; log: string[] }> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/threads/${threadId}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts ?? {}),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return { draft: null, log: data.log ?? [data.error ?? 'Draft generation failed'] };
    }
    const data = await response.json();
    return { draft: data.draft ?? null, log: data.log ?? [] };
  } catch {
    return { draft: null, log: ['Network error'] };
  }
}

/**
 * Fetch drafts, optionally filtered by threadId or status.
 */
export async function fetchDrafts(opts?: { threadId?: string; status?: string }): Promise<DraftReply[]> {
  try {
    const params = new URLSearchParams();
    if (opts?.threadId) params.set('threadId', opts.threadId);
    if (opts?.status) params.set('status', opts.status);
    const qs = params.toString();
    const response = await fetch(`${API_BASE}/api/comm/drafts${qs ? '?' + qs : ''}`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.drafts ?? [];
  } catch {
    return [];
  }
}

/**
 * Approve a draft — sends via connector and records learning.
 */
export async function approveDraft(id: string, userEdit?: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/drafts/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userEdit }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Reject a draft.
 */
export async function rejectDraft(id: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/drafts/${id}/reject`, {
      method: 'POST',
    });
    return response.ok;
  } catch {
    return false;
  }
}

// --- Reply Learning APIs ---

/**
 * Fetch all senders with aggregated learning stats.
 */
export async function fetchLearningSenders(): Promise<SenderLearningStats[]> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/learning/senders`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.senders ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch detailed learning stats for a specific sender.
 */
export async function fetchSenderLearning(senderId: string, provider: string): Promise<SenderLearningStats | null> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/learning/senders/${encodeURIComponent(senderId)}?provider=${encodeURIComponent(provider)}`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.sender ?? null;
  } catch {
    return null;
  }
}

/**
 * Clear all learning data for a specific sender.
 */
export async function clearSenderLearning(senderId: string, provider: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/learning/senders/${encodeURIComponent(senderId)}?provider=${encodeURIComponent(provider)}`, {
      method: 'DELETE',
    });
    return response.ok;
  } catch {
    return false;
  }
}

// --- Monitor Rule APIs ---

/**
 * Fetch all monitor rules.
 */
export async function fetchMonitorRules(enabledOnly: boolean = false): Promise<MonitorRule[]> {
  try {
    const qs = enabledOnly ? '?enabledOnly=true' : '';
    const response = await fetch(`${API_BASE}/api/comm/rules${qs}`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.rules ?? [];
  } catch {
    return [];
  }
}

/**
 * Create a new monitor rule.
 */
export async function createMonitorRule(params: {
  provider: CommProvider | 'all';
  ruleName: string;
  conditions: MonitorRuleConditions;
  action: MonitorAction;
  actionConfig?: MonitorRuleActionConfig | null;
}): Promise<MonitorRule | null> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.rule ?? null;
  } catch {
    return null;
  }
}

/**
 * Update a monitor rule.
 */
export async function updateMonitorRule(
  id: string,
  update: Partial<Pick<MonitorRule, 'ruleName' | 'provider' | 'enabled' | 'conditions' | 'action' | 'actionConfig'>>
): Promise<MonitorRule | null> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/rules/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.rule ?? null;
  } catch {
    return null;
  }
}

/**
 * Delete a monitor rule.
 */
export async function deleteMonitorRule(id: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/rules/${id}`, {
      method: 'DELETE',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Test a rule against recent messages.
 */
export async function testMonitorRule(id: string, limit: number = 10): Promise<{
  ruleId: string;
  ruleName: string;
  messageId: string;
  sender: string;
  subject: string | null;
  preview: string;
  timestamp: number;
}[]> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/rules/${id}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit }),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.matches ?? [];
  } catch {
    return [];
  }
}

// =============================================================
// Triage API
// =============================================================

export async function fetchTriageResults(opts?: {
  accountId?: string;
  threadId?: string;
}): Promise<import('@prism/shared').TriageResult[]> {
  try {
    const params = new URLSearchParams();
    if (opts?.accountId) params.set('accountId', opts.accountId);
    if (opts?.threadId) params.set('threadId', opts.threadId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const response = await fetch(`${API_BASE}/api/comm/triage-results${qs}`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.triageResults ?? [];
  } catch {
    return [];
  }
}

export async function fetchTriageSettings(
  accountId: string
): Promise<import('@prism/shared').TriageSettings | null> {
  try {
    const response = await fetch(
      `${API_BASE}/api/comm/connectors/${accountId}/triage-settings`
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data.settings ?? null;
  } catch {
    return null;
  }
}

// =============================================================
// LINE Chat Config APIs
// =============================================================

export interface LineChatConfig {
  name: string;
  enabled: boolean;
  persona?: string;
  tone?: string;
  instruction?: string;
  language?: string;
}

/**
 * Fetch available LINE chats with their monitoring configs.
 */
export async function fetchLineChats(accountId: string): Promise<{
  chats: {
    name: string;
    lastMessage: string;
    time: string;
    unreadCount: number;
    index: number;
    isMonitored: boolean;
    config: LineChatConfig | null;
  }[];
  chatConfigs: LineChatConfig[] | null;
}> {
  try {
    const response = await fetch(`${API_BASE}/api/connectors/${accountId}/line/chats`);
    if (!response.ok) return { chats: [], chatConfigs: null };
    return await response.json();
  } catch {
    return { chats: [], chatConfigs: null };
  }
}

/**
 * Get all per-chat monitoring configurations.
 */
export async function fetchLineChatConfigs(accountId: string): Promise<LineChatConfig[] | null> {
  try {
    const response = await fetch(`${API_BASE}/api/connectors/${accountId}/line/chat-configs`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.chatConfigs ?? null;
  } catch {
    return null;
  }
}

/**
 * Set all per-chat monitoring configurations.
 */
export async function updateLineChatConfigs(
  accountId: string,
  configs: LineChatConfig[] | null
): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/connectors/${accountId}/line/chat-configs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configs }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Update config for a single LINE chat.
 */
export async function updateLineChatConfig(
  accountId: string,
  chatName: string,
  update: Partial<Omit<LineChatConfig, 'name'>>
): Promise<LineChatConfig | null> {
  try {
    const response = await fetch(
      `${API_BASE}/api/connectors/${accountId}/line/chat-configs/${encodeURIComponent(chatName)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data.config ?? null;
  } catch {
    return null;
  }
}

/**
 * Control the LINE monitor agent (start/stop/status).
 */
export async function controlLineMonitor(
  accountId: string,
  action: 'start' | 'stop' | 'status'
): Promise<{ running: boolean }> {
  try {
    const response = await fetch(`${API_BASE}/api/connectors/${accountId}/line/monitor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if (!response.ok) return { running: false };
    return await response.json();
  } catch {
    return { running: false };
  }
}

export async function updateTriageSettings(
  accountId: string,
  settings: Partial<import('@prism/shared').TriageSettings>
): Promise<boolean> {
  try {
    const response = await fetch(
      `${API_BASE}/api/comm/connectors/${accountId}/triage-settings`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

/* ===== Import Engine (Phase 7a) ===== */

export async function uploadImportFile(
  file: File,
  platform: 'chatgpt' | 'claude' | 'gemini',
  projectName?: string
): Promise<ImportProgress> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('platform', platform);
  if (projectName?.trim()) {
    formData.append('projectName', projectName.trim());
  }

  const res = await fetch(`${API_BASE}/api/import/upload`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function syncChatGPTConversations(
  conversations: ChatGPTSyncConversation[],
  projectName?: string
): Promise<ImportProgress> {
  const res = await fetch(`${API_BASE}/api/import/chatgpt-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectName: projectName?.trim() || undefined,
      conversations,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchImportProjects(): Promise<ImportProjectTarget[]> {
  const res = await fetch(`${API_BASE}/api/import/projects`);
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.projects ?? [];
}

export async function fetchChatGPTSyncRuns(limit: number = 10): Promise<ImportSyncRun[]> {
  const res = await fetch(`${API_BASE}/api/import/chatgpt-sync/history?limit=${limit}`);
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.runs ?? [];
}

export async function fetchLatestChatGPTSyncRun(): Promise<ImportSyncRun | null> {
  const res = await fetch(`${API_BASE}/api/import/chatgpt-sync/latest`);
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.run ?? null;
}

export async function syncClaudeConversations(
  conversations: ClaudeSyncConversation[],
  projectName?: string
): Promise<ImportProgress> {
  const res = await fetch(`${API_BASE}/api/import/claude-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectName: projectName?.trim() || undefined,
      conversations,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchClaudeSyncRuns(limit: number = 10): Promise<ImportSyncRun[]> {
  const res = await fetch(`${API_BASE}/api/import/claude-sync/history?limit=${limit}`);
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.runs ?? [];
}

export async function fetchLatestClaudeSyncRun(): Promise<ImportSyncRun | null> {
  const res = await fetch(`${API_BASE}/api/import/claude-sync/latest`);
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.run ?? null;
}

export async function syncGeminiConversations(
  conversations: GeminiSyncConversation[],
  projectName?: string
): Promise<ImportProgress> {
  const res = await fetch(`${API_BASE}/api/import/gemini-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectName: projectName?.trim() || undefined,
      conversations,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchGeminiSyncRuns(limit: number = 10): Promise<ImportSyncRun[]> {
  const res = await fetch(`${API_BASE}/api/import/gemini-sync/history?limit=${limit}`);
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.runs ?? [];
}

export async function fetchLatestGeminiSyncRun(): Promise<ImportSyncRun | null> {
  const res = await fetch(`${API_BASE}/api/import/gemini-sync/latest`);
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.run ?? null;
}

export async function fetchImportedConversations(opts?: {
  platform?: string;
  limit?: number;
  offset?: number;
  search?: string;
}): Promise<{ conversations: any[]; total: number }> {
  const params = new URLSearchParams();
  if (opts?.platform) params.set('platform', opts.platform);
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.offset) params.set('offset', String(opts.offset));
  if (opts?.search) params.set('search', opts.search);

  const res = await fetch(`${API_BASE}/api/import/conversations?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchImportedMessages(conversationId: string): Promise<any[]> {
  const res = await fetch(`${API_BASE}/api/import/conversations/${conversationId}/messages`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateImportedConversationTitle(conversationId: string, title: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/import/conversations/${conversationId}/title`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function regenerateImportedConversationTitle(conversationId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/import/conversations/${conversationId}/regenerate-title`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function deleteImportedConversation(conversationId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/import/conversations/${conversationId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getObsidianSettings(): Promise<{ vaultPath: string | null }> {
  const res = await fetch(`${API_BASE}/api/obsidian/settings`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function saveObsidianSettings(vaultPath: string): Promise<{ ok: boolean; vaultPath: string }> {
  const res = await fetch(`${API_BASE}/api/obsidian/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vaultPath }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function pickObsidianVaultFolder(): Promise<{ ok: boolean; vaultPath: string }> {
  const res = await fetch(`${API_BASE}/api/obsidian/pick-folder`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function exportImportedRawSourceToObsidian(conversationId: string, vaultPath?: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/obsidian/export/raw-source`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, vaultPath }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createKnowledgeNoteFromImportedConversation(
  conversationId: string,
  model?: string,
  destinationType?: 'obsidian_context' | 'obsidian_observation' | 'obsidian_evergreen'
): Promise<{ ok: boolean; title: string; content: string; model: string; destinationType: string; knowledgeMaturity: string; compilerRun?: any }> {
  const res = await fetch(`${API_BASE}/api/import/conversations/${conversationId}/create-knowledge-note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, destinationType }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function exportKnowledgeNoteToObsidian(
  conversationId: string,
  content: string,
  title?: string,
  vaultPath?: string,
  destinationType?: 'obsidian_context' | 'obsidian_observation' | 'obsidian_evergreen',
  knowledgeMaturity?: 'context' | 'incubating' | 'evergreen',
  compilerRunId?: string | null
): Promise<any> {
  const res = await fetch(`${API_BASE}/api/wiki/export-note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, content, title, vaultPath, destinationType, knowledgeMaturity, compilerRunId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function compileSourceToWiki(input: {
  sourceKind?: 'imported' | 'native';
  sourceId?: string;
  conversationId?: string;
  sessionId?: string;
  vaultPath?: string;
  model?: string;
}): Promise<any> {
  const res = await fetch(`${API_BASE}/api/wiki/compile-source`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchWikiBackfillPlan(params?: {
  platform?: string;
  search?: string;
  limit?: number;
}): Promise<any> {
  const query = new URLSearchParams();
  if (params?.platform) query.set('platform', params.platform);
  if (params?.search) query.set('search', params.search);
  if (typeof params?.limit === 'number') query.set('limit', String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const res = await fetch(`${API_BASE}/api/wiki/backfill-plan${suffix}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function applyWikiBackfillPlan(input: {
  items: Array<{ conversationId: string; action: 'compile_now' | 'archive_only' | 'skip' }>;
  vaultPath?: string;
  model?: string;
}): Promise<any> {
  const res = await fetch(`${API_BASE}/api/wiki/backfill-apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function startWikiBackfillJob(input: {
  vaultPath?: string;
  model?: string;
  platform?: string;
  search?: string;
  limit?: number;
  batchSize?: number;
  items?: Array<{ conversationId: string; action: 'compile_now' | 'archive_only' | 'skip' }>;
}): Promise<any> {
  const res = await fetch(`${API_BASE}/api/wiki/backfill-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchWikiBackfillJobs(limit: number = 10): Promise<any> {
  const res = await fetch(`${API_BASE}/api/wiki/backfill-jobs?limit=${limit}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchWikiBackfillJob(jobId: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/wiki/backfill-jobs/${jobId}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function pauseWikiBackfillJob(jobId: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/wiki/backfill-jobs/${jobId}/pause`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function resumeWikiBackfillJob(jobId: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/wiki/backfill-jobs/${jobId}/resume`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchWikiCompilePlans(params?: {
  sourceId?: string;
  sourceType?: string;
  limit?: number;
}): Promise<any> {
  const query = new URLSearchParams();
  if (params?.sourceId) query.set('sourceId', params.sourceId);
  if (params?.sourceType) query.set('sourceType', params.sourceType);
  if (typeof params?.limit === 'number') query.set('limit', String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const res = await fetch(`${API_BASE}/api/wiki/compile-plans${suffix}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchWikiCompilePlan(id: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/wiki/compile-plans/${id}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function applyWikiCompilePlan(id: string, itemIds?: string[], vaultPath?: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/wiki/compile-plans/${id}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemIds, vaultPath }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function rejectWikiCompilePlan(id: string, vaultPath?: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/wiki/compile-plans/${id}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vaultPath }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function runWikiLint(vaultPath?: string, model?: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/wiki/lint/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vaultPath, model }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchWikiLintRuns(limit?: number): Promise<any> {
  const query = new URLSearchParams();
  if (typeof limit === 'number') query.set('limit', String(limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const res = await fetch(`${API_BASE}/api/wiki/lint/runs${suffix}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchWikiLintRun(id: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/wiki/lint/runs/${id}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function saveQueryArtifactToWiki(input: {
  sessionId: string;
  messageId?: string;
  sourceModel?: string | null;
  title?: string;
  content: string;
  artifactType: 'analysis' | 'comparison' | 'synthesis';
  streamTarget?: 'prompt' | 'observer' | 'parallel' | 'compare' | 'synthesize';
  promoteTo?: 'obsidian_observation' | 'obsidian_evergreen' | null;
  vaultPath?: string;
}): Promise<any> {
  const res = await fetch(`${API_BASE}/api/wiki/save-query-artifact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function revealObsidianExport(filePath: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/obsidian/reveal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createActionItemsFromImportedConversation(conversationId: string, model?: string): Promise<{ ok: boolean; title: string; content: string; model: string }> {
  const res = await fetch(`${API_BASE}/api/import/conversations/${conversationId}/create-action-items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchImportStats(): Promise<any> {
  const res = await fetch(`${API_BASE}/api/import/stats`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteImportBatch(batchId: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/import/batch/${batchId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function resetImportedData(): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/import/reset-all`, { method: 'POST' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/* ===== Unified Search (Phase 7b) ===== */

export async function searchAll(params: {
  query: string;
  source?: 'imported' | 'native';
  platform?: string;
  dateFrom?: string;
  dateTo?: string;
  role?: string;
  model?: string;
  limit?: number;
  offset?: number;
}): Promise<{ results: any[]; total: number; queryTimeMs: number }> {
  const urlParams = new URLSearchParams();
  urlParams.set('q', params.query);
  if (params.source) urlParams.set('source', params.source);
  if (params.platform) urlParams.set('platform', params.platform);
  if (params.dateFrom) urlParams.set('dateFrom', params.dateFrom);
  if (params.dateTo) urlParams.set('dateTo', params.dateTo);
  if (params.role) urlParams.set('role', params.role);
  if (params.model) urlParams.set('model', params.model);
  if (params.limit) urlParams.set('limit', String(params.limit));
  if (params.offset) urlParams.set('offset', String(params.offset));

  const res = await fetch(`${API_BASE}/api/search?${urlParams}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/* ===== Knowledge Graph (Phase 7c) ===== */

export async function triggerExtraction(provider?: string, model?: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/knowledge/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function triggerNativeExtraction(provider?: string, model?: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/knowledge/extract/native`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchExtractionProgress(): Promise<any> {
  const res = await fetch(`${API_BASE}/api/knowledge/extract/progress`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchTags(search?: string): Promise<any[]> {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  const res = await fetch(`${API_BASE}/api/knowledge/tags?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchTagConversations(tagId: string): Promise<any[]> {
  const res = await fetch(`${API_BASE}/api/knowledge/tags/${tagId}/conversations`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchEntities(opts?: { type?: string; search?: string; limit?: number; offset?: number }): Promise<any> {
  const params = new URLSearchParams();
  if (opts?.type) params.set('type', opts.type);
  if (opts?.search) params.set('search', opts.search);
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.offset) params.set('offset', String(opts.offset));
  const res = await fetch(`${API_BASE}/api/knowledge/entities?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchEntityDetail(entityId: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/knowledge/entities/${entityId}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchGraphData(opts?: { type?: string; minMentions?: number; center?: string; maxNodes?: number }): Promise<any> {
  const params = new URLSearchParams();
  if (opts?.type) params.set('type', opts.type);
  if (opts?.minMentions) params.set('minMentions', String(opts.minMentions));
  if (opts?.center) params.set('center', opts.center);
  if (opts?.maxNodes) params.set('maxNodes', String(opts.maxNodes));
  const res = await fetch(`${API_BASE}/api/knowledge/graph?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchKnowledgeStats(): Promise<any> {
  const res = await fetch(`${API_BASE}/api/knowledge/stats`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/* ===== Session Outline / Topic Navigation ===== */

export async function generateOutline(
  sessionId: string,
  sourceType: 'native' | 'imported',
  provider?: string,
  model?: string
): Promise<any> {
  const res = await fetch(`${API_BASE}/api/outlines/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, sourceType, provider, model }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchOutline(
  sessionId: string,
  sourceType: 'native' | 'imported'
): Promise<any> {
  const res = await fetch(`${API_BASE}/api/outlines/${sessionId}/${sourceType}`);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(await res.text());
  }
  return res.json();
}

export async function deleteOutlineApi(
  sessionId: string,
  sourceType: 'native' | 'imported'
): Promise<void> {
  await fetch(`${API_BASE}/api/outlines/${sessionId}/${sourceType}`, { method: 'DELETE' });
}

/* ===== Per-Conversation Knowledge ===== */

export async function fetchConversationKnowledge(conversationId: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/knowledge/conversation/${conversationId}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function runCompiler(input: {
  sourceKind: 'imported' | 'native';
  sourceId: string;
  destinationType?: 'obsidian_context' | 'obsidian_observation' | 'obsidian_evergreen';
  model?: string;
}): Promise<any> {
  const res = await fetch(`${API_BASE}/api/compiler/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchCompilerRuns(params?: {
  sourceId?: string;
  sourceType?: string;
  limit?: number;
}): Promise<any> {
  const query = new URLSearchParams();
  if (params?.sourceId) query.set('sourceId', params.sourceId);
  if (params?.sourceType) query.set('sourceType', params.sourceType);
  if (typeof params?.limit === 'number') query.set('limit', String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const res = await fetch(`${API_BASE}/api/compiler/runs${suffix}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchCompilerRun(id: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/compiler/runs/${id}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchSessionKnowledge(sessionId: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/knowledge/session/${sessionId}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/* ===== Artifact Provenance (Phase 7d) ===== */

// --- Provenance ---

export async function createProvenance(data: {
  sourceType: 'native' | 'imported';
  sessionId?: string;
  conversationId?: string;
  messageId: string;
  artifactId?: string;
  content: string;
  contentHash: string;
  sourceModel: string;
  entities?: string[];
  tags?: string[];
}): Promise<any> {
  const res = await fetch(`${API_BASE}/api/provenance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Create provenance failed: ${res.statusText}`);
  return res.json();
}

export async function listProvenance(filters?: {
  sourceModel?: string;
  sourceType?: string;
  sessionId?: string;
  conversationId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ records: any[]; total: number }> {
  const params = new URLSearchParams();
  if (filters) {
    Object.entries(filters).forEach(([k, v]) => {
      if (v !== undefined) params.append(k, String(v));
    });
  }
  const res = await fetch(`${API_BASE}/api/provenance?${params.toString()}`);
  if (!res.ok) throw new Error(`List provenance failed: ${res.statusText}`);
  return res.json();
}

export async function getProvenance(id: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/provenance/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Get provenance failed: ${res.statusText}`);
  return res.json();
}

export async function searchProvenanceByHash(hash: string): Promise<{ records: any[]; total: number }> {
  const res = await fetch(`${API_BASE}/api/provenance/search/by-hash?hash=${encodeURIComponent(hash)}`);
  if (!res.ok) throw new Error(`Search provenance failed: ${res.statusText}`);
  return res.json();
}

export async function updateProvenanceNote(id: string, note: string): Promise<{ record: any }> {
  const res = await fetch(`${API_BASE}/api/provenance/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  if (!res.ok) throw new Error(`Update provenance failed: ${res.statusText}`);
  return res.json();
}

export async function deleteProvenanceRecord(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/provenance/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Delete provenance failed: ${res.statusText}`);
  return res.json();
}

/* ===== Manual Connector APIs ===== */

/**
 * Set up a manual connector account.
 */
export async function setupManualConnector(displayName: string): Promise<{ ok: boolean; accountId?: string; error?: string }> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/manual/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
    });
    const data = await response.json();
    if (!response.ok) return { ok: false, error: data.error ?? 'Setup failed' };
    return { ok: true, accountId: data.accountId };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/**
 * Create a new manual thread.
 */
export async function createManualThread(opts: {
  accountId: string;
  displayName: string;
  subject?: string;
  senderName?: string;
  senderEmail?: string;
  isGroup?: boolean;
}): Promise<ExternalThread | null> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.thread ?? null;
  } catch {
    return null;
  }
}

/**
 * Add a message to a manual thread (paste in received email/message).
 */
export async function addManualMessage(
  threadId: string,
  opts: {
    content: string;
    senderName: string;
    senderEmail?: string;
    isInbound: boolean;
    subject?: string;
  }
): Promise<ExternalMessage | null> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/threads/${threadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.message ?? null;
  } catch {
    return null;
  }
}

/**
 * Update a manual thread's metadata.
 */
export async function updateManualThread(
  threadId: string,
  opts: { displayName?: string; subject?: string; senderName?: string; senderEmail?: string }
): Promise<ExternalThread | null> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.thread ?? null;
  } catch {
    return null;
  }
}

/**
 * Delete a manual thread and its messages.
 */
export async function deleteManualThread(threadId: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/comm/threads/${threadId}`, {
      method: 'DELETE',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/* ===== Notion Integration (Scenario 4) ===== */

export async function setupNotionInternal(token: string): Promise<{ ok: boolean; accountId: string; pagesFound: number; message: string }> {
  const res = await fetch(`${API_BASE}/api/notion/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Setup failed' }));
    throw new Error(err.error || 'Notion setup failed');
  }
  return res.json();
}

export async function fetchNotionStatus(): Promise<{ connected: boolean; accounts: { accountId: string; displayName: string; connectorType: string }[] }> {
  const res = await fetch(`${API_BASE}/api/notion/status`);
  if (!res.ok) return { connected: false, accounts: [] };
  return res.json();
}

export async function syncNotionPages(accountId?: string): Promise<{ ok: boolean; pagesSync: number }> {
  const res = await fetch(`${API_BASE}/api/notion/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId }),
  });
  if (!res.ok) throw new Error('Sync failed');
  return res.json();
}

export async function fetchNotionPages(query?: string): Promise<any[]> {
  try {
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    const res = await fetch(`${API_BASE}/api/notion/pages?${params}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.pages ?? [];
  } catch {
    return [];
  }
}

export async function fetchNotionPageContent(id: string): Promise<{ page: any; content: string | null }> {
  const res = await fetch(`${API_BASE}/api/notion/pages/${id}/content`);
  if (!res.ok) throw new Error('Failed to fetch page content');
  return res.json();
}

export async function writeToNotionPage(
  pageId: string,
  content: string,
  sessionId?: string,
  messageId?: string
): Promise<{ ok: boolean; write?: any }> {
  try {
    const res = await fetch(`${API_BASE}/api/notion/pages/${pageId}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, sessionId, messageId }),
    });
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch {
    return { ok: false };
  }
}

export async function fetchContextSources(sessionId: string): Promise<any[]> {
  try {
    const res = await fetch(`${API_BASE}/api/notion/context-sources/${sessionId}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.sources ?? [];
  } catch {
    return [];
  }
}

export async function attachContextSource(
  sessionId: string,
  sourceId: string,
  sourceLabel: string
): Promise<any> {
  const res = await fetch(`${API_BASE}/api/notion/context-sources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, sourceId, sourceLabel }),
  });
  if (!res.ok) throw new Error('Failed to attach context source');
  return res.json();
}

export async function detachContextSource(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/notion/context-sources/${id}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchNotionWrites(sessionId?: string): Promise<any[]> {
  try {
    const params = new URLSearchParams();
    if (sessionId) params.set('sessionId', sessionId);
    const res = await fetch(`${API_BASE}/api/notion/writes?${params}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.writes ?? [];
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────
// File Upload + Analysis
// ──────────────────────────────────────────────────────────────

/**
 * Create a new session on the backend and return the session ID.
 */
function buildDefaultObserverPayload() {
  const store = useChatStore.getState();
  const activeModel = store.selectedModels[0] ?? null;
  const observerModels = store.selectedModels.slice(1, 3);
  return {
    interactionMode: 'observer' as const,
    activeModel,
    observerModels,
  };
}

export async function createSession(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildDefaultObserverPayload()),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.session) {
      const store = useChatStore.getState();
      store.setObserverConfig(data.session.activeModel ?? buildDefaultObserverPayload().activeModel, data.session.observerModels ?? buildDefaultObserverPayload().observerModels);
    }
    return data.session?.id ?? data.id ?? null;
  } catch {
    return null;
  }
}

export async function uploadFile(sessionId: string, file: File): Promise<UploadedFile | null> {
  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('sessionId', sessionId);

    const res = await fetch(`${API_BASE}/api/files/upload`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchSessionFiles(sessionId: string): Promise<UploadedFile[]> {
  try {
    const res = await fetch(`${API_BASE}/api/files?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function fetchFile(fileId: string): Promise<UploadedFile | null> {
  try {
    const res = await fetch(`${API_BASE}/api/files/${encodeURIComponent(fileId)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function deleteFile(fileId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Model Registry ──────────────────────────────────────────

export interface ModelEntry {
  id: string;
  provider: string;
  model: string;
  displayName: string;
  maxTokens: number;
  inputCostPer1M: number;
  outputCostPer1M: number;
  description?: string;
  isReasoning?: boolean;
  supportsThinking?: boolean;
}

export interface ModelsResponse {
  models: ModelEntry[];
  registry: {
    staticCount: number;
    discoveredCount: number;
    lastRefreshedAt: number | null;
    autoRefreshEnabled: boolean;
    refreshIntervalMs: number;
  };
}

export async function fetchModels(): Promise<ModelsResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/api/models`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function refreshModels(): Promise<(ModelsResponse & { success: boolean; added: number; total: number }) | null> {
  try {
    const res = await fetch(`${API_BASE}/api/models/refresh`, { method: 'POST' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ===== RAG Knowledge Base =====

export async function ragSearch(query: string, filters?: any, limit?: number): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/api/rag/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, filters, limit }),
    });
    if (!response.ok) return { results: [], total: 0, queryTimeMs: 0 };
    return response.json();
  } catch (err) {
    console.error('[api] ragSearch failed:', err);
    return { results: [], total: 0, queryTimeMs: 0 };
  }
}

export async function ragAsk(query: string, filters?: any, maxChunks?: number): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/api/rag/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, filters, maxChunks }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } catch (err) {
    console.error('[api] ragAsk failed:', err);
    return null;
  }
}

export async function ragIndexFile(fileId: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/rag/index/file/${fileId}`, { method: 'POST' });
    return response.ok;
  } catch { return false; }
}

export async function ragIndexSession(sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/rag/index/session/${sessionId}`, { method: 'POST' });
    return response.ok;
  } catch { return false; }
}

export async function ragGetStats(): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/api/rag/stats`);
    if (!response.ok) return null;
    return response.json();
  } catch { return null; }
}

export async function ragGetInventory(): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/api/rag/inventory`);
    if (!response.ok) return { sessions: [], library: [] };
    return response.json();
  } catch { return { sessions: [], library: [] }; }
}

export async function ragIndexLibraryConversation(conversationId: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/rag/index/library/${conversationId}`, { method: 'POST' });
    return response.ok;
  } catch { return false; }
}

export async function ragIndexAll(): Promise<any> {
  try {
    const res = await fetch(`${API_BASE}/api/rag/index-all`, { method: 'POST' });
    return await res.json();
  } catch (err) {
    console.error('[api] ragIndexAll failed:', err);
    return null;
  }
}

// ===== Structured Memory =====

export async function fetchMemory(opts?: {
  type?: MemoryType | 'all';
  status?: 'active' | 'stale' | 'superseded' | 'archived' | 'all';
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: MemoryItem[]; total: number }> {
  const params = new URLSearchParams();
  if (opts?.type && opts.type !== 'all') params.set('type', opts.type);
  if (opts?.status) params.set('status', opts.status);
  if (opts?.search) params.set('search', opts.search);
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.offset) params.set('offset', String(opts.offset));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`${API_BASE}/api/memory${suffix}`);
  if (!res.ok) return { items: [], total: 0 };
  return res.json();
}

export async function fetchMemoryItem(id: string): Promise<MemoryItem | null> {
  const res = await fetch(`${API_BASE}/api/memory/${id}`);
  if (!res.ok) return null;
  return res.json();
}

export async function fetchMemoryReviewQueue(): Promise<MemoryCandidate[]> {
  const res = await fetch(`${API_BASE}/api/memory/review-queue`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.candidates ?? [];
}

export async function fetchMemoryRelationshipCandidates(): Promise<MemoryCandidate[]> {
  const res = await fetch(`${API_BASE}/api/memory/relationship-candidates`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.candidates ?? [];
}

export interface MemoryPromotionResult {
  status: string;
  added: number;
  skippedDuplicates: number;
  candidates: MemoryCandidate[];
}

export async function extractSessionMemory(sessionId: string): Promise<MemoryPromotionResult | null> {
  const res = await fetch(`${API_BASE}/api/memory/extract/session/${sessionId}`, { method: 'POST' });
  if (!res.ok) return null;
  const data = await res.json();
  return {
    status: data.status ?? 'ok',
    added: data.extracted ?? data.added ?? 0,
    skippedDuplicates: data.skippedDuplicates ?? 0,
    candidates: data.candidates ?? [],
  };
}

export async function promoteToMemory(payload: {
  sessionId?: string;
  messageId?: string;
  typeHint?: MemoryType;
  content?: string;
  title?: string;
  summary?: string;
}): Promise<MemoryPromotionResult | null> {
  const res = await fetch(`${API_BASE}/api/memory/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return {
    status: data.status ?? 'ok',
    added: data.added ?? (data.candidates?.length ?? 0),
    skippedDuplicates: data.skippedDuplicates ?? 0,
    candidates: data.candidates ?? [],
  };
}

export async function confirmMemoryCandidateApi(id: string): Promise<MemoryItem | null> {
  const res = await fetch(`${API_BASE}/api/memory/${id}/confirm`, { method: 'POST' });
  if (!res.ok) return null;
  return res.json();
}

export async function rejectMemoryCandidateApi(id: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/memory/${id}/reject`, { method: 'POST' });
  return res.ok;
}

export async function archiveMemoryItemApi(id: string): Promise<MemoryItem | null> {
  const res = await fetch(`${API_BASE}/api/memory/${id}/archive`, { method: 'POST' });
  if (!res.ok) return null;
  return res.json();
}

export async function resetMemoryApi(): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/memory/reset`, { method: 'POST' });
  return res.ok;
}

export async function updateMemoryItemApi(id: string, update: Partial<MemoryItem>): Promise<MemoryItem | null> {
  const res = await fetch(`${API_BASE}/api/memory/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function fetchMemoryGraph(): Promise<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }> {
  const res = await fetch(`${API_BASE}/api/memory/graph`);
  if (!res.ok) return { nodes: [], edges: [] };
  return res.json();
}

export async function fetchMemoryTimeline(): Promise<MemoryTimelineEvent[]> {
  const res = await fetch(`${API_BASE}/api/memory/timeline`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.events ?? [];
}

export async function fetchWorkingMemory(sessionId?: string | null): Promise<WorkingMemoryItem[]> {
  const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  const res = await fetch(`${API_BASE}/api/memory/working${suffix}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.items ?? [];
}

export async function fetchMemoryExtractionRuns(): Promise<MemoryExtractionRun[]> {
  const res = await fetch(`${API_BASE}/api/memory/extraction-runs`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.runs ?? [];
}

export async function fetchMemoryExtractionRunItems(id: string): Promise<MemoryExtractionRunItem[]> {
  const res = await fetch(`${API_BASE}/api/memory/extraction-runs/${id}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.items ?? [];
}

export async function fetchMemoryUsageRuns(): Promise<MemoryUsageRun[]> {
  const res = await fetch(`${API_BASE}/api/memory/usage-runs`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.runs ?? [];
}

export async function fetchMemoryUsageRunItems(id: string): Promise<MemoryUsageRunItem[]> {
  const res = await fetch(`${API_BASE}/api/memory/usage-runs/${id}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.items ?? [];
}

export async function fetchMemoryContextPreview(opts: {
  sessionId: string;
  model?: string;
  mode?: string | null;
  prompt?: string;
}): Promise<{ promptText: string | null; preview: MemoryInjectionPreview | null } | null> {
  const params = new URLSearchParams({ sessionId: opts.sessionId });
  if (opts.model) params.set('model', opts.model);
  if (opts.mode) params.set('mode', opts.mode);
  if (opts.prompt) params.set('prompt', opts.prompt);
  const res = await fetch(`${API_BASE}/api/memory/context-preview?${params.toString()}`);
  if (!res.ok) return null;
  return res.json();
}

export async function fetchTriggers(): Promise<{
  candidates: TriggerCandidate[];
  rules: TriggerRule[];
  history: TriggerRun[];
  notifications: TriggerNotification[];
}> {
  const res = await fetch(`${API_BASE}/api/triggers`);
  if (!res.ok) return { candidates: [], rules: [], history: [], notifications: [] };
  return res.json();
}

export async function fetchKnowledgeRelations(opts?: {
  routingDecision?: 'graph_only' | 'memory_candidate' | 'trigger_candidate' | 'all';
  limit?: number;
}): Promise<RelationshipEvidence[]> {
  const params = new URLSearchParams();
  if (opts?.routingDecision && opts.routingDecision !== 'all') params.set('routingDecision', opts.routingDecision);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`${API_BASE}/api/knowledge/relations${suffix}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.relations ?? [];
}

export async function fetchTriggerCandidates(): Promise<TriggerCandidate[]> {
  const res = await fetch(`${API_BASE}/api/triggers/candidates`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.candidates ?? [];
}

export async function fetchTriggerHistory(): Promise<TriggerRun[]> {
  const res = await fetch(`${API_BASE}/api/triggers/history`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.history ?? [];
}

export async function acceptTriggerCandidateApi(id: string): Promise<{ rule: TriggerRule; notification: TriggerNotification } | null> {
  const res = await fetch(`${API_BASE}/api/triggers/${id}/accept`, { method: 'POST' });
  if (!res.ok) return null;
  return res.json();
}

export async function rejectTriggerCandidateApi(id: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/triggers/${id}/reject`, { method: 'POST' });
  return res.ok;
}

export async function snoozeTriggerCandidateApi(id: string, until?: number): Promise<TriggerCandidate | null> {
  const res = await fetch(`${API_BASE}/api/triggers/${id}/snooze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ until }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.candidate ?? null;
}

export async function scanTriggersApi(): Promise<TriggerCandidate[]> {
  const res = await fetch(`${API_BASE}/api/triggers/scan`, { method: 'POST' });
  if (!res.ok) return [];
  const data = await res.json();
  return data.candidates ?? [];
}

export async function resetTriggersApi(): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/triggers/reset`, { method: 'POST' });
  return res.ok;
}

export async function sendTestNotificationApi(payload?: Record<string, unknown>): Promise<TriggerNotification | null> {
  const res = await fetch(`${API_BASE}/api/notifications/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.notification ?? null;
}

export async function fetchCostSummary(month?: string): Promise<{
  month: string;
  summary: LLMCostSummary;
  providerRecords: ProviderCostRecord[];
} | null> {
  const params = new URLSearchParams();
  if (month) params.set('month', month);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`${API_BASE}/api/costs/summary${suffix}`);
  if (!res.ok) return null;
  return res.json();
}

export async function fetchSessionCost(sessionId: string): Promise<{
  sessionId: string;
  totalEstimatedUsd: number;
  events: LLMUsageEvent[];
  byProvider: Record<string, { estimatedUsd: number; totalTokens: number }>;
  byModel: Record<string, { estimatedUsd: number; totalTokens: number }>;
} | null> {
  const res = await fetch(`${API_BASE}/api/costs/session/${sessionId}`);
  if (!res.ok) return null;
  return res.json();
}

export async function syncProviderCosts(provider: 'openai' | 'anthropic', month?: string): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`${API_BASE}/api/costs/sync/${provider}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(month ? { month } : {}),
  });
  const data = await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }));
  if (!res.ok) return { ok: false, message: data?.message ?? data?.error ?? `HTTP ${res.status}` };
  return data;
}
