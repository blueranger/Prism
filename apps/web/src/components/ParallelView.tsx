'use client';

import { useEffect, useMemo, useState } from 'react';
import { MODELS } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';
import ResponsePanel from './ResponsePanel';

/** Provider-based badge colors */
const providerColors: Record<string, string> = {
  openai: 'bg-green-900/40 text-green-400 border-green-800',
  anthropic: 'bg-orange-900/40 text-orange-400 border-orange-800',
  google: 'bg-blue-900/40 text-blue-400 border-blue-800',
};

function getModeLabel(mode?: string | null): string | null {
  if (!mode || mode === 'parallel') return null;
  if (mode === 'observer') return 'Observer';
  if (mode === 'observer_review') return 'Review';
  if (mode === 'observer_alternative') return 'Alternative';
  if (mode === 'observer_synthesize') return 'Observer Synthesize';
  if (mode === 'handoff') return 'Handoff';
  if (mode === 'compare') return 'Compare';
  if (mode === 'synthesize') return 'Synthesize';
  return mode;
}

type ParallelLayoutMode = 'triple' | 'main_left' | 'split_two';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return target.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
}

export default function ParallelView() {
  const responses = useChatStore((s) => s.parallelResponses);
  const selectedModels = useChatStore((s) => s.selectedModels);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const sessionId = useChatStore((s) => s.sessionId);
  const timeline = useChatStore((s) => s.timeline);
  const thinkingConfig = useChatStore((s) => s.thinkingConfig);
  const reconcileCompletedResponse = useChatStore((s) => s.reconcileCompletedResponse);
  const [providerOrder, setProviderOrder] = useState<string[]>([]);
  const [hiddenProviders, setHiddenProviders] = useState<string[]>([]);
  const [draggingProvider, setDraggingProvider] = useState<string | null>(null);
  const [layoutMode, setLayoutMode] = useState<ParallelLayoutMode>('main_left');
  const [primaryProvider, setPrimaryProvider] = useState<string | null>(null);
  const providerSelections = new Map<string, string>(
    selectedModels.map((modelId) => [MODELS[modelId]?.provider ?? modelId, modelId] as [string, string]),
  );
  const activeProviders: string[] = Array.from(providerSelections.keys());

  useEffect(() => {
    try {
      const storedOrder = JSON.parse(localStorage.getItem('prism_parallelProviderOrder') ?? '[]') as string[];
      const storedHidden = JSON.parse(localStorage.getItem('prism_parallelHiddenProviders') ?? '[]') as string[];
      if (storedOrder.length > 0) {
        setProviderOrder(storedOrder);
      }
      if (storedHidden.length > 0) {
        setHiddenProviders(storedHidden);
      }
      const storedLayout = localStorage.getItem('prism_parallelLayoutMode');
      if (storedLayout === 'triple' || storedLayout === 'main_left' || storedLayout === 'split_two') {
        setLayoutMode(storedLayout);
      }
      const storedPrimary = localStorage.getItem('prism_parallelPrimaryProvider');
      if (storedPrimary) {
        setPrimaryProvider(storedPrimary);
      }
    } catch {}
  }, []);

  useEffect(() => {
    setProviderOrder((prev) => {
      const next = [...prev.filter((provider) => activeProviders.includes(provider))];
      for (const provider of activeProviders) {
        if (!next.includes(provider)) next.push(provider);
      }
      try {
        localStorage.setItem('prism_parallelProviderOrder', JSON.stringify(next));
      } catch {}
      return next;
    });
    setHiddenProviders((prev) => {
      const next = prev.filter((provider) => activeProviders.includes(provider));
      try {
        localStorage.setItem('prism_parallelHiddenProviders', JSON.stringify(next));
      } catch {}
      return next;
    });
  }, [selectedModels.join('|')]);

  useEffect(() => {
    if (!primaryProvider || !activeProviders.includes(primaryProvider)) {
      setPrimaryProvider(activeProviders[0] ?? null);
    }
  }, [activeProviders, primaryProvider]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (!event.altKey) return;

      if (event.key === '1') {
        event.preventDefault();
        setLayoutMode('triple');
        return;
      }
      if (event.key === '2') {
        event.preventDefault();
        setLayoutMode('main_left');
        return;
      }
      if (event.key === '3') {
        event.preventDefault();
        setLayoutMode('split_two');
        return;
      }
      if (event.key === '[' || event.key === 'ArrowLeft') {
        event.preventDefault();
        setPrimaryProvider((current) => {
          if (activeProviders.length === 0) return null;
          const currentIndex = current ? activeProviders.indexOf(current) : -1;
          const nextIndex = currentIndex <= 0 ? activeProviders.length - 1 : currentIndex - 1;
          return activeProviders[nextIndex] ?? activeProviders[0] ?? null;
        });
        return;
      }
      if (event.key === ']' || event.key === 'ArrowRight') {
        event.preventDefault();
        setPrimaryProvider((current) => {
          if (activeProviders.length === 0) return null;
          const currentIndex = current ? activeProviders.indexOf(current) : -1;
          const nextIndex = currentIndex === -1 || currentIndex >= activeProviders.length - 1 ? 0 : currentIndex + 1;
          return activeProviders[nextIndex] ?? activeProviders[0] ?? null;
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeProviders]);

  useEffect(() => {
    try {
      localStorage.setItem('prism_parallelLayoutMode', layoutMode);
    } catch {}
  }, [layoutMode]);

  useEffect(() => {
    try {
      if (primaryProvider) {
        localStorage.setItem('prism_parallelPrimaryProvider', primaryProvider);
      } else {
        localStorage.removeItem('prism_parallelPrimaryProvider');
      }
    } catch {}
  }, [primaryProvider]);

  useEffect(() => {
    for (const [model, resp] of Object.entries(responses)) {
      if (!resp?.done || !resp.content.trim()) continue;
      if (resp.streamStatus !== 'stalled' && resp.streamStatus !== 'retrying') continue;
      if (!['stop', 'STOP', 'end_turn'].includes(resp.stopReason ?? resp.debug?.stopReason ?? '')) continue;
      reconcileCompletedResponse(model, 'parallel');
    }
  }, [reconcileCompletedResponse, responses]);

  if (selectedModels.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600">
        Select at least one model to get started.
      </div>
    );
  }

  const hasResponses = Object.keys(responses).length > 0;

  // Empty state: no responses and not streaming
  if (!hasResponses && !isStreaming) {
    const emptyStateModels = Array.from(providerSelections.values());
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-md">
          <div className="text-gray-500 text-sm mb-4">
            Type a question below to get started
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {emptyStateModels.map((model) => {
              const config = MODELS[model];
              const colorCls = providerColors[config?.provider ?? ''] ?? 'bg-gray-800 text-gray-400 border-gray-700';
              const tc = thinkingConfig[model];
              const thinkingEnabled = tc?.enabled;

              // Build thinking detail label
              let thinkingLabel = '';
              if (thinkingEnabled && tc.effort) {
                thinkingLabel = tc.effort.charAt(0).toUpperCase() + tc.effort.slice(1);
              } else if (thinkingEnabled && tc.budgetTokens !== undefined) {
                thinkingLabel = tc.budgetTokens >= 1024
                  ? `${(tc.budgetTokens / 1024).toFixed(0)}K`
                  : `${tc.budgetTokens}`;
              }

              return (
                <span
                  key={model}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border ${colorCls}`}
                >
                  {config?.displayName ?? model}
                  {thinkingEnabled && (
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-semibold rounded-full bg-purple-900/60 text-purple-300 border border-purple-700/50">
                      💭{thinkingLabel ? ` ${thinkingLabel}` : ''}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
          <div className="text-gray-700 text-[10px] mt-3">
            Responses from {emptyStateModels.length} model{emptyStateModels.length > 1 ? 's' : ''} will appear here
          </div>
        </div>
      </div>
    );
  }

  const groupedResponses = new Map<string, string>();
  for (const model of Object.keys(responses)) {
    const provider = MODELS[model]?.provider ?? model;
    const preferred = providerSelections.get(provider);
    if (preferred && responses[preferred]) {
      groupedResponses.set(provider, preferred);
      continue;
    }
    if (!groupedResponses.has(provider)) {
      groupedResponses.set(provider, model);
    }
  }

  const orderedProviders = providerOrder.filter((provider) =>
    activeProviders.includes(provider) && groupedResponses.has(provider)
  );
  const visibleProviders = orderedProviders.filter((provider) => !hiddenProviders.includes(provider));
  const hiddenActiveProviders = orderedProviders.filter((provider) => hiddenProviders.includes(provider));
  const baseModelsToShow = hasResponses
    ? visibleProviders.map((provider) => groupedResponses.get(provider)!).filter(Boolean)
    : Array.from(providerSelections.values());
  const orderedModelsToShow = useMemo(() => {
    if (!primaryProvider) return baseModelsToShow;
    const primaryModel = groupedResponses.get(primaryProvider);
    if (!primaryModel || !baseModelsToShow.includes(primaryModel)) return baseModelsToShow;
    return [primaryModel, ...baseModelsToShow.filter((model) => model !== primaryModel)];
  }, [baseModelsToShow, groupedResponses, primaryProvider]);

  const visibleModels =
    layoutMode === 'split_two'
      ? orderedModelsToShow.slice(0, 2)
      : orderedModelsToShow;
  const collapsedByLayout = layoutMode === 'split_two' ? orderedModelsToShow.slice(2) : [];
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
      if (
        entry.role === 'assistant' &&
        entry.sourceModel &&
        selectedModels.includes(entry.sourceModel) &&
        (entry.mode === 'parallel' || entry.mode == null)
      ) {
        return [{
          id: entry.id,
          messageIndex: currentIndex,
          label: `${MODELS[entry.sourceModel]?.displayName ?? entry.sourceModel}`,
          meta: 'Result',
        }];
      }
      return [];
    });
  }, [selectedModels, timeline]);

  const persistOrder = (next: string[]) => {
    setProviderOrder(next);
    try {
      localStorage.setItem('prism_parallelProviderOrder', JSON.stringify(next));
    } catch {}
  };

  const persistHidden = (next: string[]) => {
    setHiddenProviders(next);
    try {
      localStorage.setItem('prism_parallelHiddenProviders', JSON.stringify(next));
    } catch {}
  };

  const reorderProvider = (from: string, to: string) => {
    if (from === to) return;
    const next = [...orderedProviders];
    const fromIndex = next.indexOf(from);
    const toIndex = next.indexOf(to);
    if (fromIndex === -1 || toIndex === -1) return;
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    const merged = [...next, ...providerOrder.filter((provider) => !next.includes(provider))];
    persistOrder(merged);
  };

  const hideProvider = (provider: string) => {
    if (hiddenProviders.includes(provider)) return;
    persistHidden([...hiddenProviders, provider]);
  };

  const showProvider = (provider: string) => {
    persistHidden(hiddenProviders.filter((item) => item !== provider));
  };

  const renderPanel = (model: string) => {
    const provider = MODELS[model]?.provider ?? model;
    const resp = responses[model];
    return (
      <ResponsePanel
        key={model}
        model={model}
        content={resp?.content ?? ''}
        done={resp?.done ?? false}
        error={resp?.error}
        stopReason={resp?.stopReason}
        modeLabel={getModeLabel(resp?.mode)}
        responseMode={resp?.mode}
        streamTarget="parallel"
        thinkingContent={resp?.thinkingContent}
        messageId={resp?.messageId}
        sessionId={sessionId ?? undefined}
        streamStatus={resp?.streamStatus}
        retryable={resp?.retryable}
        partialRetained={resp?.partialRetained}
        attempt={resp?.attempt}
        debug={resp?.debug}
        promptTokens={resp?.promptTokens}
        completionTokens={resp?.completionTokens}
        reasoningTokens={resp?.reasoningTokens}
        cachedTokens={resp?.cachedTokens}
        estimatedCostUsd={resp?.estimatedCostUsd}
        pricingSource={resp?.pricingSource}
        onHide={() => hideProvider(provider)}
        draggable={layoutMode === 'triple' && visibleModels.length > 1}
        onDragStart={() => setDraggingProvider(provider)}
        onDragOver={(e) => {
          e.preventDefault();
        }}
        onDrop={() => {
          if (!draggingProvider) return;
          reorderProvider(draggingProvider, provider);
          setDraggingProvider(null);
        }}
      />
    );
  };

  const primaryModel = orderedModelsToShow[0] ?? null;
  const secondaryModels = orderedModelsToShow.slice(1);

  return (
    <div className="flex-1 flex flex-col gap-3 min-h-0">
      <div className="rounded-xl border border-gray-800 bg-gray-900/70 px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-cyan-400">Parallel Mode</div>
            <div className="text-xs text-gray-500">
              `Alt+1` triple · `Alt+2` main-left · `Alt+3` split-two · `Alt+[ / ]` switch primary
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {[
              { id: 'triple', label: '3-Up' },
              { id: 'main_left', label: 'Main + Stack' },
              { id: 'split_two', label: '2-Up + Collapse' },
            ].map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setLayoutMode(option.id as ParallelLayoutMode)}
                className={`rounded border px-2.5 py-1 text-xs transition-colors ${
                  layoutMode === option.id
                    ? 'border-cyan-700 bg-cyan-950/30 text-cyan-200'
                    : 'border-gray-700 text-gray-300 hover:bg-gray-800'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        {orderedModelsToShow.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-gray-500">Primary</span>
            {orderedModelsToShow.map((model) => {
              const provider = MODELS[model]?.provider ?? model;
              const active = provider === primaryProvider;
              return (
                <button
                  key={model}
                  type="button"
                  onClick={() => setPrimaryProvider(provider)}
                  className={`rounded border px-2 py-1 text-xs transition-colors ${
                    active
                      ? 'border-indigo-700 bg-indigo-950/40 text-indigo-200'
                      : 'border-gray-700 text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  {MODELS[model]?.displayName ?? model}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {hiddenActiveProviders.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/70 px-3 py-2">
          <span className="text-xs text-gray-500">Hidden panels</span>
          {hiddenActiveProviders.map((provider) => {
            const model = groupedResponses.get(provider) ?? providerSelections.get(provider) ?? provider;
            const label = MODELS[model]?.displayName ?? provider;
            return (
              <button
                key={provider}
                type="button"
                onClick={() => showProvider(provider)}
                className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 transition-colors hover:bg-gray-800"
              >
                Show {label}
              </button>
            );
          })}
        </div>
      )}

      {collapsedByLayout.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/70 px-3 py-2">
          <span className="text-xs text-gray-500">Collapsed by layout</span>
          {collapsedByLayout.map((model) => (
            <button
              key={model}
              type="button"
              onClick={() => setPrimaryProvider(MODELS[model]?.provider ?? model)}
              className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 transition-colors hover:bg-gray-800"
            >
              Focus {MODELS[model]?.displayName ?? model}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 flex gap-4 min-h-0 overflow-hidden">
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
          {layoutMode === 'triple' ? (
            <div className="flex h-full gap-4 min-h-0">
              {visibleModels.map((model) => renderPanel(model))}
            </div>
          ) : layoutMode === 'main_left' ? (
            primaryModel ? (
              <div className="flex h-full gap-4 min-h-0">
                <div className="flex-[1.7] min-w-0 min-h-0">{renderPanel(primaryModel)}</div>
                {secondaryModels.length > 0 && (
                  <div className="w-[380px] min-h-0 flex-shrink-0 flex flex-col gap-4">
                    {secondaryModels.slice(0, 2).map((model) => (
                      <div key={model} className="flex-1 min-h-0">
                        {renderPanel(model)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null
          ) : (
            <div className="flex h-full gap-4 min-h-0">
              {visibleModels.map((model) => (
                <div key={model} className="flex-1 min-w-0 min-h-0">
                  {renderPanel(model)}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="w-[260px] min-h-0 flex-shrink-0 rounded-xl border border-gray-800 bg-gray-900/70 p-3 overflow-hidden flex flex-col">
          <div className="mb-3">
            <div className="text-sm font-semibold text-gray-200">Outline</div>
            <div className="text-xs text-gray-500">Jump between requests and model results in this parallel session.</div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
            {outlineItems.length === 0 ? (
              <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2 text-xs text-gray-500">
                Outline entries will appear as the session grows.
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

      {hasResponses && visibleModels.length === 0 && (
        <div className="flex-1 flex items-center justify-center rounded-lg border border-dashed border-gray-800 bg-gray-900/40 text-sm text-gray-500">
          All response panels are hidden. Use the buttons above to show them again.
        </div>
      )}
    </div>
  );
}
