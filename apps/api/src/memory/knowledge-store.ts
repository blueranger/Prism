import { getDb } from './db';
import type {
  Tag, KnowledgeEntity, EntityRelation, EntityMention,
  KnowledgeGraphData, KnowledgeGraphNode, KnowledgeGraphEdge,
  EntityType
} from '@prism/shared';

const ENTITY_COLORS: Record<EntityType, string> = {
  technology: '#3B82F6',
  concept: '#8B5CF6',
  person: '#10B981',
  project: '#F59E0B',
  organization: '#EF4444',
  topic: '#6366F1',
};

/* ===== Tags ===== */

export function listTags(opts?: { search?: string; limit?: number }): Tag[] {
  const db = getDb();
  const limit = opts?.limit || 100;

  let sql = `
    SELECT t.*,
      (SELECT COUNT(*) FROM conversation_tags ct WHERE ct.tag_id = t.id)
      + (SELECT COUNT(*) FROM session_tags st WHERE st.tag_id = t.id) as conversation_count
    FROM tags t
  `;
  const params: any[] = [];

  if (opts?.search) {
    sql += ' WHERE t.name LIKE ?';
    params.push(`%${opts.search}%`);
  }

  sql += ' ORDER BY conversation_count DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    color: r.color,
    createdAt: r.created_at,
    source: r.source,
    conversationCount: r.conversation_count,
  }));
}

export function getConversationsByTag(tagId: string): Array<{ id: string; title: string; source: string; platform?: string }> {
  const db = getDb();

  const imported = db.prepare(`
    SELECT ic.id, ic.title, 'imported' as source, ic.source_platform as platform
    FROM imported_conversations ic
    JOIN conversation_tags ct ON ct.conversation_id = ic.id
    WHERE ct.tag_id = ?
  `).all(tagId) as any[];

  const native = db.prepare(`
    SELECT s.id, s.title, 'native' as source
    FROM sessions s
    JOIN session_tags st ON st.session_id = s.id
    WHERE st.tag_id = ?
  `).all(tagId) as any[];

  return [...imported, ...native];
}

/* ===== Entities ===== */

export function listEntities(opts?: {
  type?: EntityType;
  search?: string;
  limit?: number;
  offset?: number;
}): { entities: KnowledgeEntity[]; total: number } {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts?.type) {
    conditions.push('entity_type = ?');
    params.push(opts.type);
  }
  if (opts?.search) {
    conditions.push('(name LIKE ? OR description LIKE ?)');
    params.push(`%${opts.search}%`, `%${opts.search}%`);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = (db.prepare(`SELECT COUNT(*) as c FROM knowledge_entities ${where}`).get(...params) as any).c;

  const limit = opts?.limit || 50;
  const offset = opts?.offset || 0;

  const rows = db.prepare(`
    SELECT * FROM knowledge_entities ${where}
    ORDER BY mention_count DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as any[];

  const entities: KnowledgeEntity[] = rows.map(r => ({
    id: r.id,
    name: r.name,
    entityType: r.entity_type,
    description: r.description,
    aliases: r.aliases ? JSON.parse(r.aliases) : undefined,
    firstSeenAt: r.first_seen_at,
    mentionCount: r.mention_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  return { entities, total };
}

export function getEntityDetail(entityId: string): {
  entity: KnowledgeEntity;
  mentions: EntityMention[];
  relations: Array<EntityRelation & { targetName: string; targetType: EntityType }>;
} | null {
  const db = getDb();

  const row = db.prepare('SELECT * FROM knowledge_entities WHERE id = ?').get(entityId) as any;
  if (!row) return null;

  const entity: KnowledgeEntity = {
    id: row.id, name: row.name, entityType: row.entity_type,
    description: row.description, aliases: row.aliases ? JSON.parse(row.aliases) : undefined,
    firstSeenAt: row.first_seen_at, mentionCount: row.mention_count,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };

  const mentionRows = db.prepare(`
    SELECT em.*,
      ic.title as conv_title, ic.source_platform,
      s.title as session_title
    FROM entity_mentions em
    LEFT JOIN imported_conversations ic ON ic.id = em.conversation_id
    LEFT JOIN sessions s ON s.id = em.session_id
    WHERE em.entity_id = ?
  `).all(entityId) as any[];

  const mentions: EntityMention[] = mentionRows.map(r => ({
    entityId: r.entity_id,
    conversationId: r.conversation_id,
    sessionId: r.session_id,
    conversationTitle: r.conv_title || r.session_title,
    mentionCount: r.mention_count,
    contextSnippet: r.context_snippet,
  }));

  const relationRows = db.prepare(`
    SELECT er.*, ke.name as target_name, ke.entity_type as target_type
    FROM entity_relations er
    JOIN knowledge_entities ke ON ke.id = er.target_entity_id
    WHERE er.source_entity_id = ?
    UNION
    SELECT er.*, ke.name as target_name, ke.entity_type as target_type
    FROM entity_relations er
    JOIN knowledge_entities ke ON ke.id = er.source_entity_id
    WHERE er.target_entity_id = ?
  `).all(entityId, entityId) as any[];

  const relations = relationRows.map(r => ({
    id: r.id,
    sourceEntityId: r.source_entity_id,
    targetEntityId: r.target_entity_id,
    relationType: r.relation_type,
    weight: r.weight,
    createdAt: r.created_at,
    targetName: r.target_name,
    targetType: r.target_type,
  }));

  return { entity, mentions, relations };
}

/* ===== Graph Data ===== */

export function getGraphData(opts?: {
  entityType?: EntityType;
  minMentions?: number;
  centerEntityId?: string;
  maxNodes?: number;
}): KnowledgeGraphData {
  const db = getDb();
  const maxNodes = opts?.maxNodes || 100;
  const minMentions = opts?.minMentions || 1;

  let entitySql: string;
  let entityParams: any[];

  if (opts?.centerEntityId) {
    entitySql = `
      SELECT * FROM knowledge_entities WHERE id = ?
      UNION
      SELECT ke.* FROM knowledge_entities ke
      JOIN entity_relations er ON (er.target_entity_id = ke.id OR er.source_entity_id = ke.id)
      WHERE (er.source_entity_id = ? OR er.target_entity_id = ?)
      AND ke.id != ?
      LIMIT ?
    `;
    entityParams = [opts.centerEntityId, opts.centerEntityId, opts.centerEntityId, opts.centerEntityId, maxNodes];
  } else {
    const conditions: string[] = ['mention_count >= ?'];
    entityParams = [minMentions];

    if (opts?.entityType) {
      conditions.push('entity_type = ?');
      entityParams.push(opts.entityType);
    }

    entitySql = `
      SELECT * FROM knowledge_entities
      WHERE ${conditions.join(' AND ')}
      ORDER BY mention_count DESC
      LIMIT ?
    `;
    entityParams.push(maxNodes);
  }

  const entityRows = db.prepare(entitySql).all(...entityParams) as any[];
  const entityIds = new Set(entityRows.map(r => r.id));

  const nodes: KnowledgeGraphNode[] = entityRows.map(r => ({
    id: r.id,
    label: r.name,
    type: r.entity_type,
    size: Math.max(10, Math.min(50, r.mention_count * 5)),
    color: ENTITY_COLORS[r.entity_type as EntityType] || '#6B7280',
  }));

  // Get relations between these entities
  const placeholders = Array.from(entityIds).map(() => '?').join(',');
  const relationRows = entityIds.size > 0
    ? db.prepare(`
        SELECT * FROM entity_relations
        WHERE source_entity_id IN (${placeholders})
        AND target_entity_id IN (${placeholders})
      `).all(...entityIds, ...entityIds) as any[]
    : [];

  const edges: KnowledgeGraphEdge[] = relationRows.map(r => ({
    source: r.source_entity_id,
    target: r.target_entity_id,
    label: r.relation_type,
    weight: r.weight,
  }));

  return { nodes, edges };
}

/* ===== Stats ===== */

export function getKnowledgeStats(): {
  totalEntities: number;
  totalRelations: number;
  totalTags: number;
  byType: Record<string, number>;
  topEntities: Array<{ name: string; type: string; mentions: number }>;
} {
  const db = getDb();

  const totalEntities = (db.prepare('SELECT COUNT(*) as c FROM knowledge_entities').get() as any).c;
  const totalRelations = (db.prepare('SELECT COUNT(*) as c FROM entity_relations').get() as any).c;
  const totalTags = (db.prepare('SELECT COUNT(*) as c FROM tags').get() as any).c;

  const byTypeRows = db.prepare(`
    SELECT entity_type, COUNT(*) as c FROM knowledge_entities GROUP BY entity_type
  `).all() as any[];
  const byType: Record<string, number> = {};
  for (const r of byTypeRows) byType[r.entity_type] = r.c;

  const topEntities = (db.prepare(`
    SELECT name, entity_type, mention_count FROM knowledge_entities
    ORDER BY mention_count DESC LIMIT 20
  `).all() as any[]).map(r => ({ name: r.name, type: r.entity_type, mentions: r.mention_count }));

  return { totalEntities, totalRelations, totalTags, byType, topEntities };
}
