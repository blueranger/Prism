'use client';

import { useEffect, useMemo, useState } from 'react';
import { MODELS, type ObserverSnapshot } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';
import { fetchObserverState, fetchTimeline, retryModelResponse, runObserverAction, updateObserverConfigApi } from '@/lib/api';
import Timeline from './Timeline';
import ResponsePanel from './ResponsePanel';

function formatSnapshotTime(timestamp?: number | null): string {
  if (!timestamp) return 'Not captured yet';
  return new Date(timestamp).toLocaleString();
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">{children}</div>;
}

function formatDebugSummary(
  debug?: {
    chunkCount: number;
    contentChars: number;
    thinkingChars: number;
    stopReason?: string;
    providerError?: string;
    lastEvent?: string;
    note?: string;
  } | null,
) {
  if (!debug) return null;
  const parts = [
    `chunks ${debug.chunkCount}`,
    `content ${debug.contentChars} chars`,
    `thinking ${debug.thinkingChars} chars`,
  ];
  if (debug.stopReason) parts.push(`stop ${debug.stopReason}`);
  if (debug.lastEvent) parts.push(`event ${debug.lastEvent}`);
  return parts.join(' · ');
}

function extractJsonStringField(raw: string, field: string): string | null {
  const match = raw.match(new RegExp(`"${field}"\\s*:\\s*"([\\s\\S]*?)(?:"\\s*,\\s*"|\"\\s*}\\s*$|$)`, 'i'));
  if (!match?.[1]) return null;
  return match[1]
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .trim();
}

function normalizeLegacySnapshot(snapshot?: ObserverSnapshot) {
  if (!snapshot) return null;

  const rawSummary = String(snapshot.summary ?? '').trim();
  const looksStructured =
    rawSummary.startsWith('```') ||
    rawSummary.startsWith('{') ||
    rawSummary.includes('"summary"') ||
    rawSummary.includes('"risks"') ||
    rawSummary.includes('"disagreements"');

  if (!looksStructured) {
    return {
      summary: rawSummary,
      risks: snapshot.risks ?? [],
      disagreements: snapshot.disagreements ?? [],
      suggestedFollowUp: snapshot.suggestedFollowUp ?? null,
    };
  }

  const cleaned = rawSummary
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as {
      summary?: unknown;
      risks?: unknown;
      disagreements?: unknown;
      suggestedFollowUp?: unknown;
    };
    return {
      summary: String(parsed.summary ?? '').trim() || rawSummary,
      risks:
        Array.isArray(parsed.risks) && parsed.risks.length > 0
          ? parsed.risks.map((value) => String(value).trim()).filter(Boolean)
          : (snapshot.risks ?? []),
      disagreements:
        Array.isArray(parsed.disagreements) && parsed.disagreements.length > 0
          ? parsed.disagreements.map((value) => String(value).trim()).filter(Boolean)
          : (snapshot.disagreements ?? []),
      suggestedFollowUp:
        typeof parsed.suggestedFollowUp === 'string' && parsed.suggestedFollowUp.trim()
          ? parsed.suggestedFollowUp.trim()
          : (snapshot.suggestedFollowUp ?? null),
    };
  } catch {
    const extractedSummary = extractJsonStringField(cleaned, 'summary');
    return {
      summary: extractedSummary || rawSummary.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim(),
      risks: snapshot.risks ?? [],
      disagreements: snapshot.disagreements ?? [],
      suggestedFollowUp: snapshot.suggestedFollowUp ?? null,
    };
  }
}

export default function ObserverPanel() {
  const sessionId = useChatStore((s) => s.sessionId);
  const currentSession = useChatStore((s) => s.currentSession);
  const selectedModels = useChatStore((s) => s.selectedModels);
  const timeline = useChatStore((s) => s.timeline);
  const observerActiveModel = useChatStore((s) => s.observerActiveModel);
  const observerModels = useChatStore((s) => s.observerModels);
  const observerSnapshots = useChatStore((s) => s.observerSnapshots);
  const observerStatuses = useChatStore((s) => s.observerStatuses);
  const observerResponses = useChatStore((s) => s.observerResponses);
  const observerActionLoading = useChatStore((s) => s.observerActionLoading);
  const setObserverConfig = useChatStore((s) => s.setObserverConfig);
  const setCurrentSession = useChatStore((s) => s.setCurrentSession);
  const setSelectedModels = useChatStore((s) => s.setSelectedModels);
  const setObserverSnapshots = useChatStore((s) => s.setObserverSnapshots);
  const setObserverActionLoading = useChatStore((s) => s.setObserverActionLoading);
  const keepPartial = useChatStore((s) => s.keepPartial);
  const reconcileCompletedResponse = useChatStore((s) => s.reconcileCompletedResponse);
  const [actionStatusMessage, setActionStatusMessage] = useState<string | null>(null);
  const [retryingActive, setRetryingActive] = useState(false);

  useEffect(() => {
    if (currentSession?.interactionMode === 'observer' && currentSession.activeModel) {
      setObserverConfig(currentSession.activeModel, currentSession.observerModels ?? []);
      return;
    }

    if (!observerActiveModel && selectedModels.length > 0) {
      setObserverConfig(selectedModels[0], selectedModels.slice(1, 3));
    }
  }, [currentSession?.activeModel, currentSession?.interactionMode, currentSession?.observerModels, observerActiveModel, selectedModels, setObserverConfig]);

  useEffect(() => {
    if (!sessionId) return;
    if (currentSession?.interactionMode !== 'observer') return;
    fetchObserverState(sessionId).then((state) => {
      setObserverSnapshots(state?.snapshots ?? []);
    });
  }, [currentSession?.interactionMode, sessionId, setObserverSnapshots]);

  const activeModel = observerActiveModel ?? selectedModels[0] ?? null;
  const activeResponse = activeModel ? observerResponses[activeModel] : null;
  const latestUserEntry = useMemo(
    () => [...timeline].reverse().find((entry) => entry.type === 'message' && entry.role === 'user') ?? null,
    [timeline],
  );
  const hasAssistantAfterLatestUser = useMemo(() => {
    if (!latestUserEntry) return false;
    const idx = timeline.findIndex((entry) => entry.id === latestUserEntry.id);
    if (idx === -1) return false;
    return timeline.slice(idx + 1).some((entry) => entry.type === 'message' && entry.role === 'assistant');
  }, [latestUserEntry, timeline]);
  const hasCompletedActiveAssistantAfterLatestUser = useMemo(() => {
    if (!activeModel || !latestUserEntry) return false;
    const idx = timeline.findIndex((entry) => entry.id === latestUserEntry.id);
    if (idx === -1) return false;
    return timeline.slice(idx + 1).some((entry) => (
      entry.type === 'message' &&
      entry.role === 'assistant' &&
      entry.sourceModel === activeModel &&
      entry.mode === 'observer'
    ));
  }, [activeModel, latestUserEntry, timeline]);
  const inferredActiveFailure = useMemo(() => {
    if (!activeModel || hasCompletedActiveAssistantAfterLatestUser) return null;
    const relevantSnapshots = Object.values(observerSnapshots)
      .filter((snapshot) => snapshot.activeModel === activeModel)
      .sort((a, b) => b.capturedAt - a.capturedAt);
    const latestSnapshot = relevantSnapshots[0];
    if (!latestSnapshot) return null;
    const summary = latestSnapshot.summary?.toLowerCase() ?? '';
    const errorText = latestSnapshot.error?.trim();
    const clearlyMissing =
      latestSnapshot.status === 'error' ||
      summary.includes('empty or missing') ||
      summary.includes('failed') ||
      latestSnapshot.risks.some((risk) => /no actual answer|no answer content|empty/i.test(risk));
    if (!clearlyMissing) return null;
    return errorText || latestSnapshot.summary || 'The active model did not produce a visible response.';
  }, [activeModel, hasCompletedActiveAssistantAfterLatestUser, observerSnapshots]);
  const activeHasVisibleContent = Boolean(activeResponse?.content?.trim());
  const activeStopReason = activeResponse?.stopReason ?? activeResponse?.debug?.stopReason;
  const activeFinishedSuccessfully =
    Boolean(activeResponse?.done) &&
    activeHasVisibleContent &&
    !activeResponse?.error &&
    ['stop', 'STOP', 'end_turn'].includes(activeStopReason ?? '');
  const showActiveStalledBanner =
    Boolean(activeResponse) &&
    !hasCompletedActiveAssistantAfterLatestUser &&
    !activeFinishedSuccessfully &&
    (activeResponse?.streamStatus === 'stalled' || activeResponse?.streamStatus === 'retrying');
  const showActiveFailedBanner =
    !showActiveStalledBanner &&
    !activeFinishedSuccessfully &&
    (
      (Boolean(activeResponse) && Boolean(activeResponse?.done) && Boolean(activeResponse?.error) && !activeHasVisibleContent) ||
      Boolean(inferredActiveFailure)
    );
  const outlineItems = useMemo(() => {
    let messageIndex = 0;
    return timeline.flatMap((entry) => {
      if (entry.type === 'handoff') return [];
      const currentIndex = messageIndex++;
      if (entry.role === 'user') {
        return [{
          id: entry.id,
          messageIndex: currentIndex,
          label: entry.content.split('\n').find(Boolean)?.trim() || 'User request',
          meta: 'Request',
        }];
      }
      if (entry.mode === 'observer_review' || entry.mode === 'observer_alternative' || entry.mode === 'observer_synthesize') {
        const actionLabel =
          entry.mode === 'observer_review'
            ? 'Review'
            : entry.mode === 'observer_alternative'
              ? 'Alternative'
              : 'Synthesize';
        return [{
          id: entry.id,
          messageIndex: currentIndex,
          label: `${MODELS[entry.sourceModel]?.displayName ?? entry.sourceModel} ${actionLabel}`,
          meta: actionLabel,
        }];
      }
      return [];
    });
  }, [timeline]);
  const activeDebugSummary = formatDebugSummary(activeResponse?.debug);
  const showPendingActiveResponse =
    Boolean(activeResponse?.content?.trim()) &&
    !hasCompletedActiveAssistantAfterLatestUser;

  useEffect(() => {
    if (!activeModel || !activeResponse) return;
    if (!hasCompletedActiveAssistantAfterLatestUser) return;
    if (!activeResponse.content.trim()) return;
    if (activeResponse.streamStatus !== 'stalled' && activeResponse.streamStatus !== 'retrying') return;
    reconcileCompletedResponse(activeModel, 'observer');
  }, [activeModel, activeResponse, hasCompletedActiveAssistantAfterLatestUser, reconcileCompletedResponse]);

  const handleSwitchActive = async (nextActive: string) => {
    if (!sessionId) {
      setObserverConfig(nextActive, [activeModel, ...observerModels].filter(Boolean).filter((model): model is string => model !== nextActive).slice(0, 2));
      return;
    }

    const nextObservers = [activeModel, ...observerModels]
      .filter(Boolean)
      .filter((model): model is string => model !== nextActive)
      .slice(0, 2);
    const updated = await updateObserverConfigApi(sessionId, {
      activeModel: nextActive,
      observerModels: nextObservers,
    });
    const resolvedActive = updated?.activeModel ?? nextActive;
    const resolvedObservers = updated?.observerModels ?? nextObservers;
    setObserverConfig(resolvedActive, resolvedObservers);
    if (updated) {
      setCurrentSession(updated);
    }
    const reorderedSelectedModels = [resolvedActive, ...resolvedObservers, ...selectedModels]
      .filter((model, index, array): model is string => Boolean(model) && array.indexOf(model) === index)
      .slice(0, 3);
    setSelectedModels(reorderedSelectedModels);
  };

  const handleAction = async (model: string, action: 'review' | 'alternative' | 'synthesize') => {
    if (!sessionId) return;
    setObserverActionLoading(`${action}:${model}`);
    const modelLabel = MODELS[model]?.displayName ?? model;
    const actionLabel = action === 'review' ? 'Review' : action === 'alternative' ? 'Alternative' : 'Synthesize';
    setActionStatusMessage(`Generating ${actionLabel} with ${modelLabel}...`);
    try {
      const ok = await runObserverAction(sessionId, action, model);
      if (ok) {
        await fetchTimeline(sessionId);
        setActionStatusMessage(`${actionLabel} from ${modelLabel} is ready.`);
      } else {
        setActionStatusMessage(`${actionLabel} from ${modelLabel} failed.`);
      }
    } finally {
      setObserverActionLoading(null);
      window.setTimeout(() => setActionStatusMessage(null), 3000);
    }
  };

  const handleRetryActive = async () => {
    if (!activeModel) return;
    setRetryingActive(true);
    setActionStatusMessage(`Retrying ${MODELS[activeModel]?.displayName ?? activeModel}...`);
    try {
      const ok = await retryModelResponse('observer', activeModel);
      setActionStatusMessage(
        ok
          ? `${MODELS[activeModel]?.displayName ?? activeModel} resumed.`
          : `Retry failed for ${MODELS[activeModel]?.displayName ?? activeModel}.`,
      );
    } finally {
      setRetryingActive(false);
      window.setTimeout(() => setActionStatusMessage(null), 3000);
    }
  };

  if (!activeModel) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600">
        Select at least one model to use Observer mode.
      </div>
    );
  }

  return (
    <div className="flex-1 flex gap-4 min-h-0 overflow-hidden">
      <div className="flex-1 min-w-0 min-h-0 flex gap-4 overflow-hidden">
        <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
        <div className="mb-3 flex items-center justify-between rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-4 py-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-emerald-400">Observer Mode</div>
            <div className="text-sm text-gray-300">
              Active model: <span className="font-semibold text-white">{MODELS[activeModel]?.displayName ?? activeModel}</span>
            </div>
          </div>
          <div className="text-xs text-gray-500">
            {observerModels.length} observer{observerModels.length === 1 ? '' : 's'} synced
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden rounded-xl border border-gray-800 bg-gray-900/70 flex flex-col">
          <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-gray-200">Conversation</div>
              <div className="text-xs text-gray-500">Your messages and AI responses appear here in one continuous chat flow.</div>
            </div>
            <div className="text-xs text-gray-500">
              Active: <span className="text-gray-300">{MODELS[activeModel]?.displayName ?? activeModel}</span>
            </div>
          </div>
          {actionStatusMessage && (
            <div className="border-b border-gray-800 bg-indigo-950/30 px-4 py-2 text-xs text-indigo-200">
              {actionStatusMessage}
            </div>
          )}
          {showActiveStalledBanner && activeResponse && (
            <div className="border-b border-gray-800 bg-amber-950/20 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold uppercase tracking-wider text-amber-300">
                    {activeResponse.streamStatus === 'retrying' ? 'Retrying active response' : 'Active response stalled'}
                  </div>
                  <div className="mt-1 text-xs text-amber-100/90">
                    {activeResponse.streamStatus === 'retrying'
                      ? `We are retrying ${MODELS[activeModel]?.displayName ?? activeModel} in the same shared session.`
                      : `The latest reply from ${MODELS[activeModel]?.displayName ?? activeModel} stopped mid-stream. Partial output is preserved.`}
                  </div>
                  {activeDebugSummary && (
                    <div className="mt-2 rounded border border-amber-900/40 bg-black/20 px-2 py-1 font-mono text-[11px] text-amber-200/90">
                      {activeDebugSummary}
                    </div>
                  )}
                  {activeResponse?.debug?.providerError && (
                    <div className="mt-1 rounded border border-amber-900/40 bg-black/20 px-2 py-1 font-mono text-[11px] text-amber-100/90">
                      provider error: {activeResponse.debug.providerError}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {activeResponse.streamStatus === 'stalled' && activeResponse.retryable && (
                    <>
                      <button
                        type="button"
                        onClick={handleRetryActive}
                        disabled={retryingActive}
                        className="rounded border border-amber-700 px-2 py-1 text-xs text-amber-200 transition-colors hover:bg-amber-900/20 disabled:opacity-50"
                      >
                        Retry
                      </button>
                      <button
                        type="button"
                        onClick={() => keepPartial(activeModel, 'observer')}
                        className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 transition-colors hover:bg-gray-800"
                      >
                        Keep Partial
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
          {showActiveFailedBanner ? (
            <div className="border-b border-gray-800 bg-red-950/20 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold uppercase tracking-wider text-red-300">
                    Active response failed
                  </div>
                  <div className="mt-1 text-xs text-red-100/90">
                    {activeResponse?.error || inferredActiveFailure}
                  </div>
                  {activeDebugSummary && (
                    <div className="mt-2 rounded border border-red-900/40 bg-black/20 px-2 py-1 font-mono text-[11px] text-red-200/90">
                      {activeDebugSummary}
                    </div>
                  )}
                  {activeResponse?.debug?.providerError && (
                    <div className="mt-1 rounded border border-red-900/40 bg-black/20 px-2 py-1 font-mono text-[11px] text-red-100/90">
                      provider error: {activeResponse.debug.providerError}
                    </div>
                  )}
                  {activeResponse?.debug?.note && (
                    <div className="mt-1 text-[11px] text-red-100/70">
                      {activeResponse.debug.note}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleRetryActive}
                    disabled={retryingActive}
                    className="rounded border border-red-700 px-2 py-1 text-xs text-red-200 transition-colors hover:bg-red-900/20 disabled:opacity-50"
                  >
                    Retry
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          <div className="flex-1 min-h-0 overflow-hidden p-3 flex flex-col">
            {showPendingActiveResponse && activeResponse && activeModel && (
              <div className="mb-3">
                <ResponsePanel
                  model={activeModel}
                  content={activeResponse.content}
                  done={activeResponse.done}
                  error={activeResponse.error}
                  stopReason={activeResponse.stopReason}
                  modeLabel={null}
                  responseMode={activeResponse.mode ?? 'observer'}
                  streamTarget="observer"
                  messageId={activeResponse.messageId}
                  sessionId={sessionId ?? undefined}
                  streamStatus={activeResponse.streamStatus}
                  retryable={activeResponse.retryable}
                  partialRetained={activeResponse.partialRetained}
                  attempt={activeResponse.attempt}
                  debug={activeResponse.debug}
                  thinkingContent={activeResponse.thinkingContent}
                  promptTokens={activeResponse.promptTokens}
                  completionTokens={activeResponse.completionTokens}
                  reasoningTokens={activeResponse.reasoningTokens}
                  cachedTokens={activeResponse.cachedTokens}
                  estimatedCostUsd={activeResponse.estimatedCostUsd}
                  pricingSource={activeResponse.pricingSource}
                />
              </div>
            )}
            <Timeline />
          </div>
        </div>
      </div>

        <div className="w-[260px] min-h-0 flex-shrink-0 rounded-xl border border-gray-800 bg-gray-900/70 p-3 overflow-hidden flex flex-col">
          <div className="mb-3">
            <div className="text-sm font-semibold text-gray-200">Outline</div>
            <div className="text-xs text-gray-500">Jump to each user request and observer-generated result.</div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
            {outlineItems.length === 0 ? (
              <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2 text-xs text-gray-500">
                Outline entries will appear as the conversation grows.
              </div>
            ) : (
              outlineItems.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    useChatStore.getState().setOutlineHighlightRange({
                      start: item.messageIndex,
                      end: item.messageIndex,
                    });
                    useChatStore.getState().setOutlineScrollTarget(item.messageIndex);
                  }}
                  className="w-full rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2 text-left transition-colors hover:border-gray-700 hover:bg-gray-900"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-[10px] font-mono text-gray-600">{index + 1}</span>
                    <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">{item.meta}</span>
                  </div>
                  <div className="line-clamp-2 text-xs font-medium text-gray-200">{item.label}</div>
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="w-[340px] min-h-0 flex-shrink-0 rounded-xl border border-gray-800 bg-gray-900/70 p-3 overflow-y-auto">
        <div className="mb-3">
          <div className="text-sm font-semibold text-gray-200">Observers</div>
          <div className="text-xs text-gray-500">They stay synced with the conversation and speak only when asked.</div>
        </div>

        <div className="space-y-3">
          {observerModels.map((model) => {
            const snapshot = observerSnapshots[model];
            const displaySnapshot = normalizeLegacySnapshot(snapshot);
            const status = observerStatuses[model] ?? 'idle';
            const loading = observerActionLoading?.endsWith(`:${model}`);
            return (
              <div key={model} className="rounded-lg border border-gray-800 bg-gray-950/60 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-gray-200">{MODELS[model]?.displayName ?? model}</div>
                    <div className="text-[11px] text-gray-500">
                      {status === 'ready' ? `Synced ${formatSnapshotTime(snapshot?.capturedAt)}` : status}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSwitchActive(model)}
                    className="rounded border border-gray-700 px-2 py-1 text-[10px] uppercase tracking-wide text-gray-300 transition-colors hover:bg-gray-800"
                  >
                    Make Active
                  </button>
                </div>

                <div className="space-y-3 text-xs text-gray-300">
                  <div>
                    <SectionLabel>Summary</SectionLabel>
                    <p className="leading-relaxed text-gray-300">{displaySnapshot?.summary ?? 'No observer snapshot yet.'}</p>
                  </div>

                  {displaySnapshot?.risks?.length ? (
                    <div>
                      <SectionLabel>Concerns</SectionLabel>
                      <div className="space-y-1.5">
                        {displaySnapshot.risks.map((risk, index) => (
                          <div key={index} className="rounded-lg border border-amber-800 bg-amber-950/30 px-2.5 py-2 text-[11px] leading-relaxed text-amber-200">
                            {risk}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {displaySnapshot?.disagreements?.length ? (
                    <div>
                      <SectionLabel>Disagreements</SectionLabel>
                      <div className="space-y-1.5">
                        {displaySnapshot.disagreements.map((item, index) => (
                          <div key={index} className="rounded-lg border border-purple-800 bg-purple-950/30 px-2.5 py-2 text-[11px] leading-relaxed text-purple-200">
                            {item}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {displaySnapshot?.suggestedFollowUp ? (
                    <div>
                      <SectionLabel>Suggested Follow-up</SectionLabel>
                      <div className="rounded-lg border border-cyan-900/60 bg-cyan-950/20 px-2.5 py-2 text-[11px] leading-relaxed text-cyan-200">
                        {displaySnapshot.suggestedFollowUp}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={!sessionId || loading}
                    onClick={() => handleAction(model, 'review')}
                    className="rounded border border-gray-700 px-2 py-1.5 text-xs text-gray-200 transition-colors hover:bg-gray-800 disabled:opacity-50"
                  >
                    Review
                  </button>
                  <button
                    type="button"
                    disabled={!sessionId || loading}
                    onClick={() => handleAction(model, 'alternative')}
                    className="rounded border border-gray-700 px-2 py-1.5 text-xs text-gray-200 transition-colors hover:bg-gray-800 disabled:opacity-50"
                  >
                    Alternative
                  </button>
                  <button
                    type="button"
                    disabled={!sessionId || loading}
                    onClick={() => handleAction(model, 'synthesize')}
                    className="col-span-2 rounded border border-indigo-800 bg-indigo-950/30 px-2 py-1.5 text-xs text-indigo-200 transition-colors hover:bg-indigo-900/40 disabled:opacity-50"
                  >
                    Synthesize With This Model
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
