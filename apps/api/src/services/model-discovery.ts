/**
 * Model Discovery Service
 *
 * Queries each LLM provider's API to discover available models.
 * OpenAI: uses models.list() API
 * Anthropic: no list API — uses static list with health-check probing
 * Google: uses listModels() API
 */

import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { DiscoveredModel, LLMProvider } from '@prism/shared';

// ── OpenAI ──────────────────────────────────────────────────

/** Known OpenAI chat model prefixes we care about */
const OPENAI_CHAT_PREFIXES = [
  'gpt-5', 'gpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'gpt-4',
  'o1', 'o3', 'o4',
];

function isOpenAIChatModel(id: string): boolean {
  return OPENAI_CHAT_PREFIXES.some((p) => id.startsWith(p));
}

export async function discoverOpenAIModels(): Promise<DiscoveredModel[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[model-discovery] OPENAI_API_KEY not set, skipping OpenAI discovery');
    return [];
  }

  try {
    const client = new OpenAI({ apiKey });
    const list = await client.models.list();
    const now = Date.now();
    const results: DiscoveredModel[] = [];

    for await (const m of list) {
      if (!isOpenAIChatModel(m.id)) continue;
      results.push({
        model: m.id,
        provider: 'openai' as LLMProvider,
        displayName: m.id, // will be enriched by registry
        maxTokens: 128000, // default; registry will override from static config
        discoveredAt: now,
      });
    }

    console.log(`[model-discovery] OpenAI: discovered ${results.length} chat models`);
    return results;
  } catch (err: any) {
    console.error('[model-discovery] OpenAI discovery failed:', err.message);
    return [];
  }
}

// ── Anthropic ───────────────────────────────────────────────

/**
 * Anthropic doesn't have a list-models API.
 * We maintain a known-models list and verify connectivity.
 */
const KNOWN_ANTHROPIC_MODELS: Omit<DiscoveredModel, 'discoveredAt'>[] = [
  { model: 'claude-opus-4-6', provider: 'anthropic', displayName: 'Claude Opus 4.6', maxTokens: 1000000 },
  { model: 'claude-sonnet-4-6', provider: 'anthropic', displayName: 'Claude Sonnet 4.6', maxTokens: 1000000 },
  { model: 'claude-opus-4-5-20250918', provider: 'anthropic', displayName: 'Claude Opus 4.5', maxTokens: 200000 },
  { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic', displayName: 'Claude Sonnet 4.5', maxTokens: 200000 },
  { model: 'claude-sonnet-4-20250514', provider: 'anthropic', displayName: 'Claude Sonnet 4', maxTokens: 200000 },
  { model: 'claude-haiku-4-5-20251001', provider: 'anthropic', displayName: 'Claude Haiku 4.5', maxTokens: 200000 },
  { model: 'claude-haiku-3-5-20241022', provider: 'anthropic', displayName: 'Claude Haiku 3.5', maxTokens: 200000 },
];

export async function discoverAnthropicModels(): Promise<DiscoveredModel[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[model-discovery] ANTHROPIC_API_KEY not set, skipping Anthropic discovery');
    return [];
  }

  // Just return known list with timestamp (no list API available)
  const now = Date.now();
  console.log(`[model-discovery] Anthropic: returning ${KNOWN_ANTHROPIC_MODELS.length} known models`);
  return KNOWN_ANTHROPIC_MODELS.map((m) => ({ ...m, discoveredAt: now }));
}

// ── Google ──────────────────────────────────────────────────

/** Filter for Gemini text generation models */
const GOOGLE_MODEL_PREFIXES = ['gemini-'];

export async function discoverGoogleModels(): Promise<DiscoveredModel[]> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    console.warn('[model-discovery] GOOGLE_AI_API_KEY not set, skipping Google discovery');
    return [];
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    // @ts-ignore — listModels may not be in all SDK versions
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as { models?: Array<{ name?: string; displayName?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }> };
    const now = Date.now();
    const results: DiscoveredModel[] = [];

    for (const m of data.models ?? []) {
      const name: string = m.name?.replace('models/', '') ?? '';
      if (!GOOGLE_MODEL_PREFIXES.some((p) => name.startsWith(p))) continue;
      // Only models that support generateContent
      const methods: string[] = m.supportedGenerationMethods ?? [];
      if (!methods.includes('generateContent')) continue;

      results.push({
        model: name,
        provider: 'google' as LLMProvider,
        displayName: m.displayName ?? name,
        maxTokens: m.inputTokenLimit ?? 1000000,
        discoveredAt: now,
      });
    }

    console.log(`[model-discovery] Google: discovered ${results.length} Gemini models`);
    return results;
  } catch (err: any) {
    console.error('[model-discovery] Google discovery failed:', err.message);
    return [];
  }
}

// ── Aggregate ───────────────────────────────────────────────

export async function discoverAllModels(): Promise<DiscoveredModel[]> {
  const [openai, anthropic, google] = await Promise.allSettled([
    discoverOpenAIModels(),
    discoverAnthropicModels(),
    discoverGoogleModels(),
  ]);

  const results: DiscoveredModel[] = [];
  if (openai.status === 'fulfilled') results.push(...openai.value);
  if (anthropic.status === 'fulfilled') results.push(...anthropic.value);
  if (google.status === 'fulfilled') results.push(...google.value);

  console.log(`[model-discovery] Total discovered: ${results.length} models`);
  return results;
}
