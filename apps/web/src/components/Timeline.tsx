'use client';

import { useEffect, useRef } from 'react';
import { MODELS } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';
import CopyWithProvenance from './CopyWithProvenance';
import SendToNotion from './SendToNotion';
import MarkdownContent from './MarkdownContent';

export default function Timeline() {
  const timeline = useChatStore((s) => s.timeline);
  const scrollTarget = useChatStore((s) => s.outlineScrollTarget);
  const highlightRange = useChatStore((s) => s.outlineHighlightRange);
  const sessionId = useChatStore((s) => s.sessionId);
  const containerRef = useRef<HTMLDivElement>(null);

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
      <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
        Conversation timeline will appear here.
      </div>
    );
  }

  // Track message index (skip handoff entries)
  let messageIndex = 0;

  return (
    <div ref={containerRef} className="flex-1 overflow-auto space-y-3 pr-2">
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
            className={`${bgColor} rounded-lg p-3 transition-colors ${
              isHighlighted ? 'border-l-2 border-indigo-500' : ''
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-xs font-semibold ${nameColor}`}>
                {displayName}
              </span>
              {entry.handoffFrom && (
                <span className="text-xs text-indigo-400">
                  (via handoff)
                </span>
              )}
              <span className="text-xs text-gray-600 ml-auto">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>
            </div>
            <div className="flex items-start gap-2">
              <div className="flex-1">
                {entry.role === 'assistant' ? (
                  <MarkdownContent content={entry.content} />
                ) : (
                  <p className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                    {entry.content}
                  </p>
                )}
              </div>
              {entry.role === 'assistant' && sessionId && (
                <div className="flex flex-col gap-1 flex-shrink-0">
                  <CopyWithProvenance
                    content={entry.content}
                    messageId={entry.id}
                    sourceType="native"
                    sourceId={sessionId}
                    sourceModel={entry.sourceModel}
                  />
                  <SendToNotion
                    content={entry.content}
                    sessionId={sessionId}
                    messageId={entry.id}
                    sourceModel={entry.sourceModel}
                  />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
