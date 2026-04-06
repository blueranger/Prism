import { v4 as uuid } from 'uuid';
import type { ActionContextSnapshot, ActionStatus, ActionType, CreateActionRequest, KBSessionBootstrapRequest, ObserverConfig, ObserverSnapshot, ObserverStatus, Session, SessionBootstrapRecord, SessionLink, SessionType } from '@prism/shared';
import { getDb } from './db';

function mapSessionRow(row: any): Session {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    preview: row.preview,
    messageCount: row.messageCount ?? 0,
    models: row.models ? row.models.split(',').filter(Boolean) : [],
    sessionType: (row.sessionType ?? 'topic') as SessionType,
    parentSessionId: row.parentSessionId ?? null,
    actionType: row.actionType ?? null,
    actionStatus: row.actionStatus ?? null,
    actionTitle: row.actionTitle ?? null,
    actionTarget: row.actionTarget ?? null,
    contextSnapshot: row.contextSnapshot ? JSON.parse(row.contextSnapshot) as ActionContextSnapshot : null,
    resultSummary: row.resultSummary ?? null,
    interactionMode: row.interactionMode ?? null,
    activeModel: row.activeModel ?? null,
    observerModels: row.observerModels ? row.observerModels.split(',').filter(Boolean) : [],
  };
}

/**
 * Create session row if it doesn't already exist.
 */
export function ensureSession(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO sessions
     (id, title, created_at, updated_at, preview, session_type, action_status)
     VALUES (?, ?, ?, ?, ?, 'topic', NULL)`
  ).run(id, null, now, now, null);
}

/**
 * List all sessions ordered by most recently updated, enriched with message count + model list.
 */
export function listSessions(): Session[] {
  pruneStaleEmptyTopicSessions();

  const db = getDb();
  const rows = db.prepare(`
    SELECT
      s.id,
      s.title,
      s.created_at as createdAt,
      s.updated_at as updatedAt,
      s.preview,
      s.session_type as sessionType,
      s.parent_session_id as parentSessionId,
      s.action_type as actionType,
      s.action_status as actionStatus,
      s.action_title as actionTitle,
      s.action_target as actionTarget,
      s.context_snapshot as contextSnapshot,
      s.result_summary as resultSummary,
      s.interaction_mode as interactionMode,
      s.active_model as activeModel,
      s.observer_models as observerModels,
      COALESCE(mc.cnt, 0) as messageCount,
      mc.models,
      COALESCE(cs.cnt, 0) as contextSourceCount,
      COALESCE(uf.cnt, 0) as uploadedFileCount
    FROM sessions s
    LEFT JOIN (
      SELECT session_id,
             COUNT(*) as cnt,
             GROUP_CONCAT(DISTINCT source_model) as models
      FROM messages
      GROUP BY session_id
    ) mc ON mc.session_id = s.id
    LEFT JOIN (
      SELECT session_id, COUNT(*) as cnt
      FROM context_sources
      GROUP BY session_id
    ) cs ON cs.session_id = s.id
    LEFT JOIN (
      SELECT session_id, COUNT(*) as cnt
      FROM uploaded_files
      GROUP BY session_id
    ) uf ON uf.session_id = s.id
    ORDER BY s.updated_at DESC
  `).all() as any[];

  return rows
    .filter((row) => {
      const isEmptyTopicDraft =
        (row.sessionType ?? 'topic') === 'topic' &&
        (row.messageCount ?? 0) === 0 &&
        (row.contextSourceCount ?? 0) === 0 &&
        (row.uploadedFileCount ?? 0) === 0 &&
        !row.title &&
        !row.preview;

      return !isEmptyTopicDraft;
    })
    .map(mapSessionRow);
}

function pruneStaleEmptyTopicSessions(): void {
  const db = getDb();
  const latestContentful = db.prepare(`
    SELECT MAX(s.updated_at) as latestUpdatedAt
    FROM sessions s
    LEFT JOIN (
      SELECT session_id, COUNT(*) as cnt
      FROM messages
      GROUP BY session_id
    ) mc ON mc.session_id = s.id
    WHERE COALESCE(mc.cnt, 0) > 0
  `).get() as { latestUpdatedAt?: number | null };

  const cutoff = latestContentful.latestUpdatedAt ?? null;
  if (!cutoff) return;

  db.prepare(`
    DELETE FROM sessions
    WHERE id IN (
      SELECT s.id
      FROM sessions s
      LEFT JOIN (
        SELECT session_id, COUNT(*) as cnt
        FROM messages
        GROUP BY session_id
      ) mc ON mc.session_id = s.id
      LEFT JOIN (
        SELECT session_id, COUNT(*) as cnt
        FROM context_sources
        GROUP BY session_id
      ) cs ON cs.session_id = s.id
      LEFT JOIN (
        SELECT session_id, COUNT(*) as cnt
        FROM uploaded_files
        GROUP BY session_id
      ) uf ON uf.session_id = s.id
      WHERE s.session_type = 'topic'
        AND s.updated_at < ?
        AND COALESCE(mc.cnt, 0) = 0
        AND COALESCE(cs.cnt, 0) = 0
        AND COALESCE(uf.cnt, 0) = 0
        AND s.title IS NULL
        AND s.preview IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM sessions child WHERE child.parent_session_id = s.id
        )
    )
  `).run(cutoff);
}

/**
 * Get a single session with metadata.
 */
export function getSession(id: string): Session | undefined {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      s.id,
      s.title,
      s.created_at as createdAt,
      s.updated_at as updatedAt,
      s.preview,
      s.session_type as sessionType,
      s.parent_session_id as parentSessionId,
      s.action_type as actionType,
      s.action_status as actionStatus,
      s.action_title as actionTitle,
      s.action_target as actionTarget,
      s.context_snapshot as contextSnapshot,
      s.result_summary as resultSummary,
      s.interaction_mode as interactionMode,
      s.active_model as activeModel,
      s.observer_models as observerModels,
      COALESCE(mc.cnt, 0) as messageCount,
      mc.models
    FROM sessions s
    LEFT JOIN (
      SELECT session_id,
             COUNT(*) as cnt,
             GROUP_CONCAT(DISTINCT source_model) as models
      FROM messages
      WHERE session_id = ?
      GROUP BY session_id
    ) mc ON mc.session_id = s.id
    WHERE s.id = ?
  `).get(id, id) as any;

  if (!row) return undefined;

  return mapSessionRow(row);
}

/**
 * Update session title and/or preview, bumps updated_at.
 */
export function updateSessionMeta(
  id: string,
  update: {
    title?: string;
    preview?: string;
    sessionType?: SessionType;
    parentSessionId?: string | null;
    actionType?: ActionType | null;
    actionStatus?: ActionStatus | null;
    actionTitle?: string | null;
    actionTarget?: string | null;
    contextSnapshot?: ActionContextSnapshot | null;
    resultSummary?: string | null;
    interactionMode?: string | null;
    activeModel?: string | null;
    observerModels?: string[];
  }
): void {
  const db = getDb();
  const now = Date.now();

  if (update.title !== undefined) {
    db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(
      update.title, now, id
    );
  }
  if (update.preview !== undefined) {
    db.prepare('UPDATE sessions SET preview = ?, updated_at = ? WHERE id = ?').run(
      update.preview, now, id
    );
  }
  if (update.sessionType !== undefined) {
    db.prepare('UPDATE sessions SET session_type = ?, updated_at = ? WHERE id = ?').run(
      update.sessionType, now, id
    );
  }
  if (update.parentSessionId !== undefined) {
    db.prepare('UPDATE sessions SET parent_session_id = ?, updated_at = ? WHERE id = ?').run(
      update.parentSessionId, now, id
    );
  }
  if (update.actionType !== undefined) {
    db.prepare('UPDATE sessions SET action_type = ?, updated_at = ? WHERE id = ?').run(
      update.actionType, now, id
    );
  }
  if (update.actionStatus !== undefined) {
    db.prepare('UPDATE sessions SET action_status = ?, updated_at = ? WHERE id = ?').run(
      update.actionStatus, now, id
    );
  }
  if (update.actionTitle !== undefined) {
    db.prepare('UPDATE sessions SET action_title = ?, updated_at = ? WHERE id = ?').run(
      update.actionTitle, now, id
    );
  }
  if (update.actionTarget !== undefined) {
    db.prepare('UPDATE sessions SET action_target = ?, updated_at = ? WHERE id = ?').run(
      update.actionTarget, now, id
    );
  }
  if (update.contextSnapshot !== undefined) {
    db.prepare('UPDATE sessions SET context_snapshot = ?, updated_at = ? WHERE id = ?').run(
      update.contextSnapshot ? JSON.stringify(update.contextSnapshot) : null, now, id
    );
  }
  if (update.resultSummary !== undefined) {
    db.prepare('UPDATE sessions SET result_summary = ?, updated_at = ? WHERE id = ?').run(
      update.resultSummary, now, id
    );
  }
  if (update.interactionMode !== undefined) {
    db.prepare('UPDATE sessions SET interaction_mode = ?, updated_at = ? WHERE id = ?').run(
      update.interactionMode, now, id
    );
  }
  if (update.activeModel !== undefined) {
    db.prepare('UPDATE sessions SET active_model = ?, updated_at = ? WHERE id = ?').run(
      update.activeModel, now, id
    );
  }
  if (update.observerModels !== undefined) {
    db.prepare('UPDATE sessions SET observer_models = ?, updated_at = ? WHERE id = ?').run(
      update.observerModels.join(','), now, id
    );
  }
}

/**
 * Bump updated_at to now.
 */
export function touchSession(id: string): void {
  const db = getDb();
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
}

/**
 * Delete a session and all related data.
 */
export function deleteSession(id: string): void {
  const db = getDb();
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM observer_snapshots WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM session_bootstraps WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM session_outlines WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM session_tags WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM entity_mentions WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM context_sources WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM web_pages WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM uploaded_files WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM notion_writes WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM text_chunks WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM content_provenance WHERE session_id = ?').run(id);
    db.prepare('UPDATE imported_conversations SET session_id = NULL WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM handoffs WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM summaries WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM agent_tasks WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM execution_log WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM session_links WHERE session_id = ? OR linked_session_id = ?').run(id, id);
    db.prepare('UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  });
  txn();
}

export function createActionSession(
  parentSessionId: string,
  snapshot: ActionContextSnapshot,
  input: CreateActionRequest
): Session {
  const db = getDb();
  const now = Date.now();
  const id = uuid();
  const preview = (input.instruction || snapshot.sourceSummary || input.title).slice(0, 100);

  db.prepare(
    `INSERT INTO sessions
     (id, title, created_at, updated_at, preview, session_type, parent_session_id, action_type, action_status, action_title, action_target, context_snapshot, result_summary)
     VALUES (?, ?, ?, ?, ?, 'action', ?, ?, 'draft', ?, ?, ?, NULL)`
  ).run(
    id,
    input.title,
    now,
    now,
    preview,
    parentSessionId,
    input.actionType,
    input.title,
    input.target ?? snapshot.targetLabel ?? null,
    JSON.stringify(snapshot),
  );

  return getSession(id)!;
}

export function createTopicSession(input?: {
  title?: string | null;
  preview?: string | null;
  interactionMode?: string | null;
  activeModel?: string | null;
  observerModels?: string[];
}): Session {
  const db = getDb();
  const now = Date.now();
  const id = uuid();
  const title = input?.title?.trim() || null;
  const preview = input?.preview?.trim() || null;

  db.prepare(
    `INSERT INTO sessions
     (id, title, created_at, updated_at, preview, session_type, action_status, interaction_mode, active_model, observer_models)
     VALUES (?, ?, ?, ?, ?, 'topic', NULL, ?, ?, ?)`
  ).run(id, title, now, now, preview, input?.interactionMode ?? null, input?.activeModel ?? null, input?.observerModels?.join(',') ?? null);

  return getSession(id)!;
}

export function updateObserverConfig(
  sessionId: string,
  config: { interactionMode?: 'observer' | null; activeModel?: string | null; observerModels?: string[] }
): Session | undefined {
  const existing = getSession(sessionId);
  if (!existing) return undefined;

  updateSessionMeta(sessionId, {
    interactionMode: config.interactionMode ?? existing.interactionMode ?? null,
    activeModel: config.activeModel ?? existing.activeModel ?? null,
    observerModels: config.observerModels ?? existing.observerModels ?? [],
  });

  return getSession(sessionId);
}

export function getObserverConfig(sessionId: string): ObserverConfig | null {
  const session = getSession(sessionId);
  if (!session || session.interactionMode !== 'observer') return null;
  return {
    sessionId,
    interactionMode: 'observer',
    activeModel: session.activeModel ?? null,
    observerModels: session.observerModels ?? [],
    updatedAt: session.updatedAt,
  };
}

export function saveObserverSnapshot(
  input: Omit<ObserverSnapshot, 'id'>
): ObserverSnapshot {
  const db = getDb();
  const snapshot: ObserverSnapshot = {
    id: uuid(),
    ...input,
  };

  db.prepare(`
    INSERT INTO observer_snapshots
      (id, session_id, model, active_model, user_message_id, active_message_id, summary, risks, disagreements, suggested_follow_up, status, error, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, model) DO UPDATE SET
      id=excluded.id,
      active_model=excluded.active_model,
      user_message_id=excluded.user_message_id,
      active_message_id=excluded.active_message_id,
      summary=excluded.summary,
      risks=excluded.risks,
      disagreements=excluded.disagreements,
      suggested_follow_up=excluded.suggested_follow_up,
      status=excluded.status,
      error=excluded.error,
      captured_at=excluded.captured_at
  `).run(
    snapshot.id,
    snapshot.sessionId,
    snapshot.model,
    snapshot.activeModel,
    snapshot.userMessageId,
    snapshot.activeMessageId,
    snapshot.summary,
    JSON.stringify(snapshot.risks),
    JSON.stringify(snapshot.disagreements),
    snapshot.suggestedFollowUp,
    snapshot.status,
    snapshot.error,
    snapshot.capturedAt,
  );

  return snapshot;
}

export function listObserverSnapshots(sessionId: string): ObserverSnapshot[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      id,
      session_id as sessionId,
      model,
      active_model as activeModel,
      user_message_id as userMessageId,
      active_message_id as activeMessageId,
      summary,
      risks,
      disagreements,
      suggested_follow_up as suggestedFollowUp,
      status,
      error,
      captured_at as capturedAt
    FROM observer_snapshots
    WHERE session_id = ?
    ORDER BY captured_at DESC
  `).all(sessionId) as Array<{
    id: string;
    sessionId: string;
    model: string;
    activeModel: string;
    userMessageId: string;
    activeMessageId: string;
    summary: string;
    risks: string | null;
    disagreements: string | null;
    suggestedFollowUp: string | null;
    status: ObserverStatus;
    error: string | null;
    capturedAt: number;
  }>;

  return rows.map((row) => ({
    ...row,
    risks: row.risks ? JSON.parse(row.risks) as string[] : [],
    disagreements: row.disagreements ? JSON.parse(row.disagreements) as string[] : [],
  }));
}

export function saveSessionBootstrap(
  sessionId: string,
  bootstrapType: 'kb' | 'library',
  payload: KBSessionBootstrapRequest
): void {
  const db = getDb();
  const sourceCount = Array.isArray(payload.selectedSources) ? payload.selectedSources.length : 0;
  db.prepare(`
    INSERT OR REPLACE INTO session_bootstraps
    (session_id, bootstrap_type, source_count, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    sessionId,
    bootstrapType,
    sourceCount,
    JSON.stringify(payload),
    new Date().toISOString()
  );
}

export function getSessionBootstrap(sessionId: string): SessionBootstrapRecord | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT session_id as sessionId,
           bootstrap_type as bootstrapType,
           source_count as sourceCount,
           payload,
           created_at as createdAt
    FROM session_bootstraps
    WHERE session_id = ?
  `).get(sessionId) as {
    sessionId: string;
    bootstrapType: 'kb' | 'library';
    sourceCount: number;
    payload: string;
    createdAt: string;
  } | undefined;

  if (!row) return null;

  try {
    return {
      sessionId: row.sessionId,
      bootstrapType: row.bootstrapType,
      sourceCount: row.sourceCount,
      payload: JSON.parse(row.payload) as KBSessionBootstrapRequest,
      createdAt: row.createdAt,
    };
  } catch (error) {
    console.warn('[session] Failed to parse bootstrap payload for session', sessionId, error);
    return null;
  }
}

export function listChildActionSessions(parentSessionId: string): Session[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      s.id,
      s.title,
      s.created_at as createdAt,
      s.updated_at as updatedAt,
      s.preview,
      s.session_type as sessionType,
      s.parent_session_id as parentSessionId,
      s.action_type as actionType,
      s.action_status as actionStatus,
      s.action_title as actionTitle,
      s.action_target as actionTarget,
      s.context_snapshot as contextSnapshot,
      s.result_summary as resultSummary,
      s.interaction_mode as interactionMode,
      s.active_model as activeModel,
      s.observer_models as observerModels,
      COALESCE(mc.cnt, 0) as messageCount,
      mc.models
    FROM sessions s
    LEFT JOIN (
      SELECT session_id,
             COUNT(*) as cnt,
             GROUP_CONCAT(DISTINCT source_model) as models
      FROM messages
      GROUP BY session_id
    ) mc ON mc.session_id = s.id
    WHERE s.parent_session_id = ? AND s.session_type = 'action'
    ORDER BY s.created_at DESC
  `).all(parentSessionId) as any[];

  return rows.map(mapSessionRow);
}

export function updateActionSession(
  id: string,
  update: {
    actionStatus?: ActionStatus;
    actionTitle?: string;
    actionTarget?: string;
    resultSummary?: string;
  }
): Session | undefined {
  const existing = getSession(id);
  if (!existing || existing.sessionType !== 'action') return undefined;

  updateSessionMeta(id, {
    title: update.actionTitle,
    actionTitle: update.actionTitle,
    actionTarget: update.actionTarget,
    actionStatus: update.actionStatus,
    resultSummary: update.resultSummary,
  });

  return getSession(id);
}

/**
 * Link another session's context into the current session.
 */
export function linkSession(sessionId: string, linkedSessionId: string): SessionLink {
  const db = getDb();
  const link: SessionLink = {
    id: uuid(),
    sessionId,
    linkedSessionId,
    createdAt: Date.now(),
  };

  db.prepare(
    'INSERT OR IGNORE INTO session_links (id, session_id, linked_session_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(link.id, link.sessionId, link.linkedSessionId, link.createdAt);

  return link;
}

/**
 * Remove a linked session.
 */
export function unlinkSession(sessionId: string, linkedSessionId: string): void {
  const db = getDb();
  db.prepare(
    'DELETE FROM session_links WHERE session_id = ? AND linked_session_id = ?'
  ).run(sessionId, linkedSessionId);
}

/**
 * Get all session links for a session, enriched with session metadata.
 */
export function getSessionLinks(sessionId: string): (SessionLink & { linkedSession?: Session })[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      sl.id,
      sl.session_id as sessionId,
      sl.linked_session_id as linkedSessionId,
      sl.created_at as createdAt,
      s.title as linkedTitle,
      s.preview as linkedPreview,
      s.created_at as linkedCreatedAt,
      s.updated_at as linkedUpdatedAt,
      COALESCE(mc.cnt, 0) as linkedMessageCount,
      mc.models as linkedModels
    FROM session_links sl
    LEFT JOIN sessions s ON s.id = sl.linked_session_id
    LEFT JOIN (
      SELECT session_id,
             COUNT(*) as cnt,
             GROUP_CONCAT(DISTINCT source_model) as models
      FROM messages
      GROUP BY session_id
    ) mc ON mc.session_id = sl.linked_session_id
    WHERE sl.session_id = ?
  `).all(sessionId) as any[];

  return rows.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    linkedSessionId: r.linkedSessionId,
    createdAt: r.createdAt,
    linkedSession: r.linkedCreatedAt != null ? {
      id: r.linkedSessionId,
      title: r.linkedTitle,
      preview: r.linkedPreview,
      createdAt: r.linkedCreatedAt,
      updatedAt: r.linkedUpdatedAt,
      messageCount: r.linkedMessageCount,
      models: r.linkedModels ? r.linkedModels.split(',').filter(Boolean) : [],
      sessionType: 'topic',
    } : undefined,
  }));
}

/**
 * Get linked session IDs (simple list without metadata).
 */
export function getLinkedSessionIds(sessionId: string): string[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT linked_session_id FROM session_links WHERE session_id = ?'
  ).all(sessionId) as { linked_session_id: string }[];
  return rows.map((r) => r.linked_session_id);
}
