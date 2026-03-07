'use client';

import { useState } from 'react';
import { MODELS } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';
import { streamCompare } from '@/lib/api';
import ResponsePanel from './ResponsePanel';
import MarkdownContent from './MarkdownContent';

export default function ComparePanel() {
  const selectedModels = useChatStore((s) => s.selectedModels);
  const [originModel, setOriginModel] = useState<string>('');
  const [criticModels, setCriticModels] = useState<string[]>([]);
  const [instruction, setInstruction] = useState('');
  const isStreaming = useChatStore((s) => s.isStreaming);
  const sessionId = useChatStore((s) => s.sessionId);
  const responses = useChatStore((s) => s.responses);
  const compareOriginContent = useChatStore((s) => s.compareOriginContent);
  const compareOriginModel = useChatStore((s) => s.compareOriginModel);

  // Use session-active models instead of all MODELS
  const modelIds = selectedModels;

  const toggleCritic = (model: string) => {
    setCriticModels((prev) =>
      prev.includes(model) ? prev.filter((m) => m !== model) : [...prev, model]
    );
  };

  const canCompare = sessionId && originModel && criticModels.length > 0 && !isStreaming;

  const handleCompare = () => {
    if (!canCompare) return;
    streamCompare(originModel, criticModels, instruction.trim() || undefined);
    setInstruction('');
  };

  const displayOrigin = compareOriginModel ?? originModel;
  const originDisplay = displayOrigin ? MODELS[displayOrigin]?.displayName : null;

  return (
    <div className="flex-1 flex flex-col gap-4 min-h-0">
      {/* Compare controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400">Evaluate response from:</label>
          <select
            value={originModel}
            onChange={(e) => {
              setOriginModel(e.target.value);
              setCriticModels(modelIds.filter((id) => id !== e.target.value));
            }}
            disabled={isStreaming}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 disabled:opacity-50"
          >
            <option value="">Select model</option>
            {modelIds.map((id) => (
              <option key={id} value={id}>{MODELS[id]?.displayName ?? id}</option>
            ))}
          </select>
        </div>

        <span className="text-gray-600 text-xs">critics:</span>

        <div className="flex gap-2">
          {modelIds
            .filter((id) => id !== originModel)
            .map((id) => {
              const active = criticModels.includes(id);
              return (
                <button
                  key={id}
                  disabled={isStreaming}
                  onClick={() => toggleCritic(id)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                    active
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  } disabled:opacity-50`}
                >
                  {MODELS[id]?.displayName ?? id}
                </button>
              );
            })}
        </div>

        {!sessionId && (
          <span className="text-xs text-yellow-500">
            Send a prompt in Parallel mode first to generate responses
          </span>
        )}
        {sessionId && modelIds.length < 2 && (
          <span className="text-xs text-yellow-500">
            Select at least 2 models in Parallel mode to compare
          </span>
        )}
      </div>

      {/* Instruction */}
      <div className="flex gap-2">
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Optional: custom evaluation instruction..."
          disabled={isStreaming || !canCompare}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCompare(); }}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
        />
        <button
          onClick={handleCompare}
          disabled={!canCompare}
          className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isStreaming ? 'Evaluating...' : 'Compare'}
        </button>
      </div>

      {/* Results: origin + critiques side by side */}
      <div className="flex-1 flex gap-4 min-h-0">
        {/* Origin response (read-only) */}
        {compareOriginContent && originDisplay && (
          <div className="flex-1 min-w-0 bg-gray-900 border border-gray-800 rounded-lg flex flex-col">
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
              <span className="text-sm font-semibold text-gray-200">{originDisplay}</span>
              <span className="text-xs text-gray-500">original</span>
            </div>
            <div className="flex-1 p-4 overflow-auto">
              <MarkdownContent content={compareOriginContent} />
            </div>
          </div>
        )}

        {/* Critic responses */}
        {Object.keys(responses).map((model) => {
          const resp = responses[model];
          return (
            <ResponsePanel
              key={model}
              model={model}
              content={resp.content}
              done={resp.done}
              error={resp.error}
            />
          );
        })}
      </div>
    </div>
  );
}
