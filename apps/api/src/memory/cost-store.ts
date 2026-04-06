import { v4 as uuid } from 'uuid';
import type {
  CostDisplayStatus,
  CostEstimationSource,
  LLMCostSummary,
  LLMProvider,
  LLMUsageEvent,
  ProviderCostRecord,
  ProviderCostSyncRun,
} from '@prism/shared';
import { getDb } from './db';

type UsageRow = Omit<LLMUsageEvent, 'metadata'> & { metadata?: string | null };
type ProviderCostRow = Omit<ProviderCostRecord, 'metadata'> & { metadata?: string | null };

export function insertUsageEvent(event: Omit<LLMUsageEvent, 'id'> & { id?: string }): LLMUsageEvent {
  const db = getDb();
  const row: LLMUsageEvent = {
    ...event,
    id: event.id ?? uuid(),
    metadata: event.metadata ?? null,
  };

  db.prepare(
    `INSERT INTO llm_usage_events (
      id, session_id, message_id, provider, model, mode, request_id,
      started_at, completed_at, prompt_tokens, completion_tokens,
      reasoning_tokens, cached_tokens, total_tokens, estimated_cost_usd,
      pricing_version, pricing_source, workspace_scope, status, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.sessionId,
    row.messageId ?? null,
    row.provider,
    row.model,
    row.mode,
    row.requestId ?? null,
    row.startedAt,
    row.completedAt,
    row.promptTokens,
    row.completionTokens,
    row.reasoningTokens ?? 0,
    row.cachedTokens ?? 0,
    row.totalTokens,
    row.estimatedCostUsd,
    row.pricingVersion,
    row.pricingSource,
    row.workspaceScope ?? null,
    row.status ?? 'completed',
    row.metadata ? JSON.stringify(row.metadata) : null,
  );

  return row;
}

export function listUsageEventsForSession(sessionId: string): LLMUsageEvent[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT
      id,
      session_id as sessionId,
      message_id as messageId,
      provider,
      model,
      mode,
      request_id as requestId,
      started_at as startedAt,
      completed_at as completedAt,
      prompt_tokens as promptTokens,
      completion_tokens as completionTokens,
      reasoning_tokens as reasoningTokens,
      cached_tokens as cachedTokens,
      total_tokens as totalTokens,
      estimated_cost_usd as estimatedCostUsd,
      pricing_version as pricingVersion,
      pricing_source as pricingSource,
      workspace_scope as workspaceScope,
      status,
      metadata
    FROM llm_usage_events
    WHERE session_id = ?
    ORDER BY completed_at ASC`
  ).all(sessionId) as UsageRow[];

  return rows.map((row) => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  }));
}

export function listUsageEvents(opts?: {
  sessionId?: string;
  provider?: LLMProvider;
  model?: string;
  limit?: number;
}): LLMUsageEvent[] {
  const db = getDb();
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (opts?.sessionId) {
    clauses.push('session_id = ?');
    values.push(opts.sessionId);
  }
  if (opts?.provider) {
    clauses.push('provider = ?');
    values.push(opts.provider);
  }
  if (opts?.model) {
    clauses.push('model = ?');
    values.push(opts.model);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
  const rows = db.prepare(
    `SELECT
      id,
      session_id as sessionId,
      message_id as messageId,
      provider,
      model,
      mode,
      request_id as requestId,
      started_at as startedAt,
      completed_at as completedAt,
      prompt_tokens as promptTokens,
      completion_tokens as completionTokens,
      reasoning_tokens as reasoningTokens,
      cached_tokens as cachedTokens,
      total_tokens as totalTokens,
      estimated_cost_usd as estimatedCostUsd,
      pricing_version as pricingVersion,
      pricing_source as pricingSource,
      workspace_scope as workspaceScope,
      status,
      metadata
    FROM llm_usage_events
    ${where}
    ORDER BY completed_at DESC
    LIMIT ${limit}`
  ).all(...values) as UsageRow[];

  return rows.map((row) => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  }));
}

export function summarizeCostsForMonth(month: string): LLMCostSummary {
  const db = getDb();
  const [year, mm] = month.split('-').map((v) => Number(v));
  const monthStart = Date.UTC(year, (mm || 1) - 1, 1);
  const monthEnd = Date.UTC(year, mm || 1, 1);

  const totalRow = db.prepare(
    `SELECT
      COALESCE(SUM(estimated_cost_usd), 0) as estimatedUsd,
      COALESCE(SUM(total_tokens), 0) as totalTokens
    FROM llm_usage_events
    WHERE completed_at >= ? AND completed_at < ?`
  ).get(monthStart, monthEnd) as { estimatedUsd: number; totalTokens: number };

  const providerRows = db.prepare(
    `SELECT
      provider,
      COALESCE(SUM(estimated_cost_usd), 0) as estimatedUsd,
      COALESCE(SUM(total_tokens), 0) as totalTokens
    FROM llm_usage_events
    WHERE completed_at >= ? AND completed_at < ?
    GROUP BY provider
    ORDER BY estimatedUsd DESC`
  ).all(monthStart, monthEnd) as Array<{ provider: LLMProvider; estimatedUsd: number; totalTokens: number }>;

  const reconciledRows = db.prepare(
    `SELECT
      provider,
      COALESCE(SUM(amount_usd), 0) as reconciledUsd
    FROM provider_cost_records
    WHERE month = ?
    GROUP BY provider`
  ).all(month) as Array<{ provider: LLMProvider; reconciledUsd: number }>;

  const reconciledMap = new Map(reconciledRows.map((row) => [row.provider, row.reconciledUsd]));

  const modelRows = db.prepare(
    `SELECT
      provider,
      model,
      COALESCE(SUM(estimated_cost_usd), 0) as estimatedUsd,
      COALESCE(SUM(total_tokens), 0) as totalTokens
    FROM llm_usage_events
    WHERE completed_at >= ? AND completed_at < ?
    GROUP BY provider, model
    ORDER BY estimatedUsd DESC
    LIMIT 20`
  ).all(monthStart, monthEnd) as Array<{ provider: LLMProvider; model: string; estimatedUsd: number; totalTokens: number }>;

  const modeRows = db.prepare(
    `SELECT
      mode,
      COALESCE(SUM(estimated_cost_usd), 0) as estimatedUsd,
      COALESCE(SUM(total_tokens), 0) as totalTokens
    FROM llm_usage_events
    WHERE completed_at >= ? AND completed_at < ?
    GROUP BY mode
    ORDER BY estimatedUsd DESC`
  ).all(monthStart, monthEnd) as Array<{ mode: string; estimatedUsd: number; totalTokens: number }>;

  const totalReconciledUsd = reconciledRows.reduce((sum, row) => sum + row.reconciledUsd, 0);

  return {
    currency: 'USD',
    month,
    totalEstimatedUsd: totalRow.estimatedUsd,
    totalReconciledUsd,
    providerBreakdown: providerRows.map((row) => ({
      provider: row.provider,
      estimatedUsd: row.estimatedUsd,
      reconciledUsd: reconciledMap.get(row.provider) ?? 0,
      displayStatus: (reconciledMap.has(row.provider) ? 'reconciled' : 'estimated') as CostDisplayStatus,
    })),
    modelBreakdown: modelRows,
    modeBreakdown: modeRows,
  };
}

export function createProviderCostSyncRun(provider: LLMProvider, month: string): ProviderCostSyncRun {
  const db = getDb();
  const run: ProviderCostSyncRun = {
    id: uuid(),
    provider,
    month,
    status: 'failed',
    startedAt: Date.now(),
    completedAt: null,
    message: null,
  };
  db.prepare(
    `INSERT INTO provider_cost_sync_runs (id, provider, month, status, started_at, completed_at, message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(run.id, run.provider, run.month, run.status, run.startedAt, null, null);
  return run;
}

export function completeProviderCostSyncRun(runId: string, status: 'completed' | 'failed', message?: string | null): void {
  const db = getDb();
  db.prepare(
    `UPDATE provider_cost_sync_runs
     SET status = ?, completed_at = ?, message = ?
     WHERE id = ?`
  ).run(status, Date.now(), message ?? null, runId);
}

export function replaceProviderCostRecords(
  provider: LLMProvider,
  month: string,
  records: Array<Omit<ProviderCostRecord, 'id' | 'provider' | 'month' | 'currency' | 'syncedAt'> & { metadata?: Record<string, unknown> | null }>,
): void {
  const db = getDb();
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO provider_cost_records (
      id, provider, month, line_item, amount_usd, currency, display_status, synced_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM provider_cost_records WHERE provider = ? AND month = ?').run(provider, month);
    for (const record of records) {
      insert.run(
        uuid(),
        provider,
        month,
        record.lineItem,
        record.amountUsd,
        'USD',
        record.displayStatus,
        now,
        record.metadata ? JSON.stringify(record.metadata) : null,
      );
    }
  });
  tx();
}

export function listProviderCostRecords(month: string): ProviderCostRecord[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT
      id, provider, month, line_item as lineItem, amount_usd as amountUsd,
      currency, display_status as displayStatus, synced_at as syncedAt, metadata
    FROM provider_cost_records
    WHERE month = ?
    ORDER BY provider ASC, amount_usd DESC`
  ).all(month) as ProviderCostRow[];

  return rows.map((row) => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  }));
}
