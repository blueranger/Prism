import type { MemoryExtractionTrigger, MemoryType, TriggerAction, TriggerType } from '@prism/shared';
import { getSessionMessages } from '../memory/conversation';
import { createMemoryExtractionRun, addMemoryExtractionRunItems } from '../memory/memory-observability-store';
import { upsertWorkingMemory } from '../memory/working-memory-store';
import { createTriggerCandidate } from '../memory/trigger-store';
import { memoryExtractionService } from './memory-extraction-service';
import { listMemory } from '../memory/memory-store';

function buildWorkingSummary(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function inferTriggerCandidatesFromText(args: {
  sessionId?: string | null;
  sourceCandidateId?: string | null;
  sourceMemoryItemId?: string | null;
  content: string;
}): Array<{
  triggerType: TriggerType;
  title: string;
  summary: string;
  triggerAt?: number | null;
  action: TriggerAction;
}> {
  const text = args.content;
  const results: Array<{
    triggerType: TriggerType;
    title: string;
    summary: string;
    triggerAt?: number | null;
    action: TriggerAction;
  }> = [];

  if (/(下週提醒我|提醒我|remind me|follow up|之後幫我追)/i.test(text)) {
    results.push({
      triggerType: 'follow_up',
      title: 'Follow up requested',
      summary: buildWorkingSummary(text),
      triggerAt: Date.now() + 1000 * 60 * 60 * 24 * 7,
      action: {
        type: 'reminder',
        label: 'Follow up with the user on this topic',
        payload: { sessionId: args.sessionId ?? null },
      },
    });
  }

  if (/(明天|下週|下周|月底|deadline|due|by next week|before .*週|before .*月)/i.test(text)) {
    results.push({
      triggerType: 'deadline',
      title: 'Deadline or time-based follow-up',
      summary: buildWorkingSummary(text),
      triggerAt: Date.now() + 1000 * 60 * 60 * 24 * 2,
      action: {
        type: 'ask_for_review',
        label: 'Review approaching deadline',
        payload: { sessionId: args.sessionId ?? null },
      },
    });
  }

  if (/(持續追蹤|持續關注|monitor|追蹤這家公司|追這個議題|watch this|track this)/i.test(text)) {
    results.push({
      triggerType: 'monitor',
      title: 'Monitoring requested',
      summary: buildWorkingSummary(text),
      action: {
        type: 'start_monitoring',
        label: 'Start or update monitoring rule',
        payload: { sessionId: args.sessionId ?? null },
      },
    });
  }

  return results;
}

function inferTriggerCandidatesFromCandidate(args: {
  sessionId?: string | null;
  candidate: { id: string; title: string; summary: string; confidence: number; memoryType: MemoryType; payload?: Record<string, any> };
}) {
  const routingDecision = args.candidate.payload?.relationshipRoutingDecision;
  const triggerHint = args.candidate.payload?.triggerHint;
  if (args.candidate.memoryType !== 'relationship') return [];
  if (routingDecision !== 'trigger_candidate') return [];

  const triggerType: TriggerType = triggerHint === 'monitor' ? 'monitor' : 'follow_up';
  const action: TriggerAction =
    triggerType === 'monitor'
      ? {
          type: 'start_monitoring',
          label: 'Start or update monitoring for this relationship',
          payload: {
            sessionId: args.sessionId ?? null,
            relationType: args.candidate.payload?.relationType ?? null,
            targetEntityName: args.candidate.payload?.targetEntityName ?? null,
          },
        }
      : {
          type: 'reminder',
          label: 'Follow up on this relationship',
          payload: {
            sessionId: args.sessionId ?? null,
            relationType: args.candidate.payload?.relationType ?? null,
            targetEntityName: args.candidate.payload?.targetEntityName ?? null,
          },
        };

  return [
    {
      triggerType,
      title: `${triggerType === 'monitor' ? 'Monitor' : 'Follow up'} relationship: ${args.candidate.title}`,
      summary: args.candidate.summary,
      triggerAt: triggerType === 'follow_up' ? Date.now() + 1000 * 60 * 60 * 24 * 7 : null,
      action,
    },
  ];
}

export function runMemoryPipelineForSession(sessionId: string, trigger: MemoryExtractionTrigger) {
  const messages = getSessionMessages(sessionId);
  const extraction = memoryExtractionService.extractFromSession(sessionId);
  const run = createMemoryExtractionRun({
    sessionId,
    trigger,
    sourceMessageIds: messages.map((message) => message.id),
    addedCount: extraction.added,
    duplicateCount: extraction.skippedDuplicates,
    acceptedCount: 0,
    rejectedCount: 0,
    notes: `Session extraction across ${messages.length} message(s)`,
  });

  addMemoryExtractionRunItems(extraction.runItems.map((item) => ({ ...item, runId: run.id })));

  for (const message of messages.slice(-6)) {
    if (!message.content?.trim()) continue;
    upsertWorkingMemory({
      sessionId,
      title: `${message.role === 'user' ? 'User' : 'Assistant'} context`,
      summary: buildWorkingSummary(message.content),
      confidence: 0.6,
      sourceMessageId: message.id,
      observedAt: Date.now(),
      expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7,
    });
  }

  const createdTriggers = extraction.candidates.flatMap((candidate) =>
    [
      ...inferTriggerCandidatesFromText({
        sessionId,
        sourceCandidateId: candidate.id,
        content: `${candidate.title}\n${candidate.summary}`,
      }),
      ...inferTriggerCandidatesFromCandidate({ sessionId, candidate }),
    ].map((trigger) =>
      createTriggerCandidate({
        sessionId,
        sourceCandidateId: candidate.id,
        triggerType: trigger.triggerType,
        title: trigger.title,
        summary: trigger.summary,
        confidence: candidate.confidence,
        triggerAt: trigger.triggerAt ?? null,
        deliveryChannel: 'web',
        action: trigger.action,
        metadata: { extractedFrom: candidate.memoryType },
      }),
    ),
  );

  return {
    ...extraction,
    run,
    triggerCandidates: createdTriggers,
  };
}

export function runMemoryPipelineForMessage(sessionId: string, messageId: string, trigger: MemoryExtractionTrigger, typeHint?: MemoryType) {
  const extraction = memoryExtractionService.promoteMessage(sessionId, messageId, typeHint);
  const run = createMemoryExtractionRun({
    sessionId,
    trigger,
    sourceMessageIds: [messageId],
    addedCount: extraction.added,
    duplicateCount: extraction.skippedDuplicates,
    acceptedCount: 0,
    rejectedCount: 0,
    notes: 'Single-message promotion',
  });

  addMemoryExtractionRunItems(extraction.runItems.map((item) => ({ ...item, runId: run.id })));

  const sourceMessage = getSessionMessages(sessionId).find((message) => message.id === messageId);
  if (sourceMessage?.content?.trim()) {
    upsertWorkingMemory({
      sessionId,
      title: `${sourceMessage.role === 'user' ? 'User' : 'Assistant'} context`,
      summary: buildWorkingSummary(sourceMessage.content),
      confidence: 0.62,
      sourceMessageId: sourceMessage.id,
      observedAt: Date.now(),
      expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7,
    });
  }

  const createdTriggers = extraction.candidates.flatMap((candidate) =>
    [
      ...inferTriggerCandidatesFromText({
        sessionId,
        sourceCandidateId: candidate.id,
        content: `${candidate.title}\n${candidate.summary}`,
      }),
      ...inferTriggerCandidatesFromCandidate({ sessionId, candidate }),
    ].map((trigger) =>
      createTriggerCandidate({
        sessionId,
        sourceCandidateId: candidate.id,
        triggerType: trigger.triggerType,
        title: trigger.title,
        summary: trigger.summary,
        confidence: candidate.confidence,
        triggerAt: trigger.triggerAt ?? null,
        deliveryChannel: 'web',
        action: trigger.action,
        metadata: { extractedFrom: candidate.memoryType },
      }),
    ),
  );

  return {
    ...extraction,
    run,
    triggerCandidates: createdTriggers,
  };
}

export function scanTriggerCandidates() {
  const staleMemories = listMemory({ status: 'active', limit: 200 }).items.filter((item) => {
    const staleSince = item.lastConfirmedAt ?? item.updatedAt;
    return Date.now() - staleSince > 1000 * 60 * 60 * 24 * 45;
  });

  const created = staleMemories.map((item) =>
    createTriggerCandidate({
      sessionId: item.sources[0]?.sessionId ?? null,
      sourceMemoryItemId: item.id,
      triggerType: 'staleness_review',
      title: `Review stale memory: ${item.title}`,
      summary: item.summary,
      confidence: Math.max(0.5, item.confidence),
      deliveryChannel: 'web',
      action: {
        type: 'ask_for_review',
        label: 'Review and refresh this memory',
        payload: { memoryItemId: item.id },
      },
      metadata: { memoryType: item.memoryType, staleDays: Math.floor((Date.now() - (item.lastConfirmedAt ?? item.updatedAt)) / (1000 * 60 * 60 * 24)) },
    }),
  );

  return created;
}
