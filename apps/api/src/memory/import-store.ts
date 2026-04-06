import { getDb } from './db';
import { ImportedConversation, ImportedMessage, ImportedTitleSource, ImportPlatform, ImportProjectTarget, ImportSyncRun, ImportSyncState } from '@prism/shared';

export function listImportedConversations(opts: {
  platform?: ImportPlatform;
  limit?: number;
  offset?: number;
  search?: string;
}): { conversations: ImportedConversation[]; total: number } {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.platform) {
    conditions.push('ic.source_platform = ?');
    params.push(opts.platform);
  }
  if (opts.search) {
    conditions.push('ic.title LIKE ?');
    params.push(`%${opts.search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countConditions: string[] = [];
  const countParams: any[] = [];
  if (opts.platform) {
    countConditions.push('source_platform = ?');
    countParams.push(opts.platform);
  }
  if (opts.search) {
    countConditions.push('title LIKE ?');
    countParams.push(`%${opts.search}%`);
  }
  const countWhere = countConditions.length > 0 ? `WHERE ${countConditions.join(' AND ')}` : '';

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM imported_conversations ${countWhere}`).get(...countParams) as any;
  const total = countRow.total;

  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  const rows = db.prepare(`
    SELECT
      ic.*,
      iss.source_kind,
      iss.last_synced_at,
      iss.source_updated_at,
      iss.project_name as sync_project_name,
      iss.workspace_id,
      iss.workspace_name,
      iss.account_id,
      COALESCE(MAX(im.timestamp), ic.updated_at, ic.created_at) AS last_activity_at
    FROM imported_conversations ic
    LEFT JOIN import_sync_state iss ON iss.conversation_id = ic.id
    LEFT JOIN imported_messages im ON im.conversation_id = ic.id
    ${where ? where.replace('WHERE ', 'WHERE ') : ''}
    GROUP BY ic.id
    ORDER BY last_activity_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as any[];

  const conversations: ImportedConversation[] = rows.map(r => {
    const metadata = r.metadata ? JSON.parse(r.metadata) : undefined;
    return ({
    id: r.id,
    sourcePlatform: r.source_platform,
    originalId: r.original_id,
    title: r.title,
    sourceTitle: r.source_title ?? undefined,
    titleSource: (r.title_source as ImportedTitleSource | null) ?? 'source',
    titleLocked: Boolean(r.title_locked),
    titleGeneratedAt: r.title_generated_at ?? undefined,
    titleLastMessageCount: typeof r.title_last_message_count === 'number' ? r.title_last_message_count : undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastActivityAt: r.last_activity_at,
    messageCount: r.message_count,
    sessionId: r.session_id,
    importBatchId: r.import_batch_id,
    projectName: deriveProjectName(
      r.title,
      metadata,
      r.sync_project_name ?? undefined
    ),
    sourceKind: r.source_kind ?? 'archive_upload',
    lastSyncedAt: r.last_synced_at ?? undefined,
    sourceUpdatedAt: r.source_updated_at ?? undefined,
    workspaceId: r.workspace_id ?? metadata?.workspaceId ?? undefined,
    workspaceName: r.workspace_name ?? metadata?.workspaceName ?? undefined,
    accountId: r.account_id ?? metadata?.accountId ?? undefined,
    defaultModelSlug: metadata?.defaultModelSlug ?? undefined,
    isArchived: typeof metadata?.isArchived === 'boolean' ? metadata.isArchived : undefined,
    metadata,
  });
  });

  return { conversations, total };
}

function deriveProjectName(title: string, metadata?: Record<string, any>, syncProjectName?: string): string | undefined {
  if (typeof syncProjectName === 'string' && syncProjectName.trim()) return syncProjectName.trim();
  const explicit =
    metadata?.projectName ||
    metadata?.project ||
    metadata?.workspace ||
    metadata?.folder ||
    metadata?.topic;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();

  const segments = title
    .split(/[·•|｜]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length >= 2) {
    return segments[segments.length - 1];
  }
  if (typeof title === 'string' && title.trim()) {
    return title.trim();
  }
  return undefined;
}

export function getImportedMessages(conversationId: string): ImportedMessage[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM imported_messages
    WHERE conversation_id = ?
    ORDER BY timestamp ASC
  `).all(conversationId) as any[];

  return rows.map(r => ({
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    sourceModel: r.source_model,
    timestamp: r.timestamp,
    tokenCount: r.token_count,
    parentMessageId: r.parent_message_id,
    metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
  }));
}

export function getImportedConversation(conversationId: string): ImportedConversation | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      ic.*,
      iss.source_kind,
      iss.last_synced_at,
      iss.source_updated_at,
      iss.project_name as sync_project_name,
      iss.workspace_id,
      iss.workspace_name,
      iss.account_id
    FROM imported_conversations ic
    LEFT JOIN import_sync_state iss ON iss.conversation_id = ic.id
    WHERE ic.id = ?
    LIMIT 1
  `).get(conversationId) as any;

  if (!row) return null;

  const metadata = row.metadata ? JSON.parse(row.metadata) : undefined;
  return {
    id: row.id,
    sourcePlatform: row.source_platform,
    originalId: row.original_id,
    title: row.title,
    sourceTitle: row.source_title ?? undefined,
    titleSource: (row.title_source as ImportedTitleSource | null) ?? 'source',
    titleLocked: Boolean(row.title_locked),
    titleGeneratedAt: row.title_generated_at ?? undefined,
    titleLastMessageCount: typeof row.title_last_message_count === 'number' ? row.title_last_message_count : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    sessionId: row.session_id,
    importBatchId: row.import_batch_id,
    projectName: deriveProjectName(
      row.title,
      metadata,
      row.sync_project_name ?? undefined
    ),
    sourceKind: row.source_kind ?? 'archive_upload',
    lastSyncedAt: row.last_synced_at ?? undefined,
    sourceUpdatedAt: row.source_updated_at ?? undefined,
    workspaceId: row.workspace_id ?? metadata?.workspaceId ?? undefined,
    workspaceName: row.workspace_name ?? metadata?.workspaceName ?? undefined,
    accountId: row.account_id ?? metadata?.accountId ?? undefined,
    defaultModelSlug: metadata?.defaultModelSlug ?? undefined,
    isArchived: typeof metadata?.isArchived === 'boolean' ? metadata.isArchived : undefined,
    metadata,
  };
}

export function getImportStats(): {
  total: number;
  byPlatform: Record<string, number>;
} {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM imported_conversations').get() as any).c;
  const rows = db.prepare(`
    SELECT source_platform, COUNT(*) as c
    FROM imported_conversations GROUP BY source_platform
  `).all() as any[];

  const byPlatform: Record<string, number> = {};
  for (const r of rows) byPlatform[r.source_platform] = r.c;

  return { total, byPlatform };
}

export function listImportProjects(): ImportProjectTarget[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      id,
      COALESCE(action_title, title, 'Untitled session') as title,
      session_type as sessionType,
      updated_at as updatedAt
    FROM sessions
    WHERE COALESCE(TRIM(action_title), TRIM(title), '') != ''
    ORDER BY updated_at DESC
    LIMIT 100
  `).all() as Array<{ id: string; title: string; sessionType: 'topic' | 'action'; updatedAt: number }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    sessionType: row.sessionType,
    updatedAt: row.updatedAt,
  }));
}

export function upsertImportSyncState(state: ImportSyncState): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO import_sync_state
    (conversation_id, source_platform, original_id, source_kind, last_synced_at, source_updated_at, project_name, workspace_id, workspace_name, account_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      source_platform = excluded.source_platform,
      original_id = excluded.original_id,
      source_kind = excluded.source_kind,
      last_synced_at = excluded.last_synced_at,
      source_updated_at = excluded.source_updated_at,
      project_name = excluded.project_name,
      workspace_id = excluded.workspace_id,
      workspace_name = excluded.workspace_name,
      account_id = excluded.account_id,
      metadata = excluded.metadata
  `).run(
    state.conversationId,
    state.sourcePlatform,
    state.originalId,
    state.sourceKind,
    state.lastSyncedAt,
    state.sourceUpdatedAt ?? null,
    state.projectName ?? null,
    state.workspaceId ?? null,
    state.workspaceName ?? null,
    state.accountId ?? null,
    state.metadata ? JSON.stringify(state.metadata) : null
  );
}

export function deleteImportBatch(batchId: string): number {
  const db = getDb();
  const convIds = db.prepare(
    'SELECT id FROM imported_conversations WHERE import_batch_id = ?'
  ).all(batchId) as any[];

  const deleteAll = db.transaction(() => {
    for (const { id } of convIds) {
      db.prepare("DELETE FROM compiler_runs WHERE source_id = ? AND source_type LIKE 'imported_%'").run(id);
      db.prepare('DELETE FROM conversation_tags WHERE conversation_id = ?').run(id);
      db.prepare('DELETE FROM entity_mentions WHERE conversation_id = ?').run(id);
      db.prepare('DELETE FROM content_provenance WHERE conversation_id = ?').run(id);
      db.prepare("DELETE FROM session_outlines WHERE session_id = ? AND source_type = 'imported'").run(id);
      db.prepare('DELETE FROM import_sync_state WHERE conversation_id = ?').run(id);
      db.prepare('DELETE FROM imported_messages WHERE conversation_id = ?').run(id);
    }
    const info = db.prepare('DELETE FROM imported_conversations WHERE import_batch_id = ?').run(batchId);
    return info.changes;
  });

  return deleteAll();
}

export function deleteImportedConversation(conversationId: string): boolean {
  const db = getDb();
  const deleteOne = db.transaction(() => {
    db.prepare("DELETE FROM compiler_runs WHERE source_id = ? AND source_type LIKE 'imported_%'").run(conversationId);
    db.prepare('DELETE FROM conversation_tags WHERE conversation_id = ?').run(conversationId);
    db.prepare('DELETE FROM entity_mentions WHERE conversation_id = ?').run(conversationId);
    db.prepare('DELETE FROM content_provenance WHERE conversation_id = ?').run(conversationId);
    db.prepare("DELETE FROM session_outlines WHERE session_id = ? AND source_type = 'imported'").run(conversationId);
    db.prepare('DELETE FROM import_sync_state WHERE conversation_id = ?').run(conversationId);
    db.prepare('DELETE FROM imported_messages WHERE conversation_id = ?').run(conversationId);
    const info = db.prepare('DELETE FROM imported_conversations WHERE id = ?').run(conversationId);
    return info.changes > 0;
  });

  return deleteOne();
}

export function updateImportedConversationTitle(conversationId: string, title: string): boolean {
  const db = getDb();
  const trimmed = title.trim();
  if (!trimmed) return false;

  const info = db.prepare(`
    UPDATE imported_conversations
    SET title = ?,
        title_source = 'manual',
        title_locked = 1
    WHERE id = ?
  `).run(trimmed, conversationId);

  return info.changes > 0;
}

export function recordImportSyncRun(params: {
  id: string;
  sourcePlatform: ImportPlatform;
  sourceKind: 'chatgpt_browser_sync' | 'claude_browser_sync' | 'gemini_browser_sync';
  projectName?: string | null;
  batchCount?: number;
  batchIndex?: number;
  status: 'running' | 'completed' | 'failed';
  requestedConversations: number;
  processedConversations: number;
  importedConversations: number;
  overwrittenConversations: number;
  skippedConversations: number;
  failedConversations: number;
  totalMessages: number;
  metadata?: Record<string, any>;
}): ImportSyncRun {
  const db = getDb();
  const now = new Date().toISOString();
  const batchCount = Math.max(1, params.batchCount ?? 1);
  const batchIndex = Math.max(1, params.batchIndex ?? 1);
  const existing = db.prepare(`
    SELECT *
    FROM import_sync_runs
    WHERE id = ?
    LIMIT 1
  `).get(params.id) as any | undefined;

  const nextRequested = (existing?.requested_conversations ?? 0) + params.requestedConversations;
  const nextProcessed = (existing?.processed_conversations ?? 0) + params.processedConversations;
  const nextImported = (existing?.imported_conversations ?? 0) + params.importedConversations;
  const nextOverwritten = (existing?.overwritten_conversations ?? 0) + params.overwrittenConversations;
  const nextSkipped = (existing?.skipped_conversations ?? 0) + params.skippedConversations;
  const nextFailed = (existing?.failed_conversations ?? 0) + params.failedConversations;
  const nextMessages = (existing?.total_messages ?? 0) + params.totalMessages;
  const nextCompletedBatchCount = Math.max(existing?.completed_batch_count ?? 0, batchIndex);
  const nextStatus =
    params.status === 'failed'
      ? 'failed'
      : nextCompletedBatchCount >= batchCount
        ? 'completed'
        : 'running';
  const mergedMetadata = {
    ...(existing?.metadata ? JSON.parse(existing.metadata) : {}),
    ...(params.metadata ?? {}),
  };

  db.prepare(`
    INSERT INTO import_sync_runs (
      id, source_platform, source_kind, project_name, status,
      requested_conversations, processed_conversations, imported_conversations, overwritten_conversations,
      skipped_conversations, failed_conversations, total_messages, batch_count, completed_batch_count,
      started_at, updated_at, completed_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source_platform = excluded.source_platform,
      source_kind = excluded.source_kind,
      project_name = excluded.project_name,
      status = excluded.status,
      requested_conversations = excluded.requested_conversations,
      processed_conversations = excluded.processed_conversations,
      imported_conversations = excluded.imported_conversations,
      overwritten_conversations = excluded.overwritten_conversations,
      skipped_conversations = excluded.skipped_conversations,
      failed_conversations = excluded.failed_conversations,
      total_messages = excluded.total_messages,
      batch_count = excluded.batch_count,
      completed_batch_count = excluded.completed_batch_count,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at,
      metadata = excluded.metadata
  `).run(
    params.id,
    params.sourcePlatform,
    params.sourceKind,
    params.projectName ?? existing?.project_name ?? null,
    nextStatus,
    nextRequested,
    nextProcessed,
    nextImported,
    nextOverwritten,
    nextSkipped,
    nextFailed,
    nextMessages,
    batchCount,
    nextCompletedBatchCount,
    existing?.started_at ?? now,
    now,
    nextStatus === 'completed' || nextStatus === 'failed' ? now : null,
    Object.keys(mergedMetadata).length > 0 ? JSON.stringify(mergedMetadata) : null
  );

  return getImportSyncRun(params.id)!;
}

export function getImportSyncRun(id: string): ImportSyncRun | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM import_sync_runs WHERE id = ? LIMIT 1`).get(id) as any;
  if (!row) return null;
  return mapSyncRunRow(row);
}

export function listImportSyncRuns(limit: number = 20): ImportSyncRun[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM import_sync_runs
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit) as any[];
  return rows.map(mapSyncRunRow);
}

function mapSyncRunRow(row: any): ImportSyncRun {
  return {
    id: row.id,
    sourcePlatform: row.source_platform,
    sourceKind: row.source_kind,
    projectName: row.project_name ?? undefined,
    status: row.status,
    requestedConversations: row.requested_conversations ?? 0,
    processedConversations: row.processed_conversations ?? 0,
    importedConversations: row.imported_conversations ?? 0,
    overwrittenConversations: row.overwritten_conversations ?? 0,
    skippedConversations: row.skipped_conversations ?? 0,
    failedConversations: row.failed_conversations ?? 0,
    totalMessages: row.total_messages ?? 0,
    batchCount: row.batch_count ?? 1,
    completedBatchCount: row.completed_batch_count ?? 0,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}
