import fs from 'fs/promises';
import path from 'path';
import {
  CompilerArtifact,
  ImportedConversation,
  ImportedMessage,
  KnowledgeMaturity,
  ObsidianDestinationType,
  ObsidianExportResult,
} from '@prism/shared';
import { collectSingle } from './llm-service';
import { getImportedConversation, getImportedMessages } from '../memory/import-store';

const DEFAULT_TRANSFORM_MODEL = 'gpt-5.4';
const DEFAULT_CONTEXT_DIRECTORY = 'Meetings';
const DEFAULT_OBSERVATION_DIRECTORY = 'Observations';
const DEFAULT_EVERGREEN_DIRECTORY = 'Notes';
type NoteLanguage = 'zh-Hant' | 'en';

function slugifySegment(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function formatDatePrefix(timestamp?: string): string {
  const date = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function getSourceDirectory(platform: ImportedConversation['sourcePlatform']): string {
  switch (platform) {
    case 'chatgpt':
      return 'ChatGPT';
    case 'claude':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
    default:
      return 'Imported';
  }
}

function toWikiLink(relativePath: string, title: string): string {
  const withoutExt = relativePath.replace(/\.md$/i, '');
  const normalized = withoutExt.split(path.sep).join('/');
  return `[[${normalized}|${title}]]`;
}

export function buildTranscript(conversation: ImportedConversation, messages: ImportedMessage[]): string {
  const lines: string[] = [];
  lines.push(`# ${conversation.title}`);
  lines.push('');
  lines.push('## Metadata');
  lines.push(`- Source platform: ${conversation.sourcePlatform}`);
  if (conversation.sourceKind) lines.push(`- Source kind: ${conversation.sourceKind}`);
  if (conversation.projectName) lines.push(`- Project: ${conversation.projectName}`);
  if (conversation.workspaceName) lines.push(`- Workspace: ${conversation.workspaceName}`);
  if (conversation.originalId) lines.push(`- Original ID: ${conversation.originalId}`);
  if (conversation.lastSyncedAt) lines.push(`- Synced to Prism: ${conversation.lastSyncedAt}`);
  if (conversation.sourceUpdatedAt) lines.push(`- Updated at source: ${conversation.sourceUpdatedAt}`);
  const sourceUrl = deriveSourceUrl(conversation);
  if (sourceUrl) lines.push(`- Source URL: ${sourceUrl}`);
  lines.push('');
  lines.push('## Messages');
  lines.push('');
  for (const message of messages) {
    lines.push(`### ${message.role === 'assistant' ? 'Assistant' : 'User'}`);
    if (message.sourceModel) lines.push(`Model: ${message.sourceModel}`);
    lines.push(`Timestamp: ${message.timestamp}`);
    lines.push('');
    lines.push(message.content.trim());
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

export function deriveSourceUrl(conversation: ImportedConversation): string | null {
  const metadataUrl = typeof conversation.metadata?.sourceUrl === 'string' ? conversation.metadata.sourceUrl.trim() : '';
  if (metadataUrl) return metadataUrl;
  if (!conversation.originalId) return null;
  switch (conversation.sourcePlatform) {
    case 'chatgpt':
      return `https://chatgpt.com/c/${conversation.originalId}`;
    case 'claude':
      return `https://claude.ai/chat/${conversation.originalId}`;
    case 'gemini':
      return `https://gemini.google.com/app/${conversation.originalId}`;
    default:
      return null;
  }
}

export function getRawSourceRelativePath(conversation: ImportedConversation): string {
  const datePrefix = formatDatePrefix(conversation.lastSyncedAt ?? conversation.createdAt);
  const title = slugifySegment(conversation.title || conversation.sourceTitle || conversation.originalId || 'Imported Conversation');
  return path.join('Sources', getSourceDirectory(conversation.sourcePlatform), `${datePrefix} ${title}.md`);
}

export function getKnowledgeNoteRelativePath(conversation: ImportedConversation, title?: string): string {
  const resolved = slugifySegment(title || conversation.title || conversation.sourceTitle || conversation.originalId || 'Knowledge Note');
  return path.join('Notes', `${resolved}.md`);
}

export function getRoutedKnowledgeNoteRelativePath(
  conversation: ImportedConversation,
  destinationType: ObsidianDestinationType,
  title?: string
): string {
  const resolved = slugifySegment(title || conversation.title || conversation.sourceTitle || conversation.originalId || 'Knowledge Note');
  let directory = DEFAULT_EVERGREEN_DIRECTORY;
  if (destinationType === 'obsidian_context') {
    directory = DEFAULT_CONTEXT_DIRECTORY;
  } else if (destinationType === 'obsidian_observation') {
    directory = DEFAULT_OBSERVATION_DIRECTORY;
  }
  return path.join(directory, `${resolved}.md`);
}

async function ensureDirectoryForFile(targetFile: string): Promise<void> {
  await fs.mkdir(path.dirname(targetFile), { recursive: true });
}

export async function exportRawSourceNote(vaultPath: string, conversation: ImportedConversation, messages: ImportedMessage[]): Promise<ObsidianExportResult> {
  const relativePath = getRawSourceRelativePath(conversation);
  const filePath = path.join(vaultPath, relativePath);
  await ensureDirectoryForFile(filePath);
  await fs.writeFile(filePath, buildTranscript(conversation, messages), 'utf8');
  return {
    ok: true,
    filePath,
    relativePath,
    title: conversation.title,
    destinationType: 'obsidian_source',
    knowledgeMaturity: 'raw',
  };
}

export async function exportKnowledgeNote(
  vaultPath: string,
  conversation: ImportedConversation,
  content: string,
  title?: string,
  destinationType: ObsidianDestinationType = 'obsidian_evergreen',
  knowledgeMaturity: KnowledgeMaturity = 'evergreen'
): Promise<ObsidianExportResult> {
  const relativePath = getRoutedKnowledgeNoteRelativePath(conversation, destinationType, title);
  const filePath = path.join(vaultPath, relativePath);
  await ensureDirectoryForFile(filePath);
  await fs.writeFile(filePath, content.trim() + '\n', 'utf8');
  return {
    ok: true,
    filePath,
    relativePath,
    title: title || conversation.title,
    destinationType,
    knowledgeMaturity,
  };
}

export function assertImportedConversation(conversationId: string): { conversation: ImportedConversation; messages: ImportedMessage[] } {
  const conversation = getImportedConversation(conversationId);
  if (!conversation) {
    throw new Error('Imported conversation not found');
  }
  const messages = getImportedMessages(conversationId);
  if (messages.length === 0) {
    throw new Error('Imported conversation has no messages');
  }
  return { conversation, messages };
}

function buildConversationForPrompt(messages: ImportedMessage[]): string {
  return messages
    .map((message, index) => {
      const roleLabel = message.role === 'assistant' ? 'Assistant' : 'User';
      return `## ${index + 1}. ${roleLabel}\n${message.content.trim()}`;
    })
    .join('\n\n');
}

function extractMarkdownSection(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:markdown|md)?\n([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectDominantNoteLanguage(conversation: ImportedConversation, messages: ImportedMessage[]): NoteLanguage {
  const samples = [
    conversation.title,
    conversation.sourceTitle,
    conversation.projectName,
    ...messages.slice(0, 12).map((message) => message.content.slice(0, 1200)),
  ]
    .filter(Boolean)
    .join('\n');

  const cjkMatches = samples.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? [];
  const latinMatches = samples.match(/[A-Za-z]/g) ?? [];
  return cjkMatches.length >= Math.max(20, latinMatches.length * 0.35) ? 'zh-Hant' : 'en';
}

function ensureSection(content: string, heading: string, body: string): string {
  const escapedHeading = escapeRegExp(heading);
  if (new RegExp(`^#{1,6}\\s+${escapedHeading}\\s*$`, 'mi').test(content)) {
    return content;
  }
  return `${content.trim()}\n\n## ${heading}\n${body.trim()}\n`;
}

function getSectionFallback(heading: string, language: NoteLanguage = 'en'): string {
  if (language === 'zh-Hant') {
    switch (heading) {
      case 'Summary':
        return '用一小段搭配幾個具體重點，整理這份來源的核心摘要。';
      case 'Current Context':
        return '說明目前延續工作所需的專案、會議或決策脈絡。';
      case 'Working Decisions':
        return '列出目前正在採用的工作方向、暫定決策或已對齊的做法。';
      case 'Open Questions':
        return '列出仍待回答、尚未釐清的問題。';
      case 'Items Pending Decision':
        return '列出需要特定 owner、主管或下一個 checkpoint 拍板的事項。';
      case 'Why this matters now':
        return '說明這份脈絡筆記為什麼對眼前的下一步、會議或決策節點重要。';
      case 'Observation':
        return '用一小段清楚說明目前觀察到的 pattern 或 insight 候選。';
      case 'Why it may matter':
        return '說明這個 observation 若持續出現，為什麼可能重要。';
      case 'Reuse potential':
        return '描述這個 observation 未來可能在哪些情境被再次使用。';
      case 'What would validate this?':
        return '列出哪些後續證據、案例或訊號能提高對這個 observation 的信心。';
      case 'Where it was seen':
        return '說明這個 observation 是在什麼材料、脈絡或情境中被看到的。';
      case 'Key Insights':
        return '列出最值得保留、可重用的核心洞察，而不是只重述來源細節。';
      case 'Framework / Structure':
        return '整理成未來可沿用的結構、框架或模型。';
      case 'Reusable Conclusions':
        return '列出超出單一案例、之後仍可能反覆使用的結論。';
      case 'Why it matters':
        return '說明這份知識為什麼重要，不只侷限在目前案例。';
      case 'How it can be reused':
        return '說明未來可以在哪些工作或情境中重複使用這份知識。';
      default:
        return '補上缺少的段落，內容要精簡但具體。';
    }
  }
  switch (heading) {
    case 'Summary':
      return 'Summarize the source in a short paragraph and a few concrete bullets.';
    case 'Current Context':
      return 'Capture the current project, meeting, or decision context that matters for continuing the work.';
    case 'Working Decisions':
      return 'List the working decisions or temporary directions that appear active right now.';
    case 'Open Questions':
      return 'List the unresolved questions that still need answers.';
    case 'Items Pending Decision':
      return 'List the decisions that are waiting on owner approval or a later checkpoint.';
    case 'Why this matters now':
      return 'Explain why this context matters for the next concrete step or checkpoint.';
    case 'Observation':
      return 'State the observation or pattern candidate in one concise paragraph.';
    case 'Why it may matter':
      return 'Explain why this observation could matter if it keeps appearing.';
    case 'Reuse potential':
      return 'Describe where this observation may be reused in future work.';
    case 'What would validate this?':
      return 'List the evidence or future signals that would increase confidence in this observation.';
    case 'Where it was seen':
      return 'Note the concrete source situations where this observation appeared.';
    case 'Key Insights':
      return 'List the most reusable insights, not source-specific details.';
    case 'Framework / Structure':
      return 'Present the reusable structure, model, or framework that can carry this knowledge forward.';
    case 'Reusable Conclusions':
      return 'List the conclusions that appear important and reusable beyond this one source.';
    case 'Why it matters':
      return 'Explain why this knowledge matters beyond the immediate case.';
    case 'How it can be reused':
      return 'Describe the future situations where this knowledge can be reused.';
    default:
      return 'Add the missing section in concise, high-signal markdown.';
  }
}

function buildProvenanceLines(
  conversation: ImportedConversation,
  destinationType: ObsidianDestinationType,
  knowledgeMaturity: KnowledgeMaturity,
  promptModel: string,
  language: NoteLanguage
): string {
  if (language === 'zh-Hant') {
    return [
      '- 由 Prism 生成',
      `- Imported conversation ID: ${conversation.id}`,
      `- 來源平台: ${conversation.sourcePlatform}`,
      `- 輸出目的地: ${destinationType}`,
      `- 知識成熟度: ${knowledgeMaturity}`,
      `- 使用模型: ${promptModel}`,
    ].join('\n');
  }
  return [
    '- Generated in Prism',
    `- Imported conversation ID: ${conversation.id}`,
    `- Source platform: ${conversation.sourcePlatform}`,
    `- Destination type: ${destinationType}`,
    `- Knowledge maturity: ${knowledgeMaturity}`,
    `- Model used for transformation: ${promptModel}`,
  ].join('\n');
}

export function decorateKnowledgeNoteWithCompilerArtifacts(
  content: string,
  artifacts?: CompilerArtifact | null,
  destinationType: ObsidianDestinationType = 'obsidian_evergreen'
): string {
  if (!artifacts) return content;
  let next = content.trim();

  if (artifacts.concepts?.length) {
    const conceptLimit =
      destinationType === 'obsidian_context' ? 4 : destinationType === 'obsidian_observation' ? 4 : 5;
    const conceptCandidates = artifacts.concepts
      .filter((concept) => {
        if (destinationType === 'obsidian_context') {
          return concept.conceptType === 'core_concept' || concept.conceptType === 'candidate_topic';
        }
        if (destinationType === 'obsidian_observation') {
          return concept.conceptType !== 'mention';
        }
        return true;
      })
      .slice(0, conceptLimit);
    const conceptLines = conceptCandidates.map((concept) => {
      const compactType =
        concept.conceptType === 'core_concept'
          ? 'core'
          : concept.conceptType === 'candidate_topic'
            ? 'candidate'
            : null;
      return compactType
        ? `- **${concept.name}** (${compactType}): ${concept.definition}`
        : `- **${concept.name}**: ${concept.definition}`;
    });
    next = ensureSection(next, 'Concepts', conceptLines.join('\n'));
  }

  if (artifacts.relatedNoteSuggestions?.length || artifacts.backlinkSuggestions?.length) {
    const relatedLines: string[] = [];
    const seen = new Set<string>();
    const preferredNoteTypes =
      destinationType === 'obsidian_context'
        ? new Set(['context', 'project', 'topic', 'concept'])
        : destinationType === 'obsidian_observation'
          ? new Set(['observation', 'concept', 'topic', 'context'])
          : new Set(['evergreen', 'concept', 'topic', 'context']);
    const relatedLimit =
      destinationType === 'obsidian_context' ? 4 : destinationType === 'obsidian_observation' ? 4 : 5;
    const filteredRelated = artifacts.relatedNoteSuggestions
      .filter((note) => preferredNoteTypes.has(note.noteType))
      .slice(0, relatedLimit);
    for (const note of filteredRelated) {
      const key = note.title.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      relatedLines.push(`- **${note.title}** (${note.noteType}): ${note.reason}`);
    }
    const backlinkLimit = destinationType === 'obsidian_evergreen' ? 3 : 2;
    for (const suggestion of artifacts.backlinkSuggestions.slice(0, backlinkLimit)) {
      const key = suggestion.title.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      relatedLines.push(`- **${suggestion.title}** (backlink): ${suggestion.reason}`);
    }
    next = ensureSection(next, 'Related Notes', relatedLines.join('\n'));
  }

  return next.trim();
}

function getKnowledgePromptConfig(destinationType: ObsidianDestinationType = 'obsidian_evergreen'): {
  role: string;
  purpose: string;
  requiredSections: string[];
  sectionGuidance: Record<string, string>;
  avoid: string[];
  styleRules: string[];
  knowledgeMaturity: KnowledgeMaturity;
} {
  switch (destinationType) {
    case 'obsidian_context':
      return {
        role: 'Context note writer',
        purpose: 'Create a context note that preserves meeting, project, or client context for later recall and continuation of work.',
        requiredSections: ['Summary', 'Current Context', 'Working Decisions', 'Open Questions', 'Items Pending Decision', 'Why this matters now', 'Sources', 'Provenance'],
        sectionGuidance: {
          Summary: 'Give a short framing summary of what this source is about and why the note exists.',
          'Current Context': 'Capture the current state, actors, constraints, and situational background.',
          'Working Decisions': 'List the temporary or active decisions that are guiding work right now.',
          'Open Questions': 'List the unresolved questions that still block clarity or progress.',
          'Items Pending Decision': 'List the items that need explicit owner approval or a later checkpoint.',
          'Why this matters now': 'Explain why this note matters for the next concrete step, meeting, or decision checkpoint.',
          Sources: 'Include the provided raw source wiki link exactly once.',
          Provenance: 'State that the note was generated in Prism and describe the source basis and interpretation boundary.',
        },
        avoid: [
          'Do not turn temporary context into a general reusable framework.',
          'Do not write the note as evergreen knowledge.',
          'Do not collapse open questions and pending decisions into one undifferentiated section.',
        ],
        styleRules: [
          'Markdown only.',
          'Keep the note useful for future continuation of work.',
          'Prefer concrete situational detail over abstract theory.',
        ],
        knowledgeMaturity: 'context',
      };
    case 'obsidian_observation':
      return {
        role: 'Observation note writer',
        purpose: 'Create an incubation note that preserves a promising pattern or insight candidate without overstating its maturity.',
        requiredSections: ['Observation', 'Why it may matter', 'Reuse potential', 'What would validate this?', 'Where it was seen', 'Sources', 'Provenance'],
        sectionGuidance: {
          Observation: 'State the pattern or insight candidate clearly in one short paragraph.',
          'Why it may matter': 'Explain why this observation could matter if it keeps appearing.',
          'Reuse potential': 'Describe where this observation may be reused in future work.',
          'What would validate this?': 'List the evidence, future cases, or signals that would increase confidence in this observation.',
          'Where it was seen': 'Describe the concrete situations or materials where this pattern appeared.',
          Sources: 'Include the provided raw source wiki link exactly once.',
          Provenance: 'State that the note is an incubation note generated in Prism and describe the evidence boundary.',
        },
        avoid: [
          'Do not write the note as a mature framework.',
          'Do not present the observation as a validated universal rule.',
          'Do not dump the whole source as a generic summary.',
        ],
        styleRules: [
          'Markdown only.',
          'Use tentative language like "this suggests", "this may indicate", or "this could become".',
          'Preserve uncertainty explicitly.',
        ],
        knowledgeMaturity: 'incubating',
      };
    case 'obsidian_evergreen':
    default:
      return {
        role: 'Evergreen knowledge note writer',
        purpose: 'Create a core knowledge note that captures important and reusable ideas beyond the immediate case.',
        requiredSections: ['Summary', 'Key Insights', 'Framework / Structure', 'Reusable Conclusions', 'Why it matters', 'How it can be reused', 'Sources', 'Provenance'],
        sectionGuidance: {
          Summary: 'State the reusable model or core knowledge claim first; let the source case support it, not dominate it.',
          'Key Insights': 'List the most reusable insights, not source-specific details.',
          'Framework / Structure': 'Present the structure, model, or framework that can be reused in future work.',
          'Reusable Conclusions': 'List durable conclusions that remain useful beyond the immediate case.',
          'Why it matters': 'Explain why this knowledge matters beyond the current project or conversation.',
          'How it can be reused': 'Describe the future scenarios or work where this knowledge can be reused.',
          Sources: 'Include the provided raw source wiki link exactly once.',
          Provenance: 'State that the note was abstracted into evergreen form in Prism and describe the abstraction boundary.',
        },
        avoid: [
          'Do not let one project, customer, or meeting dominate the whole note.',
          'Do not retain too many source-specific scheduling details or one-off execution details.',
          'Do not use tentative observation language for the whole note.',
        ],
        styleRules: [
          'Markdown only.',
          'Keep wording concise and high-signal.',
          'Prefer stable patterns, decision models, and reusable structures.',
        ],
        knowledgeMaturity: 'evergreen',
      };
  }
}

export async function generateKnowledgeNoteFromConversation(
  conversation: ImportedConversation,
  messages: ImportedMessage[],
  model?: string,
  destinationType: ObsidianDestinationType = 'obsidian_evergreen'
): Promise<{ content: string; knowledgeMaturity: KnowledgeMaturity }> {
  const promptModel = model || DEFAULT_TRANSFORM_MODEL;
  const rawSourceLink = toWikiLink(getRawSourceRelativePath(conversation), conversation.title);
  const sourceUrl = deriveSourceUrl(conversation);
  const transcript = buildConversationForPrompt(messages);
  const promptConfig = getKnowledgePromptConfig(destinationType);
  const noteLanguage = detectDominantNoteLanguage(conversation, messages);
  const sharedGuardrails = [
    'Return markdown only.',
    'Do not include any explanatory preface before the note.',
    'Do not duplicate headings.',
    'Do not create two separate Sources or Provenance sections.',
    'Each section must contain meaningful content; avoid filler or placeholders.',
    'Do not paste compiler dashboard counts, debug output, or system telemetry into the note body.',
  ];
  const sectionGuideText = promptConfig.requiredSections
    .map((section) => `- ${section}: ${promptConfig.sectionGuidance[section] ?? 'Provide a concise, useful section.'}`)
    .join('\n');
  const avoidText = promptConfig.avoid.map((rule) => `- ${rule}`).join('\n');
  const styleRulesText = [...sharedGuardrails, ...promptConfig.styleRules].map((rule) => `- ${rule}`).join('\n');

  const { content, error } = await collectSingle(promptModel, [
    {
      role: 'system',
      content: [
        `You are a ${promptConfig.role}.`,
        `Purpose: ${promptConfig.purpose}`,
        `Output language: ${noteLanguage === 'zh-Hant' ? 'Traditional Chinese for all prose and bullet content. Keep the required section headings exactly as specified.' : 'English.'}`,
        '',
        'Required sections and order:',
        ...promptConfig.requiredSections.map((section) => `- ${section}`),
        '',
        'Section guidance:',
        sectionGuideText,
        '',
        'Avoid:',
        avoidText,
        '',
        'Style rules:',
        styleRulesText,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Conversation title: ${conversation.title}`,
        conversation.projectName ? `Project: ${conversation.projectName}` : null,
        conversation.workspaceName ? `Workspace: ${conversation.workspaceName}` : null,
        sourceUrl ? `Source URL: ${sourceUrl}` : null,
        '',
        `Create a ${promptConfig.knowledgeMaturity} note that follows the requested contract exactly.`,
        noteLanguage === 'zh-Hant'
          ? '這份來源主要是繁體中文，請用繁體中文撰寫所有段落、條列與說明；只保留規定的 section heading 原樣。'
          : 'Write the note in English.',
        'In the Sources section, include the provided raw source wiki link exactly once.',
        `Raw source wiki link: ${rawSourceLink}`,
        '',
        transcript,
      ].filter(Boolean).join('\n'),
    },
  ]);

  if (error) {
    throw new Error(error);
  }

  let normalized = extractMarkdownSection(content);
  for (const section of promptConfig.requiredSections) {
    if (section === 'Sources') {
      normalized = ensureSection(normalized, 'Sources', `- ${rawSourceLink}`);
      continue;
    }
    if (section === 'Provenance') {
      normalized = ensureSection(
        normalized,
        'Provenance',
        buildProvenanceLines(conversation, destinationType, promptConfig.knowledgeMaturity, promptModel, noteLanguage)
      );
      continue;
    }
    normalized = ensureSection(normalized, section, getSectionFallback(section, noteLanguage));
  }
  return {
    content: normalized.trim(),
    knowledgeMaturity: promptConfig.knowledgeMaturity,
  };
}

export async function generateActionItemsFromConversation(conversation: ImportedConversation, messages: ImportedMessage[], model?: string): Promise<string> {
  const promptModel = model || DEFAULT_TRANSFORM_MODEL;
  const sourceUrl = deriveSourceUrl(conversation);
  const transcript = buildConversationForPrompt(messages);

  const { content, error } = await collectSingle(promptModel, [
    {
      role: 'system',
      content:
        'You extract execution-ready action items from conversation archives. Return markdown only. Use these sections in order: Action Items, Owners, Suggested Next Steps, Source / Provenance. Keep bullets concrete. If owners are unknown, say so explicitly.',
    },
    {
      role: 'user',
      content: [
        `Conversation title: ${conversation.title}`,
        conversation.projectName ? `Project: ${conversation.projectName}` : null,
        sourceUrl ? `Source URL: ${sourceUrl}` : null,
        '',
        'Extract action items suitable for appending into a Notion page. Include provenance back to this imported conversation.',
        '',
        transcript,
      ].filter(Boolean).join('\n'),
    },
  ]);

  if (error) {
    throw new Error(error);
  }

  let normalized = extractMarkdownSection(content);
  normalized = ensureSection(normalized, 'Source / Provenance', [
    '- Generated in Prism',
    `- Imported conversation ID: ${conversation.id}`,
    `- Source platform: ${conversation.sourcePlatform}`,
    sourceUrl ? `- Source URL: ${sourceUrl}` : null,
    `- Destination type: notion_action`,
    `- Model used for extraction: ${promptModel}`,
  ].filter(Boolean).join('\n'));
  return normalized.trim();
}

export function normalizeKnowledgeDestination(
  destinationType?: string | null
): { destinationType: ObsidianDestinationType; knowledgeMaturity: KnowledgeMaturity } {
  const normalized = destinationType?.trim() || 'obsidian_evergreen';
  switch (normalized) {
    case 'obsidian_context':
      return { destinationType: 'obsidian_context', knowledgeMaturity: 'context' };
    case 'obsidian_observation':
      return { destinationType: 'obsidian_observation', knowledgeMaturity: 'incubating' };
    case 'obsidian_evergreen':
    default:
      return { destinationType: 'obsidian_evergreen', knowledgeMaturity: 'evergreen' };
  }
}
