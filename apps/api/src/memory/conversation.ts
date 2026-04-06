import { v4 as uuid } from 'uuid';
import { Message, HandoffEvent } from '@prism/shared';
import { getDb } from './db';
import { estimateTokens } from './token-estimator';
import { ensureSession, touchSession, updateSessionMeta } from './session';

export function saveMessage(
  sessionId: string,
  role: Message['role'],
  content: string,
  sourceModel: string,
  opts?: {
    handoffId?: string;
    handoffFrom?: string;
    mode?: string;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      reasoningTokens?: number;
      cachedTokens?: number;
    };
    estimatedCostUsd?: number;
    pricingSource?: Message['pricingSource'];
  }
): Message {
  const db = getDb();
  const tokenCount = estimateTokens(content);
  const mode = opts?.mode ?? 'parallel';
  const message: Message = {
    id: uuid(),
    sessionId,
    role,
    content,
    sourceModel,
    timestamp: Date.now(),
    tokenCount,
    handoffId: opts?.handoffId ?? null,
    handoffFrom: opts?.handoffFrom ?? null,
    mode,
    promptTokens: opts?.usage?.promptTokens ?? null,
    completionTokens: opts?.usage?.completionTokens ?? null,
    reasoningTokens: opts?.usage?.reasoningTokens ?? null,
    cachedTokens: opts?.usage?.cachedTokens ?? null,
    estimatedCostUsd: opts?.estimatedCostUsd ?? null,
    pricingSource: opts?.pricingSource ?? null,
  };

  db.prepare(
    `INSERT INTO messages (
      id, session_id, role, content, source_model, timestamp, token_count, handoff_id, handoff_from, mode,
      prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, estimated_cost_usd, pricing_source
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    message.id, message.sessionId, message.role, message.content,
    message.sourceModel, message.timestamp, message.tokenCount,
    message.handoffId, message.handoffFrom, message.mode,
    message.promptTokens, message.completionTokens, message.reasoningTokens,
    message.cachedTokens, message.estimatedCostUsd, message.pricingSource
  );

  // Auto-track session
  ensureSession(sessionId);
  touchSession(sessionId);

  // Set preview from first user message in the session
  if (role === 'user') {
    const count = db.prepare(
      "SELECT COUNT(*) as cnt FROM messages WHERE session_id = ? AND role = 'user'"
    ).get(sessionId) as { cnt: number };
    if (count.cnt === 1) {
      updateSessionMeta(sessionId, { preview: content.slice(0, 100) });
    }
  }

  return message;
}

export function getSessionMessages(sessionId: string): Message[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, session_id as sessionId, role, content, source_model as sourceModel,
              timestamp, token_count as tokenCount, handoff_id as handoffId,
              handoff_from as handoffFrom, mode,
              prompt_tokens as promptTokens, completion_tokens as completionTokens,
              reasoning_tokens as reasoningTokens, cached_tokens as cachedTokens,
              estimated_cost_usd as estimatedCostUsd, pricing_source as pricingSource
       FROM messages WHERE session_id = ? ORDER BY timestamp ASC`
    )
    .all(sessionId) as Message[];

  return rows;
}

export function getSessionTokenCount(sessionId: string): number {
  const db = getDb();
  const row = db
    .prepare('SELECT COALESCE(SUM(token_count), 0) as total FROM messages WHERE session_id = ?')
    .get(sessionId) as { total: number };
  return row.total;
}

// --- Handoff tracking ---

export function createHandoff(
  sessionId: string,
  fromModel: string,
  toModel: string,
  instruction: string | null
): HandoffEvent {
  const db = getDb();
  const handoff: HandoffEvent = {
    id: uuid(),
    sessionId,
    fromModel,
    toModel,
    instruction,
    timestamp: Date.now(),
  };

  db.prepare(
    `INSERT INTO handoffs (id, session_id, from_model, to_model, instruction, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(handoff.id, handoff.sessionId, handoff.fromModel, handoff.toModel, handoff.instruction, handoff.timestamp);

  return handoff;
}

export function getSessionHandoffs(sessionId: string): HandoffEvent[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, session_id as sessionId, from_model as fromModel, to_model as toModel,
              instruction, timestamp
       FROM handoffs WHERE session_id = ? ORDER BY timestamp ASC`
    )
    .all(sessionId) as HandoffEvent[];
}

export function updateHandoffSummary(handoffId: string, summary: string): void {
  const db = getDb();
  db.prepare('UPDATE handoffs SET summary = ? WHERE id = ?').run(summary, handoffId);
}

// --- Summaries ---

export function saveSummary(
  sessionId: string,
  fromTimestamp: number,
  toTimestamp: number,
  content: string,
  originalTokenCount: number
): void {
  const db = getDb();
  const tokenCount = estimateTokens(content);
  db.prepare(
    `INSERT INTO summaries (id, session_id, from_timestamp, to_timestamp, content, token_count, original_token_count, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uuid(), sessionId, fromTimestamp, toTimestamp, content, tokenCount, originalTokenCount, Date.now());
}

export function getSessionSummaries(sessionId: string): {
  content: string;
  fromTimestamp: number;
  toTimestamp: number;
  tokenCount: number;
}[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT content, from_timestamp as fromTimestamp, to_timestamp as toTimestamp, token_count as tokenCount
       FROM summaries WHERE session_id = ? ORDER BY from_timestamp ASC`
    )
    .all(sessionId) as any[];
}
