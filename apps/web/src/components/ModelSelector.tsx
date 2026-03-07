'use client';

import { useState, useRef, useEffect } from 'react';
import { MODELS, MAX_SELECTED_MODELS } from '@prism/shared';
import type { LLMProvider, ModelConfig } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';
import { fetchModels, type ModelEntry } from '@/lib/api';
import ThinkingToggle from './ThinkingToggle';

/** Provider display labels */
const PROVIDER_LABELS: Record<LLMProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
};

const PROVIDER_ORDER: LLMProvider[] = ['openai', 'anthropic', 'google'];

interface ModelItem {
  id: string;
  displayName: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
  description?: string;
  isReasoning?: boolean;
  supportsThinking?: boolean;
}

function getModelsByProvider(
  dynamicModels?: ModelEntry[] | null
): Record<LLMProvider, ModelItem[]> {
  const grouped: Record<string, ModelItem[]> = {};

  if (dynamicModels && dynamicModels.length > 0) {
    // Use API response (richer, possibly includes discovered models)
    for (const m of dynamicModels) {
      const provider = m.provider as LLMProvider;
      if (!grouped[provider]) grouped[provider] = [];
      grouped[provider].push({
        id: m.id,
        displayName: m.displayName,
        inputCostPer1M: m.inputCostPer1M ?? 0,
        outputCostPer1M: m.outputCostPer1M ?? 0,
        description: m.description,
        isReasoning: m.isReasoning,
        supportsThinking: m.supportsThinking,
      });
    }
  } else {
    // Fallback to static constants
    for (const [id, config] of Object.entries(MODELS)) {
      if (!grouped[config.provider]) grouped[config.provider] = [];
      grouped[config.provider].push({
        id,
        displayName: config.displayName,
        inputCostPer1M: config.inputCostPer1M ?? 0,
        outputCostPer1M: config.outputCostPer1M ?? 0,
        description: config.description,
        isReasoning: config.isReasoning,
        supportsThinking: config.supportsThinking,
      });
    }
  }

  return grouped as Record<LLMProvider, ModelItem[]>;
}

/** Format cost: $0.15 → "$0.15", $10 → "$10" */
function fmtCost(v: number): string {
  if (v === 0) return '—';
  if (v < 1) return `$${v.toFixed(2)}`;
  if (v % 1 === 0) return `$${v}`;
  return `$${v.toFixed(2)}`;
}

export default function ModelSelector() {
  const selectedModels = useChatStore((s) => s.selectedModels);
  const toggleModel = useChatStore((s) => s.toggleModel);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const [open, setOpen] = useState(false);
  const [apiModels, setApiModels] = useState<ModelEntry[] | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Fetch models from API on first open
  useEffect(() => {
    if (!open || apiModels) return;
    fetchModels().then((resp) => {
      if (resp?.models) setApiModels(resp.models);
    });
  }, [open, apiModels]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const modelsByProvider = getModelsByProvider(apiModels);
  const atMax = selectedModels.length >= MAX_SELECTED_MODELS;

  // Build display label for the trigger button
  const selectedNames = selectedModels
    .map((id) => {
      const apiMatch = apiModels?.find((m) => m.id === id);
      return apiMatch?.displayName ?? MODELS[id]?.displayName ?? id;
    })
    .join(', ');

  return (
    <div className="relative" ref={panelRef}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(!open)}
        disabled={isStreaming}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="w-4 h-4 text-gray-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span className="max-w-[280px] truncate">{selectedNames || 'Select models'}</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className={`w-3 h-3 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-[460px] bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden">
          <div className="p-3 border-b border-gray-800">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Model Preferences
              </span>
              <span className={`text-xs font-medium ${atMax ? 'text-yellow-500' : 'text-gray-500'}`}>
                {selectedModels.length}/{MAX_SELECTED_MODELS}
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-3 text-[10px] text-gray-600">
              <span>USD / 1M tokens</span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-700" />
                <span>In</span>
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-700" />
                <span>Out</span>
              </span>
            </div>
          </div>

          <div className="max-h-[480px] overflow-y-auto p-2">
            {PROVIDER_ORDER.map((provider) => {
              const models = modelsByProvider[provider];
              if (!models || models.length === 0) return null;

              return (
                <div key={provider} className="mb-3 last:mb-0">
                  <div className="px-2 py-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    {PROVIDER_LABELS[provider]}
                  </div>
                  {models.map((m) => {
                    const isSelected = selectedModels.includes(m.id);
                    const isDisabled = isStreaming || (!isSelected && atMax);

                    return (
                      <div key={m.id}>
                        <button
                          onClick={() => toggleModel(m.id)}
                          disabled={isDisabled}
                          className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm transition-colors ${
                            isSelected
                              ? 'bg-indigo-600/20 text-indigo-300'
                              : isDisabled
                                ? 'text-gray-600 cursor-not-allowed'
                                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                          }`}
                        >
                          {/* Checkbox */}
                          <span
                            className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                              isSelected
                                ? 'bg-indigo-600 border-indigo-500'
                                : isDisabled
                                  ? 'border-gray-700 bg-gray-800'
                                  : 'border-gray-600 bg-gray-800'
                            }`}
                          >
                            {isSelected && (
                              <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </span>

                          {/* Model name + description */}
                          <div className="flex-1 text-left min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate">{m.displayName}</span>
                              {m.supportsThinking && (
                                <span className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded bg-purple-900/50 text-purple-400 font-medium">
                                  THINKING
                                </span>
                              )}
                              {m.isReasoning && !m.supportsThinking && (
                                <span className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded bg-purple-900/50 text-purple-400 font-medium">
                                  REASONING
                                </span>
                              )}
                            </div>
                            {m.description && (
                              <div className="text-[10px] text-gray-600 truncate mt-0.5">
                                {m.description}
                              </div>
                            )}
                          </div>

                          {/* Cost per 1M tokens */}
                          <div className="flex-shrink-0 text-right text-[10px] font-mono leading-tight">
                            <div className="flex items-center justify-end gap-1">
                              <span className="text-cyan-600">{fmtCost(m.inputCostPer1M)}</span>
                              <span className="text-gray-700">/</span>
                              <span className="text-orange-600">{fmtCost(m.outputCostPer1M)}</span>
                            </div>
                            <div className="text-[8px] text-gray-700 mt-0.5">per 1M tokens</div>
                          </div>
                        </button>

                        {/* Thinking controls: show when model is selected and supports thinking */}
                        {isSelected && m.supportsThinking && (
                          <ThinkingToggle modelId={m.id} />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {atMax && (
            <div className="px-3 py-2 border-t border-gray-800 text-xs text-yellow-600">
              Maximum {MAX_SELECTED_MODELS} models selected
            </div>
          )}
        </div>
      )}
    </div>
  );
}
