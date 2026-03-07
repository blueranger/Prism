import {
  Message,
  MessageRole,
  BuiltContext,
  MODELS,
  RECENT_MESSAGES_VERBATIM,
  CROSS_SESSION_TOKEN_BUDGET_RATIO,
} from '@prism/shared';
import { getSessionMessages, getSessionSummaries } from './conversation';
import { computeBudget, estimateMessageTokens } from './token-estimator';
import { getLinkedSessionIds } from './session';
import { getDecisionsSystemPrompt } from './decision';
import { getContextSources, getNotionPage } from './notion-store';
import { getDb } from './db';

interface BuildOptions {
  sessionId: string;
  /** The model this context will be sent to */
  targetModel: string;
  /** If set, inject a handoff system message */
  handoff?: {
    fromModel: string;
    instruction?: string;
  };
  /** Include summarized context from linked sessions (default: true) */
  includeLinkedSessions?: boolean;
}

/**
 * Context Builder — assembles the messages array for an LLM API call.
 *
 * Strategy:
 *  1. Compute token budget for the target model
 *  2. Load all session messages from DB
 *  3. Always include the N most-recent messages verbatim
 *  4. For older messages, use stored summaries if available; otherwise
 *     build a naive inline summary (collapse into a single system message)
 *  5. If this is a handoff, prepend a system message with attribution
 *  6. Return the assembled messages array + metadata
 */
export function buildContext(opts: BuildOptions): BuiltContext {
  const { sessionId, targetModel, handoff } = opts;
  const budget = computeBudget(targetModel);

  const allMessages = getSessionMessages(sessionId);
  const summaries = getSessionSummaries(sessionId);

  if (allMessages.length === 0) {
    return { messages: [], tokenEstimate: 0, summarizedCount: 0, totalMessages: 0 };
  }

  // Split messages: recent (verbatim) vs older (candidates for summarization)
  const recentCount = Math.min(RECENT_MESSAGES_VERBATIM, allMessages.length);
  const olderMessages = allMessages.slice(0, allMessages.length - recentCount);
  const recentMessages = allMessages.slice(allMessages.length - recentCount);

  const result: { role: MessageRole; content: string }[] = [];
  let tokenEstimate = 0;
  let summarizedCount = 0;

  // Reserve space for handoff system message if needed
  let handoffSystemTokens = 0;
  if (handoff) {
    const fromDisplay = MODELS[handoff.fromModel]?.displayName ?? handoff.fromModel;
    const handoffText = buildHandoffSystemMessage(fromDisplay, handoff.instruction);
    handoffSystemTokens = estimateMessageTokens('system', handoffText);
  }

  let availableForHistory = budget.available - handoffSystemTokens;

  // --- Cross-session linked context ---
  let linkedContextMsg: { role: MessageRole; content: string } | null = null;
  let linkedContextTokens = 0;

  if (opts.includeLinkedSessions !== false) {
    linkedContextMsg = buildLinkedSessionContext(
      sessionId,
      Math.floor(availableForHistory * CROSS_SESSION_TOKEN_BUDGET_RATIO)
    );
    if (linkedContextMsg) {
      linkedContextTokens = estimateMessageTokens('system', linkedContextMsg.content);
      availableForHistory -= linkedContextTokens;
    }
  }

  // --- Phase A0: Inject Notion context sources ---
  let notionContextMsgs: { role: MessageRole; content: string }[] = [];
  let notionContextTokens = 0;

  {
    const sources = getContextSources(sessionId);
    if (sources.length > 0) {
      // Allocate up to 25% of available budget for Notion sources
      const notionBudget = Math.floor(availableForHistory * 0.25);
      let notionUsed = 0;

      for (const source of sources) {
        if (source.sourceType !== 'notion_page') continue;
        const page = getNotionPage(source.sourceId);
        if (!page?.contentMd) continue;

        const dateStr = page.lastEditedAt
          ? new Date(page.lastEditedAt).toISOString().split('T')[0]
          : 'unknown';
        const notionContent = `[Notion Source: "${page.title}" — last updated ${dateStr}]\n${page.contentMd}`;
        const tokens = estimateMessageTokens('system', notionContent);

        if (notionUsed + tokens > notionBudget) break;

        notionContextMsgs.push({ role: 'system', content: notionContent });
        notionUsed += tokens;
      }

      notionContextTokens = notionUsed;
      availableForHistory -= notionContextTokens;
    }
  }

  // --- Phase A0b: Inject uploaded file content ---
  let fileContextMsgs: { role: MessageRole; content: string }[] = [];
  let fileContextTokens = 0;

  {
    const db = getDb();
    const files = db.prepare(
      "SELECT * FROM uploaded_files WHERE session_id = ? AND status = 'done' ORDER BY created_at ASC"
    ).all(sessionId) as any[];

    if (files.length > 0) {
      // Allocate up to 20% of available budget for uploaded files
      const fileBudget = Math.floor(availableForHistory * 0.20);
      let fileUsed = 0;

      for (const file of files) {
        const parts: string[] = [];
        parts.push(`[Uploaded File: "${file.filename}" — type: ${file.mime_type}${file.analyzed_by ? `, analyzed by ${file.analyzed_by}` : ''}]`);

        if (file.summary) {
          parts.push(`Summary: ${file.summary}`);
        }

        if (file.extracted_text) {
          // Include extracted text, truncated to fit budget
          const maxTextChars = 10000;
          const truncated = file.extracted_text.length > maxTextChars
            ? file.extracted_text.slice(0, maxTextChars) + '\n[... text truncated]'
            : file.extracted_text;
          parts.push(`\nExtracted Content:\n${truncated}`);
        }

        const fileContent = parts.join('\n');
        const tokens = estimateMessageTokens('system', fileContent);

        if (fileUsed + tokens > fileBudget) break;

        fileContextMsgs.push({ role: 'system', content: fileContent });
        fileUsed += tokens;
      }

      fileContextTokens = fileUsed;
      availableForHistory -= fileContextTokens;
    }
  }

  // --- Phase A: Estimate recent messages tokens ---
  let recentTokens = 0;
  for (const msg of recentMessages) {
    recentTokens += estimateMessageTokens(msg.role, msg.content);
  }

  // --- Phase B: Handle older messages ---
  const availableForOlder = availableForHistory - recentTokens;

  if (olderMessages.length > 0 && availableForOlder > 0) {
    // Check if we have a stored summary covering the older range
    const oldestTs = olderMessages[0].timestamp;
    const newestOlderTs = olderMessages[olderMessages.length - 1].timestamp;

    const applicableSummary = summaries.find(
      (s) => s.fromTimestamp <= oldestTs && s.toTimestamp >= newestOlderTs
    );

    if (applicableSummary) {
      // Use the stored summary
      const summaryTokens = estimateMessageTokens('system', applicableSummary.content);
      if (summaryTokens <= availableForOlder) {
        result.push({ role: 'system', content: applicableSummary.content });
        tokenEstimate += summaryTokens;
        summarizedCount = olderMessages.length;
      }
      // If summary itself is too large, skip it (only include recent)
    } else {
      // No stored summary — try to fit older messages verbatim, most-recent-first
      const olderToInclude: Message[] = [];
      let olderTokens = 0;

      for (let i = olderMessages.length - 1; i >= 0; i--) {
        const msg = olderMessages[i];
        const msgTokens = estimateMessageTokens(msg.role, msg.content);
        if (olderTokens + msgTokens > availableForOlder) {
          break;
        }
        olderToInclude.unshift(msg);
        olderTokens += msgTokens;
      }

      const droppedCount = olderMessages.length - olderToInclude.length;

      if (droppedCount > 0) {
        // Add a note about omitted messages
        const noteContent = `[${droppedCount} earlier messages omitted for context window limits]`;
        const noteTokens = estimateMessageTokens('system', noteContent);
        result.push({ role: 'system', content: noteContent });
        tokenEstimate += noteTokens;
        summarizedCount = droppedCount;
      }

      for (const msg of olderToInclude) {
        result.push(formatMessage(msg));
        tokenEstimate += estimateMessageTokens(msg.role, msg.content);
      }
    }
  } else if (olderMessages.length > 0) {
    // No room for any older messages
    summarizedCount = olderMessages.length;
    const noteContent = `[${olderMessages.length} earlier messages omitted for context window limits]`;
    const noteTokens = estimateMessageTokens('system', noteContent);
    result.push({ role: 'system', content: noteContent });
    tokenEstimate += noteTokens;
  }

  // --- Phase C: Add recent messages verbatim ---
  for (const msg of recentMessages) {
    result.push(formatMessage(msg));
    tokenEstimate += estimateMessageTokens(msg.role, msg.content);
  }

  // --- Phase D: Prepend handoff system message ---
  if (handoff) {
    const fromDisplay = MODELS[handoff.fromModel]?.displayName ?? handoff.fromModel;
    const handoffText = buildHandoffSystemMessage(fromDisplay, handoff.instruction);
    result.unshift({ role: 'system', content: handoffText });
    tokenEstimate += handoffSystemTokens;
  }

  // --- Phase E: Insert linked session context ---
  if (linkedContextMsg) {
    // Insert after handoff message (index 1) or at the start (index 0)
    const insertIdx = handoff ? 1 : 0;
    result.splice(insertIdx, 0, linkedContextMsg);
    tokenEstimate += linkedContextTokens;
  }

  // --- Phase E2: Insert Notion context sources ---
  if (notionContextMsgs.length > 0) {
    const insertIdx = handoff ? (linkedContextMsg ? 2 : 1) : (linkedContextMsg ? 1 : 0);
    result.splice(insertIdx, 0, ...notionContextMsgs);
    tokenEstimate += notionContextTokens;
  }

  // --- Phase E3: Insert uploaded file content ---
  if (fileContextMsgs.length > 0) {
    // Insert after existing context sources
    const baseIdx = handoff ? 1 : 0;
    const offset = (linkedContextMsg ? 1 : 0) + notionContextMsgs.length;
    result.splice(baseIdx + offset, 0, ...fileContextMsgs);
    tokenEstimate += fileContextTokens;
  }

  // --- Phase F: Prepend decision memory (user preferences & observations) ---
  const decisionPrompt = getDecisionsSystemPrompt();
  if (decisionPrompt) {
    const decisionTokens = estimateMessageTokens('system', decisionPrompt);
    result.unshift({ role: 'system', content: decisionPrompt });
    tokenEstimate += decisionTokens;
  }

  // --- Safety: If still over budget, trim from the front ---
  while (tokenEstimate > budget.available && result.length > 1) {
    const removed = result.splice(handoff ? 1 : 0, 1)[0];
    tokenEstimate -= estimateMessageTokens(removed.role, removed.content);
    summarizedCount++;
  }

  return {
    messages: result,
    tokenEstimate,
    summarizedCount,
    totalMessages: allMessages.length,
  };
}

/**
 * Build context specifically for a handoff — includes cross-model attribution.
 */
export function buildHandoffContext(
  sessionId: string,
  fromModel: string,
  toModel: string,
  instruction?: string
): BuiltContext {
  return buildContext({
    sessionId,
    targetModel: toModel,
    handoff: { fromModel, instruction },
  });
}

/**
 * Build context for a regular (non-handoff) prompt in a continuing session.
 */
export function buildSessionContext(
  sessionId: string,
  targetModel: string
): BuiltContext {
  return buildContext({ sessionId, targetModel, includeLinkedSessions: true });
}

// --- Helpers ---

function formatMessage(msg: Message): { role: MessageRole; content: string } {
  // For cross-model messages, add attribution so the target model knows the source
  if (msg.role === 'assistant' && msg.sourceModel) {
    const display = MODELS[msg.sourceModel]?.displayName ?? msg.sourceModel;
    return {
      role: 'assistant',
      content: `[${display}]: ${msg.content}`,
    };
  }
  return { role: msg.role, content: msg.content };
}

/**
 * Build a system message summarizing context from linked sessions.
 * Allocates the given token budget evenly across linked sessions.
 */
function buildLinkedSessionContext(
  sessionId: string,
  availableTokens: number
): { role: MessageRole; content: string } | null {
  if (availableTokens <= 0) return null;

  const linkedIds = getLinkedSessionIds(sessionId);
  if (linkedIds.length === 0) return null;

  const perSessionBudget = Math.floor(availableTokens / linkedIds.length);
  const sections: string[] = [];

  for (const linkedId of linkedIds) {
    const messages = getSessionMessages(linkedId);
    if (messages.length === 0) continue;

    const lines: string[] = [];
    let tokensUsed = 0;

    for (const msg of messages) {
      const display = msg.role === 'assistant'
        ? (MODELS[msg.sourceModel]?.displayName ?? msg.sourceModel)
        : 'User';
      const truncated = msg.content.slice(0, 200);
      const line = `- ${display}: ${truncated}`;
      const lineTokens = estimateMessageTokens('system', line);

      if (tokensUsed + lineTokens > perSessionBudget) break;
      lines.push(line);
      tokensUsed += lineTokens;
    }

    if (lines.length > 0) {
      sections.push(`[Session ${linkedId.slice(0, 8)}]\n${lines.join('\n')}`);
    }
  }

  if (sections.length === 0) return null;

  const content =
    'The following is summarized context from linked sessions for reference:\n\n' +
    sections.join('\n\n');

  return { role: 'system', content };
}

function buildHandoffSystemMessage(fromModelDisplay: string, instruction?: string): string {
  let text = `You are continuing a task handed off from ${fromModelDisplay}. `;
  text += `The conversation history below includes messages from multiple AI models. `;
  text += `Messages from other models are prefixed with [ModelName]. `;
  text += `Continue the conversation naturally, building on the existing context.`;

  if (instruction) {
    text += `\n\nThe user's instruction for this handoff: ${instruction}`;
  }

  return text;
}
