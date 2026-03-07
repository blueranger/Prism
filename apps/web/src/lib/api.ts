import { useChatStore } from '@/stores/chat-store';
import type { AgentPlanStep } from '@/stores/chat-store';
import type { TimelineEntry, AgentTask, FlowGraph, Session, SessionLink, Decision, DecisionType, ClassificationResult, ConnectorStatus, ExternalThread, ExternalMessage, DraftReply, SenderLearningStats, MonitorRule, MonitorRuleConditions, MonitorAction, MonitorRuleActionConfig, CommProvider, UploadedFile } from '@prism/shared';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

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
      // Mark all streaming models as errored
      for (const key of Object.keys(store.responses)) {
        if (!store.responses[key].done) {
          store.markDone(key, errMsg);
        }
      }
    } catch {
      // Can't parse error body
    }
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
        store.finishStreaming();
        // Refresh timeline after streaming completes
        if (store.sessionId) {
          fetchTimeline(store.sessionId);
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

        if (parsed.type === 'handoff' || parsed.type === 'compare_start' || parsed.type === 'synthesize_start') {
          if (parsed.type === 'compare_start' && parsed.originContent) {
            store.setCompareOrigin(parsed.originModel, parsed.originContent);
          }
          continue;
        }

        if (parsed.error && !parsed.model) {
          console.error('[consumeSSE] Global error:', parsed.error);
          store.finishStreaming();
          return;
        }

        if (parsed.done) {
          console.log(`[consumeSSE] ${parsed.model} done (error=${parsed.error ?? 'none'})`);
          store.markDone(parsed.model, parsed.error);
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

  // Only include thinking config for models that have it enabled
  const activeThinking: Record<string, any> = {};
  for (const model of selectedModels) {
    const tc = thinkingConfig[model];
    if (tc?.enabled) {
      activeThinking[model] = tc;
    }
  }

  try {
    const response = await fetch(`${API_BASE}/api/prompt/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    // Mark all models as errored so UI doesn't stay stuck
    for (const model of selectedModels) {
      store.markDone(model, `Connection failed: ${err.message ?? 'Network error'}`);
    }
    store.finishStreaming();
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

  const response = await fetch(`${API_BASE}/api/handoff/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      fromModel: handoffFromModel,
      toModel: handoffToModel,
      instruction: instruction || undefined,
    }),
  });

  await consumeSSE(response);
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

  store.startStreamingFor(criticModels);

  const response = await fetch(`${API_BASE}/api/compare/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      originModel,
      criticModels,
      instruction: instruction || undefined,
    }),
  });

  await consumeSSE(response);
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

  store.startStreamingFor([synthesizerModel]);

  const response = await fetch(`${API_BASE}/api/synthesize/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      sourceModels,
      synthesizerModel,
      instruction: instruction || undefined,
    }),
  });

  await consumeSSE(response);
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
    const messages: { role: string; content: string; sourceModel: string; mode?: string }[] = data.messages ?? [];

    if (messages.length === 0) return false;

    const store = useChatStore.getState();
    store.setSessionId(sessionId);

    // Rebuild responses from the latest assistant messages per model
    const latestByModel: Record<string, string> = {};
    let lastSynthesizerModel: string | null = null;

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        latestByModel[msg.sourceModel] = msg.content;

        // Track the most recent synthesize result so we can restore it
        if (msg.mode === 'synthesize') {
          lastSynthesizerModel = msg.sourceModel;
        }
      }
    }

    const responses: Record<string, import('@/stores/chat-store').ModelResponse> = {};
    for (const [model, content] of Object.entries(latestByModel)) {
      responses[model] = { model, content, done: true };
    }
    store.clearResponses();
    // Set responses directly via Zustand set
    useChatStore.setState({ responses });

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
export async function deleteSessionApi(id: string): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${id}`, { method: 'DELETE' });
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
  platform: 'chatgpt' | 'claude' | 'gemini'
): Promise<any> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('platform', platform);

  const res = await fetch(`${API_BASE}/api/import/upload`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
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
export async function createSession(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/sessions`, { method: 'POST' });
    if (!res.ok) return null;
    const data = await res.json();
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
  registry: { staticCount: number; discoveredCount: number; lastRefreshedAt: number | null };
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

export async function refreshModels(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/models/refresh`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
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
