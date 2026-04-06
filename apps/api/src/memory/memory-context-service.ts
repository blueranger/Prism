import type { MemoryInjectionItem, MemoryInjectionPreview, OperationMode } from '@prism/shared';
import { getDb } from './db';
import { createMemoryUsageRun } from './memory-observability-store';

function mapSource(row: any): { sessionId?: string | null; messageId?: string | null } {
  return {
    sessionId: row.session_id ?? null,
    messageId: row.message_id ?? null,
  };
}

function toInjectionItem(row: any): MemoryInjectionItem {
  return {
    memoryItemId: row.id ?? null,
    title: row.title,
    summary: row.summary,
    memoryType: row.memory_type,
    confidence: row.confidence ?? 0.5,
    sourceSessionId: row.source_session_id ?? null,
    sourceMessageId: row.source_message_id ?? null,
  };
}

function dedupeById(items: MemoryInjectionItem[]): MemoryInjectionItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.memoryItemId ?? `${item.memoryType}:${item.title}:${item.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildPromptBlock(title: string, items: MemoryInjectionItem[]): string[] {
  if (items.length === 0) return [];
  return [
    `${title}:`,
    ...items.map((item) => {
      const sourceBits = [];
      if (item.sourceSessionId) sourceBits.push(`session ${String(item.sourceSessionId).slice(0, 8)}`);
      if (item.sourceMessageId) sourceBits.push(`msg ${String(item.sourceMessageId).slice(0, 8)}`);
      const sourceText = sourceBits.length > 0 ? ` [source: ${sourceBits.join(' / ')}]` : '';
      return `- ${item.title}: ${item.summary}${sourceText}`;
    }),
  ];
}

export function buildMemoryInjectionPreview(opts: {
  sessionId: string;
  model: string;
  mode?: OperationMode | null;
  promptPreview: string;
}): { promptText: string | null; preview: MemoryInjectionPreview } {
  const db = getDb();

  const profileRows = db.prepare(`
    SELECT mi.*, ms.session_id as source_session_id, ms.message_id as source_message_id
    FROM memory_items mi
    LEFT JOIN memory_sources ms ON ms.memory_item_id = mi.id
    WHERE mi.memory_type = 'profile' AND mi.status = 'active'
    ORDER BY mi.confidence DESC, mi.updated_at DESC
    LIMIT 5
  `).all() as any[];

  const relationshipRows = db.prepare(`
    SELECT mi.*, ms.session_id as source_session_id, ms.message_id as source_message_id
    FROM memory_items mi
    LEFT JOIN memory_sources ms ON ms.memory_item_id = mi.id
    WHERE mi.memory_type = 'relationship' AND mi.status = 'active'
    ORDER BY mi.confidence DESC, mi.updated_at DESC
    LIMIT 8
  `).all() as any[];

  const situationRows = db.prepare(`
    SELECT mi.*, ms.session_id as source_session_id, ms.message_id as source_message_id
    FROM memory_items mi
    LEFT JOIN memory_sources ms ON ms.memory_item_id = mi.id
    WHERE mi.memory_type IN ('situation', 'event') AND mi.status = 'active'
    ORDER BY mi.updated_at DESC
    LIMIT 8
  `).all() as any[];

  const workingRows = db.prepare(`
    SELECT wmi.id, wmi.title, wmi.summary, wmi.memory_type, wmi.confidence,
           wmi.session_id as source_session_id, wmi.source_message_id as source_message_id
    FROM working_memory_items wmi
    WHERE (wmi.session_id = ? OR wmi.session_id IS NULL)
      AND wmi.status = 'active'
      AND (wmi.expires_at IS NULL OR wmi.expires_at > ?)
    ORDER BY CASE WHEN wmi.session_id = ? THEN 0 ELSE 1 END, wmi.updated_at DESC
    LIMIT 6
  `).all(opts.sessionId, Date.now(), opts.sessionId) as any[];

  const retrievedItems = dedupeById([
    ...profileRows.map(toInjectionItem),
    ...relationshipRows.map(toInjectionItem),
    ...situationRows.map(toInjectionItem),
    ...workingRows.map((row) => ({
      memoryItemId: row.id ?? null,
      title: row.title,
      summary: row.summary,
      memoryType: row.memory_type ?? 'working',
      confidence: row.confidence ?? 0.5,
      sourceSessionId: row.source_session_id ?? null,
      sourceMessageId: row.source_message_id ?? null,
    })),
  ]);

  const injectedItems = dedupeById([
    ...profileRows.slice(0, 4).map(toInjectionItem),
    ...relationshipRows.slice(0, 5).map(toInjectionItem),
    ...situationRows.slice(0, 5).map(toInjectionItem),
    ...workingRows.slice(0, 4).map((row) => ({
      memoryItemId: row.id ?? null,
      title: row.title,
      summary: row.summary,
      memoryType: row.memory_type ?? 'working',
      confidence: row.confidence ?? 0.5,
      sourceSessionId: row.source_session_id ?? null,
      sourceMessageId: row.source_message_id ?? null,
    })),
  ]);

  const injectedKeys = new Set(injectedItems.map((item) => item.memoryItemId ?? `${item.memoryType}:${item.title}:${item.summary}`));
  const omittedItems = retrievedItems
    .filter((item) => !injectedKeys.has(item.memoryItemId ?? `${item.memoryType}:${item.title}:${item.summary}`))
    .map((item) => ({ ...item, reason: 'selection_limit' }));

  const lines: string[] = [];
  lines.push(...buildPromptBlock('Profile memory', injectedItems.filter((item) => item.memoryType === 'profile')));
  if (lines.length > 0) lines.push('');
  lines.push(...buildPromptBlock('Relationship memory', injectedItems.filter((item) => item.memoryType === 'relationship')));
  if (lines.length > 0) lines.push('');
  lines.push(...buildPromptBlock('Situation and event memory', injectedItems.filter((item) => item.memoryType === 'situation' || item.memoryType === 'event')));
  if (lines.length > 0) lines.push('');
  lines.push(...buildPromptBlock('Working memory', injectedItems.filter((item) => item.memoryType === 'working')));

  const preview: MemoryInjectionPreview = {
    retrievedItems,
    injectedItems,
    omittedItems,
  };

  const run = createMemoryUsageRun({
    sessionId: opts.sessionId,
    model: opts.model,
    mode: opts.mode ?? null,
    promptPreview: opts.promptPreview.slice(0, 300),
    retrievedItems: retrievedItems.map((item) => ({
      memoryItemId: item.memoryItemId ?? null,
      title: item.title,
      memoryType: item.memoryType,
      action: 'retrieved',
      reason: item.reason ?? null,
      summary: item.summary,
      confidence: item.confidence,
    })),
    injectedItems: injectedItems.map((item) => ({
      memoryItemId: item.memoryItemId ?? null,
      title: item.title,
      memoryType: item.memoryType,
      action: 'injected',
      reason: null,
      summary: item.summary,
      confidence: item.confidence,
    })),
    omittedItems: omittedItems.map((item) => ({
      memoryItemId: item.memoryItemId ?? null,
      title: item.title,
      memoryType: item.memoryType,
      action: 'omitted',
      reason: item.reason ?? 'selection_limit',
      summary: item.summary,
      confidence: item.confidence,
    })),
  });

  preview.runId = run.id;

  return {
    promptText: lines.filter(Boolean).length > 0 ? lines.join('\n') : null,
    preview,
  };
}
