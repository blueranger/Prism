import { getDb } from './db';
import { randomUUID } from 'crypto';
import { randomBytes } from 'crypto';

export interface ProvenanceRecord {
  id: string;
  shortCode: string;
  sourceType: 'native' | 'imported';
  sessionId: string | null;
  conversationId: string | null;
  messageId: string;
  artifactId: string | null;
  contentPreview: string;
  contentHash: string;
  sourceModel: string;
  entities: string[] | null;
  tags: string[] | null;
  copiedAt: number;
  note: string | null;
}

export interface CreateProvenanceInput {
  sourceType: 'native' | 'imported';
  sessionId?: string | null;
  conversationId?: string | null;
  messageId: string;
  artifactId?: string | null;
  content: string;
  contentHash: string;
  sourceModel: string;
  entities?: string[] | null;
  tags?: string[] | null;
}

export interface ProvenanceListResult {
  records: ProvenanceRecord[];
  total: number;
}

export interface ProvenanceListFilters {
  sourceModel?: string;
  sourceType?: 'native' | 'imported';
  sessionId?: string;
  conversationId?: string;
  limit?: number;
  offset?: number;
}

/**
 * Generate a unique short code for provenance records.
 * Format: PRZ-{8 random uppercase alphanumeric chars}
 */
function generateShortCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'PRZ-';
  const bytes = randomBytes(6); // 6 bytes = 48 bits, ~8 base36 chars
  for (let i = 0; i < 8; i++) {
    result += chars[bytes[i % bytes.length] % chars.length];
  }
  return result;
}

/**
 * Create a new provenance record.
 * Generates a unique ID and short code, stores content preview (first 500 chars).
 */
export function createProvenance(input: CreateProvenanceInput): ProvenanceRecord {
  const db = getDb();
  const id = randomUUID();
  const shortCode = generateShortCode();
  const contentPreview = input.content.slice(0, 500);
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO content_provenance
    (id, short_code, source_type, session_id, conversation_id, message_id, artifact_id,
     content_preview, content_hash, source_model, entities, tags, copied_at, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    shortCode,
    input.sourceType,
    input.sessionId || null,
    input.conversationId || null,
    input.messageId,
    input.artifactId || null,
    contentPreview,
    input.contentHash,
    input.sourceModel,
    input.entities ? JSON.stringify(input.entities) : null,
    input.tags ? JSON.stringify(input.tags) : null,
    now,
    null
  );

  return {
    id,
    shortCode,
    sourceType: input.sourceType,
    sessionId: input.sessionId || null,
    conversationId: input.conversationId || null,
    messageId: input.messageId,
    artifactId: input.artifactId || null,
    contentPreview,
    contentHash: input.contentHash,
    sourceModel: input.sourceModel,
    entities: input.entities || null,
    tags: input.tags || null,
    copiedAt: now,
    note: null,
  };
}

/**
 * Get a provenance record by its short code.
 */
export function getProvenanceByCode(shortCode: string): ProvenanceRecord | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM content_provenance WHERE short_code = ?
  `).get(shortCode) as any;

  if (!row) return null;

  return rowToRecord(row);
}

/**
 * Get all provenance records matching a content hash.
 * Returns ordered by copied_at DESC (most recent first).
 */
export function getProvenanceByHash(contentHash: string): ProvenanceRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM content_provenance WHERE content_hash = ?
    ORDER BY copied_at DESC
  `).all(contentHash) as any[];

  return rows.map(rowToRecord);
}

/**
 * Get a provenance record by its ID.
 */
export function getProvenanceById(id: string): ProvenanceRecord | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM content_provenance WHERE id = ?
  `).get(id) as any;

  if (!row) return null;

  return rowToRecord(row);
}

/**
 * List provenance records with optional filters.
 * Returns paginated results with total count.
 */
export function listProvenance(filters?: ProvenanceListFilters): ProvenanceListResult {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (filters?.sourceModel) {
    conditions.push('source_model = ?');
    params.push(filters.sourceModel);
  }

  if (filters?.sourceType) {
    conditions.push('source_type = ?');
    params.push(filters.sourceType);
  }

  if (filters?.sessionId) {
    conditions.push('session_id = ?');
    params.push(filters.sessionId);
  }

  if (filters?.conversationId) {
    conditions.push('conversation_id = ?');
    params.push(filters.conversationId);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Get total count
  const countRow = db.prepare(`
    SELECT COUNT(*) as c FROM content_provenance ${where}
  `).get(...params) as any;

  const total = countRow.c;

  // Get paginated records
  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;

  const rows = db.prepare(`
    SELECT * FROM content_provenance ${where}
    ORDER BY copied_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as any[];

  return {
    records: rows.map(rowToRecord),
    total,
  };
}

/**
 * Update the note for a provenance record.
 */
export function updateProvenanceNote(id: string, note: string | null): void {
  const db = getDb();
  db.prepare(`
    UPDATE content_provenance SET note = ? WHERE id = ?
  `).run(note, id);
}

/**
 * Delete a provenance record.
 */
export function deleteProvenance(id: string): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM content_provenance WHERE id = ?
  `).run(id);
}

/**
 * Helper: Convert database row to ProvenanceRecord interface.
 */
function rowToRecord(row: any): ProvenanceRecord {
  return {
    id: row.id,
    shortCode: row.short_code,
    sourceType: row.source_type,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    artifactId: row.artifact_id,
    contentPreview: row.content_preview,
    contentHash: row.content_hash,
    sourceModel: row.source_model,
    entities: row.entities ? JSON.parse(row.entities) : null,
    tags: row.tags ? JSON.parse(row.tags) : null,
    copiedAt: row.copied_at,
    note: row.note,
  };
}
