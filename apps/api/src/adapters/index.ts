import { LLMProvider } from '@prism/shared';
import { LLMAdapter } from './common';
import { OpenAIAdapter } from './openai';
import { AnthropicAdapter } from './anthropic';
import { GoogleAdapter } from './google';
import { modelRegistry } from '../services/model-registry';

const adapters: Record<LLMProvider, LLMAdapter> = {
  openai: new OpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
  google: new GoogleAdapter(),
};

export function getAdapter(provider: LLMProvider): LLMAdapter {
  return adapters[provider];
}

export function getAdapterForModel(model: string): LLMAdapter {
  // First check runtime registry (includes static + discovered)
  const config = modelRegistry.getById(model);
  if (!config) {
    throw new Error(`Unknown model: ${model}`);
  }
  return getAdapter(config.provider);
}
