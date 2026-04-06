import { v4 as uuid } from 'uuid';
import type {
  MemoryAttribute,
  MemoryCandidate,
  MemoryEntityLink,
  MemoryEvent,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryItem,
  MemoryLinkRole,
  MemoryScopeType,
  MemorySource,
  MemorySourceKind,
  MemoryStatus,
  MemoryTimelineEvent,
  MemoryType,
} from '@prism/shared';
import { getDb } from './db';

type CandidatePayload = {
  attributes?: Array<{ key: string; value: string }>;
  entityLinks?: Array<{ entityId?: string | null; entityName: string; linkRole: MemoryLinkRole }>;
  sources?: Array<{ sessionId?: string | null; messageId?: string | null; conversationId?: string | null; provenanceId?: string | null; excerpt: string }>;
  events?: Array<{ eventType: string; startedAt: number; endedAt?: number | null; timelineOrder?: number }>;
  edges?: Array<{
    sourceEntityId?: string | null;
    sourceEntityName: string;
    targetEntityId?: string | null;
    targetEntityName: string;
    relationType: string;
    confidence?: number;
  }>;
  expiresAt?: number | null;
  validAt?: number;
  observedAt?: number;
};

export interface ListMemoryOptions {
  type?: MemoryType;
  status?: MemoryStatus | 'all';
  search?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryGraphData {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

function parsePayload(raw: string | null | undefined): CandidatePayload {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as CandidatePayload;
  } catch {
    return {};
  }
}

function parseMemoryItem(row: any): MemoryItem {
  const db = getDb();
  const attributeRows = db.prepare('SELECT * FROM memory_attributes WHERE memory_item_id = ? ORDER BY created_at ASC').all(row.id) as any[];
  const entityRows = db.prepare('SELECT * FROM memory_entity_links WHERE memory_item_id = ? ORDER BY created_at ASC').all(row.id) as any[];
  const sourceRows = db.prepare('SELECT * FROM memory_sources WHERE memory_item_id = ? ORDER BY created_at ASC').all(row.id) as any[];
  const eventRows = db.prepare('SELECT * FROM memory_events WHERE memory_item_id = ? ORDER BY timeline_order ASC, started_at ASC').all(row.id) as any[];

  return {
    id: row.id,
    scopeType: row.scope_type,
    memoryType: row.memory_type,
    title: row.title,
    summary: row.summary,
    status: row.status,
    confidence: row.confidence,
    validAt: row.valid_at,
    observedAt: row.observed_at,
    lastConfirmedAt: row.last_confirmed_at ?? null,
    expiresAt: row.expires_at ?? null,
    sourceKind: row.source_kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attributes: attributeRows.map((attr): MemoryAttribute => ({
      id: attr.id,
      memoryItemId: attr.memory_item_id,
      key: attr.key,
      value: attr.value,
      createdAt: attr.created_at,
    })),
    entityLinks: entityRows.map((link): MemoryEntityLink => ({
      id: link.id,
      memoryItemId: link.memory_item_id,
      entityId: link.entity_id ?? null,
      entityName: link.entity_name,
      linkRole: link.link_role,
      createdAt: link.created_at,
    })),
    sources: sourceRows.map((source): MemorySource => ({
      id: source.id,
      memoryItemId: source.memory_item_id,
      sessionId: source.session_id ?? null,
      messageId: source.message_id ?? null,
      conversationId: source.conversation_id ?? null,
      provenanceId: source.provenance_id ?? null,
      excerpt: source.excerpt,
      createdAt: source.created_at,
    })),
    events: eventRows.map((event): MemoryEvent => ({
      id: event.id,
      memoryItemId: event.memory_item_id,
      eventType: event.event_type,
      startedAt: event.started_at,
      endedAt: event.ended_at ?? null,
      timelineOrder: event.timeline_order,
    })),
  };
}

export function listMemory(opts: ListMemoryOptions = {}): { items: MemoryItem[]; total: number } {
  const db = getDb();
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.type) {
    conditions.push('memory_type = ?');
    params.push(opts.type);
  }
  if (opts.status && opts.status !== 'all') {
    conditions.push('status = ?');
    params.push(opts.status);
  } else {
    conditions.push("status != 'archived'");
  }
  if (opts.search) {
    conditions.push('(title LIKE ? OR summary LIKE ?)');
    params.push(`%${opts.search}%`, `%${opts.search}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) as c FROM memory_items ${where}`).get(...params) as any).c as number;
  const rows = db.prepare(`
    SELECT * FROM memory_items
    ${where}
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as any[];

  return { items: rows.map(parseMemoryItem), total };
}

export function getMemoryItem(id: string): MemoryItem | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM memory_items WHERE id = ?').get(id) as any;
  if (!row) return null;
  return parseMemoryItem(row);
}

export function listMemoryCandidates(status: 'pending' | 'accepted' | 'rejected' = 'pending'): MemoryCandidate[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM memory_candidates
    WHERE status = ?
    ORDER BY updated_at DESC, created_at DESC
  `).all(status) as any[];

  return rows.map((row): MemoryCandidate => ({
    id: row.id,
    sessionId: row.session_id ?? null,
    messageId: row.message_id ?? null,
    scopeType: row.scope_type,
    memoryType: row.memory_type,
    title: row.title,
    summary: row.summary,
    confidence: row.confidence,
    sourceKind: row.source_kind,
    status: row.status,
    payload: parsePayload(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export interface CreateMemoryCandidateInput {
  sessionId?: string | null;
  messageId?: string | null;
  scopeType?: MemoryScopeType;
  memoryType: MemoryType;
  title: string;
  summary: string;
  confidence?: number;
  sourceKind?: MemorySourceKind;
  payload?: CandidatePayload;
}

export interface CreateMemoryCandidateResult {
  candidate: MemoryCandidate;
  created: boolean;
  reason?: 'duplicate_candidate' | 'duplicate_memory';
}

function normalizeForMatch(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isSameCandidate(row: any, input: CreateMemoryCandidateInput): boolean {
  const payload = parsePayload(row.payload);
  const inputExcerpt = normalizeForMatch(input.payload?.sources?.[0]?.excerpt);
  const rowExcerpt = normalizeForMatch(payload.sources?.[0]?.excerpt);
  return (
    row.scope_type === (input.scopeType ?? 'workspace') &&
    row.memory_type === input.memoryType &&
    normalizeForMatch(row.title) === normalizeForMatch(input.title) &&
    normalizeForMatch(row.summary) === normalizeForMatch(input.summary) &&
    normalizeForMatch(row.session_id) === normalizeForMatch(input.sessionId ?? null) &&
    normalizeForMatch(row.message_id) === normalizeForMatch(input.messageId ?? null) &&
    inputExcerpt === rowExcerpt
  );
}

function mapCandidateRow(row: any): MemoryCandidate {
  return {
    id: row.id,
    sessionId: row.session_id ?? null,
    messageId: row.message_id ?? null,
    scopeType: row.scope_type,
    memoryType: row.memory_type,
    title: row.title,
    summary: row.summary,
    confidence: row.confidence,
    sourceKind: row.source_kind,
    status: row.status,
    payload: parsePayload(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function findExistingCandidate(input: CreateMemoryCandidateInput): MemoryCandidate | null {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM memory_candidates
    WHERE memory_type = ?
      AND scope_type = ?
      AND status IN ('pending', 'accepted')
    ORDER BY updated_at DESC
    LIMIT 100
  `).all(input.memoryType, input.scopeType ?? 'workspace') as any[];
  const existing = rows.find((row) => isSameCandidate(row, input));
  return existing ? mapCandidateRow(existing) : null;
}

function findExistingMemoryForInput(input: CreateMemoryCandidateInput): MemoryItem | null {
  const probe: MemoryCandidate = {
    id: '',
    sessionId: input.sessionId ?? null,
    messageId: input.messageId ?? null,
    scopeType: input.scopeType ?? 'workspace',
    memoryType: input.memoryType,
    title: input.title,
    summary: input.summary,
    confidence: input.confidence ?? 0.6,
    sourceKind: input.sourceKind ?? 'assistant_extracted',
    status: 'pending',
    payload: input.payload ?? {},
    createdAt: 0,
    updatedAt: 0,
  };
  const row = findExistingMemory(probe);
  return row ? parseMemoryItem(row) : null;
}

export function createMemoryCandidate(input: CreateMemoryCandidateInput): CreateMemoryCandidateResult {
  const existingCandidate = findExistingCandidate(input);
  if (existingCandidate) {
    return { candidate: existingCandidate, created: false, reason: 'duplicate_candidate' };
  }

  const existingMemory = findExistingMemoryForInput(input);
  if (existingMemory) {
    return {
      candidate: {
        id: existingMemory.id,
        sessionId: input.sessionId ?? null,
        messageId: input.messageId ?? null,
        scopeType: existingMemory.scopeType,
        memoryType: existingMemory.memoryType,
        title: existingMemory.title,
        summary: existingMemory.summary,
        confidence: existingMemory.confidence,
        sourceKind: existingMemory.sourceKind,
        status: 'accepted',
        payload: input.payload ?? {},
        createdAt: existingMemory.createdAt,
        updatedAt: existingMemory.updatedAt,
      },
      created: false,
      reason: 'duplicate_memory',
    };
  }

  const db = getDb();
  const now = Date.now();
  const candidate: MemoryCandidate = {
    id: uuid(),
    sessionId: input.sessionId ?? null,
    messageId: input.messageId ?? null,
    scopeType: input.scopeType ?? 'workspace',
    memoryType: input.memoryType,
    title: input.title,
    summary: input.summary,
    confidence: input.confidence ?? 0.6,
    sourceKind: input.sourceKind ?? 'assistant_extracted',
    status: 'pending',
    payload: input.payload ?? {},
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(`
    INSERT INTO memory_candidates (
      id, session_id, message_id, scope_type, memory_type, title, summary,
      confidence, source_kind, status, payload, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidate.id,
    candidate.sessionId,
    candidate.messageId,
    candidate.scopeType,
    candidate.memoryType,
    candidate.title,
    candidate.summary,
    candidate.confidence,
    candidate.sourceKind,
    candidate.status,
      JSON.stringify(candidate.payload ?? {}),
      candidate.createdAt,
      candidate.updatedAt
  );

  return { candidate, created: true };
}

function findExistingMemory(candidate: MemoryCandidate): any | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT mi.*
    FROM memory_items mi
    LEFT JOIN memory_entity_links mel ON mel.memory_item_id = mi.id
    WHERE mi.scope_type = ?
      AND mi.memory_type = ?
      AND mi.status IN ('active', 'stale')
      AND (
        mi.title = ?
        OR EXISTS (
          SELECT 1 FROM memory_sources ms
          WHERE ms.memory_item_id = mi.id
            AND ? IS NOT NULL
            AND ms.message_id = ?
        )
      )
    ORDER BY mi.updated_at DESC
    LIMIT 1
  `).get(candidate.scopeType, candidate.memoryType, candidate.title, candidate.messageId, candidate.messageId) as any;
  return row ?? null;
}

export function confirmMemoryCandidate(id: string): MemoryItem | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(id) as any;
  if (!row) return null;
  const candidate: MemoryCandidate = {
    id: row.id,
    sessionId: row.session_id ?? null,
    messageId: row.message_id ?? null,
    scopeType: row.scope_type,
    memoryType: row.memory_type,
    title: row.title,
    summary: row.summary,
    confidence: row.confidence,
    sourceKind: row.source_kind,
    status: row.status,
    payload: parsePayload(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  const payload = candidate.payload ?? {};
  const now = Date.now();
  const existing = findExistingMemory(candidate);
  const memoryId = existing?.id ?? uuid();

  const txn = db.transaction(() => {
    if (existing) {
      db.prepare(`
        UPDATE memory_items
        SET title = ?, summary = ?, confidence = ?, updated_at = ?, status = 'active',
            expires_at = ?, valid_at = ?, observed_at = ?, source_kind = ?
        WHERE id = ?
      `).run(
        candidate.title,
        candidate.summary,
        candidate.confidence,
        now,
        payload.expiresAt ?? null,
        payload.validAt ?? candidate.createdAt,
        payload.observedAt ?? candidate.createdAt,
        candidate.sourceKind,
        memoryId
      );
      db.prepare('DELETE FROM memory_attributes WHERE memory_item_id = ?').run(memoryId);
      db.prepare('DELETE FROM memory_entity_links WHERE memory_item_id = ?').run(memoryId);
      db.prepare('DELETE FROM memory_events WHERE memory_item_id = ?').run(memoryId);
      db.prepare('DELETE FROM memory_edges WHERE memory_item_id = ?').run(memoryId);
    } else {
      db.prepare(`
        INSERT INTO memory_items (
          id, scope_type, memory_type, title, summary, status, confidence,
          valid_at, observed_at, last_confirmed_at, expires_at, source_kind, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        memoryId,
        candidate.scopeType,
        candidate.memoryType,
        candidate.title,
        candidate.summary,
        candidate.confidence,
        payload.validAt ?? candidate.createdAt,
        payload.observedAt ?? candidate.createdAt,
        now,
        payload.expiresAt ?? null,
        candidate.sourceKind,
        candidate.createdAt,
        now
      );
    }

    for (const attr of payload.attributes ?? []) {
      db.prepare(`
        INSERT INTO memory_attributes (id, memory_item_id, key, value, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(uuid(), memoryId, attr.key, attr.value, now);
    }

    for (const link of payload.entityLinks ?? []) {
      db.prepare(`
        INSERT INTO memory_entity_links (id, memory_item_id, entity_id, entity_name, link_role, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uuid(), memoryId, link.entityId ?? null, link.entityName, link.linkRole, now);
    }

    for (const source of payload.sources ?? []) {
      db.prepare(`
        INSERT INTO memory_sources (
          id, memory_item_id, session_id, message_id, conversation_id, provenance_id, excerpt, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(),
        memoryId,
        source.sessionId ?? candidate.sessionId ?? null,
        source.messageId ?? candidate.messageId ?? null,
        source.conversationId ?? null,
        source.provenanceId ?? null,
        source.excerpt,
        now
      );
    }

    for (const event of payload.events ?? []) {
      db.prepare(`
        INSERT INTO memory_events (id, memory_item_id, event_type, started_at, ended_at, timeline_order)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uuid(), memoryId, event.eventType, event.startedAt, event.endedAt ?? null, event.timelineOrder ?? 0);
    }

    for (const edge of payload.edges ?? []) {
      db.prepare(`
        INSERT INTO memory_edges (
          id, memory_item_id, source_entity_id, source_entity_name, target_entity_id,
          target_entity_name, relation_type, confidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(),
        memoryId,
        edge.sourceEntityId ?? null,
        edge.sourceEntityName,
        edge.targetEntityId ?? null,
        edge.targetEntityName,
        edge.relationType,
        edge.confidence ?? candidate.confidence,
        now
      );
    }

    db.prepare('UPDATE memory_candidates SET status = ?, updated_at = ? WHERE id = ?').run('accepted', now, candidate.id);
  });

  txn();
  return getMemoryItem(memoryId);
}

export function rejectMemoryCandidate(id: string): void {
  const db = getDb();
  db.prepare('UPDATE memory_candidates SET status = ?, updated_at = ? WHERE id = ?').run('rejected', Date.now(), id);
}

export function archiveMemoryItem(id: string): MemoryItem | null {
  const db = getDb();
  db.prepare('UPDATE memory_items SET status = ?, updated_at = ? WHERE id = ?').run('archived', Date.now(), id);
  return getMemoryItem(id);
}

export function resetAllMemory(): void {
  const db = getDb();
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM trigger_notifications').run();
    db.prepare('DELETE FROM trigger_runs').run();
    db.prepare('DELETE FROM trigger_rules').run();
    db.prepare('DELETE FROM trigger_candidates').run();
    db.prepare('DELETE FROM memory_usage_run_items').run();
    db.prepare('DELETE FROM memory_usage_runs').run();
    db.prepare('DELETE FROM memory_extraction_run_items').run();
    db.prepare('DELETE FROM memory_extraction_runs').run();
    db.prepare('DELETE FROM working_memory_items').run();
    db.prepare('DELETE FROM memory_embeddings').run();
    db.prepare('DELETE FROM memory_sources').run();
    db.prepare('DELETE FROM memory_events').run();
    db.prepare('DELETE FROM memory_edges').run();
    db.prepare('DELETE FROM memory_entity_links').run();
    db.prepare('DELETE FROM memory_attributes').run();
    db.prepare('DELETE FROM memory_candidates').run();
    db.prepare('DELETE FROM memory_items').run();
  });
  txn();
}

export function updateMemoryItem(
  id: string,
  update: Partial<Pick<MemoryItem, 'title' | 'summary' | 'status' | 'confidence' | 'expiresAt' | 'lastConfirmedAt'>>
): MemoryItem | null {
  const db = getDb();
  const existing = getMemoryItem(id);
  if (!existing) return null;
  db.prepare(`
    UPDATE memory_items
    SET title = ?, summary = ?, status = ?, confidence = ?, expires_at = ?, last_confirmed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    update.title ?? existing.title,
    update.summary ?? existing.summary,
    update.status ?? existing.status,
    update.confidence ?? existing.confidence,
    update.expiresAt ?? existing.expiresAt ?? null,
    update.lastConfirmedAt ?? existing.lastConfirmedAt ?? null,
    Date.now(),
    id
  );
  return getMemoryItem(id);
}

export function getMemoryGraph(): MemoryGraphData {
  const db = getDb();
  const memoryRows = db.prepare(`
    SELECT id, title, memory_type, confidence
    FROM memory_items
    WHERE status != 'archived'
    ORDER BY updated_at DESC
    LIMIT 120
  `).all() as any[];
  const edgeRows = db.prepare(`
    SELECT me.*, mi.title as memory_title
    FROM memory_edges me
    JOIN memory_items mi ON mi.id = me.memory_item_id
    WHERE mi.status != 'archived'
    ORDER BY mi.updated_at DESC, me.created_at DESC
    LIMIT 200
  `).all() as any[];

  const nodes: MemoryGraphNode[] = [];
  const seenNodes = new Set<string>();
  const addNode = (node: MemoryGraphNode) => {
    if (seenNodes.has(node.id)) return;
    seenNodes.add(node.id);
    nodes.push(node);
  };

  for (const row of memoryRows) {
    addNode({
      id: `memory:${row.id}`,
      label: row.title,
      type: 'memory',
      memoryType: row.memory_type,
      color: memoryTypeColor(row.memory_type),
      size: Math.max(16, Math.min(36, 14 + Math.round((row.confidence ?? 0.5) * 20))),
    });
  }

  const edges: MemoryGraphEdge[] = [];
  for (const row of edgeRows) {
    const sourceId = row.source_entity_id ? `entity:${row.source_entity_id}` : `entity-name:${row.source_entity_name}`;
    const targetId = row.target_entity_id ? `entity:${row.target_entity_id}` : `entity-name:${row.target_entity_name}`;
    addNode({
      id: sourceId,
      label: row.source_entity_name,
      type: 'entity',
      color: '#10B981',
      size: 16,
    });
    addNode({
      id: targetId,
      label: row.target_entity_name,
      type: 'entity',
      color: '#F59E0B',
      size: 16,
    });
    edges.push({
      id: row.id,
      source: sourceId,
      target: targetId,
      label: row.relation_type,
      weight: row.confidence ?? 0.5,
    });
    edges.push({
      id: `${row.id}:memory`,
      source: `memory:${row.memory_item_id}`,
      target: sourceId,
      label: 'documents',
      weight: 0.25,
    });
  }

  return { nodes, edges };
}

export function getMemoryTimeline(limit = 100): MemoryTimelineEvent[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT me.*, mi.title, mi.summary, mi.memory_type
    FROM memory_events me
    JOIN memory_items mi ON mi.id = me.memory_item_id
    WHERE mi.status != 'archived'
    ORDER BY me.started_at DESC
    LIMIT ?
  `).all(limit) as any[];

  return rows.map((row): MemoryTimelineEvent => ({
    id: row.id,
    memoryItemId: row.memory_item_id,
    title: row.title,
    summary: row.summary,
    memoryType: row.memory_type,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
  }));
}

export function buildMemorySystemPrompt(): string | null {
  const db = getDb();
  const profileRows = db.prepare(`
    SELECT title, summary
    FROM memory_items
    WHERE memory_type = 'profile' AND status = 'active'
    ORDER BY confidence DESC, updated_at DESC
    LIMIT 5
  `).all() as any[];
  const relationshipRows = db.prepare(`
    SELECT title, summary
    FROM memory_items
    WHERE memory_type = 'relationship' AND status = 'active'
    ORDER BY confidence DESC, updated_at DESC
    LIMIT 8
  `).all() as any[];
  const situationRows = db.prepare(`
    SELECT title, summary
    FROM memory_items
    WHERE memory_type IN ('situation', 'event') AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 8
  `).all() as any[];

  const lines: string[] = [];
  if (profileRows.length > 0) {
    lines.push('Profile memory:');
    for (const row of profileRows) lines.push(`- ${row.title}: ${row.summary}`);
  }
  if (relationshipRows.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Relationship memory:');
    for (const row of relationshipRows) lines.push(`- ${row.title}: ${row.summary}`);
  }
  if (situationRows.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Recent situation memory:');
    for (const row of situationRows) lines.push(`- ${row.title}: ${row.summary}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

function memoryTypeColor(type: MemoryType): string {
  switch (type) {
    case 'profile':
      return '#6366F1';
    case 'relationship':
      return '#10B981';
    case 'situation':
      return '#F59E0B';
    case 'event':
      return '#06B6D4';
    case 'claim':
      return '#A855F7';
    default:
      return '#6B7280';
  }
}
