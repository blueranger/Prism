'use client';

import { MODELS } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';
import ResponsePanel from './ResponsePanel';

/** Provider-based badge colors */
const providerColors: Record<string, string> = {
  openai: 'bg-green-900/40 text-green-400 border-green-800',
  anthropic: 'bg-orange-900/40 text-orange-400 border-orange-800',
  google: 'bg-blue-900/40 text-blue-400 border-blue-800',
};

export default function ParallelView() {
  const responses = useChatStore((s) => s.responses);
  const selectedModels = useChatStore((s) => s.selectedModels);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const sessionId = useChatStore((s) => s.sessionId);
  const thinkingConfig = useChatStore((s) => s.thinkingConfig);

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
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-md">
          <div className="text-gray-500 text-sm mb-4">
            Type a question below to get started
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {selectedModels.map((model) => {
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
            Responses from {selectedModels.length} model{selectedModels.length > 1 ? 's' : ''} will appear here
          </div>
        </div>
      </div>
    );
  }

  const modelsToShow = hasResponses ? Object.keys(responses) : selectedModels;

  return (
    <div className="flex-1 flex gap-4 min-h-0">
      {modelsToShow.map((model) => {
        const resp = responses[model];
        return (
          <ResponsePanel
            key={model}
            model={model}
            content={resp?.content ?? ''}
            done={resp?.done ?? false}
            error={resp?.error}
            thinkingContent={resp?.thinkingContent}
            messageId={`response-${model}-${Date.now()}`}
            sessionId={sessionId ?? undefined}
          />
        );
      })}
    </div>
  );
}
