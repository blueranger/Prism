import { v4 as uuid } from 'uuid';
import type {
  ImportedConversation,
  WikiBackfillAction,
  WikiBackfillAgeBucket,
  WikiBackfillApplyItem,
  WikiBackfillApplyResult,
  WikiBackfillApplyResultItem,
  WikiBackfillJob,
  WikiBackfillJobItem,
  WikiBackfillPlan,
  WikiBackfillRecommendation,
} from '@prism/shared';
import { getImportedConversation, getImportedMessages, listImportedConversations } from '../memory/import-store';
import { compileSourceToPlan, applyCompilePlan } from './wiki-compile-service';
import { exportImportedRawSourceWithWiki, runWikiLint } from './wiki-service';
import {
  createWikiBackfillJob,
  getWikiBackfillJob,
  listPendingWikiBackfillJobItems,
  listWikiBackfillJobItems,
  listWikiBackfillJobs,
  resetRunningWikiBackfillJobItems,
  updateWikiBackfillJob,
  updateWikiBackfillJobItem,
} from '../memory/wiki-backfill-job-store';

const activeBackfillJobs = new Map<string, Promise<void>>();

function isWikiBackfillJobActive(jobId: string): boolean {
  return activeBackfillJobs.has(jobId);
}

function toTimestamp(value?: string | number | null): number {
  if (!value) return 0;
  const date = new Date(value);
  const ts = date.getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function daysAgoFrom(referenceTs: number, value?: string | number | null): number {
  const ts = toTimestamp(value);
  if (!ts) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((referenceTs - ts) / (24 * 60 * 60 * 1000)));
}

function inferAgeBucket(referenceTs: number, conversation: ImportedConversation): WikiBackfillAgeBucket {
  const days = daysAgoFrom(referenceTs, conversation.lastActivityAt || conversation.updatedAt || conversation.createdAt);
  if (days <= 90) return 'recent';
  if (days <= 365) return 'mid_term';
  return 'legacy';
}

const GENERIC_ZH_TOKENS = new Set([
  '會議', '摘要', '整理', '討論', '對話', '紀錄', '記錄', '想法', '問題', '規劃', '專案', '合作', '策略', '分析',
]);

const GENERIC_EN_TOKENS = new Set([
  'meeting', 'summary', 'discussion', 'notes', 'chat', 'conversation', 'project', 'plan', 'analysis', 'idea',
]);

function extractAnchors(text?: string | null): string[] {
  if (!text) return [];
  const anchors = new Set<string>();
  const zhMatches = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const token of zhMatches) {
    if (!GENERIC_ZH_TOKENS.has(token)) anchors.add(token);
  }
  const enMatches = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
  for (const token of enMatches) {
    if (!GENERIC_EN_TOKENS.has(token)) anchors.add(token);
  }
  return Array.from(anchors);
}

function isHighSignalConversation(conversation: ImportedConversation): boolean {
  const text = `${conversation.title} ${conversation.projectName || ''}`.toLowerCase();
  return /合作|決策|框架|渠道|市場|策略|產品|sku|package|customer|partner|strategy|framework|pricing|gtm|roadmap|research/.test(text);
}

function buildRecentAnchorSets(conversations: ImportedConversation[], referenceTs: number) {
  const recent = conversations.filter((conv) => inferAgeBucket(referenceTs, conv) === 'recent');
  const projectNames = new Set<string>();
  const anchors = new Set<string>();
  for (const conv of recent) {
    if (conv.projectName?.trim()) projectNames.add(conv.projectName.trim().toLowerCase());
    for (const token of extractAnchors(conv.title)) anchors.add(token.toLowerCase());
    for (const token of extractAnchors(conv.projectName)) anchors.add(token.toLowerCase());
  }
  return { projectNames, anchors };
}

function scoreConversation(conversation: ImportedConversation, referenceTs: number, recentAnchors: ReturnType<typeof buildRecentAnchorSets>): { score: number; reasons: string[]; recommendedAction: WikiBackfillAction; ageBucket: WikiBackfillAgeBucket } {
  const reasons: string[] = [];
  let score = 0;
  const ageBucket = inferAgeBucket(referenceTs, conversation);
  const projectName = conversation.projectName?.trim().toLowerCase();
  if (ageBucket === 'recent') {
    score += 3;
    reasons.push('最近 90 天內仍有活動，優先回填。');
  } else if (ageBucket === 'mid_term') {
    score += 1;
    reasons.push('屬於 3 到 12 個月內的中期紀錄，可視為回補候選。');
  } else {
    reasons.push('超過一年，預設只做 selective recovery。');
  }
  if (projectName && recentAnchors.projectNames.has(projectName)) {
    score += 2;
    reasons.push('與近期活主題的 project 名稱重疊。');
  }
  const titleAnchors = extractAnchors(`${conversation.title} ${conversation.projectName || ''}`);
  const overlappingAnchors = titleAnchors.filter((token) => recentAnchors.anchors.has(token.toLowerCase()));
  if (overlappingAnchors.length) {
    score += 1;
    reasons.push(`與近期活主題共享關鍵詞：${overlappingAnchors.slice(0, 3).join('、')}。`);
  }
  if ((conversation.messageCount ?? 0) >= 12) {
    score += 1;
    reasons.push('訊息量較高，較可能含有可沉澱內容。');
  }
  if (isHighSignalConversation(conversation)) {
    score += 1;
    reasons.push('標題顯示這可能是策略、合作、產品化或決策相關內容。');
  }

  let recommendedAction: WikiBackfillAction = 'skip';
  if (ageBucket === 'recent') {
    recommendedAction = 'compile_now';
  } else if (ageBucket === 'mid_term') {
    recommendedAction = score >= 3 ? 'compile_now' : 'archive_only';
  } else {
    recommendedAction = score >= 4 ? 'compile_now' : score >= 2 ? 'archive_only' : 'skip';
  }
  return { score, reasons, recommendedAction, ageBucket };
}

export async function buildWikiBackfillPlan(args: {
  platform?: ImportedConversation['sourcePlatform'];
  search?: string;
  limit?: number;
} = {}): Promise<WikiBackfillPlan> {
  const { conversations } = listImportedConversations({
    platform: args.platform,
    search: args.search,
    limit: args.limit ?? 300,
    offset: 0,
  });
  const referenceTs = Date.now();
  const recentAnchors = buildRecentAnchorSets(conversations, referenceTs);
  const recommendations: WikiBackfillRecommendation[] = conversations.map((conversation) => {
    const scored = scoreConversation(conversation, referenceTs, recentAnchors);
    return {
      conversationId: conversation.id,
      title: conversation.title,
      platform: conversation.sourcePlatform,
      projectName: conversation.projectName,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastActivityAt: conversation.lastActivityAt,
      messageCount: conversation.messageCount,
      ageBucket: scored.ageBucket,
      recommendedAction: scored.recommendedAction,
      reasons: scored.reasons,
      score: scored.score,
    };
  });

  return {
    createdAt: referenceTs,
    totalConversations: recommendations.length,
    compileNowCount: recommendations.filter((item) => item.recommendedAction === 'compile_now').length,
    archiveOnlyCount: recommendations.filter((item) => item.recommendedAction === 'archive_only').length,
    skipCount: recommendations.filter((item) => item.recommendedAction === 'skip').length,
    recommendations,
  };
}

export async function applyWikiBackfillPlan(args: {
  vaultPath: string;
  items: WikiBackfillApplyItem[];
  model?: string;
}): Promise<WikiBackfillApplyResult> {
  const results: WikiBackfillApplyResultItem[] = [];
  let compiledCount = 0;
  let archivedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const item of args.items) {
    const conversation = getImportedConversation(item.conversationId);
    if (!conversation) {
      failedCount += 1;
      results.push({
        conversationId: item.conversationId,
        title: item.conversationId,
        action: item.action,
        status: 'failed',
        error: 'Imported conversation not found.',
      });
      continue;
    }

    try {
      if (item.action === 'skip') {
        skippedCount += 1;
        results.push({
          conversationId: conversation.id,
          title: conversation.title,
          action: item.action,
          status: 'skipped',
        });
        continue;
      }

      if (item.action === 'archive_only') {
        const messages = getImportedMessages(conversation.id);
        const exportResult = await exportImportedRawSourceWithWiki({
          vaultPath: args.vaultPath,
          conversation,
          messages,
        });
        archivedCount += 1;
        results.push({
          conversationId: conversation.id,
          title: conversation.title,
          action: item.action,
          status: 'applied',
          filePath: exportResult.filePath,
        });
        continue;
      }

      const compiled = await compileSourceToPlan({
        sourceKind: 'imported',
        sourceId: conversation.id,
        vaultPath: args.vaultPath,
        model: args.model,
      });
      const applied = await applyCompilePlan({
        planId: compiled.plan.id,
        vaultPath: args.vaultPath,
      });
      compiledCount += 1;
      results.push({
        conversationId: conversation.id,
        title: conversation.title,
        action: item.action,
        status: 'applied',
        compilePlanId: compiled.plan.id,
        appliedItemCount: applied.appliedItemIds.length,
        filePath: applied.wikiUpdate.writtenFiles?.[0] || applied.wikiUpdate.updatedFiles?.[0],
      });
    } catch (error: any) {
      failedCount += 1;
      results.push({
        conversationId: conversation.id,
        title: conversation.title,
        action: item.action,
        status: 'failed',
        error: error?.message || 'Backfill failed.',
      });
    }
  }

  return {
    totalProcessed: args.items.length,
    compiledCount,
    archivedCount,
    skippedCount,
    failedCount,
    results,
  };
}

async function processBackfillConversation(args: {
  vaultPath: string;
  model?: string;
  conversationId: string;
  action: WikiBackfillAction;
}): Promise<WikiBackfillApplyResultItem> {
  const conversation = getImportedConversation(args.conversationId);
  if (!conversation) {
    return {
      conversationId: args.conversationId,
      title: args.conversationId,
      action: args.action,
      status: 'failed',
      error: 'Imported conversation not found.',
    };
  }

  if (args.action === 'skip') {
    return {
      conversationId: conversation.id,
      title: conversation.title,
      action: args.action,
      status: 'skipped',
    };
  }

  if (args.action === 'archive_only') {
    const messages = getImportedMessages(conversation.id);
    const exportResult = await exportImportedRawSourceWithWiki({
      vaultPath: args.vaultPath,
      conversation,
      messages,
    });
    return {
      conversationId: conversation.id,
      title: conversation.title,
      action: args.action,
      status: 'applied',
      filePath: exportResult.filePath,
    };
  }

  const compiled = await compileSourceToPlan({
    sourceKind: 'imported',
    sourceId: conversation.id,
    vaultPath: args.vaultPath,
    model: args.model,
  });
  const applied = await applyCompilePlan({
    planId: compiled.plan.id,
    vaultPath: args.vaultPath,
  });
  return {
    conversationId: conversation.id,
    title: conversation.title,
    action: args.action,
    status: 'applied',
    compilePlanId: compiled.plan.id,
    appliedItemCount: applied.appliedItemIds.length,
    filePath: applied.wikiUpdate.writtenFiles?.[0] || applied.wikiUpdate.updatedFiles?.[0],
  };
}

function nextBatchSizeFromLint(current: number, findingCount: number, batchFailures: number): { next: number; note?: string } {
  if (batchFailures > 0 || findingCount >= 12) {
    const next = Math.max(3, Math.min(current, 5));
    return {
      next,
      note: findingCount >= 12
        ? `Lint after this batch found ${findingCount} findings, so the next batch was tightened to ${next} items.`
        : `A failure was detected in this batch, so the next batch was tightened to ${next} items.`,
    };
  }
  if (findingCount <= 3 && current < 10) {
    const next = Math.min(10, current + 2);
    return {
      next,
      note: `Lint stayed quiet after this batch, so the next batch was expanded to ${next} items.`,
    };
  }
  return { next: current };
}

function maybeRetuneRemainingItems(jobId: string, findingCount: number): string | null {
  if (findingCount < 12) return null;
  const remaining = listPendingWikiBackfillJobItems(jobId);
  let changed = 0;
  for (const item of remaining) {
    if (item.selectedAction !== 'compile_now') continue;
    if (item.ageBucket === 'recent') continue;
    if (item.score >= 4) continue;
    updateWikiBackfillJobItem(item.id, {
      selectedAction: 'archive_only',
      reasons: [...item.reasons, '上一批 lint finding 偏多，這筆暫時降為 archive only 以降低知識分叉風險。'],
    });
    changed += 1;
  }
  if (!changed) return null;
  return `Because lint findings spiked to ${findingCount}, ${changed} lower-confidence mid-term or legacy items were downgraded from compile_now to archive_only for the next batches.`;
}

async function runBackfillJob(jobId: string): Promise<void> {
  const existing = getWikiBackfillJob(jobId);
  if (!existing) return;
  updateWikiBackfillJob(jobId, {
    status: 'running',
    startedAt: existing.startedAt ?? Date.now(),
    currentConversationTitle: null,
  });

  try {
    while (true) {
      const job = getWikiBackfillJob(jobId);
      if (!job) return;
      if (job.status === 'cancelled' || job.status === 'paused' || job.status === 'failed') return;

      const pending = listPendingWikiBackfillJobItems(jobId);
      if (!pending.length) {
        updateWikiBackfillJob(jobId, {
          status: 'completed',
          completedAt: Date.now(),
          currentConversationTitle: null,
        });
        return;
      }

      const batch = pending.slice(0, job.currentBatchSize);
      let batchFailures = 0;
      for (const item of batch) {
        const beforeItem = getWikiBackfillJob(jobId);
        if (!beforeItem) return;
        if (beforeItem.status === 'paused' || beforeItem.status === 'cancelled' || beforeItem.status === 'failed') {
          return;
        }
        updateWikiBackfillJobItem(item.id, {
          status: item.selectedAction === 'skip' ? 'skipped' : 'running',
          batchNumber: job.nextBatchNumber,
          startedAt: Date.now(),
        });
        updateWikiBackfillJob(jobId, {
          currentConversationTitle: item.title,
        });

        try {
          const result = await processBackfillConversation({
            vaultPath: job.vaultPath,
            model: job.model ?? undefined,
            conversationId: item.conversationId,
            action: item.selectedAction,
          });
          updateWikiBackfillJobItem(item.id, {
            status: result.status,
            completedAt: Date.now(),
            filePath: result.filePath,
            compilePlanId: result.compilePlanId,
            appliedItemCount: result.appliedItemCount,
            error: result.error,
          });

          const currentJob = getWikiBackfillJob(jobId);
          if (!currentJob) return;
          const nextPatch: Partial<WikiBackfillJob> = {
            processedItems: currentJob.processedItems + 1,
            currentConversationTitle: null,
          };
          if (result.status === 'skipped') nextPatch.skippedCount = currentJob.skippedCount + 1;
          else if (result.status === 'failed') {
            nextPatch.failedCount = currentJob.failedCount + 1;
            batchFailures += 1;
          } else if (item.selectedAction === 'archive_only') nextPatch.archivedCount = currentJob.archivedCount + 1;
          else if (item.selectedAction === 'compile_now') nextPatch.compiledCount = currentJob.compiledCount + 1;
          updateWikiBackfillJob(jobId, nextPatch);
        } catch (error: any) {
          batchFailures += 1;
          updateWikiBackfillJobItem(item.id, {
            status: 'failed',
            completedAt: Date.now(),
            error: error?.message || 'Backfill item failed.',
          });
          updateWikiBackfillJob(jobId, {
            processedItems: (getWikiBackfillJob(jobId)?.processedItems ?? 0) + 1,
            failedCount: (getWikiBackfillJob(jobId)?.failedCount ?? 0) + 1,
            currentConversationTitle: null,
          });
        }
      }

      const latestJob = getWikiBackfillJob(jobId);
      if (!latestJob) return;
      const lintRun = await runWikiLint({
        vaultPath: latestJob.vaultPath,
        model: latestJob.model ?? undefined,
      });
      const retuneNote = maybeRetuneRemainingItems(jobId, lintRun.findingCount);
      const batchTuning = nextBatchSizeFromLint(latestJob.currentBatchSize, lintRun.findingCount, batchFailures);
      const tuningNotes = [
        ...latestJob.tuningNotes,
        `Batch ${latestJob.nextBatchNumber} completed with ${batch.length} item(s); lint found ${lintRun.findingCount} issue(s).`,
        ...(retuneNote ? [retuneNote] : []),
        ...(batchTuning.note ? [batchTuning.note] : []),
      ].slice(-20);

      updateWikiBackfillJob(jobId, {
        lastLintRunId: lintRun.id,
        lastLintFindingCount: lintRun.findingCount,
        nextBatchNumber: latestJob.nextBatchNumber + 1,
        currentBatchSize: batchTuning.next,
        tuningNotes,
      });
    }
  } catch (error: any) {
    updateWikiBackfillJob(jobId, {
      status: 'failed',
      completedAt: Date.now(),
      error: error?.message || 'Backfill job failed.',
      currentConversationTitle: null,
    });
  } finally {
    activeBackfillJobs.delete(jobId);
  }
}

export async function startWikiBackfillJob(args: {
  vaultPath: string;
  model?: string;
  platform?: ImportedConversation['sourcePlatform'];
  search?: string;
  limit?: number;
  batchSize?: number;
  items?: Array<{ conversationId: string; action: WikiBackfillAction }>;
}): Promise<{ job: WikiBackfillJob; items: WikiBackfillJobItem[] }> {
  const plan = await buildWikiBackfillPlan({
    platform: args.platform,
    search: args.search,
    limit: args.limit ?? 300,
  });
  const now = Date.now();
  const jobId = uuid();
  const batchSize = Math.max(3, Math.min(args.batchSize ?? 10, 20));
  const overrides = new Map((args.items ?? []).map((item) => [item.conversationId, item.action]));
  const items: WikiBackfillJobItem[] = plan.recommendations.map((item) => ({
    id: uuid(),
    jobId,
    conversationId: item.conversationId,
    title: item.title,
    platform: item.platform,
    projectName: item.projectName,
    ageBucket: item.ageBucket,
    score: item.score,
    recommendedAction: item.recommendedAction,
    selectedAction: overrides.get(item.conversationId) ?? item.recommendedAction,
    reasons: item.reasons,
    status: 'pending',
  }));
  const job: WikiBackfillJob = {
    id: jobId,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    vaultPath: args.vaultPath,
    model: args.model ?? null,
    batchSize,
    currentBatchSize: batchSize,
    totalItems: items.length,
    processedItems: 0,
    compiledCount: 0,
    archivedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    nextBatchNumber: 1,
    lastLintRunId: null,
    lastLintFindingCount: null,
    tuningNotes: ['Background backfill job created. Prism will process the library in batches and lint the wiki after each batch.'],
    currentConversationTitle: null,
  };
  createWikiBackfillJob(job, items);
  const runner = runBackfillJob(jobId);
  activeBackfillJobs.set(jobId, runner);
  void runner;
  return { job, items };
}

export function getWikiBackfillJobWithItems(jobId: string): { job: WikiBackfillJob; items: WikiBackfillJobItem[] } | null {
  const job = getWikiBackfillJob(jobId);
  if (!job) return null;
  return { job, items: listWikiBackfillJobItems(jobId) };
}

export function listWikiBackfillJobsWithCounts(limit = 20): WikiBackfillJob[] {
  return listWikiBackfillJobs(limit);
}

export function getWikiBackfillJobState(jobId: string): { active: boolean; resumable: boolean } {
  const job = getWikiBackfillJob(jobId);
  if (!job) return { active: false, resumable: false };
  const active = isWikiBackfillJobActive(jobId);
  const resumable = !active && ['queued', 'running', 'paused', 'failed'].includes(job.status);
  return { active, resumable };
}

export async function pauseWikiBackfillJob(jobId: string): Promise<WikiBackfillJob | null> {
  const job = getWikiBackfillJob(jobId);
  if (!job) return null;
  if (job.status === 'completed' || job.status === 'cancelled') return job;
  return updateWikiBackfillJob(jobId, {
    status: 'paused',
    currentConversationTitle: null,
    tuningNotes: [...job.tuningNotes, 'Job paused. You can resume later from the same point.'].slice(-20),
  });
}

export async function resumeWikiBackfillJob(jobId: string): Promise<{ job: WikiBackfillJob; items: WikiBackfillJobItem[] } | null> {
  const job = getWikiBackfillJob(jobId);
  if (!job) return null;
  if (job.status === 'completed' || job.status === 'cancelled') {
    return { job, items: listWikiBackfillJobItems(jobId) };
  }
  if (!isWikiBackfillJobActive(jobId)) {
    resetRunningWikiBackfillJobItems(jobId);
    const updated = updateWikiBackfillJob(jobId, {
      status: 'queued',
      error: undefined,
      currentConversationTitle: null,
      tuningNotes: [...job.tuningNotes, 'Job resumed from persisted state. Pending work will continue from the last unfinished batch boundary.'].slice(-20),
    }) ?? job;
    const runner = runBackfillJob(jobId);
    activeBackfillJobs.set(jobId, runner);
    void runner;
    return { job: updated, items: listWikiBackfillJobItems(jobId) };
  }
  return { job, items: listWikiBackfillJobItems(jobId) };
}
