import { v4 as uuid } from 'uuid';
import type {
  CommProvider,
  MonitorRule,
  MonitorRuleConditions,
  MonitorRuleActionConfig,
  MonitorAction,
  ExternalMessage,
  CommNotification,
} from '@prism/shared';
import { getDb } from '../memory/db';

// --- Rule CRUD ---

export function listRules(enabledOnly: boolean = false): MonitorRule[] {
  const db = getDb();
  const query = enabledOnly
    ? 'SELECT * FROM monitor_rules WHERE enabled = 1 ORDER BY created_at DESC'
    : 'SELECT * FROM monitor_rules ORDER BY created_at DESC';
  const rows = db.prepare(query).all() as any[];
  return rows.map(mapRowToRule);
}

export function getRule(id: string): MonitorRule | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM monitor_rules WHERE id = ?').get(id) as any;
  return row ? mapRowToRule(row) : null;
}

export function createRule(params: {
  provider: CommProvider | 'all';
  ruleName: string;
  conditions: MonitorRuleConditions;
  action: MonitorAction;
  actionConfig?: MonitorRuleActionConfig | null;
}): MonitorRule {
  const db = getDb();
  const now = Date.now();
  const id = uuid();

  db.prepare(
    `INSERT INTO monitor_rules (id, provider, rule_name, enabled, conditions, action, action_config, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.provider,
    params.ruleName,
    JSON.stringify(params.conditions),
    params.action,
    params.actionConfig ? JSON.stringify(params.actionConfig) : null,
    now,
    now
  );

  return getRule(id)!;
}

export function updateRule(
  id: string,
  update: Partial<Pick<MonitorRule, 'ruleName' | 'provider' | 'enabled' | 'conditions' | 'action' | 'actionConfig'>>
): MonitorRule | null {
  const db = getDb();
  const existing = getRule(id);
  if (!existing) return null;

  const now = Date.now();

  if (update.ruleName !== undefined) {
    db.prepare('UPDATE monitor_rules SET rule_name = ?, updated_at = ? WHERE id = ?').run(update.ruleName, now, id);
  }
  if (update.provider !== undefined) {
    db.prepare('UPDATE monitor_rules SET provider = ?, updated_at = ? WHERE id = ?').run(update.provider, now, id);
  }
  if (update.enabled !== undefined) {
    db.prepare('UPDATE monitor_rules SET enabled = ?, updated_at = ? WHERE id = ?').run(update.enabled ? 1 : 0, now, id);
  }
  if (update.conditions !== undefined) {
    db.prepare('UPDATE monitor_rules SET conditions = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(update.conditions), now, id);
  }
  if (update.action !== undefined) {
    db.prepare('UPDATE monitor_rules SET action = ?, updated_at = ? WHERE id = ?').run(update.action, now, id);
  }
  if (update.actionConfig !== undefined) {
    db.prepare('UPDATE monitor_rules SET action_config = ?, updated_at = ? WHERE id = ?').run(
      update.actionConfig ? JSON.stringify(update.actionConfig) : null,
      now,
      id
    );
  }

  return getRule(id);
}

export function deleteRule(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM monitor_rules WHERE id = ?').run(id);
  return result.changes > 0;
}

// --- Rule Evaluation Engine ---

/**
 * Match result from evaluating a single message against a single rule.
 */
export interface RuleMatch {
  rule: MonitorRule;
  message: ExternalMessage;
  threadId: string;
}

/**
 * Evaluate a single message against all enabled rules.
 * Returns matching rules. Only evaluates inbound messages.
 */
export function evaluateMessage(message: ExternalMessage): RuleMatch[] {
  if (!message.isInbound) return [];

  const rules = listRules(true);
  const matches: RuleMatch[] = [];

  for (const rule of rules) {
    // Provider filter: rule must match message provider or be 'all'
    if (rule.provider !== 'all' && rule.provider !== message.provider) {
      continue;
    }

    if (matchesConditions(rule.conditions, message)) {
      matches.push({ rule, message, threadId: message.threadId });
    }
  }

  return matches;
}

/**
 * Evaluate multiple messages against all enabled rules.
 * Used after a polling sync to process newly fetched messages.
 */
export function evaluateMessages(messages: ExternalMessage[]): RuleMatch[] {
  const inbound = messages.filter((m) => m.isInbound);
  if (inbound.length === 0) return [];

  const rules = listRules(true);
  if (rules.length === 0) return [];

  const matches: RuleMatch[] = [];

  for (const msg of inbound) {
    for (const rule of rules) {
      if (rule.provider !== 'all' && rule.provider !== msg.provider) continue;
      if (matchesConditions(rule.conditions, msg)) {
        matches.push({ rule, message: msg, threadId: msg.threadId });
      }
    }
  }

  return matches;
}

/**
 * Test a specific rule against recent messages from the DB.
 * Returns up to `limit` matches for preview/testing purposes.
 */
export function testRule(ruleId: string, limit: number = 10): RuleMatch[] {
  const rule = getRule(ruleId);
  if (!rule) return [];

  const db = getDb();

  let query = `SELECT * FROM external_messages WHERE is_inbound = 1`;
  const params: any[] = [];

  if (rule.provider !== 'all') {
    query += ' AND provider = ?';
    params.push(rule.provider);
  }

  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(100); // Check last 100 messages

  const rows = db.prepare(query).all(...params) as any[];
  const messages: ExternalMessage[] = rows.map(mapRowToMessage);

  const matches: RuleMatch[] = [];
  for (const msg of messages) {
    if (matchesConditions(rule.conditions, msg)) {
      matches.push({ rule, message: msg, threadId: msg.threadId });
      if (matches.length >= limit) break;
    }
  }

  return matches;
}

// --- Action Execution ---

/**
 * Execute the action for a rule match.
 * Returns a CommNotification if the action involves notifying the user.
 */
export async function executeAction(match: RuleMatch): Promise<CommNotification | null> {
  const { rule, message } = match;
  let draftId: string | null = null;

  // Draft reply if action requires it
  if (rule.action === 'draft_reply' || rule.action === 'draft_and_notify') {
    draftId = await triggerDraft(match);
  }

  // Build notification if action requires it
  if (rule.action === 'notify' || rule.action === 'draft_and_notify') {
    const notification: CommNotification = {
      type: 'rule_matched',
      ruleId: rule.id,
      ruleName: rule.ruleName,
      threadId: match.threadId,
      message: {
        sender: message.senderName,
        subject: message.subject,
        preview: message.content.slice(0, 100),
      },
      action: rule.action,
      draftId,
      timestamp: Date.now(),
    };
    return notification;
  }

  return null;
}

/**
 * Process all matches from a sync — execute actions and collect notifications.
 */
export async function processMatches(matches: RuleMatch[]): Promise<CommNotification[]> {
  const notifications: CommNotification[] = [];

  for (const match of matches) {
    try {
      const notification = await executeAction(match);
      if (notification) {
        notifications.push(notification);
      }
    } catch (err: any) {
      console.error(`[monitor-engine] Error executing action for rule "${match.rule.ruleName}":`, err.message);
    }
  }

  return notifications;
}

// --- Condition Matching ---

/**
 * Check if a message matches ALL conditions in a rule (AND logic).
 * Empty/undefined conditions are treated as "match all" (no restriction).
 */
function matchesConditions(conditions: MonitorRuleConditions, message: ExternalMessage): boolean {
  // keywords: content contains any of the keywords (case-insensitive)
  if (conditions.keywords && conditions.keywords.length > 0) {
    const lower = message.content.toLowerCase();
    const hasKeyword = conditions.keywords.some((kw) => lower.includes(kw.toLowerCase()));
    if (!hasKeyword) return false;
  }

  // senders: sender email or ID matches any in the list (case-insensitive)
  if (conditions.senders && conditions.senders.length > 0) {
    const senderEmail = message.senderEmail?.toLowerCase() ?? '';
    const senderId = message.senderId.toLowerCase();
    const matchesSender = conditions.senders.some((s) => {
      const lower = s.toLowerCase();
      return senderEmail === lower || senderId === lower || senderEmail.includes(lower);
    });
    if (!matchesSender) return false;
  }

  // subjectContains: subject contains any of the strings (case-insensitive)
  if (conditions.subjectContains && conditions.subjectContains.length > 0) {
    const subject = (message.subject ?? '').toLowerCase();
    const hasSubject = conditions.subjectContains.some((s) => subject.includes(s.toLowerCase()));
    if (!hasSubject) return false;
  }

  // timeRange: message timestamp hour falls within range
  if (conditions.timeRange) {
    const msgHour = new Date(message.timestamp).getHours();
    const { startHour, endHour } = conditions.timeRange;

    if (startHour <= endHour) {
      // Normal range e.g. 9-17
      if (msgHour < startHour || msgHour >= endHour) return false;
    } else {
      // Overnight range e.g. 22-6
      if (msgHour < startHour && msgHour >= endHour) return false;
    }
  }

  // isGroup: thread must be a group thread
  if (conditions.isGroup !== undefined) {
    const db = getDb();
    const thread = db.prepare('SELECT is_group FROM external_threads WHERE id = ?').get(message.threadId) as { is_group: number } | undefined;
    const isGroup = thread ? thread.is_group === 1 : false;
    if (isGroup !== conditions.isGroup) return false;
  }

  return true;
}

// --- Helpers ---

async function triggerDraft(match: RuleMatch): Promise<string | null> {
  const { rule, message } = match;

  try {
    // Lazy import to avoid circular dependencies
    const { agentRegistry } = await import('../agents/registry');
    const agent = agentRegistry.get('reply-draft');
    if (!agent) {
      console.error('[monitor-engine] ReplyDraftAgent not registered');
      return null;
    }

    const input: Record<string, unknown> = {
      threadId: message.threadId,
      messageId: message.id,
      provider: message.provider,
      accountId: message.accountId,
    };

    if (rule.actionConfig?.tone) input.tone = rule.actionConfig.tone;
    if (rule.actionConfig?.model) input.model = rule.actionConfig.model;
    if (rule.actionConfig?.instruction) input.instruction = rule.actionConfig.instruction;

    const result = await agent.execute(input, { sessionId: '', messages: [], artifacts: [] });

    if (result.success) {
      // Fetch the draft ID that was just created
      const db = getDb();
      const draft = db.prepare(
        `SELECT id FROM draft_replies WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`
      ).get(message.threadId) as { id: string } | undefined;
      return draft?.id ?? null;
    }

    console.error(`[monitor-engine] Draft failed for rule "${rule.ruleName}":`, result.output);
    return null;
  } catch (err: any) {
    console.error('[monitor-engine] Draft trigger error:', err.message);
    return null;
  }
}

function mapRowToRule(row: any): MonitorRule {
  let conditions: MonitorRuleConditions = {};
  try {
    conditions = row.conditions ? JSON.parse(row.conditions) : {};
  } catch { /* ignore */ }

  let actionConfig: MonitorRuleActionConfig | null = null;
  try {
    actionConfig = row.action_config ? JSON.parse(row.action_config) : null;
  } catch { /* ignore */ }

  return {
    id: row.id,
    provider: row.provider,
    ruleName: row.rule_name,
    enabled: row.enabled === 1,
    conditions,
    action: row.action,
    actionConfig,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRowToMessage(row: any): ExternalMessage {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch { /* ignore */ }

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
