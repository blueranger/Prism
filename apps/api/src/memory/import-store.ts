import { getDb } from './db';
import { ImportedConversation, ImportedMessage, ImportPlatform } from '@prism/shared';

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
    conditions.push('source_platform = ?');
    params.push(opts.platform);
  }
  if (opts.search) {
    conditions.push('title LIKE ?');
    params.push(`%${opts.search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM imported_conversations ${where}`).get(...params) as any;
  const total = countRow.total;

  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  const rows = db.prepare(`
    SELECT * FROM imported_conversations ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as any[];

  const conversations: ImportedConversation[] = rows.map(r => ({
    id: r.id,
    sourcePlatform: r.source_platform,
    originalId: r.original_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count,
    sessionId: r.session_id,
    importBatchId: r.import_batch_id,
    metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
  }));

  return { conversations, total };
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

export function deleteImportBatch(batchId: string): number {
  const db = getDb();
  const convIds = db.prepare(
    'SELECT id FROM imported_conversations WHERE import_batch_id = ?'
  ).all(batchId) as any[];

  const deleteAll = db.transaction(() => {
    for (const { id } of convIds) {
      db.prepare('DELETE FROM imported_messages WHERE conversation_id = ?').run(id);
    }
    const info = db.prepare('DELETE FROM imported_conversations WHERE import_batch_id = ?').run(batchId);
    return info.changes;
  });

  return deleteAll();
}
