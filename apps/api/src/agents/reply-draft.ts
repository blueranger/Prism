import { v4 as uuid } from 'uuid';
import type { AgentInputSchema, AgentResult, CommProvider } from '@prism/shared';
import { BaseAgent, type MemoryContext } from './base';
import { agentRegistry } from './registry';
import { getDb } from '../memory/db';
import { collectSingle, type ChatMessage } from '../services/llm-service';
import { buildStyleGuidance } from '../services/reply-analyzer';
import { listDecisions } from '../memory/decision';

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/**
 * ReplyDraftAgent — generates AI-drafted replies to external messages.
 *
 * Flow:
 * 1. Load thread messages from external_messages
 * 2. Query reply_learning via reply-analyzer for sender patterns
 * 3. Check Decision Memory for tone/style overrides
 * 4. Build system prompt with thread context + learned style + decisions + user instruction
 * 5. Call LLM (default Claude Sonnet) to generate draft
 * 6. Save to draft_replies table with status='pending'
 */
class ReplyDraftAgent extends BaseAgent {
  name = 'reply-draft';
  description =
    'Draft a reply to an external message thread using AI. Learns from past reply patterns to match your style.';

  inputSchema: AgentInputSchema = {
    type: 'object',
    properties: {
      threadId: { type: 'string', description: 'Internal thread ID' },
      messageId: {
        type: 'string',
        description: 'ID of the message to reply to (optional, defaults to latest inbound)',
      },
      provider: { type: 'string', description: 'Communication provider (outlook, teams, line)' },
      accountId: { type: 'string', description: 'Account ID for multi-account support' },
      tone: { type: 'string', description: 'Desired tone (e.g. professional, casual, brief)' },
      language: { type: 'string', description: 'Reply language (e.g. English, Chinese, Japanese, or "auto" to match incoming message)' },
      model: { type: 'string', description: 'LLM model to use for drafting' },
      instruction: {
        type: 'string',
        description: 'Additional instruction for the reply (e.g. "politely decline this meeting")',
      },
    },
    required: ['threadId', 'provider'],
  };

  async execute(
    input: Record<string, unknown>,
    _context: MemoryContext
  ): Promise<AgentResult> {
    const threadId = input.threadId as string;
    const provider = input.provider as CommProvider;
    const accountId = (input.accountId as string) ?? null;
    const tone = (input.tone as string) ?? null;
    const language = (input.language as string) ?? null;
    const model = (input.model as string) ?? DEFAULT_MODEL;
    const instruction = (input.instruction as string) ?? null;
    let messageId = (input.messageId as string) ?? null;

    const log: string[] = [];

    // 1. Load thread messages (prefer account_id, fall back to provider)
    const db = getDb();
    const threadMessages = accountId
      ? db.prepare(
          `SELECT * FROM external_messages
           WHERE thread_id = ? AND account_id = ?
           ORDER BY timestamp ASC`
        ).all(threadId, accountId) as any[]
      : db.prepare(
          `SELECT * FROM external_messages
           WHERE thread_id = ? AND provider = ?
           ORDER BY timestamp ASC`
        ).all(threadId, provider) as any[];

    if (threadMessages.length === 0) {
      return this.fail('No messages found in thread', [
        'Loaded 0 messages for thread',
      ]);
    }

    log.push(`Loaded ${threadMessages.length} messages from thread`);

    // Determine which message we're replying to
    if (!messageId) {
      const latestInbound = [...threadMessages]
        .reverse()
        .find((m) => m.is_inbound === 1);
      if (!latestInbound) {
        return this.fail('No inbound message found to reply to');
      }
      messageId = latestInbound.id;
    }

    const targetMessage = threadMessages.find((m) => m.id === messageId);
    if (!targetMessage) {
      return this.fail(`Message ${messageId} not found in thread`);
    }

    log.push(`Replying to message from ${targetMessage.sender_name}`);

    // 2. Get learned style guidance from reply-analyzer
    const styleGuidance = buildStyleGuidance(provider, targetMessage.sender_id);
    if (styleGuidance) {
      log.push('Loaded learned reply style for this sender');
    } else {
      log.push('No learned reply patterns for this sender');
    }

    // 3. Read persona from connector
    let persona: string | null = null;
    if (accountId) {
      const connectorRow = db.prepare('SELECT persona FROM connectors WHERE id = ?').get(accountId) as { persona: string | null } | undefined;
      persona = connectorRow?.persona ?? null;
      if (persona) {
        log.push(`Using account persona: ${persona}`);
      }
    }

    // 4. Check Decision Memory for reply-related preferences
    const decisionOverrides = getReplyDecisionOverrides();
    if (decisionOverrides) {
      log.push('Applied Decision Memory preferences');
    }

    // 5. Build system prompt
    const systemPrompt = buildSystemPrompt(
      threadMessages,
      targetMessage,
      styleGuidance,
      decisionOverrides,
      tone,
      language,
      persona,
      instruction
    );

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content:
          `Draft a reply to the following message:\n\n"${targetMessage.content}"\n\n` +
          `Remember: if the message asks about something you cannot know (user's location, status, plans, ETA, etc.), ` +
          `use [placeholder] brackets for unknown facts so the user can fill them in before sending.`,
      },
    ];

    log.push(`Calling ${model} to generate draft`);

    // 6. Call LLM
    const { content: draftContent, error } = await collectSingle(model, messages);

    if (error || !draftContent.trim()) {
      return this.fail(error ?? 'LLM returned empty response', log);
    }

    log.push(`Draft generated (${draftContent.length} chars)`);

    // 7. Save to draft_replies
    const now = Date.now();
    const draftId = uuid();

    db.prepare(
      `INSERT INTO draft_replies
       (id, thread_id, message_id, provider, account_id, draft_content, model_used, tone, language, instruction, status, triggered_by, sent_at, user_edit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)`
    ).run(
      draftId,
      threadId,
      messageId,
      provider,
      accountId,
      draftContent.trim(),
      model,
      tone,
      language,
      instruction,
      'agent',
      now,
      now
    );

    log.push(`Draft saved with id=${draftId}, status=pending`);

    return this.ok(draftContent.trim(), { log });
  }
}

/**
 * Query Decision Memory for reply-related preferences.
 * Looks for active preferences mentioning reply, tone, style, email, or communication keywords.
 */
function getReplyDecisionOverrides(): string | null {
  const decisions = listDecisions(true);
  const prefs = decisions.filter((d) => d.type === 'preference');

  const replyKeywords = [
    'reply', 'respond', 'tone', 'style', 'email', 'communication',
    'formal', 'casual', 'friendly', 'professional', 'brief', 'concise',
    'verbose', 'detailed', 'sign off', 'signature', 'greeting',
    'outlook', 'teams', 'line', 'message',
  ];

  const relevant = prefs.filter((p) => {
    const lower = p.content.toLowerCase();
    return replyKeywords.some((kw) => lower.includes(kw));
  });

  if (relevant.length === 0) return null;

  const lines = relevant.map((p) => `- ${p.content}`);
  return 'User preferences (from Decision Memory — these OVERRIDE learned patterns):\n' + lines.join('\n');
}

/**
 * Build a system prompt that includes thread context, learned reply style,
 * Decision Memory overrides, and optional tone/instruction overrides.
 */
function buildSystemPrompt(
  threadMessages: any[],
  targetMessage: any,
  styleGuidance: string | null,
  decisionOverrides: string | null,
  tone: string | null,
  language: string | null,
  persona: string | null,
  instruction: string | null
): string {
  const parts: string[] = [];

  let basePrompt =
    'You are drafting a reply to an email/message on behalf of the user. ' +
    'Write ONLY the reply body — no subject line, no greeting like "Dear...", ' +
    'unless it fits the user\'s established style. Keep the reply natural and concise.\n\n' +
    'CRITICAL RULES — you MUST follow these:\n' +
    '1. NEVER fabricate facts, events, or details you do not know. You have NO knowledge of the user\'s ' +
    'real-world situation (location, schedule, plans, activities, health, travel status, etc.).\n' +
    '2. If the incoming message asks about something you cannot know (e.g. "where are you?", ' +
    '"have you arrived?", "what time will you finish?"), draft a PLACEHOLDER reply with ' +
    'brackets like [到達時間] or [your location] for the user to fill in before sending.\n' +
    '3. You may only state facts that are explicitly present in the conversation history.\n' +
    '4. When in doubt, use a safe, non-committal response and let the user edit it.\n' +
    '5. Example of WRONG reply: "還在飛行中，預計一個小時後到" (you don\'t know this)\n' +
    '   Example of CORRECT reply: "我[已到/還沒到]，[預計到達時間]再跟你說！"';

  if (persona) {
    basePrompt += `\n\nYou are replying as: ${persona}`;
  }

  parts.push(basePrompt);

  // Thread context
  const contextSnippets = threadMessages.slice(-8).map((m) => {
    const direction = m.is_inbound === 1 ? `[${m.sender_name}]` : '[You]';
    const preview =
      m.content.length > 300 ? m.content.slice(0, 300) + '...' : m.content;
    return `${direction}: ${preview}`;
  });

  parts.push(
    '\n--- CONVERSATION CONTEXT ---\n' + contextSnippets.join('\n\n')
  );

  // Learned style from reply-analyzer
  if (styleGuidance) {
    parts.push(
      '\n--- YOUR REPLY STYLE (learned from past replies to this sender) ---\n' +
        styleGuidance
    );
  }

  // Decision Memory overrides (take priority over learned patterns)
  if (decisionOverrides) {
    parts.push(
      '\n--- DECISION MEMORY OVERRIDES ---\n' + decisionOverrides
    );
  }

  // Tone override
  if (tone) {
    parts.push(`\n--- TONE ---\nUse a ${tone} tone in the reply.`);
  }

  // Language directive
  if (language && language.toLowerCase() !== 'auto') {
    parts.push(`\n--- LANGUAGE ---\nYou MUST write your reply in ${language}. This is mandatory regardless of other context.`);
  } else {
    // Auto-detect: identify the language of the incoming message and be explicit
    const detectedLang = detectLanguage(targetMessage.content);
    parts.push(
      `\n--- LANGUAGE ---\nThe incoming message is written in ${detectedLang}. ` +
      `You MUST write your reply in ${detectedLang}. This is mandatory regardless of other context.`
    );
  }

  // User instruction
  if (instruction) {
    parts.push(
      `\n--- SPECIAL INSTRUCTION ---\n${instruction}`
    );
  }

  return parts.join('\n');
}

/**
 * Simple language detection based on character analysis.
 * Checks for CJK characters, Japanese kana, Korean hangul, etc.
 * Falls back to 'English' when text is primarily Latin script.
 */
function detectLanguage(text: string): string {
  if (!text || text.trim().length === 0) return 'English';

  // Sample first 500 chars for efficiency
  const sample = text.slice(0, 500);

  // Count character types
  let cjk = 0;
  let japanese = 0; // hiragana + katakana
  let korean = 0;
  let latin = 0;
  let total = 0;

  for (const ch of sample) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x20) continue; // skip whitespace/control
    total++;

    // CJK Unified Ideographs (shared by Chinese/Japanese/Korean)
    if (code >= 0x4e00 && code <= 0x9fff) {
      cjk++;
    }
    // Hiragana
    else if (code >= 0x3040 && code <= 0x309f) {
      japanese++;
    }
    // Katakana
    else if (code >= 0x30a0 && code <= 0x30ff) {
      japanese++;
    }
    // Hangul Syllables
    else if (code >= 0xac00 && code <= 0xd7af) {
      korean++;
    }
    // Basic Latin
    else if (code >= 0x41 && code <= 0x7a) {
      latin++;
    }
  }

  if (total === 0) return 'English';

  // Japanese uses hiragana/katakana alongside CJK
  if (japanese > 0 && (japanese + cjk) / total > 0.15) return 'Japanese';
  // Korean
  if (korean / total > 0.15) return 'Korean';
  // Chinese (CJK without Japanese kana)
  if (cjk / total > 0.15) return 'Chinese';
  // Default to English for Latin-dominant text
  return 'English';
}

// --- Self-register ---
const replyDraftAgent = new ReplyDraftAgent();
agentRegistry.register(replyDraftAgent);

export { replyDraftAgent };
