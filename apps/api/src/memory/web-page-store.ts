import { randomUUID, createHash } from 'crypto';
import type { LinkedPageCandidate, WebPageRef } from '@prism/shared';
import { getDb } from './db';
import { addContextSource } from './notion-store';

function rowToWebPage(row: any): WebPageRef {
  return {
    id: row.id,
    sessionId: row.session_id,
    rootUrl: row.root_url,
    url: row.url,
    normalizedUrl: row.normalized_url,
    title: row.title ?? null,
    host: row.host,
    depth: row.depth,
    parentWebPageId: row.parent_web_page_id ?? null,
    anchorText: row.anchor_text ?? null,
    contentText: row.content_text,
    contentHash: row.content_hash ?? null,
    attachedAt: row.attached_at,
    discoveredAt: row.discovered_at,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

export function listWebPagesForSession(sessionId: string): WebPageRef[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM web_pages WHERE session_id = ? ORDER BY attached_at ASC, depth ASC'
  ).all(sessionId) as any[];
  return rows.map(rowToWebPage);
}

export function getWebPage(id: string): WebPageRef | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM web_pages WHERE id = ?').get(id) as any;
  return row ? rowToWebPage(row) : null;
}

export function getWebPageByNormalizedUrl(sessionId: string, normalizedUrl: string): WebPageRef | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM web_pages WHERE session_id = ? AND normalized_url = ?'
  ).get(sessionId, normalizedUrl) as any;
  return row ? rowToWebPage(row) : null;
}

export function upsertWebPageAttachment(input: {
  sessionId: string;
  rootUrl: string;
  url: string;
  normalizedUrl: string;
  title?: string | null;
  host: string;
  depth: number;
  parentWebPageId?: string | null;
  anchorText?: string | null;
  contentText: string;
  metadata?: Record<string, unknown> | null;
}): WebPageRef {
  const db = getDb();
  const now = Date.now();
  const existing = getWebPageByNormalizedUrl(input.sessionId, input.normalizedUrl);
  const id = existing?.id ?? randomUUID();
  const contentHash = createHash('sha256').update(input.contentText).digest('hex');

  db.prepare(`
    INSERT INTO web_pages (
      id, session_id, root_url, url, normalized_url, title, host, depth,
      parent_web_page_id, anchor_text, content_text, content_hash, attached_at, discovered_at, metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, normalized_url) DO UPDATE SET
      root_url = excluded.root_url,
      url = excluded.url,
      title = excluded.title,
      host = excluded.host,
      depth = excluded.depth,
      parent_web_page_id = excluded.parent_web_page_id,
      anchor_text = excluded.anchor_text,
      content_text = excluded.content_text,
      content_hash = excluded.content_hash,
      metadata = excluded.metadata
  `).run(
    id,
    input.sessionId,
    input.rootUrl,
    input.url,
    input.normalizedUrl,
    input.title ?? null,
    input.host,
    input.depth,
    input.parentWebPageId ?? null,
    input.anchorText ?? null,
    input.contentText,
    contentHash,
    existing?.attachedAt ?? now,
    existing?.discoveredAt ?? now,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );

  const page = getWebPage(id)!;
  addContextSource(input.sessionId, 'web_page', page.id, page.title ?? page.url, 'user');
  return page;
}

export function removeWebPageAttachment(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM context_sources WHERE source_type = ? AND source_id = ?').run('web_page', id);
  db.prepare('DELETE FROM web_pages WHERE id = ?').run(id);
}

export function buildLinkedPageSnippet(content: string): string {
  return content.length > 220 ? `${content.slice(0, 217)}...` : content;
}

export function decorateLinkedPageCandidate(candidate: LinkedPageCandidate, content?: string | null): LinkedPageCandidate {
  return {
    ...candidate,
    snippet: candidate.snippet ?? (content ? buildLinkedPageSnippet(content) : null),
  };
}
