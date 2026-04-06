import { getDb } from './db';
import type { WikiBackfillJob, WikiBackfillJobItem, WikiBackfillJobStatus, WikiBackfillJobItemStatus } from '@prism/shared';

function mapJob(row: any): WikiBackfillJob {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    vaultPath: row.vault_path,
    model: row.model ?? null,
    batchSize: row.batch_size,
    currentBatchSize: row.current_batch_size,
    totalItems: row.total_items,
    processedItems: row.processed_items,
    compiledCount: row.compiled_count,
    archivedCount: row.archived_count,
    skippedCount: row.skipped_count,
    failedCount: row.failed_count,
    nextBatchNumber: row.next_batch_number,
    lastLintRunId: row.last_lint_run_id ?? null,
    lastLintFindingCount: row.last_lint_finding_count ?? null,
    tuningNotes: row.tuning_notes_json ? JSON.parse(row.tuning_notes_json) : [],
    currentConversationTitle: row.current_conversation_title ?? null,
    error: row.error ?? undefined,
  };
}

function mapJobItem(row: any): WikiBackfillJobItem {
  return {
    id: row.id,
    jobId: row.job_id,
    conversationId: row.conversation_id,
    title: row.title,
    platform: row.platform,
    projectName: row.project_name ?? undefined,
    ageBucket: row.age_bucket,
    score: row.score,
    recommendedAction: row.recommended_action,
    selectedAction: row.selected_action,
    reasons: row.reasons_json ? JSON.parse(row.reasons_json) : [],
    status: row.status,
    batchNumber: row.batch_number ?? null,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    filePath: row.file_path ?? undefined,
    compilePlanId: row.compile_plan_id ?? undefined,
    appliedItemCount: row.applied_item_count ?? undefined,
    error: row.error ?? undefined,
  };
}

export function createWikiBackfillJob(job: WikiBackfillJob, items: WikiBackfillJobItem[]): WikiBackfillJob {
  const db = getDb();
  const insertJob = db.prepare(`
    INSERT INTO wiki_backfill_jobs (
      id, status, created_at, updated_at, started_at, completed_at, vault_path, model,
      batch_size, current_batch_size, total_items, processed_items, compiled_count, archived_count,
      skipped_count, failed_count, next_batch_number, last_lint_run_id, last_lint_finding_count,
      tuning_notes_json, current_conversation_title, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO wiki_backfill_job_items (
      id, job_id, conversation_id, title, platform, project_name, age_bucket, score,
      recommended_action, selected_action, reasons_json, status, batch_number, started_at,
      completed_at, file_path, compile_plan_id, applied_item_count, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    insertJob.run(
      job.id,
      job.status,
      job.createdAt,
      job.updatedAt,
      job.startedAt ?? null,
      job.completedAt ?? null,
      job.vaultPath,
      job.model ?? null,
      job.batchSize,
      job.currentBatchSize,
      job.totalItems,
      job.processedItems,
      job.compiledCount,
      job.archivedCount,
      job.skippedCount,
      job.failedCount,
      job.nextBatchNumber,
      job.lastLintRunId ?? null,
      job.lastLintFindingCount ?? null,
      JSON.stringify(job.tuningNotes ?? []),
      job.currentConversationTitle ?? null,
      job.error ?? null
    );
    for (const item of items) {
      insertItem.run(
        item.id,
        item.jobId,
        item.conversationId,
        item.title,
        item.platform,
        item.projectName ?? null,
        item.ageBucket,
        item.score,
        item.recommendedAction,
        item.selectedAction,
        JSON.stringify(item.reasons ?? []),
        item.status,
        item.batchNumber ?? null,
        item.startedAt ?? null,
        item.completedAt ?? null,
        item.filePath ?? null,
        item.compilePlanId ?? null,
        item.appliedItemCount ?? null,
        item.error ?? null
      );
    }
  });
  tx();
  return job;
}

export function updateWikiBackfillJob(id: string, patch: Partial<WikiBackfillJob>): WikiBackfillJob | null {
  const existing = getWikiBackfillJob(id);
  if (!existing) return null;
  const next: WikiBackfillJob = {
    ...existing,
    ...patch,
    updatedAt: patch.updatedAt ?? Date.now(),
    tuningNotes: patch.tuningNotes ?? existing.tuningNotes,
  };
  const db = getDb();
  db.prepare(`
    UPDATE wiki_backfill_jobs
    SET status = ?,
        updated_at = ?,
        started_at = ?,
        completed_at = ?,
        vault_path = ?,
        model = ?,
        batch_size = ?,
        current_batch_size = ?,
        total_items = ?,
        processed_items = ?,
        compiled_count = ?,
        archived_count = ?,
        skipped_count = ?,
        failed_count = ?,
        next_batch_number = ?,
        last_lint_run_id = ?,
        last_lint_finding_count = ?,
        tuning_notes_json = ?,
        current_conversation_title = ?,
        error = ?
    WHERE id = ?
  `).run(
    next.status,
    next.updatedAt,
    next.startedAt ?? null,
    next.completedAt ?? null,
    next.vaultPath,
    next.model ?? null,
    next.batchSize,
    next.currentBatchSize,
    next.totalItems,
    next.processedItems,
    next.compiledCount,
    next.archivedCount,
    next.skippedCount,
    next.failedCount,
    next.nextBatchNumber,
    next.lastLintRunId ?? null,
    next.lastLintFindingCount ?? null,
    JSON.stringify(next.tuningNotes ?? []),
    next.currentConversationTitle ?? null,
    next.error ?? null,
    id
  );
  return next;
}

export function updateWikiBackfillJobItem(id: string, patch: Partial<WikiBackfillJobItem>): WikiBackfillJobItem | null {
  const existing = getWikiBackfillJobItem(id);
  if (!existing) return null;
  const next: WikiBackfillJobItem = {
    ...existing,
    ...patch,
    reasons: patch.reasons ?? existing.reasons,
  };
  const db = getDb();
  db.prepare(`
    UPDATE wiki_backfill_job_items
    SET title = ?,
        platform = ?,
        project_name = ?,
        age_bucket = ?,
        score = ?,
        recommended_action = ?,
        selected_action = ?,
        reasons_json = ?,
        status = ?,
        batch_number = ?,
        started_at = ?,
        completed_at = ?,
        file_path = ?,
        compile_plan_id = ?,
        applied_item_count = ?,
        error = ?
    WHERE id = ?
  `).run(
    next.title,
    next.platform,
    next.projectName ?? null,
    next.ageBucket,
    next.score,
    next.recommendedAction,
    next.selectedAction,
    JSON.stringify(next.reasons ?? []),
    next.status,
    next.batchNumber ?? null,
    next.startedAt ?? null,
    next.completedAt ?? null,
    next.filePath ?? null,
    next.compilePlanId ?? null,
    next.appliedItemCount ?? null,
    next.error ?? null,
    id
  );
  return next;
}

export function listWikiBackfillJobs(limit = 20): WikiBackfillJob[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM wiki_backfill_jobs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
  return rows.map(mapJob);
}

export function getWikiBackfillJob(id: string): WikiBackfillJob | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM wiki_backfill_jobs WHERE id = ? LIMIT 1`).get(id);
  return row ? mapJob(row) : null;
}

export function listWikiBackfillJobItems(jobId: string): WikiBackfillJobItem[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM wiki_backfill_job_items
    WHERE job_id = ?
    ORDER BY id ASC
  `).all(jobId);
  return rows.map(mapJobItem);
}

export function getWikiBackfillJobItem(id: string): WikiBackfillJobItem | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM wiki_backfill_job_items WHERE id = ? LIMIT 1`).get(id);
  return row ? mapJobItem(row) : null;
}

export function listPendingWikiBackfillJobItems(jobId: string): WikiBackfillJobItem[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM wiki_backfill_job_items
    WHERE job_id = ? AND status = 'pending'
    ORDER BY id ASC
  `).all(jobId);
  return rows.map(mapJobItem);
}

export function countWikiBackfillJobItemsByStatus(jobId: string, status: WikiBackfillJobItemStatus): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as count
    FROM wiki_backfill_job_items
    WHERE job_id = ? AND status = ?
  `).get(jobId, status) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function resetRunningWikiBackfillJobItems(jobId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE wiki_backfill_job_items
    SET status = 'pending',
        started_at = NULL,
        error = NULL
    WHERE job_id = ? AND status = 'running'
  `).run(jobId);
}
