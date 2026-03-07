import { Router } from 'express';
import type { CommProvider, DraftReply, ExternalThread, ExternalMessage, TriageResult, TriageSettings } from '@prism/shared';
import { getDb } from '../memory/db';
import { ConnectorRegistry } from '../connectors/registry';
import {
  recordLearning,
  listSenderStats,
  getSenderStats,
  clearSenderLearning,
} from '../services/reply-analyzer';
import {
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  testRule,
} from '../services/monitor-engine';
import { getAllSyncStates, enqueueOutlookTaskHighPriority } from '../services/connector-service';
import { broadcast } from '../services/ws';
import { ManualConnector } from '../connectors/manual';

const router = Router();

// --- Connector status endpoint ---

/**
 * GET /api/comm/connectors/status
 * Returns each active connector's account info plus last sync error.
 */
router.get('/connectors/status', (_req, res) => {
  const statuses = ConnectorRegistry.getStatuses();
  const syncStates = getAllSyncStates();

  const accounts = statuses.map((s) => {
    const syncState = syncStates.get(s.accountId);
    return {
      accountId: s.accountId,
      displayName: s.displayName ?? null,
      email: s.email ?? null,
      provider: s.provider,
      connectorType: s.connectorType,
      lastError: syncState?.lastError ?? null,
    };
  });

  res.json({ accounts });
});

// --- Thread endpoints ---

/**
 * GET /api/comm/threads
 * List all external threads across all providers.
 */
router.get('/threads', (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM external_threads ORDER BY last_message_at DESC`
    )
    .all() as any[];

  const threads: ExternalThread[] = rows.map(mapRowToThread);
  res.json({ threads });
});

/**
 * GET /api/comm/threads/:threadId/messages
 * Fetch messages for a specific thread.
 */
router.get('/threads/:threadId/messages', async (_req, res) => {
  const { threadId } = _req.params;
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM external_messages
       WHERE thread_id = ?
       ORDER BY timestamp ASC`
    )
    .all(threadId) as any[];

  // Return messages immediately with whatever content we have.
  // If some messages have empty content, trigger background fetch.
  const emptyContentRows = rows.filter((r: any) => !r.content || r.content.trim() === '');
  const hasEmptyContent = emptyContentRows.length > 0;
  console.log(`[comm] Thread ${threadId}: ${rows.length} messages total, ${emptyContentRows.length} need content loading`);

  const messages: ExternalMessage[] = rows.map(mapRowToMessage);
  res.json({ messages, contentLoading: hasEmptyContent });

  // Background: fetch missing content via Outlook queue, then notify frontend
  // (Only for Outlook — LINE messages already have content)
  const thread = db.prepare('SELECT provider FROM external_threads WHERE id = ?').get(threadId) as { provider: string } | undefined;
  const isOutlookThread = !thread || thread.provider === 'outlook';

  if (hasEmptyContent && isOutlookThread) {
    // Use HIGH priority so content fetch jumps ahead of background sync tasks
    enqueueOutlookTaskHighPriority(async () => {
      const { fetchMessageContentAsync } = await import('../services/outlook-applescript');
      let loadedCount = 0;
      for (const row of emptyContentRows) {
        console.log(`[comm] Lazy-loading content for message external_id=${row.external_id}`);
        try {
          const content = await fetchMessageContentAsync(row.external_id);
          if (content) {
            db.prepare('UPDATE external_messages SET content = ? WHERE id = ?')
              .run(content, row.id);
            loadedCount++;
            console.log(`[comm] Loaded ${content.length} chars for message ${row.external_id}`);
          } else {
            console.warn(`[comm] No content returned for message external_id=${row.external_id}`);
          }
        } catch (err: any) {
          console.error(`[comm] Content load error for ${row.external_id}:`, err.message);
        }
      }
      // Notify frontend that content is ready
      if (loadedCount > 0) {
        broadcast({ type: 'comm:contentLoaded', threadId, loadedCount });
        console.log(`[comm] Content loaded for ${loadedCount} message(s) in thread ${threadId}, notified frontend`);
      }
    }, `content-thread-${threadId}`).catch((err: any) => {
      console.error('[comm] Background content fetch error:', err.message);
    });
  }

  // For LINE threads: fetch fresh messages via Puppeteer in background
  if (thread && thread.provider === 'line') {
    const lineThread = db.prepare('SELECT * FROM external_threads WHERE id = ?').get(threadId) as any;
    if (lineThread?.account_id) {
      const connector = ConnectorRegistry.get(lineThread.account_id);
      if (connector && connector.provider === 'line') {
        // Fetch fresh messages asynchronously
        connector.fetchThreadMessages(threadId).then((freshMsgs) => {
          if (freshMsgs.length > rows.length) {
            broadcast({ type: 'comm:contentLoaded', threadId, loadedCount: freshMsgs.length - rows.length });
            console.log(`[comm] LINE fresh messages for ${threadId}: ${freshMsgs.length} (was ${rows.length})`);
          }
        }).catch((err: any) => {
          console.error(`[comm] LINE message fetch error for ${threadId}:`, err.message);
        });
      }
    }
  }
});

/**
 * POST /api/comm/threads/:threadId/draft
 * Trigger AI draft generation for a thread.
 * Body: { messageId?, tone?, model?, instruction? }
 */
router.post('/threads/:threadId/draft', async (req, res) => {
  const { threadId } = req.params;
  const { messageId, tone, language, model, instruction } = req.body;

  const db = getDb();

  // Look up the thread to get provider
  const thread = db
    .prepare('SELECT * FROM external_threads WHERE id = ?')
    .get(threadId) as any;

  if (!thread) {
    res.status(404).json({ error: 'Thread not found' });
    return;
  }

  // Import the agent dynamically to avoid circular deps
  const { agentRegistry } = await import('../agents/registry');
  const agent = agentRegistry.get('reply-draft');
  if (!agent) {
    res.status(500).json({ error: 'ReplyDraftAgent not registered' });
    return;
  }

  try {
    const result = await agent.execute(
      {
        threadId,
        messageId: messageId ?? undefined,
        provider: thread.provider,
        accountId: thread.account_id ?? '',
        tone: tone ?? undefined,
        language: language ?? undefined,
        model: model ?? undefined,
        instruction: instruction ?? undefined,
      },
      { sessionId: '', messages: [], artifacts: [] }
    );

    if (!result.success) {
      res.status(400).json({ error: result.output, log: result.log });
      return;
    }

    // Fetch the draft that was just created
    const draft = db
      .prepare(
        `SELECT * FROM draft_replies
         WHERE thread_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(threadId) as any;

    res.json({
      draft: draft ? mapRowToDraft(draft) : null,
      log: result.log,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Draft generation failed' });
  }
});

// --- Draft endpoints ---

/**
 * GET /api/comm/drafts
 * List all drafts, optionally filtered by status.
 * Query: ?status=pending&threadId=xxx
 */
router.get('/drafts', (req, res) => {
  const db = getDb();
  const status = req.query.status as string | undefined;
  const threadId = req.query.threadId as string | undefined;

  let sql = 'SELECT * FROM draft_replies';
  const conditions: string[] = [];
  const params: any[] = [];

  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (threadId) {
    conditions.push('thread_id = ?');
    params.push(threadId);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY created_at DESC';

  const rows = db.prepare(sql).all(...params) as any[];
  const drafts: DraftReply[] = rows.map(mapRowToDraft);
  res.json({ drafts });
});

/**
 * POST /api/comm/drafts/:id/approve
 * Approve a draft — sends via connector and records learning.
 * Body: { userEdit?: string }
 */
router.post('/drafts/:id/approve', async (req, res) => {
  const { id } = req.params;
  const { userEdit } = req.body;
  const db = getDb();

  const draft = db
    .prepare('SELECT * FROM draft_replies WHERE id = ?')
    .get(id) as any;

  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  if (draft.status !== 'pending') {
    res.status(400).json({ error: `Draft is already ${draft.status}` });
    return;
  }

  const finalContent = userEdit ?? draft.draft_content;
  const accountId = draft.account_id as string;

  // Send via connector — look up by accountId first, fall back to provider
  let connector = accountId ? ConnectorRegistry.get(accountId) : undefined;
  if (!connector) {
    // Legacy fallback: try by provider
    const provider = draft.provider as CommProvider;
    const connectors = ConnectorRegistry.getByProvider(provider);
    connector = connectors[0];
  }
  if (!connector) {
    res.status(400).json({ error: `No connector for account: ${accountId || draft.provider}` });
    return;
  }

  try {
    await connector.sendReply(draft.thread_id, finalContent);
  } catch (err: any) {
    res.status(500).json({ error: `Failed to send reply: ${err.message}` });
    return;
  }

  const now = Date.now();

  // Update draft status
  db.prepare(
    `UPDATE draft_replies
     SET status = 'sent', sent_at = ?, user_edit = ?, updated_at = ?
     WHERE id = ?`
  ).run(now, userEdit ?? null, now, id);

  // Record learning via reply-analyzer
  const targetMsg = db
    .prepare('SELECT * FROM external_messages WHERE id = ?')
    .get(draft.message_id) as any;

  if (targetMsg) {
    recordLearning({
      provider: draft.provider,
      senderId: targetMsg.sender_id,
      senderName: targetMsg.sender_name,
      contextMessage: targetMsg.content,
      userReply: finalContent,
      wasEditedFromDraft: !!userEdit,
    });
  }

  res.json({ ok: true, draft: mapRowToDraft({ ...draft, status: 'sent', sent_at: now, user_edit: userEdit ?? null, updated_at: now }) });
});

/**
 * POST /api/comm/drafts/:id/reject
 * Reject a draft.
 */
router.post('/drafts/:id/reject', (_req, res) => {
  const { id } = _req.params;
  const db = getDb();

  const draft = db
    .prepare('SELECT * FROM draft_replies WHERE id = ?')
    .get(id) as any;

  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  if (draft.status !== 'pending') {
    res.status(400).json({ error: `Draft is already ${draft.status}` });
    return;
  }

  const now = Date.now();
  db.prepare(
    'UPDATE draft_replies SET status = ?, updated_at = ? WHERE id = ?'
  ).run('rejected', now, id);

  res.json({ ok: true });
});

// --- Monitor Rules endpoints ---

/**
 * GET /api/comm/rules
 * List all monitor rules. Query: ?enabledOnly=true
 */
router.get('/rules', (req, res) => {
  const enabledOnly = req.query.enabledOnly === 'true';
  const rules = listRules(enabledOnly);
  res.json({ rules });
});

/**
 * POST /api/comm/rules
 * Create a new monitor rule.
 * Body: { provider, ruleName, conditions, action, actionConfig? }
 */
router.post('/rules', (req, res) => {
  const { provider, ruleName, conditions, action, actionConfig } = req.body;

  if (!provider || !ruleName || !conditions || !action) {
    res.status(400).json({ error: 'provider, ruleName, conditions, and action are required' });
    return;
  }

  const rule = createRule({ provider, ruleName, conditions, action, actionConfig });
  res.json({ rule });
});

/**
 * PUT /api/comm/rules/:id
 * Update a monitor rule.
 * Body: Partial<{ ruleName, provider, enabled, conditions, action, actionConfig }>
 */
router.put('/rules/:id', (req, res) => {
  const { id } = req.params;
  const rule = updateRule(id, req.body);
  if (!rule) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  res.json({ rule });
});

/**
 * DELETE /api/comm/rules/:id
 * Delete a monitor rule.
 */
router.delete('/rules/:id', (req, res) => {
  const { id } = req.params;
  const deleted = deleteRule(id);
  if (!deleted) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  res.json({ ok: true });
});

/**
 * POST /api/comm/rules/:id/test
 * Test a rule against recent messages.
 * Body: { limit?: number }
 */
router.post('/rules/:id/test', (req, res) => {
  const { id } = req.params;
  const limit = typeof req.body.limit === 'number' ? req.body.limit : 10;
  const matches = testRule(id, limit);
  res.json({
    matches: matches.map((m) => ({
      ruleId: m.rule.id,
      ruleName: m.rule.ruleName,
      messageId: m.message.id,
      sender: m.message.senderName,
      subject: m.message.subject,
      preview: m.message.content.slice(0, 120),
      timestamp: m.message.timestamp,
    })),
  });
});

// --- Learning endpoints ---

/**
 * GET /api/comm/learning/senders
 * List all senders with aggregated reply learning stats.
 */
router.get('/learning/senders', (_req, res) => {
  const stats = listSenderStats();
  res.json({ senders: stats });
});

/**
 * GET /api/comm/learning/senders/:id
 * Get detailed learning stats for a specific sender.
 * Query: ?provider=outlook (required)
 */
router.get('/learning/senders/:id', (req, res) => {
  const { id } = req.params;
  const provider = req.query.provider as string | undefined;

  if (!provider) {
    res.status(400).json({ error: 'provider query parameter is required' });
    return;
  }

  const stats = getSenderStats(provider, id);
  if (!stats) {
    res.status(404).json({ error: 'No learning data found for this sender' });
    return;
  }

  res.json({ sender: stats });
});

/**
 * DELETE /api/comm/learning/senders/:id
 * Clear all learning data for a specific sender.
 * Query: ?provider=outlook (required)
 */
router.delete('/learning/senders/:id', (req, res) => {
  const { id } = req.params;
  const provider = req.query.provider as string | undefined;

  if (!provider) {
    res.status(400).json({ error: 'provider query parameter is required' });
    return;
  }

  const deleted = clearSenderLearning(provider, id);
  res.json({ ok: true, deleted });
});

// --- Mapping helpers ---

function mapRowToThread(row: any): ExternalThread {
  return {
    id: row.id,
    provider: row.provider,
    accountId: row.account_id ?? '',
    externalId: row.external_id,
    sessionId: row.session_id ?? null,
    displayName: row.display_name,
    subject: row.subject ?? null,
    senderName: row.sender_name ?? null,
    senderEmail: row.sender_email ?? null,
    isGroup: row.is_group === 1,
    messageCount: row.message_count ?? 0,
    lastMessageAt: row.last_message_at ?? null,
    lastSyncedAt: row.last_synced_at ?? null,
    createdAt: row.created_at,
  };
}

function mapRowToMessage(row: any): ExternalMessage {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    // ignore
  }

  return {
    id: row.id,
    threadId: row.thread_id,
    provider: row.provider,
    accountId: row.account_id ?? '',
    externalId: row.external_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderEmail: row.sender_email ?? null,
    subject: row.subject ?? null,
    content: row.content,
    timestamp: row.timestamp,
    isInbound: row.is_inbound === 1,
    metadata,
    createdAt: row.created_at,
  };
}

function mapRowToDraft(row: any): DraftReply {
  return {
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    provider: row.provider,
    accountId: row.account_id ?? '',
    draftContent: row.draft_content,
    modelUsed: row.model_used,
    tone: row.tone ?? null,
    language: row.language ?? null,
    instruction: row.instruction ?? null,
    status: row.status,
    triggeredBy: row.triggered_by ?? null,
    sentAt: row.sent_at ?? null,
    userEdit: row.user_edit ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// =============================================================
// Manual Connector endpoints
// =============================================================

/**
 * POST /api/comm/manual/setup
 * Set up a manual connector account.
 * Body: { displayName: string }
 */
router.post('/manual/setup', (req, res) => {
  const { displayName } = req.body;
  if (!displayName || typeof displayName !== 'string') {
    res.status(400).json({ error: 'displayName is required' });
    return;
  }

  try {
    const connector = ConnectorRegistry.createInstance('manual', require('uuid').v4()) as ManualConnector;
    connector.setupManual(displayName);
    res.json({ ok: true, accountId: connector.accountId });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Setup failed' });
  }
});

/**
 * POST /api/comm/threads
 * Create a new manual thread.
 * Body: { accountId, displayName, subject?, senderName?, senderEmail?, isGroup? }
 */
router.post('/threads', (req, res) => {
  const { accountId, displayName, subject, senderName, senderEmail, isGroup } = req.body;

  if (!accountId || !displayName) {
    res.status(400).json({ error: 'accountId and displayName are required' });
    return;
  }

  const connector = ConnectorRegistry.get(accountId);
  if (!connector || connector.provider !== 'manual') {
    res.status(400).json({ error: 'Account is not a manual connector' });
    return;
  }

  try {
    const thread = (connector as ManualConnector).createThread({
      displayName,
      subject,
      senderName: senderName || displayName,
      senderEmail,
      isGroup,
    });
    res.json({ thread });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to create thread' });
  }
});

/**
 * POST /api/comm/threads/:threadId/messages
 * Add a message to a manual thread.
 * Body: { content, senderName, senderEmail?, isInbound, subject? }
 */
router.post('/threads/:threadId/messages', (req, res) => {
  const { threadId } = req.params;
  const { content, senderName, senderEmail, isInbound, subject } = req.body;

  if (!content || !senderName || isInbound === undefined) {
    res.status(400).json({ error: 'content, senderName, and isInbound are required' });
    return;
  }

  // Look up thread to find accountId
  const db = getDb();
  const thread = db.prepare('SELECT * FROM external_threads WHERE id = ?').get(threadId) as any;
  if (!thread) {
    res.status(404).json({ error: 'Thread not found' });
    return;
  }

  if (thread.provider !== 'manual') {
    res.status(400).json({ error: 'Can only add messages to manual threads' });
    return;
  }

  const connector = ConnectorRegistry.get(thread.account_id);
  if (!connector || connector.provider !== 'manual') {
    res.status(400).json({ error: 'Manual connector not found for this thread' });
    return;
  }

  try {
    const message = (connector as ManualConnector).addMessage({
      threadId,
      content,
      senderName,
      senderEmail,
      isInbound: !!isInbound,
      subject,
    });
    res.json({ message });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to add message' });
  }
});

/**
 * PATCH /api/comm/threads/:threadId
 * Update a manual thread's metadata.
 * Body: { displayName?, subject?, senderName?, senderEmail? }
 */
router.patch('/threads/:threadId', (req, res) => {
  const { threadId } = req.params;
  const { displayName, subject, senderName, senderEmail } = req.body;
  const db = getDb();

  const thread = db.prepare('SELECT * FROM external_threads WHERE id = ?').get(threadId) as any;
  if (!thread) {
    res.status(404).json({ error: 'Thread not found' });
    return;
  }

  if (thread.provider !== 'manual') {
    res.status(400).json({ error: 'Can only update manual threads' });
    return;
  }

  const updates: string[] = [];
  const params: any[] = [];

  if (displayName !== undefined) { updates.push('display_name = ?'); params.push(displayName); }
  if (subject !== undefined) { updates.push('subject = ?'); params.push(subject); }
  if (senderName !== undefined) { updates.push('sender_name = ?'); params.push(senderName); }
  if (senderEmail !== undefined) { updates.push('sender_email = ?'); params.push(senderEmail); }

  if (updates.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  params.push(threadId);
  db.prepare(`UPDATE external_threads SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM external_threads WHERE id = ?').get(threadId) as any;
  res.json({ thread: mapRowToThread(updated) });
});

/**
 * DELETE /api/comm/threads/:threadId
 * Delete a manual thread and its messages.
 */
router.delete('/threads/:threadId', (req, res) => {
  const { threadId } = req.params;
  const db = getDb();

  const thread = db.prepare('SELECT * FROM external_threads WHERE id = ?').get(threadId) as any;
  if (!thread) {
    res.status(404).json({ error: 'Thread not found' });
    return;
  }

  if (thread.provider !== 'manual') {
    res.status(400).json({ error: 'Can only delete manual threads' });
    return;
  }

  db.prepare('DELETE FROM external_messages WHERE thread_id = ?').run(threadId);
  db.prepare('DELETE FROM draft_replies WHERE thread_id = ?').run(threadId);
  db.prepare('DELETE FROM external_threads WHERE id = ?').run(threadId);

  res.json({ ok: true });
});

// =============================================================
// Triage endpoints
// =============================================================

/**
 * GET /api/comm/triage-results
 * Fetch triage results, optionally filtered by accountId or threadId.
 */
router.get('/triage-results', (_req, res) => {
  const { accountId, threadId } = _req.query;
  const db = getDb();

  let query = 'SELECT * FROM triage_results WHERE 1=1';
  const params: any[] = [];

  if (accountId) {
    query += ' AND account_id = ?';
    params.push(accountId);
  }
  if (threadId) {
    query += ' AND thread_id = ?';
    params.push(threadId);
  }

  query += ' ORDER BY created_at DESC LIMIT 100';
  const rows = db.prepare(query).all(...params) as any[];

  const triageResults: TriageResult[] = rows.map(mapRowToTriageResult);
  res.json({ triageResults });
});

/**
 * GET /api/comm/connectors/:accountId/triage-settings
 * Get triage settings for an account.
 */
router.get('/connectors/:accountId/triage-settings', (_req, res) => {
  const { accountId } = _req.params;
  const db = getDb();

  const row = db.prepare(
    'SELECT triage_enabled, triage_filter_commercial, triage_auto_instruction FROM connectors WHERE id = ?'
  ).get(accountId) as any;

  if (!row) {
    res.status(404).json({ error: 'Connector not found' });
    return;
  }

  const settings: TriageSettings = {
    triageEnabled: row.triage_enabled === 1,
    filterCommercial: row.triage_filter_commercial !== 0,
    autoInstruction: row.triage_auto_instruction ?? null,
  };

  res.json({ settings });
});

/**
 * PUT /api/comm/connectors/:accountId/triage-settings
 * Update triage settings for an account.
 */
router.put('/connectors/:accountId/triage-settings', (_req, res) => {
  const { accountId } = _req.params;
  const { triageEnabled, filterCommercial, autoInstruction } = _req.body;
  const db = getDb();

  const existing = db.prepare('SELECT id FROM connectors WHERE id = ?').get(accountId);
  if (!existing) {
    res.status(404).json({ error: 'Connector not found' });
    return;
  }

  db.prepare(
    `UPDATE connectors
     SET triage_enabled = ?,
         triage_filter_commercial = ?,
         triage_auto_instruction = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(
    triageEnabled ? 1 : 0,
    filterCommercial !== false ? 1 : 0,
    autoInstruction ?? null,
    Date.now(),
    accountId
  );

  res.json({ ok: true });
});

function mapRowToTriageResult(row: any): TriageResult {
  return {
    id: row.id,
    accountId: row.account_id,
    messageId: row.message_id,
    threadId: row.thread_id,
    senderId: row.sender_id ?? null,
    senderName: row.sender_name ?? null,
    senderRole: row.sender_role ?? 'unknown',
    importance: row.importance ?? 'normal',
    isCommercial: row.is_commercial === 1,
    suggestedAction: row.suggested_action ?? 'skip',
    reasoning: row.reasoning ?? null,
    draftId: row.draft_id ?? null,
    createdAt: row.created_at,
  };
}

export default router;
