import { v4 as uuid } from 'uuid';
import type { AgentInputSchema, AgentResult, CommProvider } from '@prism/shared';
import { BaseAgent, type MemoryContext } from './base';
import { agentRegistry } from './registry';
import { getDb } from '../memory/db';
import { collectSingle, type ChatMessage } from '../services/llm-service';
import { listDecisions } from '../memory/decision';
import { broadcast } from '../services/ws';

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/**
 * EmailTriageAgent — triages a batch of incoming external messages and classifies them.
 *
 * Flow:
 * 1. Load messages from DB by their IDs
 * 2. Pre-filter obvious commercial emails (newsletter, marketing, noreply, etc.)
 * 3. Skip messages that already have triage results
 * 4. Load connector persona from connectors table
 * 5. Build system prompt with LLM classification criteria
 * 6. Call LLM with batch of messages — request JSON array response
 * 7. Parse JSON response into classifications
 * 8. For each message where suggestedAction === 'auto_draft':
 *    - Invoke ReplyDraftAgent to generate draft
 * 9. Persist ALL triage results to triage_results table
 * 10. Broadcast WebSocket notification
 */
class EmailTriageAgent extends BaseAgent {
  name = 'email-triage';
  description =
    'Triage a batch of incoming emails and classify them by importance, sender role, and suggested action (auto-draft, manual-reply, or skip).';

  inputSchema: AgentInputSchema = {
    type: 'object',
    properties: {
      accountId: {
        type: 'string',
        description: 'Account ID for multi-account support',
      },
      provider: {
        type: 'string',
        description: 'Communication provider (outlook, teams, line)',
      },
      messageIds: {
        type: 'array',
        description: 'List of message IDs to triage',
      },
      filterCommercial: {
        type: 'boolean',
        description:
          'Skip obvious commercial/automated emails (newsletters, marketing)',
      },
      autoReplyInstruction: {
        type: 'string',
        description:
          'Custom instruction for auto-drafted replies (e.g. "keep it brief")',
      },
      model: {
        type: 'string',
        description: 'LLM model to use for classification',
      },
    },
    required: ['accountId', 'provider', 'messageIds'],
  };

  async execute(
    input: Record<string, unknown>,
    _context: MemoryContext
  ): Promise<AgentResult> {
    const accountId = input.accountId as string;
    const provider = input.provider as CommProvider;
    const messageIds = input.messageIds as string[];
    const filterCommercial = (input.filterCommercial as boolean) ?? true;
    const autoReplyInstruction = (input.autoReplyInstruction as string) ?? null;
    const model = (input.model as string) ?? DEFAULT_MODEL;

    const log: string[] = [];
    const db = getDb();

    // 1. Load messages from DB
    if (messageIds.length === 0) {
      return this.fail('No message IDs provided');
    }

    log.push(`Loading ${messageIds.length} messages from external_messages`);

    const placeholders = messageIds.map(() => '?').join(',');
    const messages = db.prepare(
      `SELECT * FROM external_messages
       WHERE id IN (${placeholders}) AND account_id = ?
       ORDER BY timestamp ASC`
    ).all(...messageIds, accountId) as any[];

    if (messages.length === 0) {
      return this.fail('No messages found with given IDs');
    }

    log.push(`Loaded ${messages.length} messages`);

    // 2. Pre-filter obvious commercial emails
    const commercialKeywords = [
      'noreply', 'no-reply', 'newsletter', 'marketing', 'promotions',
      'unsubscribe', 'mailer-daemon', 'notification', 'alert@',
    ];
    const commercialSubjectKeywords = [
      'unsubscribe', 'newsletter', 'promotion', 'advertising', '取消訂閱',
    ];

    const preFiltered: Array<{
      message: any;
      isCommercial: boolean;
      reason?: string;
    }> = messages.map((msg) => {
      if (!filterCommercial) {
        return { message: msg, isCommercial: false };
      }

      const senderEmail = (msg.sender_email || '').toLowerCase();
      const subject = (msg.subject || '').toLowerCase();

      for (const kw of commercialKeywords) {
        if (senderEmail.includes(kw)) {
          return {
            message: msg,
            isCommercial: true,
            reason: `Sender email contains "${kw}"`,
          };
        }
      }

      for (const kw of commercialSubjectKeywords) {
        if (subject.includes(kw)) {
          return {
            message: msg,
            isCommercial: true,
            reason: `Subject contains "${kw}"`,
          };
        }
      }

      return { message: msg, isCommercial: false };
    });

    const commercialCount = preFiltered.filter((m) => m.isCommercial).length;
    log.push(`Pre-filtered ${commercialCount} obvious commercial emails`);

    // 3. Skip messages that already have triage results
    const nonCommercial = preFiltered.filter((m) => !m.isCommercial);
    const existingTriages = db.prepare(
      `SELECT message_id FROM triage_results WHERE account_id = ? AND message_id IN (${nonCommercial.map(() => '?').join(',')})`
    ).all(accountId, ...nonCommercial.map((m) => m.message.id)) as { message_id: string }[];

    const existingIds = new Set(existingTriages.map((t) => t.message_id));
    const toTriage = nonCommercial.filter(
      (m) => !existingIds.has(m.message.id)
    );

    log.push(
      `Skipped ${existingIds.size} messages that already have triage results`
    );

    if (toTriage.length === 0) {
      log.push('No new messages to triage');
      return this.ok('All messages already triaged or filtered', { log });
    }

    log.push(`Triaging ${toTriage.length} messages with LLM`);

    // 4. Load connector persona
    let persona: string | null = null;
    const connectorRow = db
      .prepare('SELECT persona FROM connectors WHERE id = ?')
      .get(accountId) as { persona: string | null } | undefined;
    persona = connectorRow?.persona ?? null;
    if (persona) {
      log.push(`Using account persona: ${persona}`);
    }

    // 5. Load Decision Memory for triage preferences
    const decisionOverrides = getTriageDecisionOverrides();
    if (decisionOverrides) {
      log.push('Applied Decision Memory triage preferences');
    }

    // 6. Build system prompt
    const systemPrompt = buildTriageSystemPrompt(
      persona,
      decisionOverrides
    );

    // 7. Build user message with messages to triage
    const userMessage = buildTriageUserMessage(toTriage.map((m) => m.message));

    const chatMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    log.push(`Calling ${model} to classify messages`);

    // 8. Call LLM
    const { content: responseContent, error } = await collectSingle(
      model,
      chatMessages
    );

    if (error || !responseContent.trim()) {
      return this.fail(error ?? 'LLM returned empty response', log);
    }

    log.push(`LLM response received (${responseContent.length} chars)`);

    // 9. Parse JSON response
    let triageResults: Array<{
      messageId: string;
      senderRole: string;
      importance: string;
      isCommercial: boolean;
      suggestedAction: string;
      reasoning: string;
    }>;

    try {
      const jsonMatch = responseContent.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('No JSON array found in response');
      }
      triageResults = JSON.parse(jsonMatch[0]);
      log.push(`Parsed triage results for ${triageResults.length} messages`);
    } catch (parseErr) {
      log.push(`JSON parsing failed: ${String(parseErr)}`);
      // Fallback: mark all as 'manual_reply'
      triageResults = toTriage.map((m) => ({
        messageId: m.message.id,
        senderRole: 'unknown',
        importance: 'normal',
        isCommercial: false,
        suggestedAction: 'manual_reply',
        reasoning: 'Classification failed; manual review recommended',
      }));
    }

    // 10. For each 'auto_draft' message, invoke ReplyDraftAgent
    let draftsGenerated = 0;
    const draftResults: Array<{ messageId: string; draftId: string }> = [];

    for (const triage of triageResults) {
      if (triage.suggestedAction === 'auto_draft') {
        try {
          const msg = toTriage.find((m) => m.message.id === triage.messageId)
            ?.message;
          if (!msg) continue;

          const threadId = msg.thread_id;

          // Invoke ReplyDraftAgent
          const replyAgent = agentRegistry.get('reply-draft');
          if (!replyAgent) {
            log.push(
              `Warning: reply-draft agent not found for message ${triage.messageId}`
            );
            continue;
          }

          const draftInput = {
            threadId,
            messageId: triage.messageId,
            provider,
            accountId,
            instruction: autoReplyInstruction,
            model,
          };

          const draftResult = await replyAgent.execute(draftInput, _context);
          if (draftResult.success) {
            // Extract draft ID from the newly created draft_replies row
            const draftRow = db
              .prepare(
                `SELECT id FROM draft_replies
                 WHERE message_id = ? AND account_id = ?
                 ORDER BY created_at DESC
                 LIMIT 1`
              )
              .get(triage.messageId, accountId) as { id: string } | undefined;

            if (draftRow) {
              draftResults.push({
                messageId: triage.messageId,
                draftId: draftRow.id,
              });
              draftsGenerated++;
              log.push(
                `Auto-drafted reply for message ${triage.messageId} (draft=${draftRow.id})`
              );
            }
          } else {
            log.push(
              `Failed to draft reply for message ${triage.messageId}: ${draftResult.output}`
            );
          }
        } catch (err) {
          log.push(`Error auto-drafting message ${triage.messageId}: ${String(err)}`);
        }
      }
    }

    // 11. Persist ALL triage results (commercial + LLM-classified)
    const now = Date.now();
    const insertStmt = db.prepare(
      `INSERT OR REPLACE INTO triage_results
       (id, account_id, message_id, thread_id, sender_id, sender_name, sender_role, importance, is_commercial, suggested_action, reasoning, draft_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const txn = db.transaction(() => {
      // Insert pre-filtered commercial messages
      for (const preFilt of preFiltered.filter((m) => m.isCommercial)) {
        const msg = preFilt.message;
        insertStmt.run(
          uuid(),
          accountId,
          msg.id,
          msg.thread_id,
          msg.sender_id,
          msg.sender_name,
          'unknown',
          'low',
          1, // is_commercial = true
          'skip',
          preFilt.reason || 'Commercial email',
          null,
          now
        );
      }

      // Insert LLM-triaged messages
      for (const triage of triageResults) {
        const msg = toTriage.find((m) => m.message.id === triage.messageId)
          ?.message;
        if (!msg) continue;

        const draftId = draftResults.find(
          (d) => d.messageId === triage.messageId
        )?.draftId ?? null;

        insertStmt.run(
          uuid(),
          accountId,
          triage.messageId,
          msg.thread_id,
          msg.sender_id,
          msg.sender_name,
          triage.senderRole,
          triage.importance,
          triage.isCommercial ? 1 : 0,
          triage.suggestedAction,
          triage.reasoning,
          draftId,
          now
        );
      }
    });

    txn();

    const totalTriaged = preFiltered.length;
    log.push(
      `Persisted triage results for ${totalTriaged} messages (${draftsGenerated} auto-drafted)`
    );

    // 12. Broadcast WebSocket notification
    broadcastTriageComplete(accountId, totalTriaged, draftsGenerated);

    return this.ok(
      `Triaged ${totalTriaged} messages (${draftsGenerated} auto-drafted)`,
      { log }
    );
  }
}

/**
 * Query Decision Memory for triage-related preferences.
 */
function getTriageDecisionOverrides(): string | null {
  const decisions = listDecisions(true);
  const prefs = decisions.filter((d) => d.type === 'preference');

  const triageKeywords = [
    'triage', 'auto-draft', 'auto-reply', 'importance', 'priority',
    'vip', 'urgent', 'important', 'normal', 'low',
    'senderrole', 'seller role', 'classification',
    'email', 'message', 'communication',
  ];

  const relevant = prefs.filter((p) => {
    const lower = p.content.toLowerCase();
    return triageKeywords.some((kw) => lower.includes(kw));
  });

  if (relevant.length === 0) return null;

  const lines = relevant.map((p) => `- ${p.content}`);
  return 'User preferences (from Decision Memory):\n' + lines.join('\n');
}

/**
 * Build system prompt for email triage classification.
 */
function buildTriageSystemPrompt(
  persona: string | null,
  decisionOverrides: string | null
): string {
  const parts: string[] = [];

  let basePrompt =
    'You are an email triage assistant. Analyze each incoming email and classify it.\n\n' +
    'For each email, determine:\n' +
    '1. senderRole: "ceo" | "manager" | "colleague" | "client" | "vendor" | "external" | "unknown"\n' +
    '   - Infer from sender name, email domain, and message context\n' +
    '2. importance: "urgent" | "important" | "normal" | "low"\n' +
    '   - urgent = needs immediate response (deadlines, escalations, direct requests from leadership)\n' +
    '   - important = should respond within hours (work requests, client queries)\n' +
    '   - normal = respond when convenient (general discussion, FYIs)\n' +
    '   - low = informational only (automated notifications, CC\'d messages)\n' +
    '3. isCommercial: true if newsletter, marketing, promotion, or automated notification\n' +
    '4. suggestedAction: "auto_draft" | "manual_reply" | "skip"\n' +
    '   - auto_draft: important emails from known contacts that need a substantive reply\n' +
    '   - manual_reply: emails that need reply but are complex/sensitive (user should handle)\n' +
    '   - skip: no reply needed (newsletters, FYIs, CC-only, automated)\n' +
    '5. reasoning: Brief explanation of your classification\n\n' +
    'Respond with a JSON array. Example:\n' +
    '[\n' +
    '  { "messageId": "123", "senderRole": "colleague", "importance": "important", "isCommercial": false, "suggestedAction": "auto_draft", "reasoning": "Direct request from team member" }\n' +
    ']\n';

  if (persona) {
    basePrompt += `\nYou are triaging emails for: ${persona}`;
  }

  parts.push(basePrompt);

  // Decision Memory overrides
  if (decisionOverrides) {
    parts.push(
      '\n--- USER PREFERENCES (DECISION MEMORY) ---\n' + decisionOverrides
    );
  }

  return parts.join('\n');
}

/**
 * Build user message with messages to triage.
 */
function buildTriageUserMessage(messages: any[]): string {
  const parts: string[] = ['Messages to triage:\n'];

  for (const msg of messages) {
    const timestamp = new Date(msg.timestamp).toISOString();
    const contentPreview = msg.content.length > 500
      ? msg.content.slice(0, 500) + '...'
      : msg.content;

    parts.push(
      `[Message ID: ${msg.id}]\n` +
      `From: ${msg.sender_name} <${msg.sender_email || 'unknown'}>\n` +
      `Subject: ${msg.subject || '(no subject)'}\n` +
      `Date: ${timestamp}\n` +
      `Content: ${contentPreview}\n`
    );
  }

  return parts.join('\n');
}

/**
 * Broadcast a triage completion event to WebSocket clients.
 */
function broadcastTriageComplete(
  accountId: string,
  totalTriaged: number,
  draftsGenerated: number
): void {
  try {
    broadcast({
      type: 'comm:triageComplete',
      accountId,
      totalTriaged,
      draftsGenerated,
      timestamp: Date.now(),
    });
  } catch {
    // Silently fail if broadcast not available
  }
}

// --- Self-register ---
const emailTriageAgent = new EmailTriageAgent();
agentRegistry.register(emailTriageAgent);

export { emailTriageAgent };
