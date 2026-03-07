'use client';

import { useState } from 'react';
import { MODELS } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';
import { streamHandoff } from '@/lib/api';
import ResponsePanel from './ResponsePanel';

export default function HandoffPanel() {
  const [instruction, setInstruction] = useState('');
  const handoffFrom = useChatStore((s) => s.handoffFromModel);
  const handoffTo = useChatStore((s) => s.handoffToModel);
  const setHandoffFrom = useChatStore((s) => s.setHandoffFrom);
  const setHandoffTo = useChatStore((s) => s.setHandoffTo);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const sessionId = useChatStore((s) => s.sessionId);
  const responses = useChatStore((s) => s.responses);

  const modelIds = Object.keys(MODELS);

  const canHandoff = sessionId && handoffFrom && handoffTo && handoffFrom !== handoffTo && !isStreaming;

  const handleHandoff = () => {
    if (!canHandoff) return;
    const trimmed = instruction.trim();
    setInstruction('');
    streamHandoff(trimmed || undefined);
  };

  const resp = handoffTo ? responses[handoffTo] : null;

  return (
    <div className="flex-1 flex flex-col gap-4 min-h-0">
      {/* Handoff controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400">From:</label>
          <select
            value={handoffFrom ?? ''}
            onChange={(e) => setHandoffFrom(e.target.value || null)}
            disabled={isStreaming}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 disabled:opacity-50"
          >
            <option value="">Select model</option>
            {modelIds.map((id) => (
              <option key={id} value={id}>
                {MODELS[id].displayName}
              </option>
            ))}
          </select>
        </div>

        <span className="text-gray-600">-&gt;</span>

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400">To:</label>
          <select
            value={handoffTo ?? ''}
            onChange={(e) => setHandoffTo(e.target.value || null)}
            disabled={isStreaming}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 disabled:opacity-50"
          >
            <option value="">Select model</option>
            {modelIds
              .filter((id) => id !== handoffFrom)
              .map((id) => (
                <option key={id} value={id}>
                  {MODELS[id].displayName}
                </option>
              ))}
          </select>
        </div>

        {!sessionId && (
          <span className="text-xs text-yellow-500">
            Send a message first to start a session
          </span>
        )}
      </div>

      {/* Instruction input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Optional instruction for the handoff..."
          disabled={isStreaming || !canHandoff}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleHandoff();
          }}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
        />
        <button
          onClick={handleHandoff}
          disabled={!canHandoff}
          className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isStreaming ? 'Streaming...' : 'Handoff'}
        </button>
      </div>

      {/* Handoff response */}
      {resp && handoffTo && (
        <div className="flex-1 min-h-0">
          <ResponsePanel
            model={handoffTo}
            content={resp.content}
            done={resp.done}
            error={resp.error}
          />
        </div>
      )}
    </div>
  );
}
