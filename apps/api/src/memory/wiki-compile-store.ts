import { v4 as uuid } from 'uuid';
import type { CompilePlan } from '@prism/shared';
import { getDb } from './db';

type CompilePlanRow = {
  id: string;
  source_id: string;
  source_type: string;
  source_title: string;
  status: CompilePlan['status'];
  model?: string | null;
  created_at: number;
  updated_at: number;
  applied_at?: number | null;
  source_summary: string;
  detected_artifacts_json: string;
  items_json: string;
  warnings_json: string;
  skipped_items_json: string;
  errors_json: string;
};

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapRow(row: CompilePlanRow): CompilePlan {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceType: row.source_type as CompilePlan['sourceType'],
    sourceTitle: row.source_title,
    status: row.status,
    model: row.model ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at ?? null,
    sourceSummary: row.source_summary,
    detectedArtifacts: safeParse(row.detected_artifacts_json, []),
    items: safeParse(row.items_json, []),
    warnings: safeParse(row.warnings_json, []),
    skippedItems: safeParse(row.skipped_items_json, []),
    errors: safeParse(row.errors_json, []),
  };
}

export function createWikiCompilePlan(input: Omit<CompilePlan, 'id' | 'createdAt' | 'updatedAt' | 'appliedAt' | 'status'> & {
  status?: CompilePlan['status'];
}): CompilePlan {
  const db = getDb();
  const now = Date.now();
  const id = uuid();
  db.prepare(`
    INSERT INTO wiki_compile_plans (
      id, source_id, source_type, source_title, status, model, created_at, updated_at,
      source_summary, detected_artifacts_json, items_json, warnings_json, skipped_items_json, errors_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.sourceId,
    input.sourceType,
    input.sourceTitle,
    input.status ?? 'planned',
    input.model ?? null,
    now,
    now,
    input.sourceSummary,
    JSON.stringify(input.detectedArtifacts ?? []),
    JSON.stringify(input.items ?? []),
    JSON.stringify(input.warnings ?? []),
    JSON.stringify(input.skippedItems ?? []),
    JSON.stringify(input.errors ?? []),
  );
  return getWikiCompilePlan(id)!;
}

export function updateWikiCompilePlan(id: string, patch: Partial<Omit<CompilePlan, 'id' | 'sourceId' | 'sourceType' | 'sourceTitle' | 'createdAt'>>): CompilePlan | null {
  const current = getWikiCompilePlan(id);
  if (!current) return null;
  const next: CompilePlan = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };
  const db = getDb();
  db.prepare(`
    UPDATE wiki_compile_plans
    SET status = ?,
        model = ?,
        updated_at = ?,
        applied_at = ?,
        source_summary = ?,
        detected_artifacts_json = ?,
        items_json = ?,
        warnings_json = ?,
        skipped_items_json = ?,
        errors_json = ?
    WHERE id = ?
  `).run(
    next.status,
    next.model ?? null,
    next.updatedAt,
    next.appliedAt ?? null,
    next.sourceSummary,
    JSON.stringify(next.detectedArtifacts ?? []),
    JSON.stringify(next.items ?? []),
    JSON.stringify(next.warnings ?? []),
    JSON.stringify(next.skippedItems ?? []),
    JSON.stringify(next.errors ?? []),
    id,
  );
  return getWikiCompilePlan(id);
}

export function getWikiCompilePlan(id: string): CompilePlan | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM wiki_compile_plans WHERE id = ? LIMIT 1').get(id) as CompilePlanRow | undefined;
  return row ? mapRow(row) : null;
}

export function listWikiCompilePlans(opts: { sourceId?: string; sourceType?: string; limit?: number } = {}): CompilePlan[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: any[] = [];
  if (opts.sourceId) {
    clauses.push('source_id = ?');
    params.push(opts.sourceId);
  }
  if (opts.sourceType) {
    clauses.push('source_type = ?');
    params.push(opts.sourceType);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = opts.limit ?? 20;
  const rows = db.prepare(`
    SELECT *
    FROM wiki_compile_plans
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit) as CompilePlanRow[];
  return rows.map(mapRow);
}
