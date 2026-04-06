import { v4 as uuid } from 'uuid';
import type {
  MemoryExtractionRun,
  MemoryExtractionRunItem,
  MemoryInjectionItem,
  MemoryUsageRun,
  MemoryUsageRunItem,
  OperationMode,
} from '@prism/shared';
import { getDb } from './db';

interface CreateExtractionRunInput {
  sessionId?: string | null;
  trigger: MemoryExtractionRun['trigger'];
  sourceMessageIds: string[];
  notes?: string | null;
  addedCount: number;
  duplicateCount: number;
  acceptedCount?: number;
  rejectedCount?: number;
}

interface CreateExtractionRunItemInput {
  runId: string;
  candidateId?: string | null;
  memoryItemId?: string | null;
  title: string;
  memoryType: string;
  outcome: MemoryExtractionRunItem['outcome'];
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface CreateUsageRunInput {
  sessionId?: string | null;
  model: string;
  mode?: OperationMode | null;
  promptPreview: string;
  retrievedItems: MemoryInjectionItem[];
  injectedItems: MemoryInjectionItem[];
  omittedItems: MemoryInjectionItem[];
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return [];
  }
}

function parseOptionalJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createMemoryExtractionRun(input: CreateExtractionRunInput): MemoryExtractionRun {
  const db = getDb();
  const run: MemoryExtractionRun = {
    id: uuid(),
    sessionId: input.sessionId ?? null,
    trigger: input.trigger,
    sourceMessageIds: input.sourceMessageIds,
    addedCount: input.addedCount,
    duplicateCount: input.duplicateCount,
    acceptedCount: input.acceptedCount ?? 0,
    rejectedCount: input.rejectedCount ?? 0,
    notes: input.notes ?? null,
    createdAt: Date.now(),
  };

  db.prepare(`
    INSERT INTO memory_extraction_runs (
      id, session_id, trigger, source_message_ids, added_count, duplicate_count,
      accepted_count, rejected_count, notes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.sessionId,
    run.trigger,
    JSON.stringify(run.sourceMessageIds),
    run.addedCount,
    run.duplicateCount,
    run.acceptedCount,
    run.rejectedCount,
    run.notes,
    run.createdAt
  );

  return run;
}

export function addMemoryExtractionRunItems(items: CreateExtractionRunItemInput[]): void {
  if (items.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO memory_extraction_run_items (
      id, run_id, candidate_id, memory_item_id, title, memory_type, outcome, reason, created_at
      , metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  const txn = db.transaction(() => {
    for (const item of items) {
      stmt.run(
        uuid(),
        item.runId,
        item.candidateId ?? null,
        item.memoryItemId ?? null,
        item.title,
        item.memoryType,
        item.outcome,
        item.reason ?? null,
        now
        ,
        JSON.stringify(item.metadata ?? null)
      );
    }
  });
  txn();
}

export function listMemoryExtractionRuns(limit = 40): MemoryExtractionRun[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM memory_extraction_runs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as any[];

  return rows.map((row): MemoryExtractionRun => ({
    id: row.id,
    sessionId: row.session_id ?? null,
    trigger: row.trigger,
    sourceMessageIds: parseJsonArray(row.source_message_ids),
    addedCount: row.added_count,
    duplicateCount: row.duplicate_count,
    acceptedCount: row.accepted_count,
    rejectedCount: row.rejected_count,
    notes: row.notes ?? null,
    createdAt: row.created_at,
  }));
}

export function listMemoryExtractionRunItems(runId: string): MemoryExtractionRunItem[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM memory_extraction_run_items
    WHERE run_id = ?
    ORDER BY created_at ASC
  `).all(runId) as any[];

  return rows.map((row): MemoryExtractionRunItem => ({
    id: row.id,
    runId: row.run_id,
    candidateId: row.candidate_id ?? null,
    memoryItemId: row.memory_item_id ?? null,
    title: row.title,
    memoryType: row.memory_type,
    outcome: row.outcome,
    reason: row.reason ?? null,
    metadata: parseOptionalJson(row.metadata_json),
    createdAt: row.created_at,
  }));
}

export function createMemoryUsageRun(input: CreateUsageRunInput): MemoryUsageRun {
  const db = getDb();
  const run: MemoryUsageRun = {
    id: uuid(),
    sessionId: input.sessionId ?? null,
    model: input.model,
    mode: input.mode ?? null,
    promptPreview: input.promptPreview,
    totalRetrieved: input.retrievedItems.length,
    totalInjected: input.injectedItems.length,
    totalOmitted: input.omittedItems.length,
    createdAt: Date.now(),
  };

  db.prepare(`
    INSERT INTO memory_usage_runs (
      id, session_id, model, mode, prompt_preview, total_retrieved, total_injected, total_omitted, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.sessionId,
    run.model,
    run.mode,
    run.promptPreview,
    run.totalRetrieved,
    run.totalInjected,
    run.totalOmitted,
    run.createdAt
  );

  const stmt = db.prepare(`
    INSERT INTO memory_usage_run_items (
      id, run_id, memory_item_id, title, memory_type, action, reason, summary, confidence,
      source_session_id, source_message_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = run.createdAt;
  const write = (item: MemoryInjectionItem, action: MemoryUsageRunItem['action']) => {
    stmt.run(
      uuid(),
      run.id,
      item.memoryItemId ?? null,
      item.title,
      item.memoryType,
      action,
      item.reason ?? null,
      item.summary ?? null,
      item.confidence ?? null,
      item.sourceSessionId ?? null,
      item.sourceMessageId ?? null,
      now
    );
  };

  const txn = db.transaction(() => {
    for (const item of input.retrievedItems) write(item, 'retrieved');
    for (const item of input.injectedItems) write(item, 'injected');
    for (const item of input.omittedItems) write(item, 'omitted');
  });
  txn();

  return run;
}

export function listMemoryUsageRuns(limit = 40): MemoryUsageRun[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM memory_usage_runs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as any[];

  return rows.map((row): MemoryUsageRun => ({
    id: row.id,
    sessionId: row.session_id ?? null,
    model: row.model,
    mode: row.mode ?? null,
    promptPreview: row.prompt_preview,
    totalRetrieved: row.total_retrieved,
    totalInjected: row.total_injected,
    totalOmitted: row.total_omitted,
    createdAt: row.created_at,
  }));
}

export function listMemoryUsageRunItems(runId: string): MemoryUsageRunItem[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM memory_usage_run_items
    WHERE run_id = ?
    ORDER BY created_at ASC
  `).all(runId) as any[];

  return rows.map((row): MemoryUsageRunItem => ({
    id: row.id,
    runId: row.run_id,
    memoryItemId: row.memory_item_id ?? null,
    title: row.title,
    memoryType: row.memory_type,
    action: row.action,
    reason: row.reason ?? null,
    summary: row.summary ?? null,
    confidence: row.confidence ?? null,
    createdAt: row.created_at,
  }));
}
