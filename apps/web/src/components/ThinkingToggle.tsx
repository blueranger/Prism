'use client';

import { useState } from 'react';
import { MODELS } from '@prism/shared';
import type { ReasoningEffort } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';

const EFFORT_LABELS: { value: ReasoningEffort; label: string; desc: string }[] = [
  { value: 'low', label: 'Low', desc: 'Fast, light reasoning' },
  { value: 'medium', label: 'Med', desc: 'Balanced speed & depth' },
  { value: 'high', label: 'High', desc: 'Deep reasoning, slower' },
];

const BUDGET_PRESETS = [
  { label: 'Light', tokens: 2048 },
  { label: 'Medium', tokens: 8192 },
  { label: 'Deep', tokens: 24576 },
];

/**
 * ThinkingToggle — shown in ModelSelector for thinking-capable models.
 * OpenAI models: shows reasoning effort (low/medium/high)
 * Google models: shows thinking budget slider (0-24576 tokens)
 */
export default function ThinkingToggle({ modelId }: { modelId: string }) {
  const config = resolveThinkingModelConfig(modelId);
  if (!config?.supportsThinking) return null;

  const thinkingConfig = useChatStore((s) => s.thinkingConfig[modelId]);
  const setThinkingConfig = useChatStore((s) => s.setThinkingConfig);
  const clearThinkingConfig = useChatStore((s) => s.clearThinkingConfig);

  const isEnabled = thinkingConfig?.enabled ?? false;

  const handleToggle = () => {
    if (isEnabled) {
      clearThinkingConfig(modelId);
    } else {
      // Default config based on provider
      if (config.provider === 'openai') {
        setThinkingConfig(modelId, { enabled: true, effort: 'medium' });
      } else if (config.provider === 'google') {
        setThinkingConfig(modelId, { enabled: true, budgetTokens: 8192 });
      } else {
        setThinkingConfig(modelId, { enabled: true, budgetTokens: 8192 });
      }
    }
  };

  return (
    <div
      className="mt-1.5 ml-6 border-l-2 border-purple-800/50 pl-2.5"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Toggle row */}
      <button
        onClick={handleToggle}
        className="flex items-center gap-1.5 text-[10px] group"
      >
        <span
          className={`w-6 h-3.5 rounded-full flex items-center transition-colors ${
            isEnabled ? 'bg-purple-600 justify-end' : 'bg-gray-700 justify-start'
          }`}
        >
          <span
            className={`w-2.5 h-2.5 rounded-full mx-0.5 transition-colors ${
              isEnabled ? 'bg-white' : 'bg-gray-500'
            }`}
          />
        </span>
        <span className={`font-medium ${isEnabled ? 'text-purple-400' : 'text-gray-600'}`}>
          Thinking
        </span>
      </button>

      {/* Provider-specific controls */}
      {isEnabled && config.provider === 'openai' && (
        <OpenAIEffortSelector modelId={modelId} />
      )}
      {isEnabled && config.provider === 'google' && (
        <GoogleBudgetSelector modelId={modelId} />
      )}
    </div>
  );
}

function resolveThinkingModelConfig(modelId: string) {
  const staticConfig = MODELS[modelId];
  if (staticConfig) return staticConfig;

  const provider =
    modelId.startsWith('gpt-') || /^o[1345](?:-|$)/.test(modelId)
      ? 'openai'
      : modelId.startsWith('gemini-')
        ? 'google'
        : modelId.startsWith('claude-')
          ? 'anthropic'
          : null;

  if (!provider) return null;

  const supportsThinking =
    provider === 'openai'
      ? modelId.startsWith('gpt-5') || /^o[1345](?:-|$)/.test(modelId)
      : provider === 'google'
        ? /^gemini-(?:2\.5|3)/.test(modelId)
        : false;

  return {
    provider,
    supportsThinking,
  } as const;
}

function OpenAIEffortSelector({ modelId }: { modelId: string }) {
  const thinkingConfig = useChatStore((s) => s.thinkingConfig[modelId]);
  const setThinkingConfig = useChatStore((s) => s.setThinkingConfig);
  const currentEffort = thinkingConfig?.effort ?? 'medium';

  return (
    <div className="flex items-center gap-0.5 mt-1">
      {EFFORT_LABELS.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => setThinkingConfig(modelId, { ...thinkingConfig!, effort: value })}
          title={EFFORT_LABELS.find((e) => e.value === value)?.desc}
          className={`px-1.5 py-0.5 text-[9px] font-medium rounded transition-colors ${
            currentEffort === value
              ? 'bg-purple-600 text-white'
              : 'bg-gray-800 text-gray-500 hover:text-gray-300 hover:bg-gray-700'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function GoogleBudgetSelector({ modelId }: { modelId: string }) {
  const thinkingConfig = useChatStore((s) => s.thinkingConfig[modelId]);
  const setThinkingConfig = useChatStore((s) => s.setThinkingConfig);
  const currentBudget = thinkingConfig?.budgetTokens ?? 8192;

  return (
    <div className="mt-1">
      <div className="flex items-center gap-0.5 mb-0.5">
        {BUDGET_PRESETS.map(({ label, tokens }) => (
          <button
            key={tokens}
            onClick={() => setThinkingConfig(modelId, { ...thinkingConfig!, budgetTokens: tokens })}
            className={`px-1.5 py-0.5 text-[9px] font-medium rounded transition-colors ${
              currentBudget === tokens
                ? 'bg-purple-600 text-white'
                : 'bg-gray-800 text-gray-500 hover:text-gray-300 hover:bg-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="range"
          min={0}
          max={24576}
          step={1024}
          value={currentBudget}
          onChange={(e) =>
            setThinkingConfig(modelId, {
              ...thinkingConfig!,
              budgetTokens: Number(e.target.value),
            })
          }
          className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
        />
        <span className="text-[9px] text-gray-500 font-mono w-12 text-right flex-shrink-0">
          {currentBudget >= 1024 ? `${(currentBudget / 1024).toFixed(0)}K` : currentBudget}
        </span>
      </div>
    </div>
  );
}
