'use client';

import { useState } from 'react';
import { MODELS } from '@prism/shared';
import CopyWithProvenance from './CopyWithProvenance';
import SendToNotion from './SendToNotion';
import MarkdownContent from './MarkdownContent';

interface ResponsePanelProps {
  model: string;
  content: string;
  done: boolean;
  error?: string;
  messageId?: string;
  sessionId?: string;
  /** Chain-of-thought / thinking content (separate from main response) */
  thinkingContent?: string;
}

export default function ResponsePanel({
  model,
  content,
  done,
  error,
  messageId,
  sessionId,
  thinkingContent,
}: ResponsePanelProps) {
  const config = MODELS[model];
  const displayName = config?.displayName ?? model;
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  return (
    <div className="flex-1 min-w-0 bg-gray-900 border border-gray-800 rounded-lg flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
        <span className="text-sm font-semibold text-gray-200">{displayName}</span>
        <div className="flex items-center gap-2">
          {thinkingContent && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-400 font-medium">
              💭 Thinking
            </span>
          )}
          {!done && (
            <span className="text-xs text-indigo-400 animate-pulse">streaming...</span>
          )}
          {done && error && (
            <span className="text-xs text-red-400">error</span>
          )}
          {done && !error && content && (
            <span className="text-xs text-green-400">done</span>
          )}
        </div>
      </div>
      <div className="flex-1 p-4 overflow-auto flex flex-col">
        {error ? (
          <p className="text-red-400 text-sm">{error}</p>
        ) : (
          <>
            {/* Thinking / Chain-of-Thought section */}
            {thinkingContent && (
              <div className="mb-3">
                <button
                  onClick={() => setThinkingExpanded(!thinkingExpanded)}
                  className="flex items-center gap-1.5 text-xs text-purple-400 hover:text-purple-300 transition-colors mb-1"
                >
                  <svg
                    className={`w-3 h-3 transition-transform ${thinkingExpanded ? 'rotate-90' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="font-medium">Chain of Thought</span>
                  <span className="text-[10px] text-purple-600">
                    ({(thinkingContent.length / 4).toFixed(0)} tokens est.)
                  </span>
                </button>
                {thinkingExpanded && (
                  <div className="bg-gray-950 border border-purple-900/30 rounded-md p-3 text-xs text-gray-500 font-mono whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">
                    {thinkingContent}
                  </div>
                )}
              </div>
            )}

            {/* Main response */}
            <div className="flex items-start gap-2 flex-1">
              <div className="flex-1">
                {content ? (
                  <MarkdownContent content={content} />
                ) : (
                  <p className="text-gray-600 text-sm">Waiting for response...</p>
                )}
              </div>
              {done && !error && content && sessionId && (
                <div className="flex flex-col gap-1 flex-shrink-0 mt-1">
                  <CopyWithProvenance
                    content={content}
                    messageId={messageId || `response-${model}-${Date.now()}`}
                    sourceType="native"
                    sourceId={sessionId}
                    sourceModel={model}
                  />
                  <SendToNotion
                    content={content}
                    sessionId={sessionId}
                    messageId={messageId || `response-${model}-${Date.now()}`}
                    sourceModel={model}
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
