import { ModelConfig } from './types';

export const MODELS: Record<string, ModelConfig> = {
  // ═══════════════════════════════════════════
  //  OpenAI
  // ═══════════════════════════════════════════

  // GPT-5 series
  'gpt-5.4': {
    provider: 'openai',
    model: 'gpt-5.4',
    displayName: 'GPT-5.4',
    maxTokens: 128000,
    inputCostPer1M: 1.75,
    outputCostPer1M: 14.0,
    description: 'Preferred flagship, supports reasoning effort',
    supportsThinking: true,
  },
  'gpt-5.2': {
    provider: 'openai',
    model: 'gpt-5.2',
    displayName: 'GPT-5.2',
    maxTokens: 128000,
    inputCostPer1M: 1.75,
    outputCostPer1M: 14.0,
    description: 'Latest flagship, supports reasoning effort',
    supportsThinking: true,
  },
  'gpt-5.1': {
    provider: 'openai',
    model: 'gpt-5.1',
    displayName: 'GPT-5.1',
    maxTokens: 128000,
    inputCostPer1M: 1.25,
    outputCostPer1M: 10.0,
  },
  'gpt-5': {
    provider: 'openai',
    model: 'gpt-5',
    displayName: 'GPT-5',
    maxTokens: 128000,
    inputCostPer1M: 1.25,
    outputCostPer1M: 10.0,
  },
  'gpt-5-mini': {
    provider: 'openai',
    model: 'gpt-5-mini',
    displayName: 'GPT-5 Mini',
    maxTokens: 128000,
    inputCostPer1M: 0.25,
    outputCostPer1M: 2.0,
    description: 'Fast & affordable GPT-5',
  },
  'gpt-5-nano': {
    provider: 'openai',
    model: 'gpt-5-nano',
    displayName: 'GPT-5 Nano',
    maxTokens: 128000,
    inputCostPer1M: 0.05,
    outputCostPer1M: 0.4,
    description: 'Cheapest, good for summarization/classification',
  },

  // GPT-4.1 series
  'gpt-4.1': {
    provider: 'openai',
    model: 'gpt-4.1',
    displayName: 'GPT-4.1',
    maxTokens: 1000000,
    inputCostPer1M: 2.0,
    outputCostPer1M: 8.0,
    description: 'Strong at coding & long context',
  },
  'gpt-4.1-mini': {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    displayName: 'GPT-4.1 Mini',
    maxTokens: 1000000,
    inputCostPer1M: 0.4,
    outputCostPer1M: 1.6,
  },
  'gpt-4.1-nano': {
    provider: 'openai',
    model: 'gpt-4.1-nano',
    displayName: 'GPT-4.1 Nano',
    maxTokens: 1000000,
    inputCostPer1M: 0.1,
    outputCostPer1M: 0.4,
  },

  // GPT-4o series
  'gpt-4o': {
    provider: 'openai',
    model: 'gpt-4o',
    displayName: 'GPT-4o',
    maxTokens: 128000,
    inputCostPer1M: 2.5,
    outputCostPer1M: 10.0,
    description: 'Multimodal flagship',
  },
  'gpt-4o-mini': {
    provider: 'openai',
    model: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    maxTokens: 128000,
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.6,
  },

  // o-series (reasoning)
  'o4-mini': {
    provider: 'openai',
    model: 'o4-mini',
    displayName: 'o4-mini',
    maxTokens: 200000,
    inputCostPer1M: 1.1,
    outputCostPer1M: 4.4,
    description: 'Fast reasoning, excels at math & code',
    isReasoning: true,
    supportsThinking: true,
  },
  'o3': {
    provider: 'openai',
    model: 'o3',
    displayName: 'o3',
    maxTokens: 200000,
    inputCostPer1M: 2.0,
    outputCostPer1M: 8.0,
    description: 'Reasoning model',
    isReasoning: true,
    supportsThinking: true,
  },
  'o3-mini': {
    provider: 'openai',
    model: 'o3-mini',
    displayName: 'o3-mini',
    maxTokens: 200000,
    inputCostPer1M: 1.1,
    outputCostPer1M: 4.4,
    description: 'Compact reasoning model',
    isReasoning: true,
    supportsThinking: true,
  },

  // ═══════════════════════════════════════════
  //  Anthropic
  // ═══════════════════════════════════════════
  'claude-opus-4-6': {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    maxTokens: 1000000,
    inputCostPer1M: 15.0,
    outputCostPer1M: 75.0,
    description: 'Most capable, 1M context',
  },
  'claude-sonnet-4-6': {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    maxTokens: 1000000,
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
    description: 'Near-Opus quality at 1/5 cost',
  },
  'claude-opus-4-5-20250918': {
    provider: 'anthropic',
    model: 'claude-opus-4-5-20250918',
    displayName: 'Claude Opus 4.5',
    maxTokens: 200000,
    inputCostPer1M: 5.0,
    outputCostPer1M: 25.0,
  },
  'claude-sonnet-4-5-20250929': {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    displayName: 'Claude Sonnet 4.5',
    maxTokens: 200000,
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
  },
  'claude-sonnet-4-20250514': {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    displayName: 'Claude Sonnet 4',
    maxTokens: 200000,
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
  },
  'claude-haiku-4-5-20251001': {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    maxTokens: 200000,
    inputCostPer1M: 1.0,
    outputCostPer1M: 5.0,
    description: 'Fast & affordable',
  },
  'claude-haiku-3-5-20241022': {
    provider: 'anthropic',
    model: 'claude-haiku-3-5-20241022',
    displayName: 'Claude Haiku 3.5',
    maxTokens: 200000,
    inputCostPer1M: 0.8,
    outputCostPer1M: 4.0,
    description: 'Lightweight, cheapest Claude',
  },

  // ═══════════════════════════════════════════
  //  Google
  // ═══════════════════════════════════════════
  'gemini-3.1-pro-preview': {
    provider: 'google',
    model: 'gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro',
    maxTokens: 1000000,
    inputCostPer1M: 1.25,
    outputCostPer1M: 10.0,
    description: 'Latest flagship, 1M context',
    supportsThinking: true,
  },
  'gemini-3-flash-preview': {
    provider: 'google',
    model: 'gemini-3-flash-preview',
    displayName: 'Gemini 3 Flash',
    maxTokens: 1000000,
    inputCostPer1M: 0.5,
    outputCostPer1M: 3.0,
    supportsThinking: true,
  },
  'gemini-2.5-pro': {
    provider: 'google',
    model: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    maxTokens: 1000000,
    inputCostPer1M: 1.25,
    outputCostPer1M: 10.0,
    description: 'Stable, strong reasoning',
    supportsThinking: true,
  },
  'gemini-2.5-flash': {
    provider: 'google',
    model: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    maxTokens: 1000000,
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.6,
    description: 'Best value for most tasks',
    supportsThinking: true,
  },
  'gemini-2.5-flash-lite': {
    provider: 'google',
    model: 'gemini-2.5-flash-lite',
    displayName: 'Gemini 2.5 Flash Lite',
    maxTokens: 1000000,
    inputCostPer1M: 0.1,
    outputCostPer1M: 0.4,
    description: 'Ultra low cost',
  },
};

/** Maximum number of models that can be selected simultaneously */
export const MAX_SELECTED_MODELS = 3;

export const DEFAULT_MODELS = ['gpt-5.4', 'claude-opus-4-6', 'gemini-3.1-pro-preview'];

/** How many tokens to reserve for the model's response */
export const RESPONSE_TOKEN_RESERVE = 4096;

/** How many tokens to reserve for system prompt / handoff instructions */
export const SYSTEM_TOKEN_RESERVE = 1024;

/** Number of most-recent messages to always include verbatim (not summarized) */
export const RECENT_MESSAGES_VERBATIM = 10;

/** Approximate chars-per-token ratio for quick estimation (conservative) */
export const CHARS_PER_TOKEN = 3.5;

/** Max share of token budget allocated to cross-session linked context */
export const CROSS_SESSION_TOKEN_BUDGET_RATIO = 0.2;

export const API_PORT = 3001;
export const WEB_PORT = 3000;
