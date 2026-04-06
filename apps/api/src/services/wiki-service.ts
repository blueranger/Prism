import fs from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import type {
  ArticleCandidate,
  CompilePlan,
  CompilerRunSummary,
  CompiledSourceType,
  ImportedConversation,
  ImportedMessage,
  ObsidianDestinationType,
  ObsidianExportResult,
  SaveQueryArtifactRequest,
  WikiArtifactType,
  WikiIndexEntry,
  WikiLintFinding,
  WikiLintRun,
  WikiLogEntry,
  WikiPageKind,
  WikiUpdateResult,
} from '@prism/shared';
import { getCompilerRun } from '../memory/compiler-store';
import { getDb } from '../memory/db';
import { getSessionMessages } from '../memory/conversation';
import { getSession } from '../memory/session';
import {
  exportKnowledgeNote,
  exportRawSourceNote,
  getRawSourceRelativePath,
} from './import-transform-service';

const WIKI_SCHEMA_FILE = 'PRISM_WIKI.md';
const SCHEMA_ALIAS_FILE = 'SCHEMA.md';
const INDEX_FILE = 'index.md';
const LOG_FILE = 'log.md';
const DEFAULT_DIRECTORIES = [
  'Sources',
  'Meetings',
  'Observations',
  'Notes',
  'Concepts',
  'Topics',
  'Projects',
  'Partners',
  'Entities',
  'Analyses',
  'Comparisons',
  'Syntheses',
  path.join('Compiler', 'Plans'),
  path.join('Compiler', 'Summaries'),
] as const;

const SECTION_DIRECTORIES: Array<{ directory: string; title: string; pageKind: WikiPageKind }> = [
  { directory: 'Sources', title: 'Sources', pageKind: 'source' },
  { directory: 'Meetings', title: 'Meetings', pageKind: 'context' },
  { directory: 'Observations', title: 'Observations', pageKind: 'observation' },
  { directory: 'Notes', title: 'Notes', pageKind: 'evergreen' },
  { directory: 'Concepts', title: 'Concepts', pageKind: 'concept' },
  { directory: 'Topics', title: 'Topics', pageKind: 'topic' },
  { directory: 'Projects', title: 'Projects', pageKind: 'project' },
  { directory: 'Partners', title: 'Partners', pageKind: 'partner' },
  { directory: 'Entities', title: 'Entities', pageKind: 'entity' },
  { directory: 'Analyses', title: 'Analyses', pageKind: 'analysis' },
  { directory: 'Comparisons', title: 'Comparisons', pageKind: 'comparison' },
  { directory: 'Syntheses', title: 'Syntheses', pageKind: 'synthesis' },
  { directory: normalizeSlash(path.join('Compiler', 'Plans')), title: 'Compile Plans', pageKind: 'compile_plan' },
  { directory: normalizeSlash(path.join('Compiler', 'Summaries')), title: 'Compiler Summaries', pageKind: 'compiler_summary' },
] as const;

function normalizeSlash(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

function toWikiLink(relativePath: string, title: string): string {
  const normalized = normalizeSlash(relativePath).replace(/\.md$/i, '');
  return `[[${normalized}|${title}]]`;
}

function titleFromRelativePath(relativePath: string): string {
  return path.basename(relativePath, path.extname(relativePath));
}

function safeSlug(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function formatDatePrefix(timestamp?: number | string | null): string {
  const date = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function nativeSourceRelativePath(sessionId: string, title?: string | null, createdAt?: number | null): string {
  return normalizeSlash(path.join('Sources', 'Prism', `${formatDatePrefix(createdAt)} ${safeSlug(title || sessionId)}.md`));
}

function buildNativeSessionTranscript(args: {
  sessionId: string;
  title: string;
  createdAt?: number | null;
  updatedAt?: number | null;
  interactionMode?: string | null;
  messages: Array<{ role: string; content: string; sourceModel?: string | null; timestamp: number }>;
}): string {
  const lines = [
    `# ${args.title}`,
    '',
    '## Metadata',
    '- Source platform: prism',
    `- Session ID: ${args.sessionId}`,
    args.interactionMode ? `- Interaction mode: ${args.interactionMode}` : null,
    args.createdAt ? `- Created at: ${new Date(args.createdAt).toISOString()}` : null,
    args.updatedAt ? `- Updated at: ${new Date(args.updatedAt).toISOString()}` : null,
    '',
    '## Messages',
    '',
  ].filter((line) => line !== null) as string[];

  for (const message of args.messages) {
    lines.push(`### ${message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'User' : 'System'}`);
    if (message.sourceModel) lines.push(`Model: ${message.sourceModel}`);
    lines.push(`Timestamp: ${new Date(message.timestamp).toISOString()}`);
    lines.push('');
    lines.push(message.content.trim());
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

function artifactDirectory(artifactType: WikiArtifactType): string {
  switch (artifactType) {
    case 'comparison':
      return 'Comparisons';
    case 'synthesis':
      return 'Syntheses';
    case 'analysis':
    default:
      return 'Analyses';
  }
}

function artifactPageKind(artifactType: WikiArtifactType): WikiPageKind {
  switch (artifactType) {
    case 'comparison':
      return 'comparison';
    case 'synthesis':
      return 'synthesis';
    case 'analysis':
    default:
      return 'analysis';
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureParent(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function listMarkdownFiles(dirPath: string, relativePrefix = ''): Promise<string[]> {
  if (!(await exists(dirPath))) return [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;
    const absolute = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(absolute, relative));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(relative);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function summarizeMarkdown(filePath: string): Promise<string> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).map((line) => line.trim());
    const relativePath = normalizeSlash(filePath);
    const countSectionItems = (heading: string): number => {
      const index = lines.findIndex((line) => line.toLowerCase() === heading.toLowerCase());
      if (index === -1) return 0;
      let count = 0;
      for (let i = index + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.startsWith('## ')) break;
        if (line.startsWith('- **')) count += 1;
      }
      return count;
    };
    const firstSectionLine = (heading: string): string | null => {
      const index = lines.findIndex((line) => line.toLowerCase() === heading.toLowerCase());
      if (index === -1) return null;
      for (let i = index + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line) continue;
        if (line.startsWith('#')) break;
        if (line.startsWith('- ')) return line.slice(2).trim().slice(0, 180);
        return line.slice(0, 180);
      }
      return null;
    };
    const firstSourceContentLine = (): string | null => {
      const index = lines.findIndex((line) => line.toLowerCase() === '## messages');
      if (index === -1) return null;
      for (let i = index + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line) continue;
        if (line.startsWith('### ')) continue;
        if (/^(Timestamp|Model):/i.test(line)) continue;
        if (/^\d{1,2}:\d{2}(?::\d{2})?(?:\s+[A-Za-z][\w-]*)?$/i.test(line)) continue;
        if (/^(這是關於|這份|請幫我|幫我做|請整理|你幫我)/.test(line)) continue;
        if (line.startsWith('## ')) break;
        return line.slice(0, 180);
      }
      return null;
    };
    const firstMeaningfulParagraph = (): string | null => {
      for (const line of lines) {
        if (!line || line.startsWith('#') || line.startsWith('- Generated in Prism')) continue;
        if (/^- (Source platform|Source kind|Project|Original ID|Synced to Prism|Updated at source|Source URL|Plan ID|Run ID|Source ID|Source type|Status|Model|Created at|Updated at|Completed at|Timestamp):/i.test(line)) {
          continue;
        }
        if (/^(Model|Timestamp):/i.test(line)) {
          continue;
        }
        return line.replace(/^- /, '').slice(0, 180);
      }
      return null;
    };

    if (relativePath.includes('/Compiler/Plans/')) {
      const sourceTitle = lines.find((line) => line.startsWith('# Compile Plan - '))?.replace('# Compile Plan - ', '').trim();
      const status = lines.find((line) => line.startsWith('- Status: '))?.replace('- Status: ', '').trim();
      const artifactCount = countSectionItems('## Proposed Changes');
      const summary = [sourceTitle, status ? `status ${status}` : null, `${artifactCount} proposed changes`].filter(Boolean).join(' · ');
      return summary || 'Compile plan summary unavailable.';
    }
    if (relativePath.includes('/Compiler/Summaries/')) {
      const sourceTitle = lines.find((line) => line.startsWith('# Compiler Summary - '))?.replace('# Compiler Summary - ', '').trim();
      const status = lines.find((line) => line.startsWith('- Status: '))?.replace('- Status: ', '').trim();
      const counts = lines.filter((line) => /^- (Concepts|Related notes|Backlink suggestions|Article candidates|Graph updates|Memory candidates|Trigger candidates):/i.test(line));
      const compactCounts = counts
        .slice(0, 3)
        .map((line) => line.replace(/^- /, '').replace(': ', ' '))
        .join(' · ');
      const summary = [sourceTitle, status ? `status ${status}` : null, compactCounts || null].filter(Boolean).join(' · ');
      return summary || 'Compiler summary unavailable.';
    }
    if (relativePath.includes('/Sources/')) {
      return firstSectionLine('## Summary') || firstSourceContentLine() || firstMeaningfulParagraph() || 'No summary yet.';
    }
    return firstSectionLine('## Definition') || firstSectionLine('## Summary') || firstMeaningfulParagraph() || 'No summary yet.';
  } catch {
    return 'No summary yet.';
  }
}

function schemaContent(): string {
  return [
    '# Prism Wiki Schema',
    '',
    'This vault is maintained by Prism as an LLM-assisted wiki.',
    '',
    '## Directory Layout',
    '- `Sources/` immutable or source-grounded raw material exports',
    '- `Meetings/` context notes for project/meeting continuity',
    '- `Observations/` incubation notes for emerging patterns',
    '- `Notes/` evergreen knowledge notes',
    '- `Concepts/` concept draft pages',
    '- `Topics/` topic draft pages',
    '- `Projects/` project draft pages',
    '- `Partners/` partner pages for collaborating companies and channel counterparts',
    '- `Entities/` general organization/entity pages for institutional nodes and structures',
    '- `Analyses/`, `Comparisons/`, `Syntheses/` query artifacts filed back into the wiki',
    '- `Compiler/Plans/` review-first compile plans preserved as markdown',
    '- `Compiler/Summaries/` compiler summaries preserved as markdown',
    '',
    '## Note Semantics',
    '- Context notes preserve current state, working decisions, open questions, and pending decisions.',
    '- Observation notes preserve candidate patterns and what would validate them.',
    '- Evergreen notes preserve important reusable knowledge structures.',
    '- Partner pages preserve collaborator-specific roles, positioning, and relationships.',
    '- Entity pages preserve organizations, governance nodes, and structural actors that are not best modeled as projects or partners.',
    '',
    '## Maintenance Rules',
    '- Raw sources are source of truth and should not be modified by wiki maintenance.',
    '- Prism may update `index.md` and append `log.md` on every ingest, export, query save, and lint run.',
    '- Prism may also write markdown records for compile plans and compiler summaries under `Compiler/`.',
    '- Draft pages under `Concepts/`, `Topics/`, `Projects/`, `Partners/`, and `Entities/` are conservative suggestions and may be refined later.',
    '- Provenance and source links should be preserved on all generated wiki pages.',
    '',
    '## Lint Workflow',
    '- Look for orphan pages, duplicate concept/topic pages, missing concept pages, stale claims, and notes without provenance.',
    '- Lint findings should be reviewed before applying manual fixes.',
    '',
  ].join('\n');
}

function buildIndex(entries: WikiIndexEntry[]): string {
  const lines: string[] = ['# Prism Wiki Index', '', 'This file catalogs the current wiki pages by section.', ''];
  for (const section of SECTION_DIRECTORIES) {
    lines.push(`## ${section.title}`);
    const sectionEntries = entries.filter((entry) => entry.relativePath.startsWith(`${section.directory}/`));
    if (sectionEntries.length === 0) {
      lines.push('- _No pages yet._', '');
      continue;
    }
    for (const entry of sectionEntries) {
      lines.push(`- ${toWikiLink(entry.relativePath, entry.title)} — ${entry.summary}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

function formatLogTimestamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

function buildLogLine(entry: WikiLogEntry): string {
  const day = new Date(entry.timestamp).toISOString().slice(0, 10);
  const bits = [
    `## [${day}] ${entry.operation} | ${entry.title}`,
    `- Timestamp: ${formatLogTimestamp(entry.timestamp)}`,
    entry.pageKind ? `- Page kind: ${entry.pageKind}` : null,
    entry.relativePath ? `- Path: ${entry.relativePath}` : null,
    entry.sourceType ? `- Source type: ${entry.sourceType}` : null,
    entry.sourceId ? `- Source ID: ${entry.sourceId}` : null,
    entry.note ? `- Note: ${entry.note}` : null,
  ].filter(Boolean) as string[];
  return `${bits.join('\n')}\n\n`;
}

function compilerPlanRelativePath(plan: Pick<CompilePlan, 'id' | 'sourceTitle' | 'createdAt'>): string {
  return normalizeSlash(
    path.join(
      'Compiler',
      'Plans',
      `${formatDatePrefix(plan.createdAt)} ${safeSlug(plan.sourceTitle || plan.id)} (${plan.id.slice(0, 8)}).md`
    )
  );
}

function compilerSummaryRelativePath(run: Pick<CompilerRunSummary, 'id' | 'sourceTitle' | 'createdAt'>): string {
  return normalizeSlash(
    path.join(
      'Compiler',
      'Summaries',
      `${formatDatePrefix(run.createdAt)} ${safeSlug(run.sourceTitle || run.id)} (${run.id.slice(0, 8)}).md`
    )
  );
}

function normalizeSummaryArticleType(candidate: ArticleCandidate): ArticleCandidate['articleType'] {
  const title = `${candidate.title} ${candidate.reason}`.toLowerCase();
  if (candidate.articleType === 'partner' || candidate.articleType === 'entity') return candidate.articleType;
  if (/(collaboration|cooperation|partnership|合作案|合作項目|合作架構|合作模式|合作框架|專案|project|workstream|deal|initiative)/i.test(candidate.title)) {
    return 'project';
  }
  if (/^(riversoft|foxit japan)$/i.test(candidate.title.trim().toLowerCase())) {
    return 'partner';
  }
  if (candidate.articleType === 'project' && /\b(riversoft|foxit japan|partner|supplier|var|reseller|distributor)\b/i.test(candidate.title)) {
    return 'partner';
  }
  if (
    candidate.articleType !== 'concept' &&
    /scsk|swc|sumitomo|住友|體系|集团|集團|organization|org\b|institution|governance|entity|window|窗口|路由|routing|ipo\b/.test(title)
  ) {
    return 'entity';
  }
  return candidate.articleType;
}

function buildNormalizedConceptDefinition(candidate: ArticleCandidate): string {
  if (/international purchasing office|(^|\b)ipo(\b|$)/i.test(candidate.title)) {
    return 'International Purchasing Office（IPO）在此類 AI Appliance 合作情境中，指代表品牌方處理採購、供應商協調、整合、測試、出貨與 fulfillment 的中介角色，可與前端銷售或 VAR 模式並存。';
  }
  return `這個概念指的是：${candidate.reason}`;
}

function buildNormalizedPartnerRole(candidate: ArticleCandidate): string {
  const lower = `${candidate.title} ${candidate.reason}`.toLowerCase();
  const roleBits: string[] = [];
  if (/ipo|procurement|採購/.test(lower)) roleBits.push('採購整合');
  if (/fulfillment|出貨|交付|測試|整合/.test(lower)) roleBits.push('履約與交付');
  if (/var|channel|reseller|渠道/.test(lower)) roleBits.push('渠道 / VAR');
  const roleText = roleBits.length ? `，並涉及 ${Array.from(new Set(roleBits)).join('、')} 等角色` : '';
  return `${candidate.title} 在這裡應被視為單一合作對象頁，重點是其角色、責任與合作方式${roleText}，而不是整個合作案的總覽。`;
}

function buildNormalizedEntityRole(candidate: ArticleCandidate): string {
  if (/^swc$/i.test(candidate.title)) {
    return 'SWC 在這裡應被視為住友 / SCSK 體系中的內部對接窗口與渠道節點，重點是它如何承接案件、控制過水路徑並維持集團內部秩序。';
  }
  return `${candidate.title} 在這裡應被視為組織、制度節點或渠道結構的一部分，重點是它如何影響治理路徑與商流安排。`;
}

function buildNormalizedEntityImportance(candidate: ArticleCandidate): string {
  if (/^swc$/i.test(candidate.title)) {
    return 'SWC 之所以重要，是因為它會影響住友體系案件應由誰出面、商流如何流轉，以及 Foxit / RiverSoft 在日本市場如何避免渠道衝突。';
  }
  return `${candidate.title} 之所以重要，是因為它決定了合作案應走哪條組織路徑、由誰出面，以及哪些渠道規則需要被遵守。`;
}

function buildNormalizedProjectScope(candidate: ArticleCandidate): string {
  return `${candidate.title} 在這裡應被視為具體合作案或合作架構頁，用來整理範圍、分工、產品化進程、渠道安排與後續推進。`;
}

function buildCompilePlanMarkdown(plan: CompilePlan): string {
  const lines: string[] = [
    `# Compile Plan - ${plan.sourceTitle}`,
    '',
    '## Metadata',
    `- Plan ID: ${plan.id}`,
    `- Source ID: ${plan.sourceId}`,
    `- Source type: ${plan.sourceType}`,
    `- Status: ${plan.status}`,
    `- Model: ${plan.model ?? 'gpt-5.4'}`,
    `- Created at: ${new Date(plan.createdAt).toISOString()}`,
    `- Updated at: ${new Date(plan.updatedAt).toISOString()}`,
    plan.appliedAt ? `- Applied at: ${new Date(plan.appliedAt).toISOString()}` : null,
    '',
    '## Source Summary',
    plan.sourceSummary || 'No summary.',
    '',
    '## Detected Artifacts',
  ].filter(Boolean) as string[];

  if (plan.detectedArtifacts.length === 0) {
    lines.push('- None');
  } else {
    for (const artifact of plan.detectedArtifacts) {
      lines.push(`- **${artifact.title}** (${artifact.pageKind}/${artifact.artifactType})`);
      lines.push(`  - Confidence: ${artifact.confidence.toFixed(2)}`);
      lines.push(`  - Rationale: ${artifact.rationale}`);
      if (artifact.rubricRationale) lines.push(`  - Rubric rationale: ${artifact.rubricRationale}`);
      if (artifact.relativePath) lines.push(`  - Target: ${artifact.relativePath}`);
      if (artifact.summary) lines.push(`  - Summary: ${artifact.summary}`);
    }
  }

  lines.push('', '## Proposed Changes');
  if (plan.items.length === 0) {
    lines.push('- None');
  } else {
    for (const item of plan.items) {
      lines.push(`- **${item.title}** (${item.pageKind}/${item.operation})`);
      lines.push(`  - Path: ${item.relativePath}`);
      lines.push(`  - Confidence: ${item.confidence.toFixed(2)}`);
      lines.push(`  - Rationale: ${item.rationale}`);
      if (item.rubricRationale) lines.push(`  - Rubric rationale: ${item.rubricRationale}`);
      if (item.diffSummary) lines.push(`  - Diff summary: ${item.diffSummary}`);
      if (item.contentPreview) lines.push(`  - Preview: ${item.contentPreview}`);
    }
  }

  if (plan.warnings?.length) {
    lines.push('', '## Warnings');
    for (const warning of plan.warnings) lines.push(`- ${warning}`);
  }

  if (plan.skippedItems?.length) {
    lines.push('', '## Skipped Items');
    for (const skipped of plan.skippedItems) lines.push(`- ${skipped}`);
  }

  if (plan.errors?.length) {
    lines.push('', '## Errors');
    for (const error of plan.errors) lines.push(`- ${error}`);
  }

  return `${lines.join('\n').trim()}\n`;
}

function buildCompilerSummaryMarkdown(run: CompilerRunSummary): string {
  const lines: string[] = [
    `# Compiler Summary - ${run.sourceTitle}`,
    '',
    '## Metadata',
    `- Run ID: ${run.id}`,
    `- Source ID: ${run.sourceId}`,
    `- Source type: ${run.sourceType}`,
    run.destinationType ? `- Destination type: ${run.destinationType}` : null,
    `- Status: ${run.status}`,
    `- Model: ${run.model ?? 'gpt-5.4'}`,
    `- Created at: ${new Date(run.createdAt).toISOString()}`,
    run.completedAt ? `- Completed at: ${new Date(run.completedAt).toISOString()}` : null,
    '',
    '## Counts',
    `- Concepts: ${run.conceptCount}`,
    `- Related notes: ${run.relatedNoteCount}`,
    `- Backlink suggestions: ${run.backlinkSuggestionCount}`,
    `- Article candidates: ${run.articleCandidateCount}`,
    `- Graph updates: ${run.graphUpdatesCount}`,
    `- Memory candidates: ${run.memoryCandidatesCount}`,
    `- Trigger candidates: ${run.triggerCandidatesCount}`,
  ].filter(Boolean) as string[];

  if (run.artifacts?.concepts?.length) {
    lines.push('', '## Concepts');
    for (const concept of run.artifacts.concepts) {
      lines.push(`- **${concept.name}** (${concept.conceptType}) — ${concept.definition}`);
    }
  }

  if (run.artifacts?.relatedNoteSuggestions?.length) {
    lines.push('', '## Related Notes');
    for (const note of run.artifacts.relatedNoteSuggestions) {
      lines.push(`- **${note.title}** (${note.noteType}) — ${note.reason}`);
    }
  }

  if (run.artifacts?.backlinkSuggestions?.length) {
    lines.push('', '## Backlink Suggestions');
    for (const suggestion of run.artifacts.backlinkSuggestions) {
      lines.push(`- **${suggestion.title}** — ${suggestion.reason}`);
    }
  }

  if (run.artifacts?.articleCandidates?.length) {
    lines.push('', '## Article Candidates');
    for (const candidate of run.artifacts.articleCandidates) {
      lines.push(`- **${candidate.title}** (${normalizeSummaryArticleType(candidate)}) — ${candidate.reason}`);
    }
  }

  if (run.errors?.length) {
    lines.push('', '## Errors');
    for (const error of run.errors) lines.push(`- ${error}`);
  }

  return `${lines.join('\n').trim()}\n`;
}

function pageKindForDestination(destinationType?: ObsidianDestinationType | null): WikiPageKind {
  switch (destinationType) {
    case 'obsidian_context':
      return 'context';
    case 'obsidian_observation':
      return 'observation';
    case 'obsidian_evergreen':
      return 'evergreen';
    case 'obsidian_source':
    default:
      return 'source';
  }
}

function relativePathForArticleCandidate(candidate: ArticleCandidate): string {
  const title = `${safeSlug(candidate.title)}.md`;
  const normalizedType = normalizeSummaryArticleType(candidate);
  if (normalizedType === 'concept') return path.join('Concepts', title);
  if (normalizedType === 'partner') return path.join('Partners', title);
  if (normalizedType === 'entity') return path.join('Entities', title);
  if (normalizedType === 'project' || normalizedType === 'client') {
    return path.join('Projects', title);
  }
  return path.join('Topics', title);
}

function articleDraftContent(candidate: ArticleCandidate, sourceLink: string | null, confidence?: number | null): string {
  const normalizedType = normalizeSummaryArticleType(candidate);
  if (normalizedType === 'concept') {
    return [
      `# ${candidate.title}`,
      '',
      '## Definition',
      buildNormalizedConceptDefinition(candidate),
      '',
      '## Status',
      `- Draft type: ${normalizedType}`,
      `- Confidence: ${typeof confidence === 'number' ? confidence.toFixed(2) : 'n/a'}`,
      '',
      '## Sources',
      sourceLink ? `- ${sourceLink}` : '- Add source links.',
      '',
      '## Provenance',
      '- Generated by Prism wiki maintenance as a concept draft page.',
      '',
    ].join('\n');
  }
  if (normalizedType === 'partner') {
    return [
      `# ${candidate.title}`,
      '',
      '## Summary',
      candidate.reason,
      '',
      '## Role',
      buildNormalizedPartnerRole(candidate),
      '',
      '## How this partner appears in the source',
      `- ${candidate.reason}`,
      `- 此頁應聚焦 ${candidate.title} 本身，而不是合作架構總覽。`,
      `- 後續應持續補入 ${candidate.title} 的具體職能、合作邊界、交付責任與與其他參與方的關係。`,
      '',
      '## Related pages',
      sourceLink ? `- ${sourceLink}` : '- Add related pages.',
      '',
      '## Sources',
      sourceLink ? `- ${sourceLink}` : '- Add source links.',
      '',
      '## Provenance',
      '- Generated by Prism wiki maintenance as a partner draft page.',
      '',
    ].join('\n');
  }
  if (normalizedType === 'entity') {
    return [
      `# ${candidate.title}`,
      '',
      '## Summary',
      candidate.reason,
      '',
      '## Structural role',
      buildNormalizedEntityRole(candidate),
      '',
      '## Why this entity matters',
      buildNormalizedEntityImportance(candidate),
      '',
      '## Related pages',
      sourceLink ? `- ${sourceLink}` : '- Add related pages.',
      '- 後續可連到日本渠道、治理節點或相關合作案頁。',
      '',
      '## Sources',
      sourceLink ? `- ${sourceLink}` : '- Add source links.',
      '',
      '## Provenance',
      '- Generated by Prism wiki maintenance as an entity draft page.',
      '',
    ].join('\n');
  }
  if (normalizedType === 'project' || normalizedType === 'client') {
    return [
      `# ${candidate.title}`,
      '',
      '## Summary',
      candidate.reason,
      '',
      '## Current scope',
      buildNormalizedProjectScope(candidate),
      '',
      '## Key threads',
      `- ${candidate.reason}`,
      '- 此頁應聚焦合作架構、角色分工、SKU 或 package 產品化與落地議題。',
      '- 後續可補入 actors、scope、pending decisions、channel routing 與 rollout 狀態。',
      '',
      '## Sources',
      sourceLink ? `- ${sourceLink}` : '- Add source links.',
      '',
      '## Provenance',
      '- Generated by Prism wiki maintenance as a project draft page.',
      '',
    ].join('\n');
  }
  return [
    `# ${candidate.title}`,
    '',
    '## Summary',
    candidate.reason,
    '',
    '## Why this topic exists',
    candidate.reason,
    '',
    '## Related concepts',
    '- To be expanded by future compile runs.',
    '',
    '## Related sources/pages',
    sourceLink ? `- ${sourceLink}` : '- Add related pages.',
    '',
    '## Provenance',
    '- Generated by Prism wiki maintenance as a topic draft page.',
    '',
  ].join('\n');
}

function conceptDraftRelativePath(name: string): string {
  return path.join('Concepts', `${safeSlug(name)}.md`);
}

function conceptDraftContent(args: {
  name: string;
  definition: string;
  sourceLink: string | null;
  conceptType: 'mention' | 'candidate_topic' | 'core_concept';
  confidence: number;
}): string {
  return [
    `# ${args.name}`,
    '',
    '## Definition',
    args.definition,
    '',
    '## Status',
    `- Concept type: ${args.conceptType}`,
    `- Confidence: ${args.confidence.toFixed(2)}`,
    '',
    '## Sources',
    args.sourceLink ? `- ${args.sourceLink}` : '- Add source links.',
    '',
    '## Provenance',
    '- Generated by Prism wiki maintenance as a concept draft.',
    '',
  ].join('\n');
}

async function writeIfMissing(filePath: string, content: string): Promise<boolean> {
  if (await exists(filePath)) return false;
  await ensureParent(filePath);
  await fs.writeFile(filePath, content.trim() + '\n', 'utf8');
  return true;
}

async function ensureInfrastructureFiles(vaultPath: string, update: WikiUpdateResult): Promise<void> {
  await fs.mkdir(vaultPath, { recursive: true });
  for (const directory of DEFAULT_DIRECTORIES) {
    await fs.mkdir(path.join(vaultPath, directory), { recursive: true });
  }
  const schemaPath = path.join(vaultPath, WIKI_SCHEMA_FILE);
  const schemaBody = schemaContent();
  if (!(await exists(schemaPath))) {
    await fs.writeFile(schemaPath, schemaBody, 'utf8');
    update.ensuredFiles.push(schemaPath);
  }
  const schemaAliasPath = path.join(vaultPath, SCHEMA_ALIAS_FILE);
  if (!(await exists(schemaAliasPath))) {
    await fs.writeFile(schemaAliasPath, schemaBody, 'utf8');
    update.ensuredFiles.push(schemaAliasPath);
  }
  const indexPath = path.join(vaultPath, INDEX_FILE);
  if (!(await exists(indexPath))) {
    await fs.writeFile(indexPath, '# Prism Wiki Index\n\n- _No pages yet._\n', 'utf8');
    update.ensuredFiles.push(indexPath);
  }
  const logPath = path.join(vaultPath, LOG_FILE);
  if (!(await exists(logPath))) {
    await fs.writeFile(logPath, '# Prism Wiki Log\n\n', 'utf8');
    update.ensuredFiles.push(logPath);
  }
}

async function buildIndexEntries(vaultPath: string): Promise<WikiIndexEntry[]> {
  const entries: WikiIndexEntry[] = [];
  for (const section of SECTION_DIRECTORIES) {
    const files = await listMarkdownFiles(path.join(vaultPath, section.directory), section.directory);
    for (const relativePath of files) {
      const filePath = path.join(vaultPath, relativePath);
      const stats = await fs.stat(filePath);
      entries.push({
        title: titleFromRelativePath(relativePath),
        relativePath: normalizeSlash(relativePath),
        summary: await summarizeMarkdown(filePath),
        pageKind: section.pageKind,
        updatedAt: stats.mtimeMs,
      });
    }
  }
  return entries;
}

async function updateIndex(vaultPath: string, update: WikiUpdateResult): Promise<void> {
  const entries = await buildIndexEntries(vaultPath);
  const indexPath = path.join(vaultPath, INDEX_FILE);
  await fs.writeFile(indexPath, buildIndex(entries), 'utf8');
  update.indexUpdated = true;
  if (!update.updatedFiles.includes(indexPath)) update.updatedFiles.push(indexPath);
}

async function appendLog(vaultPath: string, entry: WikiLogEntry, update: WikiUpdateResult): Promise<void> {
  const logPath = path.join(vaultPath, LOG_FILE);
  await fs.appendFile(logPath, buildLogLine(entry), 'utf8');
  update.logAppended = true;
  update.logEntry = entry;
  if (!update.updatedFiles.includes(logPath)) update.updatedFiles.push(logPath);
}

async function createDraftPages(
  vaultPath: string,
  compilerRun: CompilerRunSummary | null | undefined,
  sourceLink: string | null,
  update: WikiUpdateResult
): Promise<void> {
  if (!compilerRun?.artifacts) return;

  for (const concept of compilerRun.artifacts.concepts ?? []) {
    if (concept.conceptType === 'mention') continue;
    const relativePath = conceptDraftRelativePath(concept.name);
    const filePath = path.join(vaultPath, relativePath);
    const created = await writeIfMissing(
      filePath,
      conceptDraftContent({
        name: concept.name,
        definition: concept.definition,
        sourceLink,
        conceptType: concept.conceptType,
        confidence: concept.confidence,
      })
    );
    if (created) update.createdDrafts.push(filePath);
  }

  for (const candidate of compilerRun.artifacts.articleCandidates ?? []) {
    const relativePath = relativePathForArticleCandidate(candidate);
    const filePath = path.join(vaultPath, relativePath);
    const created = await writeIfMissing(filePath, articleDraftContent(candidate, sourceLink, candidate.confidence));
    if (created) update.createdDrafts.push(filePath);
  }
}

export async function ensureWikiInfrastructure(vaultPath: string): Promise<WikiUpdateResult> {
  const update: WikiUpdateResult = {
    ensuredFiles: [],
    writtenFiles: [],
    updatedFiles: [],
    createdDrafts: [],
    indexUpdated: false,
    logAppended: false,
    logEntry: null,
  };
  await ensureInfrastructureFiles(vaultPath, update);
  await updateIndex(vaultPath, update);
  return update;
}

export async function writeCompilePlanMarkdown(vaultPath: string, plan: CompilePlan): Promise<WikiUpdateResult> {
  const update: WikiUpdateResult = {
    ensuredFiles: [],
    writtenFiles: [],
    updatedFiles: [],
    createdDrafts: [],
    indexUpdated: false,
    logAppended: false,
    logEntry: null,
  };
  await ensureInfrastructureFiles(vaultPath, update);
  const relativePath = compilerPlanRelativePath(plan);
  const filePath = path.join(vaultPath, relativePath);
  await ensureParent(filePath);
  await fs.writeFile(filePath, buildCompilePlanMarkdown(plan), 'utf8');
  update.writtenFiles.push(filePath);
  await updateIndex(vaultPath, update);
  await appendLog(
    vaultPath,
    {
      id: uuid(),
      timestamp: Date.now(),
      operation: 'export',
      title: `Compile Plan: ${plan.sourceTitle}`,
      pageKind: 'compile_plan',
      relativePath,
      sourceId: plan.sourceId,
      sourceType: plan.sourceType,
      note: `Compile plan ${plan.id} saved as markdown.`,
    },
    update
  );
  return update;
}

export async function writeCompilerSummaryMarkdown(vaultPath: string, run: CompilerRunSummary): Promise<WikiUpdateResult> {
  const update: WikiUpdateResult = {
    ensuredFiles: [],
    writtenFiles: [],
    updatedFiles: [],
    createdDrafts: [],
    indexUpdated: false,
    logAppended: false,
    logEntry: null,
  };
  await ensureInfrastructureFiles(vaultPath, update);
  const relativePath = compilerSummaryRelativePath(run);
  const filePath = path.join(vaultPath, relativePath);
  await ensureParent(filePath);
  await fs.writeFile(filePath, buildCompilerSummaryMarkdown(run), 'utf8');
  update.writtenFiles.push(filePath);
  await updateIndex(vaultPath, update);
  await appendLog(
    vaultPath,
    {
      id: uuid(),
      timestamp: Date.now(),
      operation: 'export',
      title: `Compiler Summary: ${run.sourceTitle}`,
      pageKind: 'compiler_summary',
      relativePath,
      sourceId: run.sourceId,
      sourceType: run.sourceType,
      note: `Compiler summary ${run.id} saved as markdown.`,
    },
    update
  );
  return update;
}

export async function applyWikiPageWrites(args: {
  vaultPath: string;
  writes: Array<{
    relativePath: string;
    content: string;
    operation: 'create' | 'update' | 'append';
    relocateFrom?: string | null;
  }>;
  logEntries?: WikiLogEntry[];
}): Promise<WikiUpdateResult> {
  const update: WikiUpdateResult = {
    ensuredFiles: [],
    writtenFiles: [],
    updatedFiles: [],
    createdDrafts: [],
    indexUpdated: false,
    logAppended: false,
    logEntry: null,
  };
  await ensureInfrastructureFiles(args.vaultPath, update);
  for (const write of args.writes) {
    const filePath = path.join(args.vaultPath, write.relativePath);
    await ensureParent(filePath);
    if (write.relocateFrom && normalizeSlash(write.relocateFrom) !== normalizeSlash(write.relativePath)) {
      const oldPath = path.join(args.vaultPath, write.relocateFrom);
      if (await exists(oldPath)) {
        await fs.rm(oldPath, { force: true });
        if (!update.updatedFiles.includes(oldPath)) update.updatedFiles.push(oldPath);
      }
    }
    if (write.operation === 'append' && (await exists(filePath))) {
      await fs.appendFile(filePath, `${write.content.trim()}\n`, 'utf8');
      update.updatedFiles.push(filePath);
      continue;
    }
    await fs.writeFile(filePath, `${write.content.trim()}\n`, 'utf8');
    if (write.operation === 'create' && !(update.writtenFiles.includes(filePath))) {
      update.writtenFiles.push(filePath);
    } else if (!(update.updatedFiles.includes(filePath))) {
      update.updatedFiles.push(filePath);
    }
  }
  await updateIndex(args.vaultPath, update);
  for (const entry of args.logEntries ?? []) {
    await appendLog(args.vaultPath, entry, update);
  }
  return update;
}

export async function exportImportedRawSourceWithWiki(args: {
  vaultPath: string;
  conversation: ImportedConversation;
  messages: ImportedMessage[];
}): Promise<ObsidianExportResult> {
  const update: WikiUpdateResult = {
    ensuredFiles: [],
    writtenFiles: [],
    updatedFiles: [],
    createdDrafts: [],
    indexUpdated: false,
    logAppended: false,
    logEntry: null,
  };
  await ensureInfrastructureFiles(args.vaultPath, update);
  const result = await exportRawSourceNote(args.vaultPath, args.conversation, args.messages);
  update.writtenFiles.push(result.filePath);
  await updateIndex(args.vaultPath, update);
  const entry: WikiLogEntry = {
    id: uuid(),
    timestamp: Date.now(),
    operation: 'ingest',
    title: args.conversation.title,
    pageKind: 'source',
    relativePath: result.relativePath,
    sourceId: args.conversation.id,
    sourceType: (`imported_${args.conversation.sourcePlatform}` as CompiledSourceType),
    note: 'Raw source exported to wiki.',
  };
  await appendLog(args.vaultPath, entry, update);
  return { ...result, wikiUpdate: update };
}

export async function exportImportedKnowledgeNoteWithWiki(args: {
  vaultPath: string;
  conversation: ImportedConversation;
  content: string;
  title?: string;
  destinationType: ObsidianDestinationType;
  knowledgeMaturity: 'context' | 'incubating' | 'evergreen';
  compilerRunId?: string | null;
}): Promise<ObsidianExportResult> {
  const update: WikiUpdateResult = {
    ensuredFiles: [],
    writtenFiles: [],
    updatedFiles: [],
    createdDrafts: [],
    indexUpdated: false,
    logAppended: false,
    logEntry: null,
  };
  await ensureInfrastructureFiles(args.vaultPath, update);
  const result = await exportKnowledgeNote(
    args.vaultPath,
    args.conversation,
    args.content,
    args.title,
    args.destinationType,
    args.knowledgeMaturity
  );
  update.writtenFiles.push(result.filePath);
  const compilerRun = args.compilerRunId ? getCompilerRun(args.compilerRunId) : null;
  const sourceLink = toWikiLink(getRawSourceRelativePath(args.conversation), args.conversation.title);
  await createDraftPages(args.vaultPath, compilerRun, sourceLink, update);
  await updateIndex(args.vaultPath, update);
  const entry: WikiLogEntry = {
    id: uuid(),
    timestamp: Date.now(),
    operation: 'export',
    title: result.title,
    pageKind: pageKindForDestination(args.destinationType),
    relativePath: result.relativePath,
    sourceId: args.conversation.id,
    sourceType: (`imported_${args.conversation.sourcePlatform}` as CompiledSourceType),
    note: `Exported via ${args.destinationType}.`,
  };
  await appendLog(args.vaultPath, entry, update);
  return { ...result, wikiUpdate: update };
}

export async function exportNativeSessionSourceWithWiki(args: {
  vaultPath: string;
  sessionId: string;
}): Promise<ObsidianExportResult> {
  const session = getSession(args.sessionId);
  if (!session) throw new Error('Session not found');
  const messages = getSessionMessages(args.sessionId);
  if (messages.length === 0) throw new Error('Session has no messages');

  const update: WikiUpdateResult = {
    ensuredFiles: [],
    writtenFiles: [],
    updatedFiles: [],
    createdDrafts: [],
    indexUpdated: false,
    logAppended: false,
    logEntry: null,
  };
  await ensureInfrastructureFiles(args.vaultPath, update);
  const relativePath = nativeSourceRelativePath(session.id, session.title, session.createdAt);
  const filePath = path.join(args.vaultPath, relativePath);
  await ensureParent(filePath);
  await fs.writeFile(
    filePath,
    buildNativeSessionTranscript({
      sessionId: session.id,
      title: session.title || 'Untitled Prism Session',
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      interactionMode: session.interactionMode ?? null,
      messages,
    }),
    'utf8'
  );
  update.writtenFiles.push(filePath);
  await updateIndex(args.vaultPath, update);
  await appendLog(
    args.vaultPath,
    {
      id: uuid(),
      timestamp: Date.now(),
      operation: 'ingest',
      title: session.title || 'Untitled Prism Session',
      pageKind: 'source',
      relativePath,
      sourceId: session.id,
      sourceType: 'native_prism_session',
      note: 'Native Prism session exported as a raw wiki source.',
    },
    update
  );
  return {
    ok: true,
    filePath,
    relativePath,
    title: session.title || 'Untitled Prism Session',
    destinationType: 'obsidian_source',
    knowledgeMaturity: 'raw',
    wikiUpdate: update,
  };
}

function buildQueryArtifactTitle(input: SaveQueryArtifactRequest): string {
  if (input.title?.trim()) return safeSlug(input.title.trim());
  const prefix = input.artifactType === 'comparison' ? 'Comparison' : input.artifactType === 'synthesis' ? 'Synthesis' : 'Analysis';
  return `${prefix} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
}

function buildQueryArtifactMarkdown(args: {
  title: string;
  content: string;
  sessionTitle: string;
  request: SaveQueryArtifactRequest;
}): string {
  return [
    `# ${args.title}`,
    '',
    '## Summary',
    args.content.trim(),
    '',
    '## Sources',
    `- Session: ${args.sessionTitle}`,
    `- Session ID: ${args.request.sessionId}`,
    args.request.messageId ? `- Message ID: ${args.request.messageId}` : null,
    '',
    '## Provenance',
    '- Generated in Prism and filed back into the wiki as a query artifact.',
    args.request.sourceModel ? `- Source model: ${args.request.sourceModel}` : null,
    args.request.streamTarget ? `- Stream target: ${args.request.streamTarget}` : null,
    args.request.promoteTo ? `- Promotion hint: ${args.request.promoteTo}` : null,
    '',
  ].filter((line) => line !== null).join('\n');
}

export async function saveQueryArtifactToWiki(args: {
  vaultPath: string;
  request: SaveQueryArtifactRequest;
}): Promise<ObsidianExportResult> {
  const session = getSession(args.request.sessionId);
  if (!session) throw new Error('Session not found');

  const update: WikiUpdateResult = {
    ensuredFiles: [],
    writtenFiles: [],
    updatedFiles: [],
    createdDrafts: [],
    indexUpdated: false,
    logAppended: false,
    logEntry: null,
  };
  await ensureInfrastructureFiles(args.vaultPath, update);
  const directory = artifactDirectory(args.request.artifactType);
  const title = buildQueryArtifactTitle(args.request);
  const relativePath = normalizeSlash(path.join(directory, `${title}.md`));
  const filePath = path.join(args.vaultPath, relativePath);
  await ensureParent(filePath);
  await fs.writeFile(
    filePath,
    buildQueryArtifactMarkdown({
      title,
      content: args.request.content,
      sessionTitle: session.title || 'Untitled Prism Session',
      request: args.request,
    }),
    'utf8'
  );
  update.writtenFiles.push(filePath);
  await updateIndex(args.vaultPath, update);
  const entry: WikiLogEntry = {
    id: uuid(),
    timestamp: Date.now(),
    operation: 'query',
    title,
    pageKind: artifactPageKind(args.request.artifactType),
    relativePath,
    sourceId: args.request.sessionId,
    sourceType: 'native_prism_session',
    note: `Saved ${args.request.artifactType} artifact from ${args.request.streamTarget ?? 'prompt'} mode.`,
  };
  await appendLog(args.vaultPath, entry, update);
  return {
    ok: true,
    filePath,
    relativePath,
    title,
    destinationType: args.request.promoteTo ?? undefined,
    knowledgeMaturity:
      args.request.promoteTo === 'obsidian_observation'
        ? 'incubating'
        : args.request.promoteTo === 'obsidian_evergreen'
          ? 'evergreen'
          : undefined,
    wikiUpdate: update,
  };
}

function similarityKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '');
}

function pushFinding(findings: WikiLintFinding[], finding: Omit<WikiLintFinding, 'id'>): void {
  findings.push({ ...finding, id: uuid() });
}

export async function runWikiLint(args: { vaultPath: string; model?: string | null }): Promise<WikiLintRun> {
  const createdAt = Date.now();
  const findings: WikiLintFinding[] = [];
  const articleCandidates: ArticleCandidate[] = [];
  const errors: string[] = [];

  try {
    await ensureWikiInfrastructure(args.vaultPath);
    const entries = await buildIndexEntries(args.vaultPath);
    const linkMap = new Map<string, number>();
    const titles = new Map<string, WikiIndexEntry[]>();

    for (const entry of entries) {
      const normalizedTitle = similarityKey(entry.title);
      titles.set(normalizedTitle, [...(titles.get(normalizedTitle) ?? []), entry]);
      try {
        const raw = await fs.readFile(path.join(args.vaultPath, entry.relativePath), 'utf8');
        const links = raw.match(/\[\[[^\]]+\]\]/g) ?? [];
        for (const link of links) {
          const target = link.replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0].trim();
          const normalized = normalizeSlash(`${target}.md`);
          linkMap.set(normalized, (linkMap.get(normalized) ?? 0) + 1);
        }
        if (!/^##?\s+Sources\s*$/m.test(raw)) {
          pushFinding(findings, {
            severity: 'warning',
            findingType: 'missing_source_link',
            title: `Missing Sources section: ${entry.title}`,
            description: 'This page does not appear to contain a Sources section.',
            relativePath: entry.relativePath,
            suggestedFix: 'Add a Sources section with at least one raw source or supporting wiki link.',
          });
        }
        if (!/^##?\s+Provenance\s*$/m.test(raw)) {
          pushFinding(findings, {
            severity: 'warning',
            findingType: 'missing_provenance',
            title: `Missing Provenance section: ${entry.title}`,
            description: 'This page does not appear to contain a Provenance section.',
            relativePath: entry.relativePath,
            suggestedFix: 'Add a Provenance section describing source basis and interpretation boundary.',
          });
        }
      } catch (error: any) {
        errors.push(`Failed reading ${entry.relativePath}: ${error?.message || String(error)}`);
      }
    }

    for (const entry of entries) {
      if (entry.pageKind === 'source' || entry.pageKind === 'index' || entry.pageKind === 'log' || entry.pageKind === 'schema') continue;
      const inbound = linkMap.get(normalizeSlash(entry.relativePath)) ?? 0;
      if (inbound === 0) {
        pushFinding(findings, {
          severity: 'info',
          findingType: 'orphan_page',
          title: `Orphan page: ${entry.title}`,
          description: 'This page has no detected inbound wiki links.',
          relativePath: entry.relativePath,
          suggestedFix: 'Add at least one backlink from a related note or topic hub.',
        });
      }
    }

    for (const [key, group] of titles.entries()) {
      if (!key || group.length < 2) continue;
      pushFinding(findings, {
        severity: 'warning',
        findingType: 'duplicate_page',
        title: `Possible duplicate pages: ${group.map((item) => item.title).join(' / ')}`,
        description: 'These pages have highly similar normalized titles and may be duplicates or need clearer scoping.',
        relatedPaths: group.map((item) => item.relativePath),
        evidence: group.map((item) => item.relativePath),
        suggestedFix: 'Review whether these should be merged, renamed, or more clearly distinguished.',
      });
    }

    const conceptFiles = entries.filter((entry) => entry.pageKind === 'concept').map((entry) => similarityKey(entry.title));
    for (const entry of entries.filter((item) => item.pageKind === 'context' || item.pageKind === 'observation' || item.pageKind === 'evergreen')) {
      try {
        const raw = await fs.readFile(path.join(args.vaultPath, entry.relativePath), 'utf8');
        const conceptMatches = [...raw.matchAll(/- \*\*(.+?)\*\* \((?:core|candidate)\):/g)].map((match) => match[1].trim());
        for (const concept of conceptMatches) {
          if (conceptFiles.includes(similarityKey(concept))) continue;
          pushFinding(findings, {
            severity: 'info',
            findingType: 'missing_concept_page',
            title: `Missing concept page: ${concept}`,
            description: `This concept appears in ${entry.title} but no corresponding concept page was found.`,
            relativePath: entry.relativePath,
            suggestedFix: 'Create a concept draft page or link this concept to an existing concept note.',
          });
          articleCandidates.push({
            title: concept,
            articleType: 'concept',
            reason: `Mentioned in ${entry.title} without a matching concept page.`,
            confidence: 0.55,
          });
        }
      } catch {
        // ignore secondary read failure
      }
    }
  } catch (error: any) {
    errors.push(error?.message || String(error));
  }

  const status: WikiLintRun['status'] =
    errors.length === 0 ? 'completed' : findings.length > 0 ? 'partial' : 'failed';
  const completedAt = Date.now();
  const run: WikiLintRun = {
    id: uuid(),
    status,
    createdAt,
    completedAt,
    model: args.model ?? null,
    findingCount: findings.length,
    findings,
    articleCandidates: articleCandidates.slice(0, 8),
    errors: errors.length ? errors : undefined,
  };

  const db = getDb();
  db.prepare(`
    INSERT INTO wiki_lint_runs (
      id, status, created_at, completed_at, model, finding_count, findings_json, article_candidates_json, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.status,
    run.createdAt,
    run.completedAt ?? null,
    run.model ?? null,
    run.findingCount,
    JSON.stringify(run.findings),
    JSON.stringify(run.articleCandidates ?? []),
    run.errors?.join(' | ') ?? null
  );

  const update: WikiUpdateResult = {
    ensuredFiles: [],
    writtenFiles: [],
    updatedFiles: [],
    createdDrafts: [],
    indexUpdated: false,
    logAppended: false,
    logEntry: null,
  };
  await ensureInfrastructureFiles(args.vaultPath, update);
  await appendLog(
    args.vaultPath,
    {
      id: uuid(),
      timestamp: Date.now(),
      operation: 'lint',
      title: `Wiki lint (${run.findingCount} findings)`,
      pageKind: 'log',
      note: run.findingCount > 0 ? `Detected ${run.findingCount} finding(s).` : 'No findings.',
    },
    update
  );

  return run;
}

export function listWikiLintRuns(limit = 10): WikiLintRun[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM wiki_lint_runs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: string;
    status: WikiLintRun['status'];
    created_at: number;
    completed_at?: number | null;
    model?: string | null;
    finding_count: number;
    findings_json?: string | null;
    article_candidates_json?: string | null;
    error?: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
    model: row.model ?? null,
    findingCount: row.finding_count,
    findings: row.findings_json ? JSON.parse(row.findings_json) : [],
    articleCandidates: row.article_candidates_json ? JSON.parse(row.article_candidates_json) : [],
    errors: row.error ? row.error.split(' | ') : undefined,
  }));
}

export function getWikiLintRun(id: string): WikiLintRun | null {
  return listWikiLintRuns(100).find((run) => run.id === id) ?? null;
}
