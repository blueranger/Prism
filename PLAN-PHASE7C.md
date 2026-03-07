# Phase 7c Implementation Plan — Knowledge Graph

## Goal
Automatically extract topics, concepts, and entities from imported and native conversations, then organize them into a navigable knowledge graph. Users can visually explore their knowledge, see connections between topics discussed across different conversations and platforms, and discover patterns in their AI usage.

## Prerequisites
- Phase 7a (Import Engine) and Phase 7b (Unified Search) must be completed
- FTS5 tables are populated with content

---

## Step 1: New Database Tables

**File:** `apps/api/src/memory/db.ts`

Add after the FTS5 tables:

```sql
-- Tags (user-created or auto-extracted)
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT,                             -- hex color for UI display
  created_at TEXT NOT NULL,
  source TEXT DEFAULT 'auto'              -- 'auto' (extracted) | 'manual' (user-created)
);

-- Tag ↔ Imported Conversation mapping
CREATE TABLE IF NOT EXISTS conversation_tags (
  tag_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,            -- 0-1, how confident the extraction was
  PRIMARY KEY (tag_id, conversation_id),
  FOREIGN KEY (tag_id) REFERENCES tags(id),
  FOREIGN KEY (conversation_id) REFERENCES imported_conversations(id)
);

-- Tag ↔ Native Session mapping
CREATE TABLE IF NOT EXISTS session_tags (
  tag_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  PRIMARY KEY (tag_id, session_id),
  FOREIGN KEY (tag_id) REFERENCES tags(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Knowledge entities (people, technologies, concepts, projects, etc.)
CREATE TABLE IF NOT EXISTS knowledge_entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,              -- 'technology' | 'concept' | 'person' | 'project' | 'organization' | 'topic'
  description TEXT,                        -- short summary
  aliases TEXT,                            -- JSON array of alternative names
  first_seen_at TEXT,                      -- when this entity first appeared
  mention_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Entity ↔ Conversation mapping (which conversations mention this entity)
CREATE TABLE IF NOT EXISTS entity_mentions (
  entity_id TEXT NOT NULL,
  conversation_id TEXT,                    -- imported conversation
  session_id TEXT,                         -- native session (one of these two is set)
  mention_count INTEGER DEFAULT 1,
  context_snippet TEXT,                    -- a representative snippet showing the mention
  PRIMARY KEY (entity_id, COALESCE(conversation_id, ''), COALESCE(session_id, '')),
  FOREIGN KEY (entity_id) REFERENCES knowledge_entities(id),
  FOREIGN KEY (conversation_id) REFERENCES imported_conversations(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Entity ↔ Entity relationships
CREATE TABLE IF NOT EXISTS entity_relations (
  id TEXT PRIMARY KEY,
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,            -- 'related_to' | 'part_of' | 'depends_on' | 'alternative_to' | 'used_with'
  weight REAL DEFAULT 1.0,               -- co-occurrence strength
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_entity_id) REFERENCES knowledge_entities(id),
  FOREIGN KEY (target_entity_id) REFERENCES knowledge_entities(id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_tags_conv ON conversation_tags(conversation_id);
CREATE INDEX IF NOT EXISTS idx_session_tags_session ON session_tags(session_id);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_conv ON entity_mentions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_session ON entity_mentions(session_id);
CREATE INDEX IF NOT EXISTS idx_entity_relations_source ON entity_relations(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_relations_target ON entity_relations(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_entities_type ON knowledge_entities(entity_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_entities_name_type ON knowledge_entities(name, entity_type);
```

---

## Step 2: Shared Types

**File:** `packages/shared/src/types.ts`

Add:

```typescript
/* ===== Phase 7c: Knowledge Graph ===== */

export type EntityType = 'technology' | 'concept' | 'person' | 'project' | 'organization' | 'topic';
export type RelationType = 'related_to' | 'part_of' | 'depends_on' | 'alternative_to' | 'used_with';

export interface Tag {
  id: string;
  name: string;
  color?: string;
  createdAt: string;
  source: 'auto' | 'manual';
  conversationCount?: number;  // how many conversations use this tag
}

export interface KnowledgeEntity {
  id: string;
  name: string;
  entityType: EntityType;
  description?: string;
  aliases?: string[];
  firstSeenAt?: string;
  mentionCount: number;
  createdAt: string;
  updatedAt?: string;
}

export interface EntityRelation {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: RelationType;
  weight: number;
  createdAt: string;
}

export interface EntityMention {
  entityId: string;
  conversationId?: string;
  sessionId?: string;
  conversationTitle?: string;
  mentionCount: number;
  contextSnippet?: string;
}

// For the graph visualization
export interface KnowledgeGraphNode {
  id: string;
  label: string;
  type: EntityType;
  size: number;          // based on mention count
  color: string;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  label: RelationType;
  weight: number;
}

export interface KnowledgeGraphData {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

export interface ExtractionProgress {
  status: 'idle' | 'running' | 'completed' | 'failed';
  totalConversations: number;
  processedConversations: number;
  entitiesFound: number;
  relationsFound: number;
  error?: string;
}
```

---

## Step 3: Entity Extraction Service

**New file:** `apps/api/src/services/extraction-service.ts`

This service uses one of the configured LLMs (preferably a fast/cheap one) to extract entities and topics from conversation content. It processes conversations in batches.

```typescript
import { v4 as uuid } from 'uuid';
import { getDb } from '../memory/db';
import { getAdapter } from '../adapters/common';
import { EntityType, RelationType, ExtractionProgress, ImportPlatform } from '@prism/shared';

// Extraction prompt template
const EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Analyze the following conversation and extract:

1. **Entities**: Named things discussed (technologies, concepts, people, projects, organizations, topics)
2. **Tags**: High-level topic labels for this conversation (2-5 tags)
3. **Relations**: How entities relate to each other

For each entity, provide:
- name: The canonical name
- type: One of: technology, concept, person, project, organization, topic
- description: One-sentence description
- aliases: Other names used for this entity in the conversation

For each relation, provide:
- source: Entity name
- target: Entity name
- type: One of: related_to, part_of, depends_on, alternative_to, used_with

Respond in JSON format:
{
  "tags": ["tag1", "tag2"],
  "entities": [
    { "name": "...", "type": "...", "description": "...", "aliases": [] }
  ],
  "relations": [
    { "source": "...", "target": "...", "type": "..." }
  ]
}

CONVERSATION TITLE: {title}
CONVERSATION:
{content}`;

export class ExtractionService {
  private progress: ExtractionProgress = {
    status: 'idle',
    totalConversations: 0,
    processedConversations: 0,
    entitiesFound: 0,
    relationsFound: 0,
  };

  getProgress(): ExtractionProgress {
    return { ...this.progress };
  }

  /**
   * Extract entities from all imported conversations that haven't been processed yet.
   * Uses an LLM to analyze conversation content.
   * @param provider - Which LLM provider to use for extraction ('openai' | 'anthropic' | 'google')
   * @param model - Specific model to use (e.g. 'gpt-4o-mini', 'claude-3-5-haiku-20241022', 'gemini-2.0-flash')
   */
  async extractAll(provider: string = 'openai', model: string = 'gpt-4o-mini'): Promise<ExtractionProgress> {
    if (this.progress.status === 'running') {
      throw new Error('Extraction is already running');
    }

    const db = getDb();

    // Find conversations not yet processed (no tags assigned)
    const unprocessed = db.prepare(`
      SELECT ic.id, ic.title, ic.source_platform
      FROM imported_conversations ic
      WHERE ic.id NOT IN (SELECT DISTINCT conversation_id FROM conversation_tags)
      ORDER BY ic.created_at DESC
    `).all() as any[];

    this.progress = {
      status: 'running',
      totalConversations: unprocessed.length,
      processedConversations: 0,
      entitiesFound: 0,
      relationsFound: 0,
    };

    try {
      const adapter = getAdapter(provider as any);

      for (const conv of unprocessed) {
        try {
          await this.processConversation(db, adapter, model, conv);
          this.progress.processedConversations++;
        } catch (err: any) {
          console.error(`[extraction] Failed for conversation ${conv.id}:`, err.message);
          // Continue with next conversation
        }
      }

      this.progress.status = 'completed';
    } catch (err: any) {
      this.progress.status = 'failed';
      this.progress.error = err.message;
    }

    return this.progress;
  }

  /**
   * Extract entities from a single conversation.
   */
  private async processConversation(db: any, adapter: any, model: string, conv: any): Promise<void> {
    // Get messages for this conversation
    const messages = db.prepare(`
      SELECT role, content FROM imported_messages
      WHERE conversation_id = ?
      ORDER BY timestamp ASC
      LIMIT 50
    `).all(conv.id) as any[];

    // Build conversation text (truncate to avoid hitting token limits)
    const conversationText = messages
      .map((m: any) => `[${m.role}]: ${m.content}`)
      .join('\n\n');

    // Truncate to ~3000 words to stay within token budget
    const truncated = conversationText.split(/\s+/).slice(0, 3000).join(' ');

    const prompt = EXTRACTION_PROMPT
      .replace('{title}', conv.title)
      .replace('{content}', truncated);

    // Call LLM for extraction
    let responseText = '';
    const stream = adapter.stream({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,  // low temperature for consistent extraction
    });

    for await (const chunk of stream) {
      if (chunk.content) responseText += chunk.content;
    }

    // Parse JSON response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[extraction] No valid JSON in response for ${conv.id}`);
      return;
    }

    let extraction: {
      tags: string[];
      entities: Array<{ name: string; type: EntityType; description: string; aliases?: string[] }>;
      relations: Array<{ source: string; target: string; type: RelationType }>;
    };

    try {
      extraction = JSON.parse(jsonMatch[0]);
    } catch {
      console.warn(`[extraction] Invalid JSON for ${conv.id}`);
      return;
    }

    // Store results in DB
    const now = new Date().toISOString();

    // Process tags
    for (const tagName of (extraction.tags || [])) {
      const normalizedName = tagName.toLowerCase().trim();
      if (!normalizedName) continue;

      // Upsert tag
      let tagId: string;
      const existing = db.prepare('SELECT id FROM tags WHERE name = ?').get(normalizedName) as any;
      if (existing) {
        tagId = existing.id;
      } else {
        tagId = uuid();
        db.prepare('INSERT INTO tags (id, name, created_at, source) VALUES (?, ?, ?, ?)').run(
          tagId, normalizedName, now, 'auto'
        );
      }

      // Link tag to conversation
      db.prepare('INSERT OR IGNORE INTO conversation_tags (tag_id, conversation_id) VALUES (?, ?)').run(
        tagId, conv.id
      );
    }

    // Process entities
    const entityNameToId: Record<string, string> = {};
    for (const ent of (extraction.entities || [])) {
      const normalizedName = ent.name.trim();
      if (!normalizedName) continue;

      let entityId: string;
      const existing = db.prepare(
        'SELECT id FROM knowledge_entities WHERE name = ? AND entity_type = ?'
      ).get(normalizedName, ent.type) as any;

      if (existing) {
        entityId = existing.id;
        // Update mention count
        db.prepare('UPDATE knowledge_entities SET mention_count = mention_count + 1, updated_at = ? WHERE id = ?').run(now, entityId);
      } else {
        entityId = uuid();
        db.prepare(`
          INSERT INTO knowledge_entities (id, name, entity_type, description, aliases, first_seen_at, mention_count, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
          entityId, normalizedName, ent.type,
          ent.description || null,
          ent.aliases ? JSON.stringify(ent.aliases) : null,
          conv.created_at || now, now
        );
        this.progress.entitiesFound++;
      }

      entityNameToId[normalizedName] = entityId;

      // Add mention
      const snippet = messages
        .find((m: any) => m.content.toLowerCase().includes(normalizedName.toLowerCase()))
        ?.content?.slice(0, 200) || '';

      db.prepare(`
        INSERT OR REPLACE INTO entity_mentions (entity_id, conversation_id, mention_count, context_snippet)
        VALUES (?, ?, 1, ?)
      `).run(entityId, conv.id, snippet);
    }

    // Process relations
    for (const rel of (extraction.relations || [])) {
      const sourceId = entityNameToId[rel.source.trim()];
      const targetId = entityNameToId[rel.target.trim()];
      if (!sourceId || !targetId || sourceId === targetId) continue;

      const existingRel = db.prepare(
        'SELECT id, weight FROM entity_relations WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?'
      ).get(sourceId, targetId, rel.type) as any;

      if (existingRel) {
        db.prepare('UPDATE entity_relations SET weight = weight + 1 WHERE id = ?').run(existingRel.id);
      } else {
        db.prepare(`
          INSERT INTO entity_relations (id, source_entity_id, target_entity_id, relation_type, weight, created_at)
          VALUES (?, ?, ?, ?, 1, ?)
        `).run(uuid(), sourceId, targetId, rel.type, now);
        this.progress.relationsFound++;
      }
    }
  }

  /**
   * Also extract from native Prism sessions.
   */
  async extractFromNativeSessions(provider: string = 'openai', model: string = 'gpt-4o-mini'): Promise<void> {
    const db = getDb();
    const sessions = db.prepare(`
      SELECT s.id, s.title
      FROM sessions s
      WHERE s.id NOT IN (SELECT DISTINCT session_id FROM session_tags)
      AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
      ORDER BY s.updated_at DESC
    `).all() as any[];

    const adapter = getAdapter(provider as any);

    for (const session of sessions) {
      try {
        const messages = db.prepare(`
          SELECT role, content FROM messages
          WHERE session_id = ?
          ORDER BY timestamp ASC
          LIMIT 50
        `).all(session.id) as any[];

        const conversationText = messages
          .map((m: any) => `[${m.role}]: ${m.content}`)
          .join('\n\n');

        const truncated = conversationText.split(/\s+/).slice(0, 3000).join(' ');

        const prompt = EXTRACTION_PROMPT
          .replace('{title}', session.title || 'Untitled')
          .replace('{content}', truncated);

        let responseText = '';
        const stream = adapter.stream({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
        });

        for await (const chunk of stream) {
          if (chunk.content) responseText += chunk.content;
        }

        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;

        const extraction = JSON.parse(jsonMatch[0]);
        const now = new Date().toISOString();

        // Process tags for native sessions
        for (const tagName of (extraction.tags || [])) {
          const normalizedName = tagName.toLowerCase().trim();
          if (!normalizedName) continue;

          let tagId: string;
          const existing = db.prepare('SELECT id FROM tags WHERE name = ?').get(normalizedName) as any;
          if (existing) {
            tagId = existing.id;
          } else {
            tagId = uuid();
            db.prepare('INSERT INTO tags (id, name, created_at, source) VALUES (?, ?, ?, ?)').run(tagId, normalizedName, now, 'auto');
          }

          db.prepare('INSERT OR IGNORE INTO session_tags (tag_id, session_id) VALUES (?, ?)').run(tagId, session.id);
        }

        // Process entities (same logic, but with session_id instead of conversation_id)
        const entityNameToId: Record<string, string> = {};
        for (const ent of (extraction.entities || [])) {
          const normalizedName = ent.name.trim();
          if (!normalizedName) continue;

          let entityId: string;
          const existing = db.prepare(
            'SELECT id FROM knowledge_entities WHERE name = ? AND entity_type = ?'
          ).get(normalizedName, ent.type) as any;

          if (existing) {
            entityId = existing.id;
            db.prepare('UPDATE knowledge_entities SET mention_count = mention_count + 1, updated_at = ? WHERE id = ?').run(now, entityId);
          } else {
            entityId = uuid();
            db.prepare(`
              INSERT INTO knowledge_entities (id, name, entity_type, description, aliases, first_seen_at, mention_count, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 1, ?)
            `).run(entityId, normalizedName, ent.type, ent.description || null, ent.aliases ? JSON.stringify(ent.aliases) : null, now, now);
          }

          entityNameToId[normalizedName] = entityId;

          const snippet = messages
            .find((m: any) => m.content.toLowerCase().includes(normalizedName.toLowerCase()))
            ?.content?.slice(0, 200) || '';

          db.prepare(`
            INSERT OR REPLACE INTO entity_mentions (entity_id, session_id, mention_count, context_snippet)
            VALUES (?, ?, 1, ?)
          `).run(entityId, session.id, snippet);
        }

        // Process relations
        for (const rel of (extraction.relations || [])) {
          const sourceId = entityNameToId[rel.source.trim()];
          const targetId = entityNameToId[rel.target.trim()];
          if (!sourceId || !targetId || sourceId === targetId) continue;

          const existingRel = db.prepare(
            'SELECT id FROM entity_relations WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?'
          ).get(sourceId, targetId, rel.type) as any;

          if (existingRel) {
            db.prepare('UPDATE entity_relations SET weight = weight + 1 WHERE id = ?').run(existingRel.id);
          } else {
            db.prepare(`
              INSERT INTO entity_relations (id, source_entity_id, target_entity_id, relation_type, weight, created_at)
              VALUES (?, ?, ?, ?, 1, ?)
            `).run(uuid(), sourceId, targetId, rel.type, now);
          }
        }
      } catch (err: any) {
        console.error(`[extraction] Native session ${session.id} failed:`, err.message);
      }
    }
  }
}

export const extractionService = new ExtractionService();
```

---

## Step 4: Knowledge Graph Memory Module

**New file:** `apps/api/src/memory/knowledge-store.ts`

```typescript
import { getDb } from './db';
import {
  Tag, KnowledgeEntity, EntityRelation, EntityMention,
  KnowledgeGraphData, KnowledgeGraphNode, KnowledgeGraphEdge,
  EntityType
} from '@prism/shared';

// Color map for entity types
const ENTITY_COLORS: Record<EntityType, string> = {
  technology: '#3B82F6',   // blue
  concept: '#8B5CF6',      // purple
  person: '#10B981',       // green
  project: '#F59E0B',      // amber
  organization: '#EF4444', // red
  topic: '#6366F1',        // indigo
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

  // Get mentions with conversation titles
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

  // Get relations (both directions)
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
    // Get the center entity + all connected entities
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
    size: Math.max(10, Math.min(50, r.mention_count * 5)),  // scale node size
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
```

---

## Step 5: API Routes

**New file:** `apps/api/src/routes/knowledge.ts`

```typescript
import { Router } from 'express';
import { extractionService } from '../services/extraction-service';
import {
  listTags, getConversationsByTag,
  listEntities, getEntityDetail,
  getGraphData, getKnowledgeStats,
} from '../memory/knowledge-store';

const router = Router();

// POST /api/knowledge/extract — Trigger entity extraction
router.post('/extract', async (req, res) => {
  try {
    const { provider, model } = req.body;
    // Run extraction in background
    const promise = extractionService.extractAll(provider, model);
    // Return immediately with status
    res.json({ status: 'started', message: 'Extraction started in background' });
    // Let it complete in background
    promise.catch(err => console.error('[extraction] Background error:', err));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/knowledge/extract/progress — Get extraction progress
router.get('/extract/progress', (_req, res) => {
  res.json(extractionService.getProgress());
});

// GET /api/knowledge/tags — List all tags
router.get('/tags', (req, res) => {
  const tags = listTags({
    search: req.query.search as string,
    limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
  });
  res.json(tags);
});

// GET /api/knowledge/tags/:id/conversations — Get conversations for a tag
router.get('/tags/:id/conversations', (req, res) => {
  const conversations = getConversationsByTag(req.params.id);
  res.json(conversations);
});

// GET /api/knowledge/entities — List entities
router.get('/entities', (req, res) => {
  const result = listEntities({
    type: req.query.type as any,
    search: req.query.search as string,
    limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
    offset: req.query.offset ? parseInt(req.query.offset as string) : undefined,
  });
  res.json(result);
});

// GET /api/knowledge/entities/:id — Get entity detail
router.get('/entities/:id', (req, res) => {
  const detail = getEntityDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Entity not found' });
  res.json(detail);
});

// GET /api/knowledge/graph — Get graph data for visualization
router.get('/graph', (req, res) => {
  const data = getGraphData({
    entityType: req.query.type as any,
    minMentions: req.query.minMentions ? parseInt(req.query.minMentions as string) : undefined,
    centerEntityId: req.query.center as string,
    maxNodes: req.query.maxNodes ? parseInt(req.query.maxNodes as string) : undefined,
  });
  res.json(data);
});

// GET /api/knowledge/stats — Get knowledge graph statistics
router.get('/stats', (_req, res) => {
  const stats = getKnowledgeStats();
  res.json(stats);
});

export default router;
```

**Register in `apps/api/src/index.ts`:**

```typescript
import knowledgeRouter from './routes/knowledge';
// ... after other app.use() calls:
app.use('/api/knowledge', knowledgeRouter);
```

---

## Step 6: Frontend — API Client

**File:** `apps/web/src/lib/api.ts`

Add:

```typescript
/* ===== Knowledge Graph ===== */

export async function triggerExtraction(provider?: string, model?: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/knowledge/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchExtractionProgress(): Promise<any> {
  const res = await fetch(`${API_BASE}/api/knowledge/extract/progress`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchTags(search?: string): Promise<any[]> {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  const res = await fetch(`${API_BASE}/api/knowledge/tags?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchTagConversations(tagId: string): Promise<any[]> {
  const res = await fetch(`${API_BASE}/api/knowledge/tags/${tagId}/conversations`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchEntities(opts?: { type?: string; search?: string; limit?: number; offset?: number }): Promise<any> {
  const params = new URLSearchParams();
  if (opts?.type) params.set('type', opts.type);
  if (opts?.search) params.set('search', opts.search);
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.offset) params.set('offset', String(opts.offset));
  const res = await fetch(`${API_BASE}/api/knowledge/entities?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchEntityDetail(entityId: string): Promise<any> {
  const res = await fetch(`${API_BASE}/api/knowledge/entities/${entityId}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchGraphData(opts?: { type?: string; minMentions?: number; center?: string; maxNodes?: number }): Promise<any> {
  const params = new URLSearchParams();
  if (opts?.type) params.set('type', opts.type);
  if (opts?.minMentions) params.set('minMentions', String(opts.minMentions));
  if (opts?.center) params.set('center', opts.center);
  if (opts?.maxNodes) params.set('maxNodes', String(opts.maxNodes));
  const res = await fetch(`${API_BASE}/api/knowledge/graph?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchKnowledgeStats(): Promise<any> {
  const res = await fetch(`${API_BASE}/api/knowledge/stats`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
```

---

## Step 7: Frontend — Store Updates

**File:** `apps/web/src/stores/chat-store.ts`

Add knowledge graph state:

```typescript
// Add to state interface:
knowledgeGraphData: KnowledgeGraphData | null;
knowledgeEntities: KnowledgeEntity[];
knowledgeTags: Tag[];
knowledgeStats: any;
knowledgeSelectedEntity: string | null;
knowledgeEntityDetail: any;
knowledgeExtractionProgress: ExtractionProgress | null;
knowledgeLoading: boolean;

// Add actions:
fetchKnowledgeGraph: (opts?: any) => Promise<void>;
fetchKnowledgeEntities: (opts?: any) => Promise<void>;
fetchKnowledgeTags: (search?: string) => Promise<void>;
selectKnowledgeEntity: (id: string) => Promise<void>;
triggerKnowledgeExtraction: (provider?: string, model?: string) => Promise<void>;
pollExtractionProgress: () => Promise<void>;
fetchKnowledgeStats: () => Promise<void>;
```

Also add `'knowledge'` to the `OperationMode` type in shared types (note: 7A already added `'library'`, so the final result should be):

```typescript
export type OperationMode = 'parallel' | 'handoff' | 'compare' | 'synthesize' | 'agents' | 'flow' | 'communication' | 'library' | 'knowledge';
```

---

## Step 8: Frontend — Knowledge Graph UI

### 8a. KnowledgeView (main container)

**New file:** `apps/web/src/components/KnowledgeView.tsx`

Three-panel layout:
- **Left panel**: Entity list with type filters (tabs for each EntityType) + search
- **Center panel**: Interactive graph visualization (using d3-force or react-force-graph)
- **Right panel**: Entity detail (description, mentions, related conversations)

Top bar includes:
- "Run Extraction" button (triggers LLM-based extraction)
- Extraction progress indicator
- Stats display (total entities, relations, tags)

### 8b. KnowledgeGraph (interactive visualization)

**New file:** `apps/web/src/components/KnowledgeGraph.tsx`

Use **d3-force** for the graph visualization (already available in d3 npm package, or install `react-force-graph-2d`):

Features:
- Nodes = entities, sized by mention count, colored by entity type
- Edges = relations, labeled with relation type, thickness by weight
- Hover: show entity name + description tooltip
- Click: select entity, center the graph on it, show entity detail in right panel
- Drag: reposition nodes
- Zoom/pan: navigate the graph
- Filter controls: show/hide entity types, minimum mention threshold

**Recommended library**: `react-force-graph-2d` (lightweight, React-friendly)
```bash
cd apps/web && npm install react-force-graph-2d
```

If you prefer to avoid extra dependencies, you can use raw d3-force with an SVG/Canvas element.

### 8c. EntityDetail

**New file:** `apps/web/src/components/EntityDetail.tsx`

Right sidebar showing:
- Entity name, type badge, description
- Aliases list
- First seen date + total mentions
- Related entities (clickable, navigates to that entity in the graph)
- Conversations where this entity is mentioned (clickable, navigates to Library/Session)
- Context snippets showing how the entity was discussed

### 8d. TagCloud

**New file:** `apps/web/src/components/TagCloud.tsx`

A visual tag cloud component:
- Shows all auto-extracted tags
- Size proportional to conversation count
- Click a tag → filters conversations by that tag (shown in a dropdown or navigates to Library with that filter)
- Can be embedded in Library view header or Knowledge view

### 8e. Update ModeSelector

**File:** `apps/web/src/components/ModeSelector.tsx`

Add a new mode button for "Knowledge" (🧠 icon).

### 8f. Update page.tsx

**File:** `apps/web/src/app/page.tsx`

Add:
```tsx
{mode === 'knowledge' && <KnowledgeView />}
```

---

## Step 9: Frontend Dependency

```bash
cd apps/web && npm install react-force-graph-2d
```

If using TypeScript:
```bash
npm install -D @types/react-force-graph-2d
```

(If types package doesn't exist, create a local declaration file `src/types/react-force-graph-2d.d.ts`)

---

## Step 10: Testing Checklist

1. **Trigger extraction**: Click "Run Extraction", verify it processes imported conversations
2. **Progress polling**: During extraction, verify the progress indicator updates
3. **Entity list**: After extraction, verify entities appear with correct types and mention counts
4. **Entity detail**: Click an entity, verify mentions + relations + snippets display correctly
5. **Graph visualization**: Verify nodes and edges render, drag/zoom works
6. **Graph filtering**: Filter by entity type, verify graph updates
7. **Center on entity**: Click a node, verify graph centers on it and shows connected entities
8. **Tag cloud**: Verify tags appear, click a tag → shows associated conversations
9. **Navigate to conversation**: From entity detail, click a conversation → goes to Library or Session
10. **Native sessions**: Verify extraction also processes native Prism sessions
11. **Incremental extraction**: Import new conversations, run extraction again, verify only new ones are processed
12. **LLM provider selection**: Verify extraction works with different providers (OpenAI, Anthropic, Google)

---

## Files Created/Modified Summary

| Action | Path |
|--------|------|
| MODIFY | `apps/api/src/memory/db.ts` — Add 5 new tables + indexes |
| MODIFY | `packages/shared/src/types.ts` — Add knowledge types, update OperationMode |
| CREATE | `apps/api/src/services/extraction-service.ts` |
| CREATE | `apps/api/src/memory/knowledge-store.ts` |
| CREATE | `apps/api/src/routes/knowledge.ts` |
| MODIFY | `apps/api/src/index.ts` — Register knowledge route |
| MODIFY | `apps/web/src/lib/api.ts` — Add knowledge API functions |
| MODIFY | `apps/web/src/stores/chat-store.ts` — Add knowledge state |
| CREATE | `apps/web/src/components/KnowledgeView.tsx` |
| CREATE | `apps/web/src/components/KnowledgeGraph.tsx` |
| CREATE | `apps/web/src/components/EntityDetail.tsx` |
| CREATE | `apps/web/src/components/TagCloud.tsx` |
| MODIFY | `apps/web/src/components/ModeSelector.tsx` — Add Knowledge mode |
| MODIFY | `apps/web/src/app/page.tsx` — Render KnowledgeView |
