import { v4 as uuid } from 'uuid';
import type { Session, SessionLink } from '@prism/shared';
import { getDb } from './db';

/**
 * Create session row if it doesn't already exist.
 */
export function ensureSession(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    'INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at, preview) VALUES (?, ?, ?, ?, ?)'
  ).run(id, null, now, now, null);
}

/**
 * List all sessions ordered by most recently updated, enriched with message count + model list.
 */
export function listSessions(): Session[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      s.id,
      s.title,
      s.created_at as createdAt,
      s.updated_at as updatedAt,
      s.preview,
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
    ORDER BY s.updated_at DESC
  `).all() as (Session & { models: string | null })[];

  return rows.map((r) => ({
    ...r,
    models: r.models ? r.models.split(',').filter(Boolean) : [],
  }));
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
  `).get(id, id) as (Session & { models: string | null }) | undefined;

  if (!row) return undefined;

  return {
    ...row,
    models: row.models ? row.models.split(',').filter(Boolean) : [],
  };
}

/**
 * Update session title and/or preview, bumps updated_at.
 */
export function updateSessionMeta(
  id: string,
  update: { title?: string; preview?: string }
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
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM handoffs WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM summaries WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM agent_tasks WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM execution_log WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM session_links WHERE session_id = ? OR linked_session_id = ?').run(id, id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  });
  txn();
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
