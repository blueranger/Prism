import { getDb } from './db';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import type { NotionPageRef, ContextSource, NotionWriteRecord } from '@prism/shared';

// ── Notion Pages ──

export function upsertNotionPage(accountId: string, page: {
  notionPageId: string;
  title: string;
  url: string;
  contentMd?: string | null;
  lastEditedAt?: number;
  parentType?: string;
  parentId?: string | null;
  iconEmoji?: string | null;
}): NotionPageRef {
  const db = getDb();
  const now = Date.now();
  const contentHash = page.contentMd
    ? createHash('sha256').update(page.contentMd).digest('hex')
    : null;

  const existing = db.prepare(
    'SELECT id FROM notion_pages WHERE account_id = ? AND notion_page_id = ?'
  ).get(accountId, page.notionPageId) as { id: string } | undefined;

  const id = existing?.id ?? randomUUID();

  db.prepare(`
    INSERT INTO notion_pages (id, account_id, notion_page_id, title, url, content_md, content_hash, last_edited_at, parent_type, parent_id, icon_emoji, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, notion_page_id) DO UPDATE SET
      title = excluded.title,
      url = excluded.url,
      content_md = excluded.content_md,
      content_hash = excluded.content_hash,
      last_edited_at = excluded.last_edited_at,
      parent_type = excluded.parent_type,
      parent_id = excluded.parent_id,
      icon_emoji = excluded.icon_emoji,
      synced_at = excluded.synced_at
  `).run(
    id, accountId, page.notionPageId, page.title, page.url,
    page.contentMd ?? null, contentHash, page.lastEditedAt ?? null,
    page.parentType ?? null, page.parentId ?? null, page.iconEmoji ?? null, now
  );

  return {
    id,
    notionPageId: page.notionPageId,
    title: page.title,
    url: page.url,
    lastEditedAt: page.lastEditedAt ?? 0,
    parentType: (page.parentType as any) ?? 'workspace',
    parentId: page.parentId ?? null,
    iconEmoji: page.iconEmoji ?? null,
    contentMd: page.contentMd ?? null,
    contentHash,
    syncedAt: now,
  };
}

export function getNotionPages(accountId: string): NotionPageRef[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM notion_pages WHERE account_id = ? ORDER BY last_edited_at DESC'
  ).all(accountId) as any[];
  return rows.map(rowToNotionPage);
}

export function getNotionPage(id: string): NotionPageRef | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM notion_pages WHERE id = ?').get(id) as any;
  return row ? rowToNotionPage(row) : null;
}

export function searchNotionPages(accountId: string, query: string): NotionPageRef[] {
  const db = getDb();
  const like = `%${query}%`;
  const rows = db.prepare(
    'SELECT * FROM notion_pages WHERE account_id = ? AND (title LIKE ? OR content_md LIKE ?) ORDER BY last_edited_at DESC LIMIT 50'
  ).all(accountId, like, like) as any[];
  return rows.map(rowToNotionPage);
}

export function getAllNotionPages(): NotionPageRef[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM notion_pages ORDER BY last_edited_at DESC'
  ).all() as any[];
  return rows.map(rowToNotionPage);
}

export function deleteNotionPage(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM notion_pages WHERE id = ?').run(id);
}

export function pruneNotionPagesForAccount(accountId: string, notionPageIds: string[]): void {
  const db = getDb();
  if (notionPageIds.length === 0) {
    db.prepare('DELETE FROM notion_pages WHERE account_id = ?').run(accountId);
    return;
  }

  const placeholders = notionPageIds.map(() => '?').join(', ');
  db.prepare(
    `DELETE FROM notion_pages
     WHERE account_id = ?
       AND notion_page_id NOT IN (${placeholders})`
  ).run(accountId, ...notionPageIds);
}

function rowToNotionPage(row: any): NotionPageRef {
  return {
    id: row.id,
    notionPageId: row.notion_page_id,
    title: row.title,
    url: row.url,
    lastEditedAt: row.last_edited_at ?? 0,
    parentType: row.parent_type ?? 'workspace',
    parentId: row.parent_id ?? null,
    iconEmoji: row.icon_emoji ?? null,
    contentMd: row.content_md ?? null,
    contentHash: row.content_hash ?? null,
    syncedAt: row.synced_at,
  };
}

// ── Context Sources ──

export function addContextSource(
  sessionId: string,
  sourceType: 'notion_page' | 'web_page',
  sourceId: string,
  sourceLabel: string,
  attachedBy: 'user' | 'auto' = 'user'
): ContextSource {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();

  // Check if already attached
  const existing = db.prepare(
    'SELECT id FROM context_sources WHERE session_id = ? AND source_type = ? AND source_id = ?'
  ).get(sessionId, sourceType, sourceId) as { id: string } | undefined;

  if (existing) {
    const row = db.prepare('SELECT * FROM context_sources WHERE id = ?').get(existing.id) as any;
    return rowToContextSource(row);
  }

  db.prepare(`
    INSERT INTO context_sources (id, session_id, source_type, source_id, source_label, attached_at, attached_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, sessionId, sourceType, sourceId, sourceLabel, now, attachedBy);

  return { id, sessionId, sourceType, sourceId, sourceLabel, attachedAt: now, attachedBy };
}

export function getContextSources(sessionId: string): ContextSource[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM context_sources WHERE session_id = ? ORDER BY attached_at ASC'
  ).all(sessionId) as any[];
  return rows.map(rowToContextSource);
}

export function removeContextSource(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM context_sources WHERE id = ?').run(id);
}

function rowToContextSource(row: any): ContextSource {
  return {
    id: row.id,
    sessionId: row.session_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceLabel: row.source_label,
    attachedAt: row.attached_at,
    attachedBy: row.attached_by,
  };
}

// ── Notion Writes ──

export function createNotionWrite(record: {
  sessionId: string;
  messageId: string;
  accountId: string;
  notionPageId: string;
  pageTitle: string;
  contentPreview: string;
  status?: 'success' | 'failed';
}): NotionWriteRecord {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  const status = record.status ?? 'success';

  db.prepare(`
    INSERT INTO notion_writes (id, session_id, message_id, account_id, notion_page_id, page_title, content_preview, written_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, record.sessionId, record.messageId, record.accountId, record.notionPageId, record.pageTitle, record.contentPreview, now, status);

  return {
    id,
    sessionId: record.sessionId,
    messageId: record.messageId,
    accountId: record.accountId,
    notionPageId: record.notionPageId,
    pageTitle: record.pageTitle,
    contentPreview: record.contentPreview,
    writtenAt: now,
    status,
  };
}

export function getNotionWrites(sessionId?: string): NotionWriteRecord[] {
  const db = getDb();
  const sql = sessionId
    ? 'SELECT * FROM notion_writes WHERE session_id = ? ORDER BY written_at DESC'
    : 'SELECT * FROM notion_writes ORDER BY written_at DESC LIMIT 100';
  const rows = (sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()) as any[];
  return rows.map(rowToNotionWrite);
}

function rowToNotionWrite(row: any): NotionWriteRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    accountId: row.account_id,
    notionPageId: row.notion_page_id,
    pageTitle: row.page_title,
    contentPreview: row.content_preview,
    writtenAt: row.written_at,
    status: row.status,
  };
}
