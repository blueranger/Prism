import { v4 as uuid } from 'uuid';
import { getDb } from '../memory/db';
import { getAdapter } from '../adapters';
import type { LLMProvider, EntityType, RelationType, ExtractionProgress } from '@prism/shared';

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

interface ExtractionResult {
  tags: string[];
  entities: Array<{ name: string; type: EntityType; description: string; aliases?: string[] }>;
  relations: Array<{ source: string; target: string; type: RelationType }>;
}

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
   */
  async extractAll(provider: LLMProvider = 'openai', model: string = 'gpt-4o-mini'): Promise<ExtractionProgress> {
    if (this.progress.status === 'running') {
      throw new Error('Extraction is already running');
    }

    const db = getDb();

    const unprocessed = db.prepare(`
      SELECT ic.id, ic.title, ic.source_platform, ic.created_at
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
      const adapter = getAdapter(provider);

      for (const conv of unprocessed) {
        try {
          await this.processConversation(db, adapter, provider, model, conv);
          this.progress.processedConversations++;
        } catch (err: any) {
          console.error(`[extraction] Failed for conversation ${conv.id}:`, err.message);
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
   * Extract entities from a single imported conversation.
   */
  private async processConversation(
    db: any, adapter: any, provider: LLMProvider, model: string, conv: any
  ): Promise<void> {
    const messages = db.prepare(`
      SELECT role, content FROM imported_messages
      WHERE conversation_id = ?
      ORDER BY timestamp ASC
      LIMIT 50
    `).all(conv.id) as any[];

    const conversationText = messages
      .map((m: any) => `[${m.role}]: ${m.content}`)
      .join('\n\n');

    const truncated = conversationText.split(/\s+/).slice(0, 3000).join(' ');

    const prompt = EXTRACTION_PROMPT
      .replace('{title}', conv.title)
      .replace('{content}', truncated);

    // Call LLM using the standard adapter.stream() interface
    let responseText = '';
    const stream = adapter.stream({
      model,
      provider,
      messages: [{ role: 'user' as const, content: prompt }],
      temperature: 0.1,
    });

    for await (const chunk of stream) {
      if (chunk.content) responseText += chunk.content;
    }

    const extraction = this.parseResponse(responseText, conv.id);
    if (!extraction) return;

    this.storeExtractionResults(db, extraction, conv, messages);
  }

  /**
   * Also extract from native Prism sessions.
   */
  async extractFromNativeSessions(provider: LLMProvider = 'openai', model: string = 'gpt-4o-mini'): Promise<void> {
    const db = getDb();
    const sessions = db.prepare(`
      SELECT s.id, s.title
      FROM sessions s
      WHERE s.id NOT IN (SELECT DISTINCT session_id FROM session_tags)
      AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
      ORDER BY s.updated_at DESC
    `).all() as any[];

    const adapter = getAdapter(provider);

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
          provider,
          messages: [{ role: 'user' as const, content: prompt }],
          temperature: 0.1,
        });

        for await (const chunk of stream) {
          if (chunk.content) responseText += chunk.content;
        }

        const extraction = this.parseResponse(responseText, session.id);
        if (!extraction) continue;

        this.storeNativeExtractionResults(db, extraction, session, messages);
      } catch (err: any) {
        console.error(`[extraction] Native session ${session.id} failed:`, err.message);
      }
    }
  }

  /**
   * Parse JSON response from LLM extraction.
   */
  private parseResponse(responseText: string, contextId: string): ExtractionResult | null {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[extraction] No valid JSON in response for ${contextId}`);
      return null;
    }

    try {
      return JSON.parse(jsonMatch[0]) as ExtractionResult;
    } catch {
      console.warn(`[extraction] Invalid JSON for ${contextId}`);
      return null;
    }
  }

  /**
   * Store extraction results for an imported conversation.
   */
  private storeExtractionResults(
    db: any, extraction: ExtractionResult, conv: any, messages: any[]
  ): void {
    const now = new Date().toISOString();

    // Process tags
    for (const tagName of (extraction.tags || [])) {
      const normalizedName = tagName.toLowerCase().trim();
      if (!normalizedName) continue;

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

      const snippet = messages
        .find((m: any) => m.content.toLowerCase().includes(normalizedName.toLowerCase()))
        ?.content?.slice(0, 200) || '';

      db.prepare(`
        INSERT OR REPLACE INTO entity_mentions (entity_id, conversation_id, mention_count, context_snippet)
        VALUES (?, ?, 1, ?)
      `).run(entityId, conv.id, snippet);
    }

    // Process relations
    this.storeRelations(db, extraction.relations, entityNameToId);
  }

  /**
   * Store extraction results for a native session.
   */
  private storeNativeExtractionResults(
    db: any, extraction: ExtractionResult, session: any, messages: any[]
  ): void {
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
    this.storeRelations(db, extraction.relations, entityNameToId);
  }

  /**
   * Store entity relations (shared between imported and native).
   */
  private storeRelations(
    db: any,
    relations: ExtractionResult['relations'],
    entityNameToId: Record<string, string>
  ): void {
    const now = new Date().toISOString();
    for (const rel of (relations || [])) {
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
}

export const extractionService = new ExtractionService();
