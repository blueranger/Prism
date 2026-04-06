import path from 'path';
import { v4 as uuid } from 'uuid';
import type {
  ArticleCandidate,
  ApplyCompilePlanResult,
  CompilePlan,
  CompilePlanItem,
  CompiledArtifactCandidate,
  CompiledSourceDocument,
  CompiledSourceMessage,
  CompiledSourceType,
  ConceptCandidate,
  WikiLogEntry,
  WikiPageKind,
} from '@prism/shared';
import { collectSingle } from './llm-service';
import { normalizeImportedConversation, normalizeNativeSession, runCompiler } from './compiler-service';
import { applyWikiPageWrites } from './wiki-service';
import { writeCompilePlanMarkdown, writeCompilerSummaryMarkdown } from './wiki-service';
import { createWikiCompilePlan, getWikiCompilePlan, listWikiCompilePlans, updateWikiCompilePlan } from '../memory/wiki-compile-store';
import { buildTranscript, deriveSourceUrl, getRawSourceRelativePath } from './import-transform-service';
import { getImportedConversation, getImportedMessages } from '../memory/import-store';
import { getSession } from '../memory/session';
import { getSessionMessages } from '../memory/conversation';

type SourceKind = 'imported' | 'native';
type NoteLanguage = 'zh-Hant' | 'en';

type NormalizedArticleCandidate = ArticleCandidate & {
  normalizedArticleType: ArticleCandidate['articleType'];
  normalizedTitle: string;
  relocateFrom?: string | null;
};

type SegmentedContextArtifact = {
  title: string;
  summary: string;
  currentContext: string;
  workingDecisions: string[];
  openQuestions: string[];
  itemsPendingDecision: string[];
  whyThisMattersNow: string;
  rationale: string;
  confidence: number;
};

type SegmentedObservationArtifact = {
  title: string;
  observation: string;
  whyItMayMatter: string;
  reusePotential: string;
  whatWouldValidateThis: string[];
  whereSeen: string[];
  rationale: string;
  confidence: number;
};

type SegmentedEvergreenArtifact = {
  title: string;
  summary: string;
  keyInsights: string[];
  frameworkStructure: string[];
  reusableConclusions: string[];
  whyItMatters: string;
  howItCanBeReused: string;
  rationale: string;
  confidence: number;
};

type SegmentedSource = {
  sourceSummary: string;
  contextArtifacts?: SegmentedContextArtifact[];
  observationArtifacts?: SegmentedObservationArtifact[];
  evergreenArtifacts?: SegmentedEvergreenArtifact[];
  warnings?: string[];
};

function safeParse<T>(raw: string): T | null {
  const fenced = raw.match(/```(?:json)?\n([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? raw;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    const match = candidate.match(/\{[\s\S]*\}$/m);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return null;
    }
  }
}

function normalizeSlash(value: string): string {
  return value.replace(/\\/g, '/');
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

function rawSourceRelativePath(document: CompiledSourceDocument): string {
  if (document.sourceType.startsWith('imported_')) {
    const conversation = getImportedConversation(document.sourceId);
    if (conversation) return normalizeSlash(getRawSourceRelativePath(conversation));
  }
  return normalizeSlash(path.join('Sources', 'Prism', `${formatDatePrefix(document.timestamps.createdAt)} ${safeSlug(document.title || document.sourceId)}.md`));
}

function toWikiLink(relativePath: string, title: string): string {
  return `[[${normalizeSlash(relativePath).replace(/\.md$/i, '')}|${title}]]`;
}

function detectDominantLanguage(document: CompiledSourceDocument): NoteLanguage {
  const sample = [
    document.title,
    document.projectName,
    document.workspaceName,
    ...document.messages.slice(0, 10).map((message) => message.content.slice(0, 1000)),
  ]
    .filter(Boolean)
    .join('\n');
  const cjkMatches = sample.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? [];
  const latinMatches = sample.match(/[A-Za-z]/g) ?? [];
  return cjkMatches.length >= Math.max(20, latinMatches.length * 0.35) ? 'zh-Hant' : 'en';
}

function genericSourceMarkdown(document: CompiledSourceDocument): string {
  const lines = [
    `# ${document.title}`,
    '',
    '## Metadata',
    `- Source type: ${document.sourceType}`,
    document.projectName ? `- Project: ${document.projectName}` : null,
    document.workspaceName ? `- Workspace: ${document.workspaceName}` : null,
    document.sourceUrl ? `- Source URL: ${document.sourceUrl}` : null,
    document.timestamps.createdAt ? `- Created at: ${new Date(document.timestamps.createdAt).toISOString()}` : null,
    document.timestamps.updatedAt ? `- Updated at: ${new Date(document.timestamps.updatedAt).toISOString()}` : null,
    '',
    '## Messages',
    '',
    ...document.messages.flatMap((message, index) => {
      const roleLabel = message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'User' : 'System';
      return [
        `### ${index + 1}. ${roleLabel}`,
        message.sourceModel ? `- Model: ${message.sourceModel}` : null,
        `- Timestamp: ${new Date(message.timestamp ?? Date.now()).toISOString()}`,
        '',
        message.content.trim(),
        '',
      ].filter(Boolean) as string[];
    }),
  ].filter(Boolean) as string[];
  return `${lines.join('\n').trim()}\n`;
}

function artifactRelativePath(pageKind: WikiPageKind, title: string): string {
  const file = `${safeSlug(title)}.md`;
  switch (pageKind) {
    case 'context':
      return normalizeSlash(path.join('Meetings', file));
    case 'observation':
      return normalizeSlash(path.join('Observations', file));
    case 'evergreen':
      return normalizeSlash(path.join('Notes', file));
    case 'concept':
      return normalizeSlash(path.join('Concepts', file));
    case 'topic':
      return normalizeSlash(path.join('Topics', file));
    case 'project':
      return normalizeSlash(path.join('Projects', file));
    case 'partner':
      return normalizeSlash(path.join('Partners', file));
    case 'entity':
      return normalizeSlash(path.join('Entities', file));
    default:
      return normalizeSlash(path.join('Notes', file));
  }
}

function compactSummary(text: string, limit = 220): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, limit);
}

function compactPreview(text: string, limit = 260): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, limit);
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

function rubricRationaleForPageKind(pageKind: WikiPageKind, rationale: string, language: NoteLanguage): string {
  if (language === 'zh-Hant') {
    switch (pageKind) {
      case 'context':
        return `因為這段內容主要在整理目前狀態、工作決策、未決問題與待拍板事項，所以屬於 context，而不是可直接抽象成 evergreen。${rationale ? ` ${rationale}` : ''}`;
      case 'observation':
        return `因為這段內容是可重用但仍待驗證的候選 pattern，重點在保留觀察與驗證條件，所以屬於 observation。${rationale ? ` ${rationale}` : ''}`;
      case 'evergreen':
        return `因為這段內容已具備跨情境可重用的結構與結論，可以抽象成較耐久的知識，所以屬於 evergreen。${rationale ? ` ${rationale}` : ''}`;
      case 'concept':
        return `因為這是抽象概念而不是專案或工作脈絡，最適合整理成 concept 草稿頁。${rationale ? ` ${rationale}` : ''}`;
      case 'topic':
        return `因為這個知識單位適合作為匯總多篇相關內容的主題頁，而不是單一概念或單一專案。${rationale ? ` ${rationale}` : ''}`;
      case 'project':
        return `因為這段內容指向明確的合作案或專案脈絡，應整理成 project 頁面，而不是抽象知識頁。${rationale ? ` ${rationale}` : ''}`;
      case 'partner':
        return `因為這段內容主要描述合作夥伴的角色、定位與互動方式，最適合整理成 partner 頁面。${rationale ? ` ${rationale}` : ''}`;
      case 'entity':
        return `因為這段內容主要描述組織、制度節點或一般實體，而不是合作夥伴或專案，所以屬於 entity。${rationale ? ` ${rationale}` : ''}`;
      case 'source':
        return `因為 raw source 應保持 immutable，這裡只保留來源存檔，不做知識抽象。${rationale ? ` ${rationale}` : ''}`;
      default:
        return rationale;
    }
  }
  switch (pageKind) {
    case 'context':
      return `This belongs in context because it captures current state, working decisions, open questions, and pending decisions rather than durable reusable knowledge.${rationale ? ` ${rationale}` : ''}`;
    case 'observation':
      return `This belongs in observation because it is a reusable but still tentative pattern that needs validation before becoming evergreen knowledge.${rationale ? ` ${rationale}` : ''}`;
    case 'evergreen':
      return `This belongs in evergreen because it has been abstracted into reusable structure and conclusions that can travel beyond the immediate case.${rationale ? ` ${rationale}` : ''}`;
    case 'concept':
      return `This belongs in concept because it is an abstract idea rather than a project or workstream context.${rationale ? ` ${rationale}` : ''}`;
    case 'topic':
      return `This belongs in topic because it should act as a hub that connects several related concepts, notes, or sources.${rationale ? ` ${rationale}` : ''}`;
    case 'project':
      return `This belongs in project because it captures a specific collaboration or workstream rather than generalized knowledge.${rationale ? ` ${rationale}` : ''}`;
    case 'partner':
      return `This belongs in partner because it primarily describes a collaborating company, supplier, or channel partner and its role in the system.${rationale ? ` ${rationale}` : ''}`;
    case 'entity':
      return `This belongs in entity because it primarily describes an organization, institutional node, or non-partner actor.${rationale ? ` ${rationale}` : ''}`;
    case 'source':
      return `This belongs in source because raw source pages should remain immutable and source-grounded.${rationale ? ` ${rationale}` : ''}`;
    default:
      return rationale;
  }
}

function localizeArticleTitle(title: string, pageKind: WikiPageKind, language: NoteLanguage): string {
  if (language !== 'zh-Hant' || containsCjk(title)) return title;
  const normalized = title.trim();
  if (pageKind === 'project' && /foxit/i.test(normalized) && /riversoft/i.test(normalized) && /idp/i.test(normalized)) {
    return 'Foxit 與 RiverSoft 的 IDP 合作案';
  }
  if (pageKind === 'partner' && /^RiverSoft$/i.test(normalized)) {
    return 'RiverSoft';
  }
  if (pageKind === 'entity' && /^SWC$/i.test(normalized)) {
    return 'SWC';
  }
  if (/^Foxit RiverSoft Collaboration for IDP$/i.test(normalized)) {
    return 'Foxit 與 RiverSoft 的 IDP 合作案';
  }
  if (/^SWC as Gateway for Sumitomo Group Opportunities$/i.test(normalized)) {
    return pageKind === 'entity' ? 'SWC' : 'SWC 作為住友體系合作機會的過水窗口';
  }
  if (/^IDP Appliance Commercial Models$/i.test(normalized)) {
    return 'IDP Appliance 商業模式';
  }
  if (/^International Purchasing Office in AI Appliance Partnerships$/i.test(normalized)) {
    return 'AI Appliance 合作中的 International Purchasing Office（IPO）';
  }
  if (pageKind === 'topic' && /commercial models?/i.test(normalized)) {
    return normalized.replace(/Commercial Models?/i, '商業模式');
  }
  return normalized;
}

function legacyRelocatePath(originalTitle: string, normalizedTitle: string, pageKind: WikiPageKind): string | null {
  if (pageKind === 'project' && /foxit/i.test(normalizedTitle) && /riversoft/i.test(normalizedTitle) && /idp/i.test(normalizedTitle)) {
    const currentBucket = normalizeSlash(path.join('Projects', `${safeSlug(normalizedTitle)}.md`));
    const alternates = [
      normalizeSlash(path.join('Projects', 'Foxit 與 RiverSoft 的 IDP 合作架構.md')),
      normalizeSlash(path.join('Partners', 'Foxit RiverSoft Collaboration for IDP.md')),
    ];
    return alternates.find((candidate) => candidate !== currentBucket) ?? null;
  }
  if (pageKind === 'partner' && /^RiverSoft$/i.test(normalizedTitle)) {
    return normalizeSlash(path.join('Entities', 'RiverSoft.md'));
  }
  if (pageKind === 'project' && /^Foxit RiverSoft Collaboration for IDP$/i.test(originalTitle)) {
    return normalizeSlash(path.join('Partners', `${safeSlug(originalTitle)}.md`));
  }
  if (pageKind === 'entity' && /^SWC as Gateway for Sumitomo Group Opportunities$/i.test(originalTitle)) {
    return normalizeSlash(path.join('Partners', `${safeSlug(originalTitle)}.md`));
  }
  if (pageKind === 'concept' && /^International Purchasing Office in AI Appliance Partnerships$/i.test(originalTitle)) {
    return normalizeSlash(path.join('Concepts', `${safeSlug(originalTitle)}.md`));
  }
  const legacySameBucket = normalizeSlash(path.join(
    pageKind === 'project' ? 'Projects' :
    pageKind === 'topic' ? 'Topics' :
    pageKind === 'partner' ? 'Partners' :
    pageKind === 'entity' ? 'Entities' :
    pageKind === 'concept' ? 'Concepts' : 'Notes',
    `${safeSlug(originalTitle)}.md`
  ));
  const currentBucket = normalizeSlash(path.join(
    pageKind === 'project' ? 'Projects' :
    pageKind === 'topic' ? 'Topics' :
    pageKind === 'partner' ? 'Partners' :
    pageKind === 'entity' ? 'Entities' :
    pageKind === 'concept' ? 'Concepts' : 'Notes',
    `${safeSlug(normalizedTitle)}.md`
  ));
  return legacySameBucket !== currentBucket ? legacySameBucket : null;
}

function inferArticleCandidateType(candidate: ArticleCandidate, language: NoteLanguage): NormalizedArticleCandidate {
  const lowerTitle = candidate.title.toLowerCase();
  const lowerCombined = `${candidate.title} ${candidate.reason}`.toLowerCase();
  let normalizedArticleType: ArticleCandidate['articleType'] = candidate.articleType;

  if (candidate.articleType === 'client') {
    normalizedArticleType = 'project';
  } else if (candidate.articleType === 'concept') {
    normalizedArticleType = 'concept';
  } else if (/(collaboration|cooperation|partnership|合作案|合作項目|合作架構|合作模式|合作框架|專案|project|workstream|deal|initiative)/i.test(candidate.title)) {
    normalizedArticleType = 'project';
  } else if (/^(riversoft|foxit japan)$/i.test(lowerTitle)) {
    normalizedArticleType = 'partner';
  } else if (/(scsk|swc|sumitomo|住友|體系|集團|organization|institution|governance|entity|window|窗口|routing|路由|ipo\b)/i.test(lowerCombined)) {
    normalizedArticleType = 'entity';
  } else if (/(riversoft|foxit japan|partner|supplier|var|reseller|distributor|channel partner|fulfillment hub)/i.test(lowerTitle) && !/(collaboration|cooperation|project|合作案|專案)/i.test(lowerTitle)) {
    normalizedArticleType = 'partner';
  }

  const pageKind =
    normalizedArticleType === 'concept' ? 'concept' :
    normalizedArticleType === 'partner' ? 'partner' :
    normalizedArticleType === 'entity' ? 'entity' :
    normalizedArticleType === 'project' || normalizedArticleType === 'client' ? 'project' :
    'topic';
  const normalizedTitle = localizeArticleTitle(candidate.title, pageKind, language);
  return {
    ...candidate,
    normalizedArticleType,
    normalizedTitle,
    relocateFrom: legacyRelocatePath(candidate.title, normalizedTitle, pageKind),
  };
}

function buildConceptDefinitionFromCandidate(candidate: ArticleCandidate, language: NoteLanguage): string {
  if (language === 'zh-Hant') {
    if (/international purchasing office|(^|\b)ipo(\b|$)/i.test(candidate.title)) {
      return 'International Purchasing Office（IPO）在此類 AI Appliance 合作情境中，指代表品牌方處理採購、供應商協調、整合、測試、出貨與 fulfillment 的中介角色，可與前端銷售或 VAR 模式並存。';
    }
    return `這個概念指的是：${candidate.reason}`;
  }
  if (/international purchasing office|(^|\b)ipo(\b|$)/i.test(candidate.title)) {
    return 'In this AI appliance collaboration context, an International Purchasing Office (IPO) is the intermediary role that handles procurement, supplier coordination, integration, testing, shipping, and fulfillment on behalf of the brand side.';
  }
  return `This concept refers to: ${candidate.reason}`;
}

function buildPartnerRole(candidate: ArticleCandidate, language: NoteLanguage): string {
  if (language === 'zh-Hant') {
    const lower = `${candidate.title} ${candidate.reason}`.toLowerCase();
    const roleBits: string[] = [];
    if (/ipo|procurement|採購/.test(lower)) roleBits.push('採購整合');
    if (/fulfillment|出貨|交付|測試|整合/.test(lower)) roleBits.push('履約與交付');
    if (/var|channel|reseller|渠道/.test(lower)) roleBits.push('渠道 / VAR');
    const roleText = roleBits.length ? `，並涉及 ${Array.from(new Set(roleBits)).join('、')} 等角色` : '';
    return `${candidate.title} 在這份 source 中被視為單一合作對象，主要承擔供應鏈、商務協作與落地執行責任${roleText}；這一頁應聚焦其長期可辨識的角色定位，而不是整個合作案的總覽。`;
  }
  return `${candidate.title} is treated here as a single collaborator profile, focusing on role, operational responsibility, channel position, and relationship shape rather than project-wide structure.`;
}

function buildPartnerPresence(candidate: ArticleCandidate, language: NoteLanguage): string[] {
  if (language === 'zh-Hant') {
    return [
      candidate.reason,
      `${candidate.title} 的描述應以其在合作中的角色與功能為主，而不是整個合作案的總覽。`,
      `後續應持續補入 ${candidate.title} 具體負責的職能、合作邊界與與其他參與方的關係。`,
    ];
  }
  return [
    candidate.reason,
    `${candidate.title} should be described primarily through its role in the collaboration, not as a summary of the whole project.`,
  ];
}

function buildEntityStructuralRole(candidate: ArticleCandidate, language: NoteLanguage): string {
  if (language === 'zh-Hant') {
    if (/^swc$/i.test(candidate.title)) {
      return 'SWC 在這裡被視為住友 / SCSK 體系中的內部對接窗口與渠道節點，重點是它如何承接案件、控制過水路徑並維持集團內部秩序。';
    }
    return `${candidate.title} 在此被視為組織或制度節點，重點是它如何影響治理路徑、渠道邊界、商流過水或內部協調，而不是作為單一合作夥伴。`;
  }
  return `${candidate.title} is treated here as an organizational or structural node that shapes governance paths, channel boundaries, commercial routing, or internal coordination rather than acting as a single partner.`;
}

function buildEntityImportance(candidate: ArticleCandidate, language: NoteLanguage): string {
  if (language === 'zh-Hant') {
    if (/^swc$/i.test(candidate.title)) {
      return 'SWC 之所以重要，是因為它會影響住友體系案件應由誰出面、商流如何流轉，以及 Foxit / RiverSoft 在日本市場如何避免渠道衝突。';
    }
    return `${candidate.title} 之所以重要，是因為它決定了相關合作應走哪條組織路徑、由誰出面、以及哪些渠道規則需要被遵守。`;
  }
  return `${candidate.title} matters because it determines which organizational path a collaboration should follow, who fronts the interaction, and which channel rules must be respected.`;
}

function buildProjectScope(candidate: ArticleCandidate, language: NoteLanguage): string {
  if (language === 'zh-Hant') {
    return `${candidate.title} 被視為具體合作案或合作架構頁，應整理其目前範圍、參與方分工、產品化進程、渠道策略、待落地工作與後續演化方向。`;
  }
  return `${candidate.title} is treated as a concrete collaboration or project page and should capture current scope, role split, implementation threads, and next-stage evolution.`;
}

function buildProjectThreads(candidate: ArticleCandidate, language: NoteLanguage): string[] {
  if (language === 'zh-Hant') {
    return [
      candidate.reason,
      '需要持續補充：誰擁有客戶關係、誰負責供應鏈/整合/測試/出貨、SKU 或 package 如何產品化，以及哪些工作仍待拍板。',
    ];
  }
  return [
    candidate.reason,
    'Further updates should clarify customer ownership, supply-chain/integration/testing/shipping responsibility, and pending decisions.',
  ];
}

function buildConceptDefinitionFromConcept(concept: ConceptCandidate, language: NoteLanguage): string {
  if (language === 'zh-Hant') {
    if (/international purchasing office|(^|\b)ipo(\b|$)/i.test(concept.name)) {
      return 'International Purchasing Office（IPO）在此類 AI Appliance 合作情境中，指代表品牌方處理採購、供應商協調、整合、測試、出貨與 fulfillment 的中介角色，可與前端銷售或 VAR 模式並存。';
    }
    return concept.definition;
  }
  if (/international purchasing office|(^|\b)ipo(\b|$)/i.test(concept.name)) {
    return 'In this AI appliance collaboration context, an International Purchasing Office (IPO) is the intermediary role that handles procurement, supplier coordination, integration, testing, shipping, and fulfillment on behalf of the brand side.';
  }
  return concept.definition;
}

function normalizeConceptName(name: string, language: NoteLanguage): string {
  if (language !== 'zh-Hant') return name.trim();
  const lower = name.toLowerCase();
  if (/standardized?|標準化/.test(lower) && /solution package|package|sku/.test(lower)) return '標準化 Solution Package 與 SKU';
  if (/foxit-led/.test(lower) && /riversoft-led/.test(lower)) return 'Foxit-led 與 RiverSoft-led 雙模式商業架構';
  if (/riversoft/.test(lower) && /ipo/.test(lower) && /fulfillment/.test(lower)) return 'RiverSoft 作為 Foxit 的 IPO 與 Fulfillment Hub';
  if (/swc/.test(lower) && /(住友|sumitomo)/.test(lower) && /(過水|窗口|gateway)/.test(lower)) return 'SWC 作為住友體系案件的過水窗口';
  return name.trim();
}

function conceptRelocatePath(originalName: string, normalizedName: string): string | null {
  const current = normalizeSlash(path.join('Concepts', `${safeSlug(normalizedName)}.md`));
  const legacy = normalizeSlash(path.join('Concepts', `${safeSlug(originalName)}.md`));
  return legacy !== current ? legacy : null;
}

function conceptLegacyAliasPath(normalizedName: string): string | null {
  if (normalizedName === '標準化 Solution Package 與 SKU') {
    return normalizeSlash(path.join('Concepts', '標準化 solution package SKU.md'));
  }
  if (normalizedName === 'Foxit-led 與 RiverSoft-led 雙模式商業架構') {
    return normalizeSlash(path.join('Concepts', 'Foxit-led 與 RiverSoft-led 兩種商業模式.md'));
  }
  if (normalizedName === 'RiverSoft 作為 Foxit 的 IPO 與 Fulfillment Hub') {
    return normalizeSlash(path.join('Concepts', 'RiverSoft 作為 Foxit 的 IPO fulfillment hub.md'));
  }
  if (normalizedName === 'SWC 作為住友體系案件的過水窗口') {
    return normalizeSlash(path.join('Concepts', '住友體系案件經由 SWC 過水.md'));
  }
  return null;
}

function dedupeConceptCandidates(concepts: ConceptCandidate[], language: NoteLanguage): ConceptCandidate[] {
  const byKey = new Map<string, ConceptCandidate>();
  for (const concept of concepts) {
    const normalizedName = normalizeConceptName(concept.name, language);
    const key = safeSlug(normalizedName).toLowerCase();
    const normalizedConcept = { ...concept, name: normalizedName };
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, normalizedConcept);
      continue;
    }
    const winner =
      normalizedConcept.confidence > existing.confidence
        ? normalizedConcept
        : normalizedConcept.confidence === existing.confidence && normalizedConcept.definition.length > existing.definition.length
          ? normalizedConcept
          : existing;
    byKey.set(key, winner);
  }
  return Array.from(byKey.values());
}

function dedupeArticleCandidates(candidates: ArticleCandidate[], language: NoteLanguage): ArticleCandidate[] {
  const byKey = new Map<string, ArticleCandidate>();
  for (const candidate of candidates) {
    const normalized = inferArticleCandidateType(candidate, language);
    const key = `${normalized.normalizedArticleType}:${safeSlug(normalized.normalizedTitle).toLowerCase()}`;
    const normalizedCandidate = {
      ...candidate,
      title: normalized.normalizedTitle,
      articleType: normalized.normalizedArticleType,
    } as ArticleCandidate;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, normalizedCandidate);
      continue;
    }
    const winner =
      normalizedCandidate.confidence > existing.confidence
        ? normalizedCandidate
        : normalizedCandidate.confidence === existing.confidence && normalizedCandidate.reason.length > existing.reason.length
          ? normalizedCandidate
          : existing;
    byKey.set(key, winner);
  }
  return Array.from(byKey.values());
}

function buildContextMarkdown(artifact: SegmentedContextArtifact, sourceLink: string, sourceLabel: string, model: string, language: NoteLanguage): string {
  if (language === 'zh-Hant') {
    return [
      `# ${artifact.title}`,
      '',
      '## Summary',
      artifact.summary,
      '',
      '## Current Context',
      artifact.currentContext,
      '',
      '## Working Decisions',
      ...artifact.workingDecisions.map((item) => `- ${item}`),
      '',
      '## Open Questions',
      ...artifact.openQuestions.map((item) => `- ${item}`),
      '',
      '## Items Pending Decision',
      ...artifact.itemsPendingDecision.map((item) => `- ${item}`),
      '',
      '## Why this matters now',
      artifact.whyThisMattersNow,
      '',
      '## Sources',
      `- ${sourceLink}`,
      '',
      '## Provenance',
      '- 由 Prism source-driven compiler 生成。',
      `- 來源：${sourceLabel}`,
      `- 使用模型：${model}`,
      '- 此頁面偏向工作脈絡整理，不代表成熟 evergreen 知識。',
      '',
    ].join('\n');
  }
  return [
    `# ${artifact.title}`,
    '',
    '## Summary',
    artifact.summary,
    '',
    '## Current Context',
    artifact.currentContext,
    '',
    '## Working Decisions',
    ...artifact.workingDecisions.map((item) => `- ${item}`),
    '',
    '## Open Questions',
    ...artifact.openQuestions.map((item) => `- ${item}`),
    '',
    '## Items Pending Decision',
    ...artifact.itemsPendingDecision.map((item) => `- ${item}`),
    '',
    '## Why this matters now',
    artifact.whyThisMattersNow,
    '',
    '## Sources',
    `- ${sourceLink}`,
    '',
    '## Provenance',
    '- Generated by Prism source-driven compiler.',
    `- Source basis: ${sourceLabel}`,
    `- Model: ${model}`,
    '- This page is for working context, not evergreen knowledge.',
    '',
  ].join('\n');
}

function buildObservationMarkdown(artifact: SegmentedObservationArtifact, sourceLink: string, sourceLabel: string, model: string, language: NoteLanguage): string {
  const validateLines = artifact.whatWouldValidateThis.length ? artifact.whatWouldValidateThis : [language === 'zh-Hant' ? '需要更多跨案例證據。' : 'Needs more cross-case evidence.'];
  const whereSeenLines = artifact.whereSeen.length ? artifact.whereSeen : [language === 'zh-Hant' ? '目前主要來自這份 source。' : 'Currently observed mainly in this source.'];
  if (language === 'zh-Hant') {
    return [
      `# ${artifact.title}`,
      '',
      '## Observation',
      artifact.observation,
      '',
      '## Why it may matter',
      artifact.whyItMayMatter,
      '',
      '## Reuse potential',
      artifact.reusePotential,
      '',
      '## What would validate this?',
      ...validateLines.map((item) => `- ${item}`),
      '',
      '## Where it was seen',
      ...whereSeenLines.map((item) => `- ${item}`),
      '',
      '## Sources',
      `- ${sourceLink}`,
      '',
      '## Provenance',
      '- 由 Prism source-driven compiler 生成。',
      `- 來源：${sourceLabel}`,
      `- 使用模型：${model}`,
      '- 這是 incubation note，應視為候選 pattern，而非定論。',
      '',
    ].join('\n');
  }
  return [
    `# ${artifact.title}`,
    '',
    '## Observation',
    artifact.observation,
    '',
    '## Why it may matter',
    artifact.whyItMayMatter,
    '',
    '## Reuse potential',
    artifact.reusePotential,
    '',
    '## What would validate this?',
    ...validateLines.map((item) => `- ${item}`),
    '',
    '## Where it was seen',
    ...whereSeenLines.map((item) => `- ${item}`),
    '',
    '## Sources',
    `- ${sourceLink}`,
    '',
    '## Provenance',
    '- Generated by Prism source-driven compiler.',
    `- Source basis: ${sourceLabel}`,
    `- Model: ${model}`,
    '- This is an incubation note and should be treated as a candidate pattern.',
    '',
  ].join('\n');
}

function buildEvergreenMarkdown(artifact: SegmentedEvergreenArtifact, sourceLink: string, sourceLabel: string, model: string, language: NoteLanguage): string {
  if (language === 'zh-Hant') {
    return [
      `# ${artifact.title}`,
      '',
      '## Summary',
      artifact.summary,
      '',
      '## Key Insights',
      ...artifact.keyInsights.map((item) => `- ${item}`),
      '',
      '## Framework / Structure',
      ...artifact.frameworkStructure.map((item) => `- ${item}`),
      '',
      '## Reusable Conclusions',
      ...artifact.reusableConclusions.map((item) => `- ${item}`),
      '',
      '## Why it matters',
      artifact.whyItMatters,
      '',
      '## How it can be reused',
      artifact.howItCanBeReused,
      '',
      '## Sources',
      `- ${sourceLink}`,
      '',
      '## Provenance',
      '- 由 Prism source-driven compiler 生成。',
      `- 來源：${sourceLabel}`,
      `- 使用模型：${model}`,
      '- 這份內容已抽象成可重用知識，但仍應回連到原始 source 驗證細節。',
      '',
    ].join('\n');
  }
  return [
    `# ${artifact.title}`,
    '',
    '## Summary',
    artifact.summary,
    '',
    '## Key Insights',
    ...artifact.keyInsights.map((item) => `- ${item}`),
    '',
    '## Framework / Structure',
    ...artifact.frameworkStructure.map((item) => `- ${item}`),
    '',
    '## Reusable Conclusions',
    ...artifact.reusableConclusions.map((item) => `- ${item}`),
    '',
    '## Why it matters',
    artifact.whyItMatters,
    '',
    '## How it can be reused',
    artifact.howItCanBeReused,
    '',
    '## Sources',
    `- ${sourceLink}`,
    '',
    '## Provenance',
    '- Generated by Prism source-driven compiler.',
    `- Source basis: ${sourceLabel}`,
    `- Model: ${model}`,
    '- This page abstracts reusable knowledge from the source, while keeping the source link for verification.',
    '',
  ].join('\n');
}

function buildConceptDraft(concept: ConceptCandidate, sourceLink: string, language: NoteLanguage): string {
  if (language === 'zh-Hant') {
    return [
      `# ${concept.name}`,
      '',
      '## Definition',
      buildConceptDefinitionFromConcept(concept, language),
      '',
      '## Status',
      `- 類型：${concept.conceptType}`,
      `- 信心：${concept.confidence.toFixed(2)}`,
      '',
      '## Sources',
      `- ${sourceLink}`,
      '',
      '## Provenance',
      '- 由 Prism compile plan 產生的概念草稿頁。',
      '',
    ].join('\n');
  }
  return [
    `# ${concept.name}`,
    '',
    '## Definition',
    buildConceptDefinitionFromConcept(concept, language),
    '',
    '## Status',
    `- Type: ${concept.conceptType}`,
    `- Confidence: ${concept.confidence.toFixed(2)}`,
    '',
    '## Sources',
    `- ${sourceLink}`,
    '',
    '## Provenance',
    '- Generated by Prism compile plan as a concept draft.',
    '',
  ].join('\n');
}

function buildArticleDraft(candidate: ArticleCandidate, sourceLink: string, language: NoteLanguage): string {
  const normalized = inferArticleCandidateType(candidate, language);
  const pageKind = articlePageKind(candidate, language);
  const title = normalized.normalizedTitle;
  if (language === 'zh-Hant') {
    if (pageKind === 'partner') {
      return [
        `# ${title}`,
        '',
        '## Summary',
        candidate.reason,
        '',
        '## Role',
        buildPartnerRole(candidate, language),
        '',
        '## How this partner appears in the source',
        ...buildPartnerPresence(candidate, language).map((line) => `- ${line}`),
        '',
        '## Related pages',
        `- ${sourceLink}`,
        '',
        '## Sources',
        `- ${sourceLink}`,
        '',
        '## Provenance',
        '- 由 Prism compile plan 產生的 partner 草稿頁。',
        '',
      ].join('\n');
    }
    if (pageKind === 'entity') {
      return [
        `# ${title}`,
        '',
        '## Summary',
        candidate.reason,
        '',
        '## Structural role',
        buildEntityStructuralRole(candidate, language),
        '',
        '## Why this entity matters',
        buildEntityImportance(candidate, language),
        '',
        '## Related pages',
        `- ${sourceLink}`,
        `- 後續可連到日本渠道、住友體系或相關合作案頁。`,
        '',
        '## Sources',
        `- ${sourceLink}`,
        '',
        '## Provenance',
        '- 由 Prism compile plan 產生的 entity 草稿頁。',
        '',
      ].join('\n');
    }
    if (pageKind === 'project') {
      return [
        `# ${title}`,
        '',
        '## Summary',
        candidate.reason,
        '',
        '## Current scope',
        buildProjectScope(candidate, language),
        '',
        '## Key threads',
        ...buildProjectThreads(candidate, language).map((line) => `- ${line}`),
        '',
        '## Sources',
        `- ${sourceLink}`,
        '',
        '## Provenance',
        '- 由 Prism compile plan 產生的 project 草稿頁。',
        '',
      ].join('\n');
    }
    if (pageKind === 'topic') {
      return [
        `# ${title}`,
        '',
        '## Summary',
        candidate.reason,
        '',
        '## Why this topic exists',
        candidate.reason,
        '',
        '## Related concepts',
        '- 待後續 compile 持續補齊。',
        '',
        '## Related sources/pages',
        `- ${sourceLink}`,
        '',
        '## Provenance',
        '- 由 Prism compile plan 產生的 topic 草稿頁。',
        '',
      ].join('\n');
    }
    return [
      `# ${title}`,
      '',
      '## Definition',
      buildConceptDefinitionFromCandidate(candidate, language),
      '',
      '## Status',
      `- 類型：${normalized.normalizedArticleType}`,
      `- 信心：${candidate.confidence.toFixed(2)}`,
      '',
      '## Sources',
      `- ${sourceLink}`,
      '',
      '## Provenance',
      '- 由 Prism compile plan 產生的 concept 草稿頁。',
      '',
    ].join('\n');
  }
  if (pageKind === 'partner') {
    return [
      `# ${title}`,
      '',
      '## Summary',
      candidate.reason,
      '',
      '## Role',
      buildPartnerRole(candidate, language),
      '',
      '## How this partner appears in the source',
      ...buildPartnerPresence(candidate, language).map((line) => `- ${line}`),
      '',
      '## Related pages',
      `- ${sourceLink}`,
      '',
      '## Sources',
      `- ${sourceLink}`,
      '',
      '## Provenance',
      '- Generated by Prism compile plan as a partner draft page.',
      '',
    ].join('\n');
  }
  if (pageKind === 'entity') {
    return [
      `# ${title}`,
      '',
      '## Summary',
      candidate.reason,
      '',
      '## Structural role',
      buildEntityStructuralRole(candidate, language),
      '',
      '## Why this entity matters',
      buildEntityImportance(candidate, language),
      '',
      '## Related pages',
      `- ${sourceLink}`,
      '- This page can later link to channel, governance, or project pages that depend on this entity.',
      '',
      '## Sources',
      `- ${sourceLink}`,
      '',
      '## Provenance',
      '- Generated by Prism compile plan as an entity draft page.',
      '',
    ].join('\n');
  }
  if (pageKind === 'project') {
    return [
      `# ${title}`,
      '',
      '## Summary',
      candidate.reason,
      '',
      '## Current scope',
      buildProjectScope(candidate, language),
      '',
      '## Key threads',
      ...buildProjectThreads(candidate, language).map((line) => `- ${line}`),
      '',
      '## Sources',
      `- ${sourceLink}`,
      '',
      '## Provenance',
      '- Generated by Prism compile plan as a project draft page.',
      '',
    ].join('\n');
  }
  if (pageKind === 'topic') {
    return [
      `# ${title}`,
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
      `- ${sourceLink}`,
      '',
      '## Provenance',
      '- Generated by Prism compile plan as a topic draft page.',
      '',
    ].join('\n');
  }
  return [
    `# ${title}`,
    '',
    '## Definition',
    buildConceptDefinitionFromCandidate(candidate, language),
    '',
    '## Status',
    `- Type: ${normalized.normalizedArticleType}`,
    `- Confidence: ${candidate.confidence.toFixed(2)}`,
    '',
    '## Sources',
    `- ${sourceLink}`,
    '',
    '## Provenance',
    '- Generated by Prism compile plan as a concept draft page.',
    '',
  ].join('\n');
}

function articlePageKind(candidate: ArticleCandidate, language: NoteLanguage): WikiPageKind {
  const normalized = inferArticleCandidateType(candidate, language);
  if (normalized.normalizedArticleType === 'concept') return 'concept';
  if (normalized.normalizedArticleType === 'partner') return 'partner';
  if (normalized.normalizedArticleType === 'entity') return 'entity';
  if (normalized.normalizedArticleType === 'project' || normalized.normalizedArticleType === 'client') return 'project';
  return 'topic';
}

function articleRelativePath(candidate: ArticleCandidate, language: NoteLanguage): string {
  const normalized = inferArticleCandidateType(candidate, language);
  return artifactRelativePath(articlePageKind(candidate, language), normalized.normalizedTitle);
}

async function segmentSource(document: CompiledSourceDocument, model: string): Promise<SegmentedSource> {
  const prompt = [
    `Source title: ${document.title}`,
    `Source type: ${document.sourceType}`,
    document.projectName ? `Project: ${document.projectName}` : null,
    document.workspaceName ? `Workspace: ${document.workspaceName}` : null,
    document.sourceUrl ? `Source URL: ${document.sourceUrl}` : null,
    '',
    'Read the full source and decide what wiki artifacts should exist.',
    'Return JSON only with this shape:',
    '{',
    '  "sourceSummary": "short summary",',
    '  "contextArtifacts": [{ "title": "...", "summary": "...", "currentContext": "...", "workingDecisions": ["..."], "openQuestions": ["..."], "itemsPendingDecision": ["..."], "whyThisMattersNow": "...", "rationale": "...", "confidence": 0.0 }],',
    '  "observationArtifacts": [{ "title": "...", "observation": "...", "whyItMayMatter": "...", "reusePotential": "...", "whatWouldValidateThis": ["..."], "whereSeen": ["..."], "rationale": "...", "confidence": 0.0 }],',
    '  "evergreenArtifacts": [{ "title": "...", "summary": "...", "keyInsights": ["..."], "frameworkStructure": ["..."], "reusableConclusions": ["..."], "whyItMatters": "...", "howItCanBeReused": "...", "rationale": "...", "confidence": 0.0 }],',
    '  "warnings": ["..."]',
    '}',
    '',
    'Rules:',
    '- A single source may yield zero, one, or multiple artifacts of each kind.',
    '- Only propose a context artifact if the source contains meaningful current-state, decision, or pending-decision context.',
    '- Only propose an observation artifact if the source contains a reusable but not fully settled pattern.',
    '- Only propose an evergreen artifact if the source contains important and reusable knowledge that can be abstracted beyond the immediate case.',
    '- Keep arrays focused and high-signal.',
    '- Use the source language for prose fields when possible.',
    '',
    document.normalizedTranscript,
  ].filter(Boolean).join('\n');

  const { content, error } = await collectSingle(model, [
    {
      role: 'system',
      content: 'You are Prism Source Compiler. Read a source and decide which wiki artifacts it should become. Return JSON only.',
    },
    { role: 'user', content: prompt },
  ]);
  if (error) throw new Error(error);
  const parsed = safeParse<SegmentedSource>(content);
  if (!parsed) throw new Error('Source segmentation returned invalid JSON');
  return {
    sourceSummary: parsed.sourceSummary?.trim() || compactSummary(document.normalizedTranscript, 240),
    contextArtifacts: Array.isArray(parsed.contextArtifacts) ? parsed.contextArtifacts : [],
    observationArtifacts: Array.isArray(parsed.observationArtifacts) ? parsed.observationArtifacts : [],
    evergreenArtifacts: Array.isArray(parsed.evergreenArtifacts) ? parsed.evergreenArtifacts : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
  };
}

function buildDiffSummary(operation: 'create' | 'update' | 'append' | 'no_op', rationale: string): string {
  if (operation === 'create') return `Create new page. ${rationale}`;
  if (operation === 'append') return `Append a compiler update block to an existing page. ${rationale}`;
  if (operation === 'update') return `Refresh existing page sections conservatively. ${rationale}`;
  return `No change needed. ${rationale}`;
}

function toArtifactCandidate(item: CompilePlanItem): CompiledArtifactCandidate {
  return {
    id: item.id,
    artifactType: item.artifactType,
    pageKind: item.pageKind,
    title: item.title,
    summary: item.diffSummary || item.rationale,
    rationale: item.rationale,
    confidence: item.confidence,
    relativePath: item.relativePath,
    contentPreview: item.contentPreview,
    metadata: item.metadata ?? null,
  };
}

async function buildPlanItems(args: {
  vaultPath: string;
  document: CompiledSourceDocument;
  model: string;
  segmented: SegmentedSource;
  compilerArtifacts: Awaited<ReturnType<typeof runCompiler>>['artifacts'];
}): Promise<CompilePlanItem[]> {
  const language = detectDominantLanguage(args.document);
  const sourceRelativePath = rawSourceRelativePath(args.document);
  const sourceLink = toWikiLink(sourceRelativePath, args.document.title);
  const sourceLabel = args.document.title;
  const items: CompilePlanItem[] = [];
  const sourceFileExists = await fileExists(path.join(args.vaultPath, sourceRelativePath));
  const rawSourcePreview =
    language === 'zh-Hant'
      ? `來源摘要：${compactPreview(args.segmented.sourceSummary, 220)}\n來源路徑：${sourceRelativePath}`
      : `Source summary: ${compactPreview(args.segmented.sourceSummary, 220)}\nSource path: ${sourceRelativePath}`;
  items.push({
    id: uuid(),
    artifactType: 'raw_source',
    pageKind: 'source',
    operation: sourceFileExists ? 'no_op' : 'create',
    title: args.document.title,
    relativePath: sourceRelativePath,
    rationale: sourceFileExists
      ? 'Raw source page already exists and should remain immutable.'
      : 'Every compiled source should be preserved as an immutable raw source page.',
    rubricRationale: rubricRationaleForPageKind(
      'source',
      sourceFileExists
        ? 'Raw source page already exists and should remain immutable.'
        : 'Every compiled source should be preserved as an immutable raw source page.',
      language
    ),
    confidence: 1,
    contentPreview: rawSourcePreview,
    diffSummary: sourceFileExists
      ? 'No-op because raw source already exists.'
      : 'Create immutable raw source page from the source transcript.',
    selectedByDefault: !sourceFileExists,
    metadata: {
      content: genericSourceMarkdown(args.document),
      sourceId: args.document.sourceId,
      sourceType: args.document.sourceType,
    },
  });

  for (const artifact of args.segmented.contextArtifacts ?? []) {
    const relativePath = artifactRelativePath('context', artifact.title);
    const exists = await fileExists(path.join(args.vaultPath, relativePath));
    const content = buildContextMarkdown(artifact, sourceLink, sourceLabel, args.model, language);
    items.push({
      id: uuid(),
      artifactType: 'context',
      pageKind: 'context',
      operation: exists ? 'append' : 'create',
      title: artifact.title,
      relativePath,
      rationale: artifact.rationale,
      rubricRationale: rubricRationaleForPageKind('context', artifact.rationale, language),
      confidence: artifact.confidence,
      contentPreview: compactPreview(artifact.summary),
      diffSummary: buildDiffSummary(exists ? 'append' : 'create', artifact.rationale),
      selectedByDefault: true,
      metadata: {
        content,
        appendContent: `\n## Prism Compile Update\n${artifact.summary}\n\n### Working Decisions\n${artifact.workingDecisions.map((item) => `- ${item}`).join('\n')}\n\n### Open Questions\n${artifact.openQuestions.map((item) => `- ${item}`).join('\n')}\n`,
      },
    });
  }

  for (const artifact of args.segmented.observationArtifacts ?? []) {
    const relativePath = artifactRelativePath('observation', artifact.title);
    const exists = await fileExists(path.join(args.vaultPath, relativePath));
    const content = buildObservationMarkdown(artifact, sourceLink, sourceLabel, args.model, language);
    items.push({
      id: uuid(),
      artifactType: 'observation',
      pageKind: 'observation',
      operation: exists ? 'append' : 'create',
      title: artifact.title,
      relativePath,
      rationale: artifact.rationale,
      rubricRationale: rubricRationaleForPageKind('observation', artifact.rationale, language),
      confidence: artifact.confidence,
      contentPreview: compactPreview(artifact.observation),
      diffSummary: buildDiffSummary(exists ? 'append' : 'create', artifact.rationale),
      selectedByDefault: true,
      metadata: {
        content,
        appendContent: `\n## Prism Compile Update\n${artifact.observation}\n\n### What would validate this?\n${artifact.whatWouldValidateThis.map((item) => `- ${item}`).join('\n')}\n`,
      },
    });
  }

  for (const artifact of args.segmented.evergreenArtifacts ?? []) {
    const relativePath = artifactRelativePath('evergreen', artifact.title);
    const exists = await fileExists(path.join(args.vaultPath, relativePath));
    const content = buildEvergreenMarkdown(artifact, sourceLink, sourceLabel, args.model, language);
    items.push({
      id: uuid(),
      artifactType: 'evergreen',
      pageKind: 'evergreen',
      operation: exists ? 'append' : 'create',
      title: artifact.title,
      relativePath,
      rationale: artifact.rationale,
      rubricRationale: rubricRationaleForPageKind('evergreen', artifact.rationale, language),
      confidence: artifact.confidence,
      contentPreview: compactPreview(artifact.summary),
      diffSummary: buildDiffSummary(exists ? 'append' : 'create', artifact.rationale),
      selectedByDefault: true,
      metadata: {
        content,
        appendContent: `\n## Prism Compile Update\n${artifact.summary}\n\n### Reusable Conclusions\n${artifact.reusableConclusions.map((item) => `- ${item}`).join('\n')}\n`,
      },
    });
  }

  for (const concept of dedupeConceptCandidates((args.compilerArtifacts?.concepts ?? []).filter((item) => item.conceptType !== 'mention'), language).slice(0, 6)) {
    const relativePath = artifactRelativePath('concept', concept.name);
    const exists = await fileExists(path.join(args.vaultPath, relativePath));
    const relocateFrom = conceptLegacyAliasPath(concept.name);
    items.push({
      id: uuid(),
      artifactType: 'concept',
      pageKind: 'concept',
      operation: exists ? 'append' : 'create',
      title: concept.name,
      relativePath,
      rationale: `This source reinforces the concept "${concept.name}".`,
      rubricRationale: rubricRationaleForPageKind('concept', `This source reinforces the concept "${concept.name}".`, language),
      confidence: concept.confidence,
      contentPreview: compactPreview(concept.definition),
      diffSummary: relocateFrom
        ? `Relocate + replace from ${relocateFrom}. Concept detected as ${concept.conceptType}.`
        : buildDiffSummary(exists ? 'append' : 'create', `Concept detected as ${concept.conceptType}.`),
      selectedByDefault: !exists,
      metadata: {
        content: buildConceptDraft(concept, sourceLink, language),
        appendContent: `\n## Prism Compile Update\n- Seen again in ${sourceLink}\n- ${concept.definition}\n`,
        relocateFrom,
        reviewMode: relocateFrom ? 'relocate_replace' : null,
      },
    });
  }

  for (const candidate of dedupeArticleCandidates(args.compilerArtifacts?.articleCandidates ?? [], language).slice(0, 4)) {
    const normalizedCandidate = inferArticleCandidateType(candidate, language);
    const pageKind = articlePageKind(candidate, language);
    const relativePath = articleRelativePath(candidate, language);
    const exists = await fileExists(path.join(args.vaultPath, relativePath));
    const artifactType =
      pageKind === 'topic'
        ? 'topic'
        : pageKind === 'partner'
          ? 'partner'
          : pageKind === 'entity'
            ? 'entity'
            : 'project';
    items.push({
      id: uuid(),
      artifactType,
      pageKind,
      operation: exists ? 'append' : 'create',
      title: normalizedCandidate.normalizedTitle,
      relativePath,
      rationale: candidate.reason,
      rubricRationale: rubricRationaleForPageKind(pageKind, candidate.reason, language),
      confidence: candidate.confidence,
      contentPreview: compactPreview(candidate.reason),
      diffSummary: normalizedCandidate.relocateFrom
        ? `Relocate + replace from ${normalizedCandidate.relocateFrom}. ${candidate.reason}`
        : buildDiffSummary(exists ? 'append' : 'create', candidate.reason),
      selectedByDefault: !exists,
      metadata: {
        content: buildArticleDraft({ ...candidate, title: normalizedCandidate.normalizedTitle, articleType: normalizedCandidate.normalizedArticleType }, sourceLink, language),
        appendContent: `\n## Prism Compile Suggestion\n- ${candidate.reason}\n- Source: ${sourceLink}\n`,
        relocateFrom: normalizedCandidate.relocateFrom,
        reviewMode: normalizedCandidate.relocateFrom ? 'relocate_replace' : null,
      },
    });
  }

  items.push({
    id: uuid(),
    artifactType: 'index_update',
    pageKind: 'index',
    operation: 'update',
    title: 'index.md',
    relativePath: 'index.md',
    rationale: 'Index should reflect newly created or updated pages after apply.',
    rubricRationale: language === 'zh-Hant' ? '這不是知識分類本身，而是 wiki 基礎設施更新，用來讓索引反映此次 apply 結果。' : 'This is infrastructure maintenance rather than a knowledge artifact; the wiki index must reflect applied changes.',
    confidence: 1,
    diffSummary: 'Refresh wiki index after applying selected items.',
    selectedByDefault: true,
  });
  items.push({
    id: uuid(),
    artifactType: 'log_update',
    pageKind: 'log',
    operation: 'append',
    title: 'log.md',
    relativePath: 'log.md',
    rationale: 'Every compile apply should be recorded in the wiki log.',
    rubricRationale: language === 'zh-Hant' ? '這不是知識頁面，而是 wiki 演化紀錄，用來保留這次 compile 的時間序列痕跡。' : 'This is a wiki evolution record rather than a knowledge page; every apply should leave a chronological trace.',
    confidence: 1,
    diffSummary: 'Append compile application entries to the wiki log.',
    selectedByDefault: true,
  });
  return items;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await import('fs/promises').then((fs) => fs.access(filePath));
    return true;
  } catch {
    return false;
  }
}

async function normalizeSource(sourceKind: SourceKind, sourceId: string): Promise<CompiledSourceDocument> {
  return sourceKind === 'imported' ? normalizeImportedConversation(sourceId) : normalizeNativeSession(sourceId);
}

export async function compileSourceToPlan(args: {
  sourceKind: SourceKind;
  sourceId: string;
  vaultPath: string;
  model?: string;
}): Promise<{ plan: CompilePlan; compilerRun: Awaited<ReturnType<typeof runCompiler>> }> {
  const model = args.model || 'gpt-5.4';
  const document = await normalizeSource(args.sourceKind, args.sourceId);
  const compilerRun = await runCompiler({
    sourceKind: args.sourceKind,
    sourceId: args.sourceId,
    destinationType: null,
    model,
  });
  const language = detectDominantLanguage(document);
  if (compilerRun.artifacts?.concepts?.length) {
    compilerRun.artifacts.concepts = dedupeConceptCandidates(compilerRun.artifacts.concepts, language);
  }
  if (compilerRun.artifacts?.articleCandidates?.length) {
    compilerRun.artifacts.articleCandidates = dedupeArticleCandidates(compilerRun.artifacts.articleCandidates, language);
  }
  const segmented = await segmentSource(document, model);
  const items = await buildPlanItems({
    vaultPath: args.vaultPath,
    document,
    model,
    segmented,
    compilerArtifacts: compilerRun.artifacts,
  });
  const detectedArtifacts = items
    .filter((item) => !['index', 'log'].includes(item.pageKind))
    .map(toArtifactCandidate);
  const plan = createWikiCompilePlan({
    sourceId: document.sourceId,
    sourceType: document.sourceType,
    sourceTitle: document.title,
    model,
    sourceSummary: segmented.sourceSummary,
    detectedArtifacts,
    items,
    warnings: segmented.warnings ?? [],
    skippedItems: items.filter((item) => item.operation === 'no_op').map((item) => item.title),
    errors: compilerRun.errors ?? [],
  });
  await writeCompilerSummaryMarkdown(args.vaultPath, compilerRun);
  await writeCompilePlanMarkdown(args.vaultPath, plan);
  return { plan, compilerRun };
}

export function listCompilePlans(args: { sourceId?: string; sourceType?: CompiledSourceType; limit?: number } = {}): CompilePlan[] {
  return listWikiCompilePlans(args);
}

export function getCompilePlan(id: string): CompilePlan | null {
  return getWikiCompilePlan(id);
}

export async function rejectCompilePlan(id: string, vaultPath: string): Promise<CompilePlan | null> {
  const plan = updateWikiCompilePlan(id, { status: 'rejected' });
  if (plan) {
    await writeCompilePlanMarkdown(vaultPath, plan);
  }
  return plan;
}

export async function applyCompilePlan(args: {
  planId: string;
  vaultPath: string;
  itemIds?: string[];
}): Promise<ApplyCompilePlanResult> {
  const plan = getWikiCompilePlan(args.planId);
  if (!plan) throw new Error('Compile plan not found');
  const selectedIds = new Set((args.itemIds?.length ? args.itemIds : plan.items.filter((item) => item.selectedByDefault !== false).map((item) => item.id)));
  const writes: Array<{ relativePath: string; content: string; operation: 'create' | 'update' | 'append'; relocateFrom?: string | null }> = [];
  const logEntries: WikiLogEntry[] = [];
  const appliedItemIds: string[] = [];

  for (const item of plan.items) {
    if (!selectedIds.has(item.id)) continue;
    if (item.pageKind === 'index' || item.pageKind === 'log' || item.operation === 'no_op') continue;
    const metadata = item.metadata ?? {};
    const content = typeof metadata.content === 'string'
      ? metadata.content
      : typeof metadata.appendContent === 'string'
        ? metadata.appendContent
        : null;
    if (!content) continue;
    const operation = item.operation === 'append' ? 'append' : item.operation === 'update' ? 'update' : 'create';
    writes.push({
      relativePath: item.relativePath,
      content: operation === 'append' && typeof metadata.appendContent === 'string' ? metadata.appendContent : content,
      operation,
      relocateFrom: typeof metadata.relocateFrom === 'string' ? metadata.relocateFrom : null,
    });
    logEntries.push({
      id: uuid(),
      timestamp: Date.now(),
      operation: 'export',
      title: item.title,
      pageKind: item.pageKind,
      relativePath: item.relativePath,
      sourceId: plan.sourceId,
      sourceType: plan.sourceType,
      note: typeof metadata.relocateFrom === 'string'
        ? `Applied compile plan ${plan.id} via relocate + replace from ${metadata.relocateFrom}.`
        : `Applied compile plan ${plan.id} via ${item.operation}.`,
    });
    appliedItemIds.push(item.id);
  }

  const wikiUpdate = await applyWikiPageWrites({
    vaultPath: args.vaultPath,
    writes,
    logEntries,
  });

  const appliedSet = new Set(appliedItemIds);
  const actionableSelectedCount = plan.items.filter((item) =>
    selectedIds.has(item.id) && item.pageKind !== 'index' && item.pageKind !== 'log' && item.operation !== 'no_op'
  ).length;
  const status: CompilePlan['status'] =
    actionableSelectedCount === 0
      ? 'rejected'
      : appliedItemIds.length === actionableSelectedCount
        ? 'fully_applied'
        : appliedItemIds.length > 0
          ? 'partially_applied'
          : 'failed';
  const updatedPlan = updateWikiCompilePlan(plan.id, {
    status,
    appliedAt: Date.now(),
  });
  if (updatedPlan) {
    await writeCompilePlanMarkdown(args.vaultPath, updatedPlan);
  }
  return {
    plan: {
      ...(updatedPlan ?? plan),
      items: (updatedPlan ?? plan).items.map((item) => ({
        ...item,
        metadata: item.metadata ?? null,
      })),
    },
    appliedItemIds: Array.from(appliedSet),
    wikiUpdate,
  };
}
