import { v4 as uuid } from 'uuid';
import type {
  TriggerCandidate,
  TriggerDeliveryChannel,
  TriggerNotification,
  TriggerRule,
  TriggerRun,
} from '@prism/shared';
import { getDb } from './db';

type TriggerActionInput = TriggerCandidate['action'];

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapTriggerCandidate(row: any): TriggerCandidate {
  return {
    id: row.id,
    sessionId: row.session_id ?? null,
    sourceMemoryItemId: row.source_memory_item_id ?? null,
    sourceCandidateId: row.source_candidate_id ?? null,
    triggerType: row.trigger_type,
    title: row.title,
    summary: row.summary,
    status: row.status,
    confidence: row.confidence,
    triggerAt: row.trigger_at ?? null,
    deliveryChannel: row.delivery_channel,
    action: parseJson<TriggerActionInput>(row.action_json, { type: 'reminder', label: 'Review trigger' }),
    metadata: parseJson<Record<string, unknown> | null>(row.metadata_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTriggerRule(row: any): TriggerRule {
  return {
    id: row.id,
    triggerCandidateId: row.trigger_candidate_id ?? null,
    triggerType: row.trigger_type,
    title: row.title,
    summary: row.summary,
    status: row.status,
    triggerAt: row.trigger_at ?? null,
    deliveryChannel: row.delivery_channel,
    action: parseJson<TriggerActionInput>(row.action_json, { type: 'reminder', label: 'Review trigger' }),
    metadata: parseJson<Record<string, unknown> | null>(row.metadata_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTriggerRun(row: any): TriggerRun {
  return {
    id: row.id,
    triggerCandidateId: row.trigger_candidate_id ?? null,
    triggerRuleId: row.trigger_rule_id ?? null,
    status: row.status,
    note: row.note ?? null,
    createdAt: row.created_at,
  };
}

function mapNotification(row: any): TriggerNotification {
  return {
    id: row.id,
    triggerRunId: row.trigger_run_id ?? null,
    channel: row.channel as TriggerDeliveryChannel,
    title: row.title,
    body: row.body,
    deepLink: row.deep_link ?? null,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function createTriggerCandidate(input: Omit<TriggerCandidate, 'id' | 'createdAt' | 'updatedAt' | 'status'> & { status?: TriggerCandidate['status'] }): TriggerCandidate {
  const db = getDb();
  const now = Date.now();
  const candidate: TriggerCandidate = {
    id: uuid(),
    status: input.status ?? 'pending',
    createdAt: now,
    updatedAt: now,
    ...input,
  };

  db.prepare(`
    INSERT INTO trigger_candidates (
      id, session_id, source_memory_item_id, source_candidate_id, trigger_type, title, summary,
      status, confidence, trigger_at, delivery_channel, action_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidate.id,
    candidate.sessionId ?? null,
    candidate.sourceMemoryItemId ?? null,
    candidate.sourceCandidateId ?? null,
    candidate.triggerType,
    candidate.title,
    candidate.summary,
    candidate.status,
    candidate.confidence,
    candidate.triggerAt ?? null,
    candidate.deliveryChannel,
    JSON.stringify(candidate.action),
    JSON.stringify(candidate.metadata ?? null),
    candidate.createdAt,
    candidate.updatedAt
  );

  return candidate;
}

export function listTriggerCandidates(status?: TriggerCandidate['status'] | 'all'): TriggerCandidate[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM trigger_candidates
    ${status && status !== 'all' ? 'WHERE status = ?' : ''}
    ORDER BY updated_at DESC, created_at DESC
  `).all(...(status && status !== 'all' ? [status] : [])) as any[];
  return rows.map(mapTriggerCandidate);
}

export function listTriggerRules(status?: TriggerRule['status'] | 'all'): TriggerRule[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM trigger_rules
    ${status && status !== 'all' ? 'WHERE status = ?' : ''}
    ORDER BY COALESCE(trigger_at, created_at) ASC
  `).all(...(status && status !== 'all' ? [status] : [])) as any[];
  return rows.map(mapTriggerRule);
}

export function listTriggerRuns(limit = 100): TriggerRun[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM trigger_runs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as any[];
  return rows.map(mapTriggerRun);
}

export function listTriggerNotifications(limit = 100): TriggerNotification[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM trigger_notifications
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as any[];
  return rows.map(mapNotification);
}

export function acceptTriggerCandidate(id: string): TriggerRule | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM trigger_candidates WHERE id = ?').get(id) as any;
  if (!row) return null;
  const candidate = mapTriggerCandidate(row);
  const now = Date.now();
  const rule: TriggerRule = {
    id: uuid(),
    triggerCandidateId: candidate.id,
    triggerType: candidate.triggerType,
    title: candidate.title,
    summary: candidate.summary,
    status: 'active',
    triggerAt: candidate.triggerAt ?? null,
    deliveryChannel: candidate.deliveryChannel,
    action: candidate.action,
    metadata: candidate.metadata ?? null,
    createdAt: now,
    updatedAt: now,
  };

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO trigger_rules (
        id, trigger_candidate_id, trigger_type, title, summary, status, trigger_at,
        delivery_channel, action_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rule.id,
      rule.triggerCandidateId,
      rule.triggerType,
      rule.title,
      rule.summary,
      rule.status,
      rule.triggerAt ?? null,
      rule.deliveryChannel,
      JSON.stringify(rule.action),
      JSON.stringify(rule.metadata ?? null),
      rule.createdAt,
      rule.updatedAt
    );
    db.prepare('UPDATE trigger_candidates SET status = ?, updated_at = ? WHERE id = ?').run('accepted', now, id);
    db.prepare(`
      INSERT INTO trigger_runs (id, trigger_candidate_id, trigger_rule_id, status, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuid(), candidate.id, rule.id, 'accepted', 'Accepted from candidate', now);
  });
  txn();
  return rule;
}

export function rejectTriggerCandidate(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare('UPDATE trigger_candidates SET status = ?, updated_at = ? WHERE id = ?').run('rejected', now, id);
  db.prepare(`
    INSERT INTO trigger_runs (id, trigger_candidate_id, trigger_rule_id, status, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuid(), id, null, 'rejected', 'Rejected by user', now);
}

export function snoozeTriggerCandidate(id: string, triggerAt: number): TriggerCandidate | null {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    UPDATE trigger_candidates
    SET status = 'snoozed', trigger_at = ?, updated_at = ?
    WHERE id = ?
  `).run(triggerAt, now, id);
  const row = db.prepare('SELECT * FROM trigger_candidates WHERE id = ?').get(id) as any;
  if (!row) return null;
  db.prepare(`
    INSERT INTO trigger_runs (id, trigger_candidate_id, trigger_rule_id, status, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuid(), id, null, 'snoozed', 'Snoozed trigger candidate', now);
  return mapTriggerCandidate(row);
}

export function createTriggerNotification(input: Omit<TriggerNotification, 'id' | 'createdAt'>): TriggerNotification {
  const db = getDb();
  const notification: TriggerNotification = {
    id: uuid(),
    createdAt: Date.now(),
    ...input,
  };
  db.prepare(`
    INSERT INTO trigger_notifications (id, trigger_run_id, channel, title, body, deep_link, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    notification.id,
    notification.triggerRunId ?? null,
    notification.channel,
    notification.title,
    notification.body,
    notification.deepLink ?? null,
    notification.status,
    notification.createdAt
  );
  return notification;
}

export function resetTriggers(): void {
  const db = getDb();
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM trigger_notifications').run();
    db.prepare('DELETE FROM trigger_runs').run();
    db.prepare('DELETE FROM trigger_rules').run();
    db.prepare('DELETE FROM trigger_candidates').run();
  });
  txn();
}
