'use client';

import { useState, useEffect } from 'react';
import { MODELS } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';
import { streamSynthesize } from '@/lib/api';
import ResponsePanel from './ResponsePanel';

export default function SynthesizePanel() {
  const selectedModels = useChatStore((s) => s.selectedModels);
  const [sourceModels, setSourceModels] = useState<string[]>([]);
  const [synthesizer, setSynthesizer] = useState<string>('');
  const [instruction, setInstruction] = useState('');
  const isStreaming = useChatStore((s) => s.isStreaming);
  const sessionId = useChatStore((s) => s.sessionId);
  const responses = useChatStore((s) => s.responses);
  const storedSynthesizerModel = useChatStore((s) => s.synthesizerModel);

  // Sync source models when selectedModels change (e.g. switching to Synthesize mode)
  // Default: all currently selected models are source models
  useEffect(() => {
    setSourceModels(selectedModels);
  }, [selectedModels]);

  // Restore synthesizer selection from store (after session restore)
  useEffect(() => {
    if (storedSynthesizerModel && !synthesizer) {
      setSynthesizer(storedSynthesizerModel);
    }
  }, [storedSynthesizerModel]);

  // Use selectedModels (session-active) instead of all MODELS
  const modelIds = selectedModels;

  const toggleSource = (model: string) => {
    setSourceModels((prev) =>
      prev.includes(model) ? prev.filter((m) => m !== model) : [...prev, model]
    );
  };

  const canSynthesize = sessionId && sourceModels.length >= 2 && synthesizer && !isStreaming;

  const handleSynthesize = () => {
    if (!canSynthesize) return;
    useChatStore.getState().setSynthesizerModel(synthesizer);
    streamSynthesize(sourceModels, synthesizer, instruction.trim() || undefined);
    setInstruction('');
  };

  const synthResp = synthesizer ? responses[synthesizer] : null;

  return (
    <div className="flex-1 flex flex-col gap-4 min-h-0">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs text-gray-400">Source responses from:</span>
        <div className="flex gap-2">
          {modelIds.map((id) => {
            const active = sourceModels.includes(id);
            return (
              <button
                key={id}
                disabled={isStreaming}
                onClick={() => toggleSource(id)}
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

        <span className="text-gray-600">|</span>

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400">Synthesizer:</label>
          <select
            value={synthesizer}
            onChange={(e) => setSynthesizer(e.target.value)}
            disabled={isStreaming}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 disabled:opacity-50"
          >
            <option value="">Select model</option>
            {modelIds.map((id) => (
              <option key={id} value={id}>{MODELS[id]?.displayName ?? id}</option>
            ))}
          </select>
        </div>

        {!sessionId && (
          <span className="text-xs text-yellow-500">
            Send a prompt in Parallel mode first to generate responses
          </span>
        )}
        {sessionId && modelIds.length < 2 && (
          <span className="text-xs text-yellow-500">
            Select at least 2 models in Parallel mode to synthesize
          </span>
        )}
      </div>

      {/* Instruction */}
      <div className="flex gap-2">
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Optional: custom synthesis instruction..."
          disabled={isStreaming || !canSynthesize}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSynthesize(); }}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
        />
        <button
          onClick={handleSynthesize}
          disabled={!canSynthesize}
          className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isStreaming ? 'Synthesizing...' : 'Synthesize'}
        </button>
      </div>

      {/* Result */}
      {synthResp && synthesizer && (
        <div className="flex-1 min-h-0">
          <ResponsePanel
            model={synthesizer}
            content={synthResp.content}
            done={synthResp.done}
            error={synthResp.error}
            sessionId={sessionId ?? undefined}
            messageId={`synthesize-${synthesizer}-${Date.now()}`}
          />
        </div>
      )}
    </div>
  );
}
