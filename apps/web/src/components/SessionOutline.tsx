'use client';

import { useCallback } from 'react';
import { useChatStore } from '@/stores/chat-store';
import type { OutlineSection } from '@prism/shared';

interface SessionOutlineProps {
  sessionId: string;
  sourceType: 'native' | 'imported';
  onSectionClick?: (section: OutlineSection) => void;
}

export default function SessionOutline({ sessionId, sourceType, onSectionClick }: SessionOutlineProps) {
  const outline = useChatStore((s) => s.sessionOutline);
  const loading = useChatStore((s) => s.sessionOutlineLoading);
  const highlightRange = useChatStore((s) => s.outlineHighlightRange);
  const generateOutline = useChatStore((s) => s.generateSessionOutline);
  const fetchOutline = useChatStore((s) => s.fetchSessionOutline);

  const handleGenerate = useCallback(() => {
    generateOutline(sessionId, sourceType, 'openai', 'gpt-4o-mini');
  }, [generateOutline, sessionId, sourceType]);

  const handleRefresh = useCallback(() => {
    generateOutline(sessionId, sourceType, 'openai', 'gpt-4o-mini');
  }, [generateOutline, sessionId, sourceType]);

  const handleSectionClick = useCallback((section: OutlineSection) => {
    useChatStore.getState().setOutlineHighlightRange({
      start: section.startMessageIndex,
      end: section.endMessageIndex,
    });
    useChatStore.getState().setOutlineScrollTarget(section.startMessageIndex);
    onSectionClick?.(section);
  }, [onSectionClick]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-pulse text-indigo-400 text-sm mb-2">Analyzing topics...</div>
          <div className="text-[10px] text-gray-600">This may take a few seconds</div>
        </div>
      </div>
    );
  }

  if (!outline || outline.sections.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-gray-500 mb-3">No topic outline yet</p>
          <button
            onClick={handleGenerate}
            className="px-3 py-1.5 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
          >
            Generate Topics
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-gray-600">
          {outline.sections.length} topics · {outline.modelUsed}
        </span>
        <button
          onClick={handleRefresh}
          className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
        {outline.sections.map((section, idx) => {
          const isHighlighted = highlightRange &&
            section.startMessageIndex === highlightRange.start &&
            section.endMessageIndex === highlightRange.end;

          return (
            <button
              key={section.id}
              onClick={() => handleSectionClick(section)}
              className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors border ${
                isHighlighted
                  ? 'bg-indigo-900/30 border-indigo-600/50'
                  : 'hover:bg-gray-800/50 border-transparent'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] text-gray-600 font-mono">{idx + 1}</span>
                <span className="text-xs text-gray-200 font-medium flex-1 truncate">
                  {section.title}
                </span>
                <span className="text-[10px] text-gray-600 flex-shrink-0">
                  {section.messageCount} msgs
                </span>
              </div>
              {section.description && (
                <p className="text-[10px] text-gray-500 ml-5 line-clamp-2">
                  {section.description}
                </p>
              )}
              {section.keyEntities && section.keyEntities.length > 0 && (
                <div className="flex flex-wrap gap-1 ml-5 mt-1">
                  {section.keyEntities.slice(0, 4).map((entity) => (
                    <span key={entity} className="text-[9px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">
                      {entity}
                    </span>
                  ))}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
