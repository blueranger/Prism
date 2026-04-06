import { v4 as uuid } from 'uuid';
import type { WorkingMemoryItem } from '@prism/shared';
import { getDb } from './db';

function mapRow(row: any): WorkingMemoryItem {
  return {
    id: row.id,
    sessionId: row.session_id ?? null,
    title: row.title,
    summary: row.summary,
    memoryType: row.memory_type,
    status: row.status,
    confidence: row.confidence,
    sourceMessageId: row.source_message_id ?? null,
    observedAt: row.observed_at,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertWorkingMemory(input: {
  sessionId?: string | null;
  title: string;
  summary: string;
  confidence?: number;
  sourceMessageId?: string | null;
  observedAt: number;
  expiresAt?: number | null;
}): WorkingMemoryItem {
  const db = getDb();
  const existing = db.prepare(`
    SELECT *
    FROM working_memory_items
    WHERE COALESCE(session_id, '') = COALESCE(?, '')
      AND title = ?
      AND status != 'archived'
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(input.sessionId ?? null, input.title) as any;

  const now = Date.now();
  if (existing) {
    db.prepare(`
      UPDATE working_memory_items
      SET summary = ?, confidence = ?, source_message_id = ?, observed_at = ?, expires_at = ?, updated_at = ?, status = 'active'
      WHERE id = ?
    `).run(
      input.summary,
      input.confidence ?? 0.6,
      input.sourceMessageId ?? null,
      input.observedAt,
      input.expiresAt ?? null,
      now,
      existing.id
    );
    return mapRow(db.prepare('SELECT * FROM working_memory_items WHERE id = ?').get(existing.id) as any);
  }

  const row: WorkingMemoryItem = {
    id: uuid(),
    sessionId: input.sessionId ?? null,
    title: input.title,
    summary: input.summary,
    memoryType: 'working',
    status: 'active',
    confidence: input.confidence ?? 0.6,
    sourceMessageId: input.sourceMessageId ?? null,
    observedAt: input.observedAt,
    expiresAt: input.expiresAt ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(`
    INSERT INTO working_memory_items (
      id, session_id, title, summary, memory_type, status, confidence, source_message_id,
      observed_at, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.sessionId,
    row.title,
    row.summary,
    row.memoryType,
    row.status,
    row.confidence,
    row.sourceMessageId,
    row.observedAt,
    row.expiresAt,
    row.createdAt,
    row.updatedAt
  );

  return row;
}

export function listWorkingMemory(sessionId?: string | null, limit = 20): WorkingMemoryItem[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM working_memory_items
    WHERE status != 'archived'
      AND (? IS NULL OR session_id = ?)
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(sessionId ?? null, sessionId ?? null, limit) as any[];
  return rows.map(mapRow);
}

export function markWorkingMemoryStale(now = Date.now()): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE working_memory_items
    SET status = 'stale', updated_at = ?
    WHERE status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `).run(now, now);
  return result.changes;
}
