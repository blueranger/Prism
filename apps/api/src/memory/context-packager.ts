import { Message, MODELS } from '@prism/shared';
import { getSessionMessages, saveSummary } from './conversation';
import { estimateMessageTokens } from './token-estimator';
import { getAdapterForModel } from '../adapters';

/**
 * Context Packager — extracts and compresses conversation history.
 *
 * Two modes:
 *  1. Naive summarization (no LLM call) — collapses messages into a structured text block.
 *     Fast, deterministic, always available.
 *  2. LLM-powered summarization — sends older messages to a fast model to get a compressed summary.
 *     Better quality, async, requires an available model.
 */

/**
 * Produce a naive (non-LLM) summary of a set of messages.
 * Groups by speaker and condenses into a bullet-point format.
 */
export function naiveSummarize(messages: Message[]): string {
  if (messages.length === 0) return '';

  const lines: string[] = ['Summary of earlier conversation:'];

  for (const msg of messages) {
    const speaker =
      msg.role === 'user'
        ? 'User'
        : MODELS[msg.sourceModel]?.displayName ?? msg.sourceModel;

    // Truncate long messages to first ~200 chars
    const preview =
      msg.content.length > 200
        ? msg.content.slice(0, 200) + '...'
        : msg.content;

    lines.push(`- ${speaker}: ${preview}`);
  }

  return lines.join('\n');
}

/**
 * Use an LLM to produce a high-quality summary of conversation messages.
 * Falls back to naive summary on failure.
 *
 * Uses the cheapest available model (Gemini Flash > GPT-4o > Claude).
 */
export async function llmSummarize(
  messages: Message[],
  preferredModel?: string
): Promise<string> {
  if (messages.length === 0) return '';

  // Pick a model for summarization — prefer a fast/cheap one
  const summarizationModels = preferredModel
    ? [preferredModel]
    : ['gemini-2.5-flash', 'gpt-4o', 'claude-sonnet-4-20250514'];

  const transcript = messages
    .map((m) => {
      const speaker =
        m.role === 'user'
          ? 'User'
          : MODELS[m.sourceModel]?.displayName ?? m.sourceModel;
      return `${speaker}: ${m.content}`;
    })
    .join('\n\n');

  const prompt = `Summarize the following conversation concisely. Preserve key decisions, questions, and conclusions. Use bullet points. Keep the summary under 500 words.\n\n${transcript}`;

  for (const model of summarizationModels) {
    try {
      const config = MODELS[model];
      if (!config) continue;

      const adapter = getAdapterForModel(model);
      let result = '';

      for await (const chunk of adapter.stream({
        messages: [{ role: 'user', content: prompt }],
        model: config.model,
        provider: config.provider,
        temperature: 0.3,
        maxTokens: 1024,
      })) {
        if (chunk.error) throw new Error(chunk.error);
        result += chunk.content;
      }

      if (result.trim()) return result.trim();
    } catch {
      // Try next model
      continue;
    }
  }

  // All models failed — fall back to naive
  return naiveSummarize(messages);
}

/**
 * Summarize and store a range of messages for a session.
 * Returns the generated summary text.
 */
export async function summarizeAndStore(
  sessionId: string,
  fromTimestamp: number,
  toTimestamp: number,
  options?: { useLLM?: boolean; preferredModel?: string }
): Promise<string> {
  const allMessages = getSessionMessages(sessionId);
  const range = allMessages.filter(
    (m) => m.timestamp >= fromTimestamp && m.timestamp <= toTimestamp
  );

  if (range.length === 0) return '';

  const originalTokens = range.reduce(
    (sum, m) => sum + estimateMessageTokens(m.role, m.content),
    0
  );

  let summary: string;
  if (options?.useLLM) {
    summary = await llmSummarize(range, options.preferredModel);
  } else {
    summary = naiveSummarize(range);
  }

  saveSummary(sessionId, fromTimestamp, toTimestamp, summary, originalTokens);

  return summary;
}
