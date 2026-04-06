import { CHARS_PER_TOKEN, RESPONSE_TOKEN_RESERVE, SYSTEM_TOKEN_RESERVE } from '@prism/shared';
import type { ContextBudget, MessageRole } from '@prism/shared';
import { modelRegistry } from '../services/model-registry';

/**
 * Estimate token count for a string using character-based heuristic.
 * Conservative: ~3.5 chars per token (slightly overestimates to avoid exceeding limits).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate tokens for a message including role overhead (~4 tokens per message for framing).
 */
export function estimateMessageTokens(role: MessageRole, content: string): number {
  return estimateTokens(content) + 4;
}

/**
 * Compute the token budget for a given model.
 */
export function computeBudget(model: string): ContextBudget {
  const config = modelRegistry.getById(model);
  if (!config) throw new Error(`Unknown model: ${model}`);

  const maxTokens = config.maxTokens;
  const reserveForResponse = RESPONSE_TOKEN_RESERVE;
  const reserveForSystem = SYSTEM_TOKEN_RESERVE;
  const available = maxTokens - reserveForResponse - reserveForSystem;

  return { maxTokens, reserveForResponse, reserveForSystem, available };
}
