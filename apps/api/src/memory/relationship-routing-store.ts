import { v4 as uuid } from 'uuid';
import type { EntityType, RelationshipEvidence, RelationshipPromotionReason, RelationshipRoutingDecision } from '@prism/shared';
import { getDb } from './db';

interface UpsertRelationshipEvidenceInput {
  workspaceKey: string;
  sourceEntityName: string;
  targetEntityName: string;
  relationType: string;
  routingDecision: RelationshipRoutingDecision;
  promotionReason?: RelationshipPromotionReason | null;
  sourceSessionId?: string | null;
  sourceMessageId?: string | null;
  summary?: string | null;
}

interface EnsureKnowledgeRelationInput {
  sourceEntityName: string;
  targetEntityName: string;
  relationType: string;
  sourceEntityType?: EntityType;
  targetEntityType?: EntityType;
}

function normalizeEntityName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

function mapEvidence(row: any): RelationshipEvidence {
  return {
    id: row.id,
    workspaceKey: row.workspace_key,
    sourceEntityName: row.source_entity_name,
    targetEntityName: row.target_entity_name,
    relationType: row.relation_type,
    routingDecision: row.routing_decision,
    promotionReason: row.promotion_reason ?? null,
    mentionCount: row.mention_count,
    lastSeenAt: row.last_seen_at,
    sourceSessionId: row.source_session_id ?? null,
    sourceMessageId: row.source_message_id ?? null,
    summary: row.summary ?? null,
  };
}

function ensureKnowledgeEntity(name: string, entityType: EntityType = 'organization'): string {
  const db = getDb();
  const now = new Date().toISOString();
  const normalized = normalizeEntityName(name);
  const existing = db
    .prepare('SELECT id, mention_count FROM knowledge_entities WHERE name = ? AND entity_type = ?')
    .get(normalized, entityType) as { id: string; mention_count: number } | undefined;

  if (existing) {
    db.prepare('UPDATE knowledge_entities SET mention_count = ?, updated_at = ? WHERE id = ?').run(
      (existing.mention_count ?? 0) + 1,
      now,
      existing.id,
    );
    return existing.id;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO knowledge_entities (
      id, name, entity_type, description, aliases, first_seen_at, mention_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, normalized, entityType, null, null, now, 1, now, now);
  return id;
}

export function ensureKnowledgeRelation(input: EnsureKnowledgeRelationInput): void {
  const db = getDb();
  const now = new Date().toISOString();
  const sourceId = ensureKnowledgeEntity(input.sourceEntityName, input.sourceEntityType ?? 'organization');
  const targetId = ensureKnowledgeEntity(input.targetEntityName, input.targetEntityType ?? 'organization');
  const existing = db.prepare(`
    SELECT id, weight FROM entity_relations
    WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?
  `).get(sourceId, targetId, input.relationType) as { id: string; weight: number } | undefined;

  if (existing) {
    db.prepare('UPDATE entity_relations SET weight = ? WHERE id = ?').run((existing.weight ?? 0) + 1, existing.id);
    return;
  }

  db.prepare(`
    INSERT INTO entity_relations (
      id, source_entity_id, target_entity_id, relation_type, weight, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuid(), sourceId, targetId, input.relationType, 1, now);
}

export function upsertRelationshipEvidence(input: UpsertRelationshipEvidenceInput): RelationshipEvidence {
  const db = getDb();
  const now = Date.now();
  const sourceEntityName = normalizeEntityName(input.sourceEntityName);
  const targetEntityName = normalizeEntityName(input.targetEntityName);
  const existing = db.prepare(`
    SELECT * FROM relationship_mentions
    WHERE workspace_key = ? AND source_entity_name = ? AND target_entity_name = ? AND relation_type = ?
  `).get(input.workspaceKey, sourceEntityName, targetEntityName, input.relationType) as any;

  if (existing) {
    const nextMentionCount = (existing.mention_count ?? 0) + 1;
    const nextDecision =
      existing.routing_decision === 'trigger_candidate' || input.routingDecision === 'trigger_candidate'
        ? 'trigger_candidate'
        : existing.routing_decision === 'memory_candidate' || input.routingDecision === 'memory_candidate'
          ? 'memory_candidate'
          : 'graph_only';
    const nextReason = input.promotionReason ?? existing.promotion_reason ?? null;
    const nextSummary = input.summary ?? existing.summary ?? null;
    db.prepare(`
      UPDATE relationship_mentions
      SET routing_decision = ?, promotion_reason = ?, mention_count = ?, last_seen_at = ?,
          source_session_id = ?, source_message_id = ?, summary = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextDecision,
      nextReason,
      nextMentionCount,
      now,
      input.sourceSessionId ?? existing.source_session_id ?? null,
      input.sourceMessageId ?? existing.source_message_id ?? null,
      nextSummary,
      now,
      existing.id,
    );
    return mapEvidence({
      ...existing,
      routing_decision: nextDecision,
      promotion_reason: nextReason,
      mention_count: nextMentionCount,
      last_seen_at: now,
      source_session_id: input.sourceSessionId ?? existing.source_session_id ?? null,
      source_message_id: input.sourceMessageId ?? existing.source_message_id ?? null,
      summary: nextSummary,
    });
  }

  const evidence: RelationshipEvidence = {
    id: uuid(),
    workspaceKey: input.workspaceKey,
    sourceEntityName,
    targetEntityName,
    relationType: input.relationType,
    routingDecision: input.routingDecision,
    promotionReason: input.promotionReason ?? null,
    mentionCount: 1,
    lastSeenAt: now,
    sourceSessionId: input.sourceSessionId ?? null,
    sourceMessageId: input.sourceMessageId ?? null,
    summary: input.summary ?? null,
  };

  db.prepare(`
    INSERT INTO relationship_mentions (
      id, workspace_key, source_entity_name, target_entity_name, relation_type,
      routing_decision, promotion_reason, mention_count, last_seen_at,
      source_session_id, source_message_id, summary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    evidence.id,
    evidence.workspaceKey,
    evidence.sourceEntityName,
    evidence.targetEntityName,
    evidence.relationType,
    evidence.routingDecision,
    evidence.promotionReason ?? null,
    evidence.mentionCount,
    evidence.lastSeenAt,
    evidence.sourceSessionId ?? null,
    evidence.sourceMessageId ?? null,
    evidence.summary ?? null,
    now,
    now,
  );

  return evidence;
}

export function listRelationshipEvidence(opts?: {
  routingDecision?: RelationshipRoutingDecision | 'all';
  limit?: number;
}): RelationshipEvidence[] {
  const db = getDb();
  const routingDecision = opts?.routingDecision;
  const limit = opts?.limit ?? 100;
  const rows = db.prepare(`
    SELECT *
    FROM relationship_mentions
    ${routingDecision && routingDecision !== 'all' ? 'WHERE routing_decision = ?' : ''}
    ORDER BY updated_at DESC, mention_count DESC
    LIMIT ?
  `).all(...(routingDecision && routingDecision !== 'all' ? [routingDecision, limit] : [limit])) as any[];
  return rows.map(mapEvidence);
}

export function findRelationshipEvidence(input: {
  workspaceKey: string;
  sourceEntityName: string;
  targetEntityName: string;
  relationType: string;
}): RelationshipEvidence | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT *
    FROM relationship_mentions
    WHERE workspace_key = ? AND source_entity_name = ? AND target_entity_name = ? AND relation_type = ?
  `).get(
    input.workspaceKey,
    normalizeEntityName(input.sourceEntityName),
    normalizeEntityName(input.targetEntityName),
    input.relationType,
  ) as any;
  return row ? mapEvidence(row) : null;
}
