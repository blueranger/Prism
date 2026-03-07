import { v4 as uuid } from 'uuid';
import type { Decision, DecisionType } from '@prism/shared';
import { getDb } from './db';

/**
 * Create a new decision (preference or observation).
 */
export function createDecision(
  type: DecisionType,
  content: string,
  model?: string | null
): Decision {
  const db = getDb();
  const now = Date.now();
  const decision: Decision = {
    id: uuid(),
    type,
    content,
    model: model ?? null,
    active: true,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO decisions (id, type, content, model, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    decision.id, decision.type, decision.content,
    decision.model, decision.active ? 1 : 0,
    decision.createdAt, decision.updatedAt
  );

  return decision;
}

/**
 * List all decisions, optionally filtered by active status.
 */
export function listDecisions(activeOnly: boolean = true): Decision[] {
  const db = getDb();
  const query = activeOnly
    ? 'SELECT * FROM decisions WHERE active = 1 ORDER BY updated_at DESC'
    : 'SELECT * FROM decisions ORDER BY updated_at DESC';

  const rows = db.prepare(query).all() as any[];

  return rows.map(mapRow);
}

/**
 * Get a single decision by ID.
 */
export function getDecision(id: string): Decision | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as any;
  if (!row) return undefined;
  return mapRow(row);
}

/**
 * Update a decision's content, type, model, or active status.
 */
export function updateDecision(
  id: string,
  update: Partial<Pick<Decision, 'content' | 'type' | 'model' | 'active'>>
): Decision | undefined {
  const db = getDb();
  const existing = getDecision(id);
  if (!existing) return undefined;

  const now = Date.now();

  if (update.content !== undefined) {
    db.prepare('UPDATE decisions SET content = ?, updated_at = ? WHERE id = ?')
      .run(update.content, now, id);
  }
  if (update.type !== undefined) {
    db.prepare('UPDATE decisions SET type = ?, updated_at = ? WHERE id = ?')
      .run(update.type, now, id);
  }
  if (update.model !== undefined) {
    db.prepare('UPDATE decisions SET model = ?, updated_at = ? WHERE id = ?')
      .run(update.model, now, id);
  }
  if (update.active !== undefined) {
    db.prepare('UPDATE decisions SET active = ?, updated_at = ? WHERE id = ?')
      .run(update.active ? 1 : 0, now, id);
  }

  return getDecision(id);
}

/**
 * Hard-delete a decision.
 */
export function deleteDecision(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM decisions WHERE id = ?').run(id);
}

/**
 * Get all active decisions as a formatted string for system message injection.
 * Returns null if there are no active decisions.
 */
export function getDecisionsSystemPrompt(): string | null {
  const decisions = listDecisions(true);
  if (decisions.length === 0) return null;

  const prefs = decisions.filter((d) => d.type === 'preference');
  const obs = decisions.filter((d) => d.type === 'observation');

  const lines: string[] = [];

  if (prefs.length > 0) {
    lines.push('User preferences:');
    for (const p of prefs) {
      const modelTag = p.model ? ` [${p.model}]` : '';
      lines.push(`- ${p.content}${modelTag}`);
    }
  }

  if (obs.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Model performance observations:');
    for (const o of obs) {
      const modelTag = o.model ? ` [${o.model}]` : '';
      lines.push(`- ${o.content}${modelTag}`);
    }
  }

  return lines.join('\n');
}

// --- Internal ---

function mapRow(row: any): Decision {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    model: row.model,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
