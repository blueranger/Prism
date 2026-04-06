import {
  Message,
  MessageRole,
  BuiltContext,
  ContextBreakdownItem,
  ContextDocumentDebugItem,
  ContextDocumentReason,
  MODELS,
  RECENT_MESSAGES_VERBATIM,
  CROSS_SESSION_TOKEN_BUDGET_RATIO,
} from '@prism/shared';
import { getSessionMessages, getSessionSummaries } from './conversation';
import { computeBudget, estimateMessageTokens } from './token-estimator';
import { getLinkedSessionIds, getSession } from './session';
import { getDecisionsSystemPrompt } from './decision';
import { buildMemoryInjectionPreview } from './memory-context-service';
import { getContextSources, getNotionPage } from './notion-store';
import { getDb } from './db';
import { getWebPage } from './web-page-store';

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

  const session = getSession(sessionId);
  const isActionSession = session?.sessionType === 'action';
  const allMessages = getSessionMessages(sessionId).filter((msg) => !isActionSession || msg.role !== 'system');
  const summaries = getSessionSummaries(sessionId);

  if (allMessages.length === 0) {
    return { messages: [], tokenEstimate: 0, summarizedCount: 0, totalMessages: 0, breakdown: [], documents: [], memoryInjection: null };
  }

  // Split messages: recent (verbatim) vs older (candidates for summarization)
  const recentCount = Math.min(RECENT_MESSAGES_VERBATIM, allMessages.length);
  const olderMessages = allMessages.slice(0, allMessages.length - recentCount);
  const recentMessages = allMessages.slice(allMessages.length - recentCount);

  const result: { role: MessageRole; content: string }[] = [];
  let tokenEstimate = 0;
  let summarizedCount = 0;
  const breakdownMap = new Map<string, ContextBreakdownItem>();
  const documents: ContextDocumentDebugItem[] = [];
  let actionContextMsg: { role: MessageRole; content: string } | null = null;
  let actionContextTokens = 0;
  let memoryContextMsg: { role: MessageRole; content: string } | null = null;
  let memoryContextTokens = 0;
  let memoryInjection = null;

  const addBreakdown = (key: string, label: string, tokens: number, count = 0) => {
    if (tokens <= 0 && count <= 0) return;
    const existing = breakdownMap.get(key);
    if (existing) {
      existing.tokens += tokens;
      existing.count = (existing.count ?? 0) + count;
      return;
    }
    breakdownMap.set(key, { key, label, tokens, ...(count > 0 ? { count } : {}) });
  };

  if (isActionSession && session?.contextSnapshot) {
    actionContextMsg = {
      role: 'system',
      content: buildActionContextSystemMessage(session),
    };
    actionContextTokens = estimateMessageTokens('system', actionContextMsg.content);
    addBreakdown('action_context', 'Action context', actionContextTokens, 1);
  }

  const memoryContext = buildMemoryInjectionPreview({
    sessionId,
    model: targetModel,
    mode: handoff ? 'handoff' : session?.interactionMode ?? null,
    promptPreview: allMessages[allMessages.length - 1]?.content ?? '',
  });
  memoryInjection = memoryContext.preview;
  if (memoryContext.promptText) {
    memoryContextMsg = {
      role: 'system',
      content: `Structured memory:\n${memoryContext.promptText}`,
    };
    memoryContextTokens = estimateMessageTokens('system', memoryContextMsg.content);
    addBreakdown('structured_memory', 'Structured memory', memoryContextTokens, 1);
  }

  // Reserve space for handoff system message if needed
  let handoffSystemTokens = 0;
  if (handoff) {
    const fromDisplay = MODELS[handoff.fromModel]?.displayName ?? handoff.fromModel;
    const handoffText = buildHandoffSystemMessage(fromDisplay, handoff.instruction);
    handoffSystemTokens = estimateMessageTokens('system', handoffText);
    addBreakdown('handoff', 'Handoff instruction', handoffSystemTokens, 1);
  }

  let availableForHistory = budget.available - handoffSystemTokens - actionContextTokens - memoryContextTokens;

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
      addBreakdown('linked_sessions', 'Linked sessions', linkedContextTokens, 1);
    }
  }

  const buildAttachmentManifest = (): { role: MessageRole; content: string } | null => {
    if (documents.length === 0) return null;

    const lines = [
      'Attached context for this request:',
      ...documents
        .slice()
        .sort((a, b) => (a.priorityOrder ?? 999) - (b.priorityOrder ?? 999))
        .map((doc) => `- ${doc.displayType ?? humanizeSourceType(doc.sourceType)}: "${doc.label}" — ${documentStatusLabel(doc.reason)}`),
      'When referring to attached materials, cite them by title or filename. Do not claim you saw content from attachments marked not included.',
    ];

    return {
      role: 'system',
      content: lines.join('\n'),
    };
  };

  // --- Phase A0: Inject Notion context sources ---
  let notionContextMsgs: { role: MessageRole; content: string }[] = [];
  let notionContextTokens = 0;

  {
    const sources = getContextSources(sessionId)
      .slice()
      .sort((a, b) => b.attachedAt - a.attachedAt);
    if (sources.length > 0) {
      // Allocate up to 25% of available budget for Notion sources
      const sourceBudget = Math.floor(availableForHistory * 0.25);
      let sourceUsed = 0;

      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        let sourceContent: string | null = null;
        let label = source.sourceLabel;
        let ready = false;
        let displayType = humanizeSourceType(source.sourceType);

        if (source.sourceType === 'notion_page') {
          const page = getNotionPage(source.sourceId);
          label = page?.title ?? source.sourceLabel;
          displayType = 'Notion page';
          if (!page?.contentMd) {
            documents.push(buildDocumentRecord(source.sourceId, source.sourceType, label, displayType, 'omitted', 0, 'not_ready', index + 1));
            continue;
          }
          ready = true;

          const dateStr = page.lastEditedAt
            ? new Date(page.lastEditedAt).toISOString().split('T')[0]
            : 'unknown';
          sourceContent = `[Attached Notion page: "${page.title}" — last updated ${dateStr}]\n${page.contentMd}`;
        } else if (source.sourceType === 'web_page') {
          const page = getWebPage(source.sourceId);
          label = page?.title ?? page?.url ?? source.sourceLabel;
          displayType = 'Web page';
          if (!page?.contentText) {
            documents.push(buildDocumentRecord(source.sourceId, source.sourceType, label, displayType, 'omitted', 0, 'not_ready', index + 1));
            continue;
          }
          ready = true;
          sourceContent = `[Attached Web page: "${page.title ?? page.url}" — ${page.url}]\n${page.contentText}`;
        }

        if (!sourceContent) continue;
        const remainingBudget = sourceBudget - sourceUsed;
        if (remainingBudget <= 0) {
          documents.push(buildDocumentRecord(
            source.sourceId,
            source.sourceType,
            label,
            displayType,
            'omitted',
            0,
            index === 0 ? 'budget_exhausted' : 'lower_priority_than_newer_sources',
            index + 1
          ));
          continue;
        }

        const boundedSourceContent = fitSystemContentToBudget(sourceContent, remainingBudget);
        if (!boundedSourceContent) {
          documents.push(buildDocumentRecord(
            source.sourceId,
            source.sourceType,
            label,
            displayType,
            'omitted',
            0,
            ready ? (index === 0 ? 'budget_exhausted' : 'lower_priority_than_newer_sources') : 'not_ready',
            index + 1
          ));
          continue;
        }
        const tokens = estimateMessageTokens('system', boundedSourceContent);

        if (tokens > remainingBudget) {
          documents.push(buildDocumentRecord(
            source.sourceId,
            source.sourceType,
            label,
            displayType,
            'omitted',
            0,
            index === 0 ? 'budget_exhausted' : 'lower_priority_than_newer_sources',
            index + 1
          ));
          continue;
        }

        notionContextMsgs.push({ role: 'system', content: boundedSourceContent });
        sourceUsed += tokens;
        documents.push(buildDocumentRecord(
          source.sourceId,
          source.sourceType,
          label,
          displayType,
          boundedSourceContent === sourceContent ? 'full' : 'summary',
          tokens,
          boundedSourceContent === sourceContent ? 'included' : 'truncated_to_budget',
          index + 1
        ));
      }

      notionContextTokens = sourceUsed;
      availableForHistory -= notionContextTokens;
      addBreakdown('attached_sources', 'Attached sources', notionContextTokens, notionContextMsgs.length);
    }
  }

  // --- Phase A0b: Inject uploaded file content ---
  let fileContextMsgs: { role: MessageRole; content: string }[] = [];
  let fileContextTokens = 0;

  {
    const db = getDb();
    const files = db.prepare(
      "SELECT * FROM uploaded_files WHERE session_id = ? ORDER BY created_at ASC"
    ).all(sessionId) as any[];

    if (files.length > 0) {
      // Allocate up to 20% of available budget for uploaded files
      const fileBudget = Math.floor(availableForHistory * 0.20);
      let fileUsed = 0;

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const label = file.filename;
        const displayType = humanizeUploadedFileType(file.mime_type, file.filename);
        if (file.status !== 'done') {
          documents.push(buildDocumentRecord(file.id, 'uploaded_file', label, displayType, 'omitted', 0, 'not_ready', index + 1));
          continue;
        }

        const parts: string[] = [];
        parts.push(`[Attached ${displayType}: "${file.filename}"${file.analyzed_by ? ` — analyzed by ${file.analyzed_by}` : ''}]`);

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
        const remainingBudget = fileBudget - fileUsed;
        if (remainingBudget <= 0) {
          documents.push(buildDocumentRecord(file.id, 'uploaded_file', label, displayType, 'omitted', 0, index === 0 ? 'budget_exhausted' : 'lower_priority_than_newer_sources', index + 1));
          continue;
        }

        const boundedFileContent = fitSystemContentToBudget(fileContent, remainingBudget);
        if (!boundedFileContent) {
          documents.push(buildDocumentRecord(file.id, 'uploaded_file', label, displayType, 'omitted', 0, index === 0 ? 'budget_exhausted' : 'lower_priority_than_newer_sources', index + 1));
          continue;
        }
        const tokens = estimateMessageTokens('system', boundedFileContent);

        if (fileUsed + tokens > fileBudget) {
          documents.push(buildDocumentRecord(file.id, 'uploaded_file', label, displayType, 'omitted', 0, index === 0 ? 'budget_exhausted' : 'lower_priority_than_newer_sources', index + 1));
          continue;
        }

        fileContextMsgs.push({ role: 'system', content: boundedFileContent });
        fileUsed += tokens;
        documents.push(buildDocumentRecord(
          file.id,
          'uploaded_file',
          label,
          displayType,
          boundedFileContent === fileContent ? 'full' : 'summary',
          tokens,
          boundedFileContent === fileContent ? 'included' : 'truncated_to_budget',
          index + 1
        ));
      }

      fileContextTokens = fileUsed;
      availableForHistory -= fileContextTokens;
      addBreakdown('uploaded_files', 'Uploaded files', fileContextTokens, fileContextMsgs.length);
    }
  }

  // --- Phase A: Estimate recent messages tokens ---
  let recentTokens = 0;
  for (const msg of recentMessages) {
    recentTokens += estimateMessageTokens(msg.role, msg.content);
  }
  addBreakdown('recent_messages', 'Recent messages', recentTokens, recentMessages.length);

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
        addBreakdown('older_summary', 'Older summary', summaryTokens, 1);
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
        addBreakdown('omission_note', 'Omitted messages note', noteTokens, 1);
      }

      for (const msg of olderToInclude) {
        result.push(formatMessage(msg));
        tokenEstimate += estimateMessageTokens(msg.role, msg.content);
      }
      addBreakdown('older_messages', 'Older messages', olderTokens, olderToInclude.length);
    }
  } else if (olderMessages.length > 0) {
    // No room for any older messages
    summarizedCount = olderMessages.length;
    const noteContent = `[${olderMessages.length} earlier messages omitted for context window limits]`;
    const noteTokens = estimateMessageTokens('system', noteContent);
    result.push({ role: 'system', content: noteContent });
    tokenEstimate += noteTokens;
    addBreakdown('omission_note', 'Omitted messages note', noteTokens, 1);
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

  if (actionContextMsg) {
    result.unshift(actionContextMsg);
    tokenEstimate += actionContextTokens;
  }

  // --- Phase E: Insert linked session context ---
  if (linkedContextMsg) {
    // Insert after handoff message (index 1) or at the start (index 0)
    const insertIdx = handoff ? 1 : 0;
    result.splice(insertIdx, 0, linkedContextMsg);
    tokenEstimate += linkedContextTokens;
  }

  const attachmentManifestMsg = buildAttachmentManifest();
  let attachmentManifestTokens = 0;
  if (attachmentManifestMsg) {
    attachmentManifestTokens = estimateMessageTokens('system', attachmentManifestMsg.content);
    addBreakdown('attachment_manifest', 'Attachment manifest', attachmentManifestTokens, documents.length);
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

  if (attachmentManifestMsg) {
    const baseIdx = handoff ? 1 : 0;
    const offset = (linkedContextMsg ? 1 : 0);
    result.splice(baseIdx + offset, 0, attachmentManifestMsg);
    tokenEstimate += attachmentManifestTokens;
  }

  // --- Phase F: Prepend decision memory (user preferences & observations) ---
  const decisionPrompt = getDecisionsSystemPrompt();
  if (decisionPrompt) {
    const decisionTokens = estimateMessageTokens('system', decisionPrompt);
    result.unshift({ role: 'system', content: decisionPrompt });
    tokenEstimate += decisionTokens;
    addBreakdown('decision_memory', 'Decision memory', decisionTokens, 1);
  }

  if (memoryContextMsg) {
    result.push(memoryContextMsg);
    tokenEstimate += memoryContextTokens;
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
    breakdown: Array.from(breakdownMap.values()).sort((a, b) => b.tokens - a.tokens),
    documents,
    memoryInjection,
  };
}

function fitSystemContentToBudget(content: string, budgetTokens: number): string | null {
  if (budgetTokens <= 12) return null;

  const fullTokens = estimateMessageTokens('system', content);
  if (fullTokens <= budgetTokens) return content;

  const lines = content.split('\n');
  if (lines.length === 0) return null;

  const header = lines[0];
  const body = lines.slice(1).join('\n').trim();
  const suffix = '\n[... attached source truncated to fit context window]';

  let low = 0;
  let high = body.length;
  let best: string | null = null;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${header}\n${body.slice(0, mid).trimEnd()}${suffix}`;
    const tokens = estimateMessageTokens('system', candidate);

    if (tokens <= budgetTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (best) return best;

  const minimal = `${header}${suffix}`;
  return estimateMessageTokens('system', minimal) <= budgetTokens ? minimal : null;
}

function buildDocumentRecord(
  id: string,
  sourceType: ContextDocumentDebugItem['sourceType'],
  label: string,
  displayType: string,
  status: ContextDocumentDebugItem['status'],
  tokens: number,
  reason: ContextDocumentReason,
  priorityOrder: number
): ContextDocumentDebugItem {
  return {
    id,
    sourceType,
    label,
    displayType,
    status,
    tokens,
    reason,
    priorityOrder,
  };
}

function humanizeSourceType(sourceType: ContextDocumentDebugItem['sourceType']): string {
  switch (sourceType) {
    case 'notion_page':
      return 'Notion page';
    case 'web_page':
      return 'Web page';
    case 'uploaded_file':
      return 'File';
    default:
      return 'File';
  }
}

function humanizeUploadedFileType(mimeType?: string | null, filename?: string | null): string {
  const name = (filename ?? '').toLowerCase();
  const mime = (mimeType ?? '').toLowerCase();
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'PDF';
  if (mime.includes('wordprocessingml') || mime.includes('msword') || name.endsWith('.docx') || name.endsWith('.doc')) return 'Word document';
  if (mime.includes('spreadsheetml') || mime.includes('excel') || name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) return 'Excel workbook';
  if (mime.includes('presentationml') || mime.includes('powerpoint') || name.endsWith('.pptx') || name.endsWith('.ppt')) return 'PowerPoint presentation';
  if (mime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].some((ext) => name.endsWith(ext))) return 'Image';
  if (mime.startsWith('text/') || ['.txt', '.md', '.markdown', '.json', '.csv'].some((ext) => name.endsWith(ext))) return 'Text file';
  return 'File';
}

function documentStatusLabel(reason: ContextDocumentReason): string {
  switch (reason) {
    case 'included':
      return 'included';
    case 'truncated_to_budget':
      return 'included as summary';
    case 'budget_exhausted':
      return 'not included (budget limit)';
    case 'lower_priority_than_newer_sources':
      return 'not included (lower priority)';
    case 'not_ready':
      return 'not included (not ready)';
    default:
      return 'included';
  }
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

function buildActionContextSystemMessage(session: NonNullable<ReturnType<typeof getSession>>): string {
  const snapshot = session.contextSnapshot;
  if (!snapshot) {
    return 'You are working in an action thread derived from a broader topic discussion.';
  }

  const lines: string[] = [
    'You are working in an action thread derived from a broader topic discussion.',
    '',
    `Action type: ${session.actionType ?? 'custom'}`,
    `Action scenario: ${snapshot.actionScenario ?? 'new'}`,
    `Action title: ${session.actionTitle ?? session.title ?? 'Untitled action'}`,
  ];

  if (session.actionTarget ?? snapshot.targetLabel) {
    lines.push(`Target: ${session.actionTarget ?? snapshot.targetLabel}`);
  }

  lines.push('', 'Topic summary:', snapshot.sourceSummary || '(No summary available)');

  if (snapshot.selectedMessageIds.length > 0) {
    lines.push('', `Selected evidence count: ${snapshot.selectedMessageIds.length} message(s)`);
  }

  if (snapshot.userInstruction) {
    lines.push('', `Instruction: ${snapshot.userInstruction}`);
  }

  if (snapshot.outputExpectation) {
    lines.push('', `Output expectation: ${snapshot.outputExpectation}`);
  }

  return lines.join('\n');
}
