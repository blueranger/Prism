import path from 'path';
import type {
  ArticleCandidate,
  BacklinkSuggestion,
  CompiledSourceDocument,
  CompiledSourceMessage,
  CompiledSourceType,
  CompilerArtifact,
  CompilerRunSummary,
  ConceptCandidate,
  KnowledgeMaturity,
  ObsidianDestinationType,
  RelatedNoteSuggestion,
} from '@prism/shared';
import { collectSingle } from './llm-service';
import { getImportedConversation, getImportedMessages } from '../memory/import-store';
import { getSessionMessages } from '../memory/conversation';
import { getSession } from '../memory/session';
import { createCompilerRun, completeCompilerRun, getCompilerRun, listCompilerRuns } from '../memory/compiler-store';
import { deriveSourceUrl, getRawSourceRelativePath } from './import-transform-service';
import { extractionService } from './extraction-service';
import { runMemoryPipelineForSession } from './memory-trigger-pipeline';

const DEFAULT_COMPILER_MODEL = 'gpt-5.4';

type CompilerSourceKind = 'imported' | 'native';

function buildNormalizedTranscript(messages: CompiledSourceMessage[]): string {
  return messages
    .map((message, index) => {
      const roleLabel = message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'User' : 'System';
      return `## ${index + 1}. ${roleLabel}\n${message.content.trim()}`;
    })
    .join('\n\n');
}

function mapImportedSourceType(platform: string): CompiledSourceType {
  if (platform === 'chatgpt') return 'imported_chatgpt';
  if (platform === 'claude') return 'imported_claude';
  if (platform === 'gemini') return 'imported_gemini';
  return 'external_transcript';
}

function wikiPathForImportedSource(sourceId: string): string | null {
  const conversation = getImportedConversation(sourceId);
  if (!conversation) return null;
  const relative = getRawSourceRelativePath(conversation).replace(/\\/g, '/').replace(/\.md$/i, '');
  return `[[${relative}|${conversation.title}]]`;
}

function safeJsonParse<T>(content: string): T | null {
  const fenced = content.match(/```(?:json)?\n([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? content;
  const match = candidate.match(/\{[\s\S]*\}$/m);
  const jsonText = match?.[0] ?? candidate;
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    return null;
  }
}

function dedupeByName<T extends { title?: string; name?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = (item.title ?? item.name ?? '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function normalizeConceptCandidate(concept: ConceptCandidate): ConceptCandidate {
  const name = (concept.name || '').trim();
  const definition = (concept.definition || '').trim();
  let conceptType = concept.conceptType;
  if (!conceptType) {
    conceptType = 'mention';
  }
  return {
    ...concept,
    name,
    definition,
    conceptType,
  };
}

function rebalanceConceptTypes(concepts: ConceptCandidate[]): ConceptCandidate[] {
  const normalized = concepts.map(normalizeConceptCandidate).filter((concept) => concept.name && concept.definition);
  let coreCount = 0;
  return normalized.map((concept) => {
    if (concept.conceptType !== 'core_concept') return concept;
    coreCount += 1;
    if (coreCount <= 3) return concept;
    return {
      ...concept,
      conceptType: 'candidate_topic',
    };
  });
}

function cleanTitle(value: string): string {
  return value
    .replace(/\s*->\s*`[^`]+`/g, '')
    .replace(/\s*->\s*.+$/g, '')
    .trim();
}

function normalizeRelatedNoteSuggestion(note: RelatedNoteSuggestion): RelatedNoteSuggestion {
  const title = cleanTitle(note.title || '');
  return {
    ...note,
    title,
    reason: (note.reason || '').trim(),
  };
}

function normalizeBacklinkSuggestion(note: BacklinkSuggestion): BacklinkSuggestion {
  return {
    ...note,
    title: cleanTitle(note.title || ''),
    reason: (note.reason || '').trim(),
  };
}

export async function normalizeImportedConversation(conversationId: string): Promise<CompiledSourceDocument> {
  const conversation = getImportedConversation(conversationId);
  if (!conversation) throw new Error('Imported conversation not found');
  const messages = getImportedMessages(conversationId);
  if (messages.length === 0) throw new Error('Imported conversation has no messages');

  const normalizedMessages: CompiledSourceMessage[] = messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    sourceModel: message.sourceModel ?? null,
    timestamp: message.timestamp,
  }));

  return {
    sourceId: conversation.id,
    sourceType: mapImportedSourceType(conversation.sourcePlatform),
    title: conversation.title,
    sourceUrl: deriveSourceUrl(conversation),
    projectName: conversation.projectName ?? null,
    workspaceName: conversation.workspaceName ?? null,
    timestamps: {
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      syncedAt: conversation.lastSyncedAt ?? null,
    },
    messages: normalizedMessages,
    normalizedTranscript: buildNormalizedTranscript(normalizedMessages),
    metadata: {
      sourcePlatform: conversation.sourcePlatform,
      sourceKind: conversation.sourceKind,
      originalId: conversation.originalId,
      workspaceId: conversation.workspaceId ?? null,
      accountId: conversation.accountId ?? null,
    },
  };
}

export async function normalizeNativeSession(sessionId: string): Promise<CompiledSourceDocument> {
  const session = getSession(sessionId);
  if (!session) throw new Error('Session not found');
  const messages = getSessionMessages(sessionId);
  if (messages.length === 0) throw new Error('Session has no messages');

  const normalizedMessages: CompiledSourceMessage[] = messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    sourceModel: message.sourceModel ?? null,
    timestamp: message.timestamp,
  }));

  return {
    sourceId: session.id,
    sourceType: 'native_prism_session',
    title: session.title || 'Untitled Prism Session',
    sourceUrl: null,
    projectName: session.actionTitle ?? null,
    workspaceName: null,
    timestamps: {
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      syncedAt: null,
    },
    messages: normalizedMessages,
    normalizedTranscript: buildNormalizedTranscript(normalizedMessages),
    metadata: {
      sessionType: session.sessionType,
      interactionMode: session.interactionMode ?? null,
      activeModel: session.activeModel ?? null,
    },
  };
}

async function extractCompilerArtifacts(
  document: CompiledSourceDocument,
  destinationType: ObsidianDestinationType | null,
  model: string
): Promise<CompilerArtifact> {
  const rawSourceLink =
    document.sourceType.startsWith('imported_') ? wikiPathForImportedSource(document.sourceId) : null;

  const prompt = [
    `Source title: ${document.title}`,
    `Source type: ${document.sourceType}`,
    document.projectName ? `Project: ${document.projectName}` : null,
    document.workspaceName ? `Workspace: ${document.workspaceName}` : null,
    document.sourceUrl ? `Source URL: ${document.sourceUrl}` : null,
    destinationType ? `Requested note destination: ${destinationType}` : null,
    rawSourceLink ? `Raw source wiki link: ${rawSourceLink}` : null,
    '',
    'Analyze this source as part of an evolving topic wiki.',
    'Return JSON with these keys:',
    '- concepts: [{ name, definition, confidence, whereSeen, sourceLinks, conceptType }]',
    '- backlinkSuggestions: [{ title, targetPath, reason, confidence }]',
    '- relatedNoteSuggestions: [{ title, noteType, reason, confidence }]',
    '- articleCandidates: [{ title, articleType, reason, confidence }]',
    '',
    'Rules:',
    '- conceptType must be one of: mention, candidate_topic, core_concept',
    '- Use core_concept sparingly. Reserve it for ideas that appear central, durable, and broadly reusable beyond this one source.',
    '- If a concept feels important but still source-specific or not yet validated, prefer candidate_topic instead of core_concept.',
    '- noteType must be one of: source, context, observation, evergreen, concept, project, topic',
    '- articleType must be one of: topic, concept, project, partner, client',
    '- Keep arrays focused and high-signal; prefer 3-8 concepts.',
    '- relatedNoteSuggestions should suggest note titles, not file paths.',
    '- backlinkSuggestions should only suggest links that would likely help future retrieval.',
    '- Do not put file paths, wiki-link syntax, or arrows into note titles. Keep titles clean and human-readable.',
    '',
    document.normalizedTranscript,
  ].filter(Boolean).join('\n');

  const { content, error } = await collectSingle(model, [
    {
      role: 'system',
      content: 'You are Prism Extraction Compiler. Convert source documents into structured knowledge-building suggestions. Return JSON only.',
    },
    {
      role: 'user',
      content: prompt,
    },
  ]);

  if (error) throw new Error(error);

  const parsed = safeJsonParse<{
    concepts?: ConceptCandidate[];
    backlinkSuggestions?: BacklinkSuggestion[];
    relatedNoteSuggestions?: RelatedNoteSuggestion[];
    articleCandidates?: ArticleCandidate[];
  }>(content);

  if (!parsed) {
    throw new Error('Compiler extraction returned invalid JSON');
  }

  return {
    concepts: rebalanceConceptTypes(dedupeByName(parsed.concepts ?? []).slice(0, 12)),
    backlinkSuggestions: dedupeByName(parsed.backlinkSuggestions ?? []).map(normalizeBacklinkSuggestion).filter((item) => item.title).slice(0, 8),
    relatedNoteSuggestions: dedupeByName(parsed.relatedNoteSuggestions ?? []).map(normalizeRelatedNoteSuggestion).filter((item) => item.title).slice(0, 8),
    articleCandidates: dedupeByName(parsed.articleCandidates ?? []).slice(0, 6),
  };
}

export async function runCompiler(args: {
  sourceKind: CompilerSourceKind;
  sourceId: string;
  destinationType?: ObsidianDestinationType | null;
  model?: string;
}): Promise<CompilerRunSummary> {
  const model = args.model || DEFAULT_COMPILER_MODEL;
  const document =
    args.sourceKind === 'imported'
      ? await normalizeImportedConversation(args.sourceId)
      : await normalizeNativeSession(args.sourceId);

  const run = createCompilerRun({
    sourceId: document.sourceId,
    sourceType: document.sourceType,
    sourceTitle: document.title,
    destinationType: args.destinationType ?? null,
    model,
  });

  const errors: string[] = [];
  let graphUpdatesCount = 0;
  let memoryCandidatesCount = 0;
  let triggerCandidatesCount = 0;
  let artifacts: CompilerArtifact = {
    concepts: [],
    backlinkSuggestions: [],
    relatedNoteSuggestions: [],
    articleCandidates: [],
  };

  try {
    artifacts = await extractCompilerArtifacts(document, args.destinationType ?? null, model);
  } catch (error: any) {
    errors.push(`concept/link extraction: ${error?.message || String(error)}`);
  }

  try {
    if (args.sourceKind === 'imported') {
      const graph = await extractionService.extractImportedConversationById(args.sourceId);
      graphUpdatesCount = (graph.tags ?? 0) + (graph.entities ?? 0) + (graph.relations ?? 0);
    } else {
      const graph = await extractionService.extractNativeSessionById(args.sourceId);
      graphUpdatesCount = (graph.tags ?? 0) + (graph.entities ?? 0) + (graph.relations ?? 0);
    }
  } catch (error: any) {
    errors.push(`graph update: ${error?.message || String(error)}`);
  }

  try {
    if (args.sourceKind === 'native') {
      const memoryResult = runMemoryPipelineForSession(args.sourceId, 'manual_extract_session');
      memoryCandidatesCount = memoryResult.added ?? memoryResult.candidates?.length ?? 0;
      triggerCandidatesCount = memoryResult.triggerCandidates?.length ?? 0;
    }
  } catch (error: any) {
    errors.push(`memory/trigger update: ${error?.message || String(error)}`);
  }

  const status: CompilerRunSummary['status'] =
    errors.length === 0 ? 'completed' : artifacts.concepts.length || graphUpdatesCount || memoryCandidatesCount || triggerCandidatesCount ? 'partial' : 'failed';

  const completed = completeCompilerRun({
    id: run.id,
    status,
    graphUpdatesCount,
    memoryCandidatesCount,
    triggerCandidatesCount,
    conceptCount: artifacts.concepts.length,
    relatedNoteCount: artifacts.relatedNoteSuggestions.length,
    backlinkSuggestionCount: artifacts.backlinkSuggestions.length,
    articleCandidateCount: artifacts.articleCandidates.length,
    artifacts,
    errors,
  });

  if (!completed) throw new Error('Compiler run could not be completed');
  return completed;
}

export async function runCompilerForImportedConversation(args: {
  conversationId: string;
  destinationType?: ObsidianDestinationType | null;
  model?: string;
}): Promise<CompilerRunSummary> {
  return runCompiler({
    sourceKind: 'imported',
    sourceId: args.conversationId,
    destinationType: args.destinationType ?? null,
    model: args.model,
  });
}

export async function runCompilerForNativeSession(args: {
  sessionId: string;
  destinationType?: ObsidianDestinationType | null;
  model?: string;
}): Promise<CompilerRunSummary> {
  return runCompiler({
    sourceKind: 'native',
    sourceId: args.sessionId,
    destinationType: args.destinationType ?? null,
    model: args.model,
  });
}

export function listRecentCompilerRuns(args: {
  sourceId?: string;
  sourceType?: CompiledSourceType;
  limit?: number;
} = {}): CompilerRunSummary[] {
  return listCompilerRuns(args);
}

export function getCompilerRunById(id: string): CompilerRunSummary | null {
  return getCompilerRun(id);
}

export function getSuggestedNoteDirectory(destinationType: ObsidianDestinationType | null): string {
  switch (destinationType) {
    case 'obsidian_context':
      return path.join('Meetings');
    case 'obsidian_observation':
      return path.join('Observations');
    case 'obsidian_evergreen':
    default:
      return path.join('Notes');
  }
}
