import type {
  CostEstimationSource,
  LLMProvider,
  LLMUsageEvent,
  ModelConfig,
  ProviderCostRecord,
} from '@prism/shared';
import { estimateMessageTokens, estimateTokens } from '../memory/token-estimator';
import {
  completeProviderCostSyncRun,
  createProviderCostSyncRun,
  insertUsageEvent,
  replaceProviderCostRecords,
} from '../memory/cost-store';
import { modelRegistry } from './model-registry';

export interface UsageComputationInput {
  sessionId: string;
  messageId?: string | null;
  provider: LLMProvider;
  model: string;
  mode: string;
  startedAt: number;
  completedAt?: number;
  requestId?: string | null;
  requestMessages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  content?: string;
  thinkingContent?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
    cachedTokens?: number;
    totalTokens?: number;
  };
  status?: 'completed' | 'failed';
  metadata?: Record<string, unknown> | null;
}

export interface ComputedUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  pricingSource: CostEstimationSource;
  pricingVersion: string;
}

function sumPromptTokens(messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = []): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message.role, message.content), 0);
}

export function estimateTurnCost(modelConfig: ModelConfig | undefined, usage: {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
}): number {
  if (!modelConfig) return 0;
  const inputCost = (usage.promptTokens / 1_000_000) * modelConfig.inputCostPer1M;
  const outputTokenTotal = usage.completionTokens + (usage.reasoningTokens ?? 0);
  const outputCost = (outputTokenTotal / 1_000_000) * modelConfig.outputCostPer1M;
  return Number((inputCost + outputCost).toFixed(8));
}

export function computeUsageEvent(input: UsageComputationInput): ComputedUsage {
  const modelConfig = modelRegistry.getById(input.model);
  const promptTokens = input.usage?.promptTokens ?? sumPromptTokens(input.requestMessages);
  const completionTokens = input.usage?.completionTokens ?? estimateTokens(input.content ?? '');
  const reasoningTokens = input.usage?.reasoningTokens ?? estimateTokens(input.thinkingContent ?? '');
  const cachedTokens = input.usage?.cachedTokens ?? 0;
  const totalTokens = input.usage?.totalTokens ?? (promptTokens + completionTokens + reasoningTokens);
  const pricingSource: CostEstimationSource =
    input.usage?.promptTokens !== undefined || input.usage?.completionTokens !== undefined
      ? 'provider_usage_estimate'
      : 'static_registry_estimate';
  const estimatedCostUsd = estimateTurnCost(modelConfig, {
    promptTokens,
    completionTokens,
    reasoningTokens,
  });

  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    cachedTokens,
    totalTokens,
    estimatedCostUsd,
    pricingSource,
    pricingVersion: 'static-v1',
  };
}

export function recordUsageEvent(input: UsageComputationInput): LLMUsageEvent {
  const computed = computeUsageEvent(input);
  return insertUsageEvent({
    sessionId: input.sessionId,
    messageId: input.messageId ?? null,
    provider: input.provider,
    model: input.model,
    mode: input.mode,
    requestId: input.requestId ?? null,
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? Date.now(),
    promptTokens: computed.promptTokens,
    completionTokens: computed.completionTokens,
    reasoningTokens: computed.reasoningTokens,
    cachedTokens: computed.cachedTokens,
    totalTokens: computed.totalTokens,
    estimatedCostUsd: computed.estimatedCostUsd,
    pricingVersion: computed.pricingVersion,
    pricingSource: computed.pricingSource,
    status: input.status ?? 'completed',
    metadata: {
      ...(input.metadata ?? {}),
      estimatedFromHeuristic: computed.pricingSource === 'static_registry_estimate',
    },
  });
}

function currentMonthKey(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export async function syncOpenAICosts(month = currentMonthKey()): Promise<{ ok: boolean; message?: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, message: 'OPENAI_API_KEY is not set' };
  }

  const run = createProviderCostSyncRun('openai', month);
  try {
    const [year, mm] = month.split('-').map(Number);
    const start = new Date(Date.UTC(year, (mm || 1) - 1, 1)).toISOString();
    const end = new Date(Date.UTC(year, mm || 1, 1)).toISOString();
    const response = await fetch(`https://api.openai.com/v1/organization/costs?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI cost sync failed (${response.status}): ${text.slice(0, 400)}`);
    }

    const json = await response.json() as any;
    const records: Array<Omit<ProviderCostRecord, 'id' | 'provider' | 'month' | 'currency' | 'syncedAt'>> = [];
    const data = Array.isArray(json?.data) ? json.data : [];
    for (const item of data) {
      const amountUsd = Number(item?.amount?.value ?? item?.amount?.usd ?? item?.cost ?? 0);
      const lineItem = String(item?.line_item ?? item?.project_id ?? item?.organization_id ?? 'openai_month_total');
      records.push({
        lineItem,
        amountUsd: Number.isFinite(amountUsd) ? amountUsd : 0,
        displayStatus: 'reconciled',
        metadata: item ?? null,
      });
    }
    replaceProviderCostRecords('openai', month, records);
    completeProviderCostSyncRun(run.id, 'completed', `Synced ${records.length} OpenAI cost record(s)`);
    return { ok: true };
  } catch (error: any) {
    completeProviderCostSyncRun(run.id, 'failed', error?.message ?? 'Unknown error');
    return { ok: false, message: error?.message ?? 'Unknown error' };
  }
}

export async function syncAnthropicCosts(month = currentMonthKey()): Promise<{ ok: boolean; message?: string }> {
  const apiKey = process.env.ANTHROPIC_ADMIN_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, message: 'Admin key required' };
  }

  const run = createProviderCostSyncRun('anthropic', month);
  try {
    const [year, mm] = month.split('-').map(Number);
    const start = new Date(Date.UTC(year, (mm || 1) - 1, 1)).toISOString();
    const end = new Date(Date.UTC(year, mm || 1, 1)).toISOString();
    const response = await fetch(`https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(start)}&ending_at=${encodeURIComponent(end)}`, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      const msg = response.status === 401 || response.status === 403 ? 'Admin key required' : `Anthropic cost sync failed (${response.status}): ${text.slice(0, 400)}`;
      throw new Error(msg);
    }

    const json = await response.json() as any;
    const data = Array.isArray(json?.data) ? json.data : [];
    const records: Array<Omit<ProviderCostRecord, 'id' | 'provider' | 'month' | 'currency' | 'syncedAt'>> = data.map((item: any) => ({
      lineItem: String(item?.workspace_id ?? item?.model ?? item?.description ?? 'anthropic_month_total'),
      amountUsd: Number(item?.cost_usd ?? item?.amount_usd ?? item?.amount ?? 0),
      displayStatus: 'reconciled',
      metadata: item ?? null,
    }));
    replaceProviderCostRecords('anthropic', month, records);
    completeProviderCostSyncRun(run.id, 'completed', `Synced ${records.length} Anthropic cost record(s)`);
    return { ok: true };
  } catch (error: any) {
    completeProviderCostSyncRun(run.id, 'failed', error?.message ?? 'Unknown error');
    return { ok: false, message: error?.message ?? 'Unknown error' };
  }
}
