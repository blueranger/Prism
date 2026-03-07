import { getDb } from './db';
import type { SessionOutline, OutlineSection } from '@prism/shared';

export function saveOutline(outline: SessionOutline): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO session_outlines
    (id, session_id, source_type, version, sections, generated_at, model_used, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    outline.id,
    outline.sessionId,
    outline.sourceType,
    outline.version,
    JSON.stringify(outline.sections),
    outline.generatedAt,
    outline.modelUsed,
    new Date().toISOString()
  );
}

export function getOutline(sessionId: string, sourceType: 'native' | 'imported'): SessionOutline | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM session_outlines
    WHERE session_id = ? AND source_type = ?
    ORDER BY version DESC
    LIMIT 1
  `).get(sessionId, sourceType) as any;

  if (!row) return null;

  return {
    id: row.id,
    sessionId: row.session_id,
    sourceType: row.source_type,
    sections: JSON.parse(row.sections) as OutlineSection[],
    generatedAt: row.generated_at,
    modelUsed: row.model_used,
    version: row.version,
  };
}

export function deleteOutline(sessionId: string, sourceType: 'native' | 'imported'): void {
  const db = getDb();
  db.prepare('DELETE FROM session_outlines WHERE session_id = ? AND source_type = ?').run(sessionId, sourceType);
}
