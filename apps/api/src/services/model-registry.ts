/**
 * Model Registry — merges static MODELS config with dynamically discovered models.
 *
 * Static config (constants.ts) is the source of truth for pricing, descriptions,
 * and display names. Discovery adds newly available models that aren't in static config.
 */

import { MODELS } from '@prism/shared';
import type { ModelConfig, DiscoveredModel, ModelRegistryInfo, LLMProvider } from '@prism/shared';
import { discoverAllModels } from './model-discovery';

const DEFAULT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

function isAutoRefreshEnabled(): boolean {
  return process.env.MODEL_DISCOVERY_ENABLED === 'true';
}

function getRefreshIntervalMs(): number {
  const raw = parseInt(process.env.MODEL_DISCOVERY_INTERVAL_MS ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_REFRESH_INTERVAL_MS;
  }
  return raw;
}

function inferDiscoveredCapabilities(modelId: string, provider: LLMProvider): Pick<ModelConfig, 'isReasoning' | 'supportsThinking'> {
  if (provider === 'openai') {
    if (modelId.startsWith('gpt-5') || /^o[1345](?:-|$)/.test(modelId)) {
      return { isReasoning: true, supportsThinking: true };
    }
  }

  if (provider === 'google') {
    if (/^gemini-(?:2\.5|3)/.test(modelId)) {
      return { isReasoning: false, supportsThinking: true };
    }
  }

  return {
    isReasoning: undefined,
    supportsThinking: undefined,
  };
}

class ModelRegistryService {
  /** Merged model map (static + discovered) */
  private models: Record<string, ModelConfig>;

  /** Discovered models that aren't in static config */
  private discoveredExtras: Record<string, ModelConfig> = {};

  /** Last successful refresh timestamp */
  private lastRefreshedAt: number | null = null;

  /** Whether a refresh is currently running */
  private refreshing = false;
  private initPromise: Promise<{ added: number; total: number }> | null = null;

  constructor() {
    // Deep-clone static config as our base
    this.models = { ...MODELS };
  }

  /** Get all available models (static + discovered) */
  getAll(): Record<string, ModelConfig> {
    return { ...this.models, ...this.discoveredExtras };
  }

  /** Get a single model config by ID */
  getById(modelId: string): ModelConfig | undefined {
    return this.discoveredExtras[modelId] ?? this.models[modelId];
  }

  /** Get all models for a specific provider */
  getByProvider(provider: LLMProvider): Record<string, ModelConfig> {
    const all = this.getAll();
    const result: Record<string, ModelConfig> = {};
    for (const [id, config] of Object.entries(all)) {
      if (config.provider === provider) result[id] = config;
    }
    return result;
  }

  /** Get registry metadata */
  getInfo(): ModelRegistryInfo {
    return {
      staticCount: Object.keys(this.models).length,
      discoveredCount: Object.keys(this.discoveredExtras).length,
      lastRefreshedAt: this.lastRefreshedAt,
      autoRefreshEnabled: isAutoRefreshEnabled(),
      refreshIntervalMs: getRefreshIntervalMs(),
    };
  }

  /** Ensure runtime-discovered models are loaded at least once. */
  async ensureInitialized(): Promise<void> {
    if (this.lastRefreshedAt) return;
    if (!this.initPromise) {
      this.initPromise = this.refresh()
        .catch((err) => {
          console.warn('[model-registry] Initial bootstrap refresh failed:', err);
          return { added: 0, total: Object.keys(this.getAll()).length };
        })
        .finally(() => {
          this.initPromise = null;
        });
    }

    await this.initPromise;
  }

  /**
   * Refresh the registry by running model discovery.
   * Discovered models that already exist in static config are ignored
   * (static config has better metadata like pricing and descriptions).
   * New models found only via discovery are added to discoveredExtras.
   */
  async refresh(): Promise<{ added: number; total: number }> {
    if (this.refreshing) {
      console.warn('[model-registry] Refresh already in progress, skipping');
      return { added: 0, total: Object.keys(this.getAll()).length };
    }

    this.refreshing = true;
    try {
      const discovered = await discoverAllModels();
      const newExtras: Record<string, ModelConfig> = {};

      for (const d of discovered) {
        // Skip if already in static config (static has better metadata)
        if (this.models[d.model]) continue;
        const inferred = inferDiscoveredCapabilities(d.model, d.provider);

        // Create a ModelConfig from the discovered data
        newExtras[d.model] = {
          provider: d.provider,
          model: d.model,
          displayName: d.displayName,
          maxTokens: d.maxTokens,
          inputCostPer1M: d.inputCostPer1M ?? 0,
          outputCostPer1M: d.outputCostPer1M ?? 0,
          description: d.description ?? 'Discovered via API',
          isReasoning: d.isReasoning ?? inferred.isReasoning,
          supportsThinking: inferred.supportsThinking ?? d.isReasoning,
        };
      }

      this.discoveredExtras = newExtras;
      this.lastRefreshedAt = Date.now();

      const added = Object.keys(newExtras).length;
      const total = Object.keys(this.getAll()).length;
      console.log(`[model-registry] Refresh complete: ${total} total models (${added} discovered beyond static config)`);
      return { added, total };
    } finally {
      this.refreshing = false;
    }
  }
}

/** Singleton registry instance */
export const modelRegistry = new ModelRegistryService();
