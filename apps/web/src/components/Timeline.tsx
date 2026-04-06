'use client';

import { useEffect, useState, useRef } from 'react';
import { MODELS, type TimelineEntry } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';
import { promoteToMemory } from '@/lib/api';
import MarkdownContent from './MarkdownContent';
import ResponsePanel from './ResponsePanel';

interface TimelineProps {
  entries?: TimelineEntry[];
}

function UserMessageActions({
  entry,
  sessionId,
}: {
  entry: TimelineEntry;
  sessionId?: string;
}) {
  const [promoting, setPromoting] = useState(false);

  if (!sessionId || entry.type !== 'message' || entry.role !== 'user' || !entry.content.trim()) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={async () => {
        setPromoting(true);
        try {
          const result = await promoteToMemory({
            sessionId,
            messageId: entry.id,
            content: entry.content,
            title: 'User message',
            summary: entry.content.slice(0, 220),
          });
          try {
            const candidates = result?.candidates ?? [];
            if (candidates.length > 0) {
              sessionStorage.setItem('prism:memory:focus-candidates', JSON.stringify(candidates.map((candidate) => candidate.id)));
            }
            if (result) {
              sessionStorage.setItem(
                'prism:memory:last-action',
                JSON.stringify({
                  message: result.added > 0
                    ? `Added ${result.added} memory candidate${result.added === 1 ? '' : 's'}${result.skippedDuplicates > 0 ? ` and skipped ${result.skippedDuplicates} duplicate${result.skippedDuplicates === 1 ? '' : 's'}` : ''}.`
                    : `No new memory candidates were added${result.skippedDuplicates > 0 ? `; skipped ${result.skippedDuplicates} duplicate${result.skippedDuplicates === 1 ? '' : 's'}` : ''}.`,
                }),
              );
            }
          } catch {}
          useChatStore.getState().setMode('memory');
        } finally {
          setPromoting(false);
        }
      }}
      className="rounded border border-indigo-700 px-1.5 py-0.5 text-[10px] text-indigo-200 transition-colors hover:bg-indigo-900/20 disabled:opacity-50"
      disabled={promoting}
      title="Promote this user message into the memory review queue"
    >
      {promoting ? 'Promoting...' : 'Promote to Memory'}
    </button>
  );
}

export default function Timeline({ entries }: TimelineProps) {
  const timelineFromStore = useChatStore((s) => s.timeline);
  const scrollTarget = useChatStore((s) => s.outlineScrollTarget);
  const highlightRange = useChatStore((s) => s.outlineHighlightRange);
  const sessionId = useChatStore((s) => s.sessionId);
  const containerRef = useRef<HTMLDivElement>(null);
  const timeline = entries ?? timelineFromStore;

  // Scroll to target message when outline section is clicked
  useEffect(() => {
    if (scrollTarget === null || !containerRef.current) return;

    const targetEl = containerRef.current.querySelector(
      `[data-message-index="${scrollTarget}"]`
    );
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // Clear the scroll target after scrolling
    const timer = setTimeout(() => {
      useChatStore.getState().setOutlineScrollTarget(null);
    }, 500);
    return () => clearTimeout(timer);
  }, [scrollTarget]);

  if (timeline.length === 0) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center text-gray-600 text-sm">
        Conversation timeline will appear here.
      </div>
    );
  }

  // Track message index (skip handoff entries)
  let messageIndex = 0;

  const modeLabel = (mode?: string | null): string | null => {
    if (!mode || mode === 'observer') return null;
    if (mode === 'parallel') return 'Parallel';
    if (mode === 'handoff') return 'Handoff';
    if (mode === 'compare') return 'Compare';
    if (mode === 'synthesize') return 'Synthesize';
    if (mode === 'observer_review') return 'Review';
    if (mode === 'observer_alternative') return 'Alternative';
    if (mode === 'observer_synthesize') return 'Synthesize';
    return null;
  };

  return (
    <div ref={containerRef} className="h-full min-h-0 overflow-y-auto space-y-3 pr-2">
      {timeline.map((entry) => {
        if (entry.type === 'handoff') {
          return (
            <div
              key={entry.id}
              className="flex items-center gap-2 py-2"
            >
              <div className="flex-1 h-px bg-indigo-800" />
              <span className="text-xs text-indigo-400 whitespace-nowrap px-2">
                {entry.content}
              </span>
              <div className="flex-1 h-px bg-indigo-800" />
            </div>
          );
        }

        const currentIndex = messageIndex++;
        const isUser = entry.role === 'user';
        const displayName = isUser
          ? 'You'
          : MODELS[entry.sourceModel]?.displayName ?? entry.sourceModel;

        const bgColor = isUser ? 'bg-gray-800' : 'bg-gray-900';
        const modelColors: Record<string, string> = {
          openai: 'text-green-400',
          anthropic: 'text-orange-400',
          google: 'text-blue-400',
        };
        const provider = MODELS[entry.sourceModel]?.provider;
        const nameColor = isUser
          ? 'text-gray-300'
          : modelColors[provider ?? ''] ?? 'text-gray-300';

        // Check if this message is in the highlighted range
        const isHighlighted = highlightRange &&
          currentIndex >= highlightRange.start &&
          currentIndex <= highlightRange.end;

        return (
          <div
            key={entry.id}
            data-message-index={currentIndex}
            className={`transition-colors ${
              isHighlighted ? 'rounded-lg border-l-2 border-indigo-500' : ''
            }`}
          >
            {entry.role === 'assistant' ? (
              <ResponsePanel
                model={entry.sourceModel}
                content={entry.content}
                done={true}
                modeLabel={modeLabel(entry.mode)}
              responseMode={entry.mode ?? null}
              messageId={entry.id}
              sessionId={sessionId ?? undefined}
              promptTokens={entry.promptTokens ?? null}
              completionTokens={entry.completionTokens ?? null}
              reasoningTokens={entry.reasoningTokens ?? null}
              cachedTokens={entry.cachedTokens ?? null}
              estimatedCostUsd={entry.estimatedCostUsd ?? null}
              pricingSource={entry.pricingSource ?? null}
            />
            ) : (
              <div className={`${bgColor} rounded-lg p-3`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-xs font-semibold ${nameColor}`}>
                    {displayName}
                  </span>
                  {modeLabel(entry.mode) && (
                    <span className="rounded bg-indigo-900/40 px-1.5 py-0.5 text-[10px] text-indigo-300">
                      {modeLabel(entry.mode)}
                    </span>
                  )}
                  {entry.handoffFrom && (
                    <span className="text-xs text-indigo-400">
                      (via handoff)
                    </span>
                  )}
                  {isUser && (
                    <UserMessageActions entry={entry} sessionId={sessionId ?? undefined} />
                  )}
                  <span className="text-xs text-gray-600 ml-auto">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <p className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                  {entry.content}
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
