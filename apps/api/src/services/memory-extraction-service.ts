import { getSessionMessages } from '../memory/conversation';
import { getDb } from '../memory/db';
import { createMemoryCandidate } from '../memory/memory-store';
import { ensureKnowledgeRelation, upsertRelationshipEvidence } from '../memory/relationship-routing-store';
import type {
  MemoryCandidate,
  MemoryLinkRole,
  MemoryType,
  RelationshipEvidence,
  RelationshipPromotionReason,
  RelationshipRoutingDecision,
} from '@prism/shared';

interface ExtractionRunItemDraft {
  candidateId?: string | null;
  memoryItemId?: string | null;
  title: string;
  memoryType: MemoryType;
  outcome: 'added' | 'duplicate_candidate' | 'duplicate_memory' | 'graph_only' | 'trigger_candidate';
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface CandidateCollection {
  candidates: MemoryCandidate[];
  added: number;
  skippedDuplicates: number;
  graphOnlyRelations: RelationshipEvidence[];
  runItems: ExtractionRunItemDraft[];
}

interface RelationshipFact {
  sourceEntityName: string;
  targetEntityName: string;
  relationType: string;
  routingDecision: RelationshipRoutingDecision;
  promotionReason?: RelationshipPromotionReason | null;
  confidence: number;
  summary: string;
  title: string;
  triggerHint?: 'follow_up' | 'monitor' | null;
  linkRole: MemoryLinkRole;
}

function emptyCollection(): CandidateCollection {
  return { candidates: [], added: 0, skippedDuplicates: 0, graphOnlyRelations: [], runItems: [] };
}

function truncate(text: string, max = 220): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function normalize(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function buildCandidateSummary(content: string): string {
  return truncate(content.replace(/\n{2,}/g, '\n'));
}

function buildCandidatePayload(sessionId: string, messageId: string, excerpt: string, extra?: Record<string, any>) {
  return {
    sources: [{ sessionId, messageId, excerpt: truncate(excerpt, 400) }],
    ...(extra ?? {}),
  };
}

function collectCandidate(
  result: ReturnType<typeof createMemoryCandidate>,
  bucket: CandidateCollection,
  draft: Omit<ExtractionRunItemDraft, 'candidateId' | 'memoryItemId' | 'outcome' | 'reason'> & {
    preferredOutcome?: 'added' | 'trigger_candidate';
    duplicateReason?: string | null;
  },
) {
  const metadata = draft.metadata ?? null;
  if (result.created) {
    bucket.candidates.push(result.candidate);
    bucket.added += 1;
    bucket.runItems.push({
      candidateId: result.candidate.id,
      memoryItemId: null,
      title: draft.title,
      memoryType: draft.memoryType,
      outcome: draft.preferredOutcome ?? 'added',
      reason: draft.duplicateReason ?? null,
      metadata,
    });
  } else {
    bucket.skippedDuplicates += 1;
    bucket.runItems.push({
      candidateId: result.reason === 'duplicate_candidate' ? result.candidate.id : null,
      memoryItemId: result.reason === 'duplicate_memory' ? result.candidate.id : null,
      title: draft.title,
      memoryType: draft.memoryType,
      outcome: result.reason === 'duplicate_memory' ? 'duplicate_memory' : 'duplicate_candidate',
      reason: draft.duplicateReason ?? result.reason ?? null,
      metadata,
    });
  }
}

function mergeCollections(target: CandidateCollection, incoming: CandidateCollection) {
  target.candidates.push(...incoming.candidates);
  target.added += incoming.added;
  target.skippedDuplicates += incoming.skippedDuplicates;
  target.graphOnlyRelations.push(...incoming.graphOnlyRelations);
  target.runItems.push(...incoming.runItems);
}

function detectPeople(content: string): Array<{ name: string; role: MemoryLinkRole }> {
  const matches: Array<{ name: string; role: MemoryLinkRole }> = [];
  const rolePatterns: Array<[RegExp, MemoryLinkRole]> = [
    [/(?:老闆|主管|上司|manager|boss)[：:\s]*([A-Za-z\u4e00-\u9fa5·\-\s]{2,30})/gi, 'manager'],
    [/(?:部下|下屬|team member|report)[：:\s]*([A-Za-z\u4e00-\u9fa5·\-\s]{2,30})/gi, 'report'],
    [/(?:客戶|client|customer)[：:\s]*([A-Za-z\u4e00-\u9fa5·\-\s]{2,40})/gi, 'customer'],
  ];
  for (const [pattern, role] of rolePatterns) {
    for (const match of content.matchAll(pattern)) {
      const name = match[1]?.trim();
      if (name) matches.push({ name, role });
    }
  }
  return matches;
}

function detectCompanyOwnership(content: string): string[] {
  const companies: string[] = [];
  for (const match of content.matchAll(/(?:負責|owner of|負責的|covers?)\s*([A-Za-z0-9\u4e00-\u9fa5&\-\s]{2,40})(?:公司|業務|產品|account)?/gi)) {
    const company = match[1]?.trim();
    if (company) companies.push(company);
  }
  return companies;
}

function detectEmployer(content: string): string | null {
  const patterns = [
    /(?:我現在在|我目前在|我在|I work at|I am at)\s*([A-Za-z0-9\u4e00-\u9fa5&.\- ]{2,60})(?:工作|任職|上班)?/i,
    /([A-Za-z0-9\u4e00-\u9fa5&.\- ]{2,60})(?:員工|同事)/i,
  ];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    const employer = match?.[1]?.trim();
    if (employer) return employer.replace(/\s+/g, ' ');
  }
  return null;
}

function detectRoleFacts(content: string): string[] {
  const roles = new Set<string>();
  const introMatch = content.match(/(?:我的職稱是|我的角色是|我是|我扮演|I am|my title is)\s*([^\n。]{2,120})/i);
  if (introMatch?.[1]) {
    roles.add(truncate(introMatch[1], 100));
  }
  for (const match of content.matchAll(/^\s*(?:\d+[.)]\s*|[-*]\s*)([^\n]{2,120})$/gm)) {
    const line = match[1]?.trim();
    if (!line) continue;
    if (/(?:需要你|幫我|評估|分析|新聞|網址|連結|http)/i.test(line)) continue;
    roles.add(truncate(line, 100));
  }
  return [...roles];
}

function extractTaskText(content: string): string | null {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const taskLines = lines.filter((line) =>
    /(?:我需要你|幫我|評估|分析|review|analyze|判讀|追蹤|提醒我|請你)/i.test(line) ||
    /^https?:\/\//i.test(line),
  );

  if (taskLines.length === 0) return null;
  return truncate(taskLines.join(' '), 220);
}

function getWorkspaceKey(content: string): string {
  const employer = detectEmployer(content);
  return employer ? `workspace:${employer.toLowerCase()}` : 'workspace:default';
}

function detectOrgMentions(content: string, employer: string | null): string[] {
  const organizations = new Set<string>();
  if (employer) organizations.add(normalize(employer));

  const explicitBrands = content.match(/\b[A-Z][A-Za-z0-9.\-]{1,30}\b/g) ?? [];
  for (const brand of explicitBrands) {
    if (brand.length < 3) continue;
    organizations.add(brand);
  }

  const knownChineseOrgs = content.match(/[A-Za-z0-9\u4e00-\u9fa5&.\-]{2,40}(?:公司|集團|團隊|品牌)/g) ?? [];
  for (const raw of knownChineseOrgs) {
    organizations.add(raw);
  }

  return [...organizations].map(normalize).filter(Boolean);
}

function hasExplicitWorkRelevance(content: string): boolean {
  return /(這是我們(?:的)?(?:競品|partner|夥伴|合作夥伴|客戶)|重點(?:競品|partner|客戶)|重要(?:競品|partner|客戶))/i.test(content);
}

function detectFollowupOrMonitorHint(content: string): 'follow_up' | 'monitor' | null {
  if (/(持續追蹤|持續關注|monitor|追這個議題|watch this|track this)/i.test(content)) return 'monitor';
  if (/(下週提醒我|提醒我|follow up|之後幫我追)/i.test(content)) return 'follow_up';
  return null;
}

function inferOrgRelationshipFacts(content: string, employer: string | null): RelationshipFact[] {
  const facts: RelationshipFact[] = [];
  const organizations = detectOrgMentions(content, employer);
  const primaryEntity = employer ? normalize(employer) : 'User';
  const otherOrganizations = organizations.filter((name) => normalize(name) !== primaryEntity);
  if (otherOrganizations.length === 0) return facts;

  const explicitWorkRelevance = hasExplicitWorkRelevance(content);
  const triggerHint = detectFollowupOrMonitorHint(content);

  const competitorSignal = /(競品|競爭對手|competitor)/i.test(content) || (/(也在做|同樣在做|also .*does)/i.test(content) && /(IDP|PDF)/i.test(content));
  const partnerSignal = /(partner|合作夥伴|合作方|夥伴|OEM|代理)/i.test(content);

  if (!competitorSignal && !partnerSignal) return facts;

  for (const org of otherOrganizations.slice(0, 4)) {
    if (competitorSignal) {
      facts.push({
        sourceEntityName: primaryEntity,
        targetEntityName: org,
        relationType: 'competitor_of',
        routingDecision: triggerHint ? 'trigger_candidate' : explicitWorkRelevance ? 'memory_candidate' : 'graph_only',
        promotionReason: triggerHint
          ? triggerHint === 'monitor'
            ? 'monitor_intent'
            : 'followup_intent'
          : explicitWorkRelevance
            ? 'explicit_work_relevance'
            : 'single_article_context',
        confidence: explicitWorkRelevance || triggerHint ? 0.8 : 0.58,
        summary: `${primaryEntity} and ${org} are discussed in a competitive context.`,
        title: `Relationship: ${primaryEntity} competitor_of ${org}`,
        triggerHint,
        linkRole: 'mentioned_entity',
      });
    }

    if (partnerSignal) {
      facts.push({
        sourceEntityName: primaryEntity,
        targetEntityName: org,
        relationType: 'partner_of',
        routingDecision: triggerHint ? 'trigger_candidate' : explicitWorkRelevance ? 'memory_candidate' : 'graph_only',
        promotionReason: triggerHint
          ? triggerHint === 'monitor'
            ? 'monitor_intent'
            : 'followup_intent'
          : explicitWorkRelevance
            ? 'explicit_work_relevance'
            : 'single_article_context',
        confidence: explicitWorkRelevance || triggerHint ? 0.8 : 0.56,
        summary: `${primaryEntity} and ${org} are discussed in a partnership context.`,
        title: `Relationship: ${primaryEntity} partner_of ${org}`,
        triggerHint,
        linkRole: 'mentioned_entity',
      });
    }
  }

  return facts;
}

function inferPeopleRelationshipFacts(content: string): RelationshipFact[] {
  const people = detectPeople(content);
  const triggerHint = detectFollowupOrMonitorHint(content);
  return people.slice(0, 6).map(({ name, role }) => {
    const relationType = role === 'manager' ? 'reports_to' : role === 'report' ? 'manages' : 'customer_of';
    return {
      sourceEntityName: 'User',
      targetEntityName: name,
      relationType,
      routingDecision: triggerHint && role === 'customer' ? 'trigger_candidate' : 'memory_candidate',
      promotionReason:
        role === 'customer'
          ? triggerHint === 'monitor'
            ? 'monitor_intent'
            : 'customer'
          : 'boss_report',
      confidence: role === 'customer' ? 0.78 : 0.74,
      summary: buildCandidateSummary(content),
      title: `Relationship: User ${relationType} ${name}`,
      triggerHint: role === 'customer' ? triggerHint : null,
      linkRole: role,
    };
  });
}

function maybeCreateProfileCandidates(sessionId: string, messageId: string, content: string): CandidateCollection {
  const result = emptyCollection();
  const employer = detectEmployer(content);
  const roleHints = detectRoleFacts(content);
  const companies = detectCompanyOwnership(content);
  if (!employer && roleHints.length === 0 && companies.length === 0) return result;

  if (employer) {
    collectCandidate(
      createMemoryCandidate({
        sessionId,
        messageId,
        scopeType: 'workspace',
        memoryType: 'profile',
        title: `Employment: ${truncate(employer, 50)}`,
        summary: `User works at ${employer}.`,
        confidence: 0.9,
        payload: buildCandidatePayload(sessionId, messageId, employer, {
          attributes: [
            { key: 'employer', value: employer },
            { key: 'employment_status', value: 'current' },
          ],
        }),
      }),
      result,
      { title: `Employment: ${truncate(employer, 50)}`, memoryType: 'profile' },
    );
  }

  for (const role of roleHints.slice(0, 6)) {
    collectCandidate(
      createMemoryCandidate({
        sessionId,
        messageId,
        scopeType: 'workspace',
        memoryType: 'profile',
        title: `Role: ${truncate(role, 50)}`,
        summary: employer ? `User works at ${employer} as ${role}.` : `User role/title: ${role}.`,
        confidence: 0.88,
        payload: buildCandidatePayload(sessionId, messageId, role, {
          attributes: [
            ...(employer ? [{ key: 'employer', value: employer }] : []),
            { key: 'role', value: role },
          ],
        }),
      }),
      result,
      { title: `Role: ${truncate(role, 50)}`, memoryType: 'profile' },
    );
  }

  if (companies.length > 0) {
    collectCandidate(
      createMemoryCandidate({
        sessionId,
        messageId,
        scopeType: 'workspace',
        memoryType: 'profile',
        title: 'Account ownership and responsibilities',
        summary: employer
          ? `User works at ${employer} and is responsible for ${companies.slice(0, 5).join(', ')}.`
          : `User is responsible for ${companies.slice(0, 5).join(', ')}.`,
        confidence: 0.82,
        payload: buildCandidatePayload(sessionId, messageId, content, {
          attributes: companies.slice(0, 5).map((company) => ({ key: 'owns_account', value: company })),
        }),
      }),
      result,
      { title: 'Account ownership and responsibilities', memoryType: 'profile' },
    );
  }

  return result;
}

function maybeCreateRelationshipCandidates(sessionId: string, messageId: string, content: string): CandidateCollection {
  const result = emptyCollection();
  const employer = detectEmployer(content);
  const workspaceKey = getWorkspaceKey(content);
  const facts = [...inferPeopleRelationshipFacts(content), ...inferOrgRelationshipFacts(content, employer)];
  if (facts.length === 0) return result;

  for (const fact of facts) {
    ensureKnowledgeRelation({
      sourceEntityName: fact.sourceEntityName,
      targetEntityName: fact.targetEntityName,
      relationType: fact.relationType,
      sourceEntityType: fact.sourceEntityName === 'User' ? 'person' : 'organization',
      targetEntityType: fact.linkRole === 'manager' || fact.linkRole === 'report' ? 'person' : 'organization',
    });

    const evidence = upsertRelationshipEvidence({
      workspaceKey,
      sourceEntityName: fact.sourceEntityName,
      targetEntityName: fact.targetEntityName,
      relationType: fact.relationType,
      routingDecision: fact.routingDecision,
      promotionReason: fact.promotionReason ?? null,
      sourceSessionId: sessionId,
      sourceMessageId: messageId,
      summary: fact.summary,
    });

    let routingDecision = evidence.routingDecision;
    let promotionReason = evidence.promotionReason ?? fact.promotionReason ?? null;

    if (
      routingDecision === 'graph_only' &&
      evidence.mentionCount >= 2 &&
      (fact.relationType === 'competitor_of' || fact.relationType === 'partner_of' || fact.relationType === 'customer_of')
    ) {
      routingDecision = 'memory_candidate';
      promotionReason = 'mention_threshold';
      upsertRelationshipEvidence({
        workspaceKey,
        sourceEntityName: fact.sourceEntityName,
        targetEntityName: fact.targetEntityName,
        relationType: fact.relationType,
        routingDecision,
        promotionReason,
        sourceSessionId: sessionId,
        sourceMessageId: messageId,
        summary: fact.summary,
      });
    }

    const metadata = {
      relationshipRoutingDecision: routingDecision,
      relationshipPromotionReason: promotionReason,
      relationshipEvidenceId: evidence.id,
      sourceEntityName: fact.sourceEntityName,
      targetEntityName: fact.targetEntityName,
      relationType: fact.relationType,
      mentionCount: evidence.mentionCount,
    };

    if (routingDecision === 'graph_only') {
      result.graphOnlyRelations.push(evidence);
      result.runItems.push({
        title: fact.title,
        memoryType: 'relationship',
        outcome: 'graph_only',
        reason: 'relationship routed to knowledge graph only',
        metadata,
      });
      continue;
    }

    collectCandidate(
      createMemoryCandidate({
        sessionId,
        messageId,
        scopeType: 'workspace',
        memoryType: 'relationship',
        title: fact.title,
        summary: fact.summary,
        confidence: fact.confidence,
        payload: buildCandidatePayload(sessionId, messageId, content, {
          entityLinks: [
            { entityName: fact.sourceEntityName, linkRole: 'subject' },
            { entityName: fact.targetEntityName, linkRole: fact.linkRole },
          ],
          edges: [
            {
              sourceEntityName: fact.sourceEntityName,
              targetEntityName: fact.targetEntityName,
              relationType: fact.relationType,
              confidence: fact.confidence,
            },
          ],
          ...metadata,
          triggerHint: fact.triggerHint ?? null,
        }),
      }),
      result,
      {
        title: fact.title,
        memoryType: 'relationship',
        preferredOutcome: routingDecision === 'trigger_candidate' ? 'trigger_candidate' : 'added',
        duplicateReason:
          routingDecision === 'trigger_candidate'
            ? 'relationship promoted to memory and trigger candidate'
            : 'relationship promoted to memory candidate',
        metadata,
      },
    );
  }

  return result;
}

function maybeCreateSituationCandidate(sessionId: string, messageId: string, content: string): CandidateCollection {
  const result = emptyCollection();
  if (content.trim().length < 40) return result;
  const taskText = extractTaskText(content);
  const title = taskText ? truncate(taskText, 60) : truncate(content.split('\n')[0] || 'Current situation', 60);
  const summary = taskText ?? buildCandidateSummary(content);
  collectCandidate(
    createMemoryCandidate({
      sessionId,
      messageId,
      scopeType: 'session',
      memoryType: 'situation',
      title,
      summary,
      confidence: taskText ? 0.76 : 0.68,
      payload: buildCandidatePayload(sessionId, messageId, content, {
        expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30,
      }),
    }),
    result,
    { title, memoryType: 'situation' },
  );
  return result;
}

function maybeCreateEventCandidate(sessionId: string, messageId: string, content: string, timestamp: number): CandidateCollection {
  const result = emptyCollection();
  if (!/(今天|昨天|上週|本週|today|yesterday|deadline|決定|會議|meeting|launch|交付)/i.test(content)) return result;
  const title = truncate(content.split('\n')[0] || 'Event memory', 60);
  collectCandidate(
    createMemoryCandidate({
      sessionId,
      messageId,
      scopeType: 'workspace',
      memoryType: 'event',
      title,
      summary: buildCandidateSummary(content),
      confidence: 0.66,
      payload: buildCandidatePayload(sessionId, messageId, content, {
        events: [{ eventType: 'conversation_event', startedAt: timestamp, timelineOrder: 0 }],
      }),
    }),
    result,
    { title, memoryType: 'event' },
  );
  return result;
}

export const memoryExtractionService = {
  extractFromSession(sessionId: string): CandidateCollection {
    const messages = getSessionMessages(sessionId);
    const result = emptyCollection();
    for (const message of messages) {
      if (!message.content?.trim()) continue;
      mergeCollections(result, maybeCreateProfileCandidates(sessionId, message.id, message.content));
      mergeCollections(result, maybeCreateRelationshipCandidates(sessionId, message.id, message.content));
      mergeCollections(result, maybeCreateSituationCandidate(sessionId, message.id, message.content));
      mergeCollections(result, maybeCreateEventCandidate(sessionId, message.id, message.content, message.timestamp));
    }
    return result;
  },

  promoteMessage(sessionId: string, messageId: string, typeHint?: MemoryType): CandidateCollection {
    const db = getDb();
    const row = db.prepare('SELECT * FROM messages WHERE id = ? AND session_id = ?').get(messageId, sessionId) as any;
    if (!row) return emptyCollection();
    const content = row.content as string;

    if (typeHint) {
      const result = emptyCollection();
      collectCandidate(
        createMemoryCandidate({
          sessionId,
          messageId,
          scopeType: typeHint === 'situation' ? 'session' : 'workspace',
          memoryType: typeHint,
          title: truncate(content.split('\n')[0] || `Promoted ${typeHint}`, 60),
          summary: buildCandidateSummary(content),
          confidence: 0.8,
          sourceKind: 'promoted_from_session',
          payload: buildCandidatePayload(sessionId, messageId, content, {
            ...(typeHint === 'event'
              ? { events: [{ eventType: 'promoted_message', startedAt: row.timestamp, timelineOrder: 0 }] }
              : {}),
          }),
        }),
        result,
        { title: truncate(content.split('\n')[0] || `Promoted ${typeHint}`, 60), memoryType: typeHint },
      );
      return result;
    }

    const result = emptyCollection();
    mergeCollections(result, maybeCreateProfileCandidates(sessionId, messageId, content));
    mergeCollections(result, maybeCreateRelationshipCandidates(sessionId, messageId, content));
    mergeCollections(result, maybeCreateSituationCandidate(sessionId, messageId, content));
    mergeCollections(result, maybeCreateEventCandidate(sessionId, messageId, content, row.timestamp));
    return result;
  },
};
