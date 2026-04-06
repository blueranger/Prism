import { Router } from 'express';
import type { CompiledSourceType, KnowledgeNoteExportRequest, SaveQueryArtifactRequest } from '@prism/shared';
import { getAppSetting } from '../memory/settings-store';
import { getCompilerRun } from '../memory/compiler-store';
import { assertImportedConversation, normalizeKnowledgeDestination } from '../services/import-transform-service';
import {
  applyCompilePlan,
  compileSourceToPlan,
  getCompilePlan,
  listCompilePlans,
  rejectCompilePlan,
} from '../services/wiki-compile-service';
import {
  applyWikiBackfillPlan,
  buildWikiBackfillPlan,
  getWikiBackfillJobState,
  getWikiBackfillJobWithItems,
  listWikiBackfillJobsWithCounts,
  pauseWikiBackfillJob,
  resumeWikiBackfillJob,
  startWikiBackfillJob,
} from '../services/wiki-backfill-service';
import {
  exportImportedKnowledgeNoteWithWiki as exportImportedKnowledgeNoteWithWikiV1,
  exportImportedRawSourceWithWiki as exportImportedRawSourceWithWikiV1,
  exportNativeSessionSourceWithWiki as exportNativeSessionSourceWithWikiV1,
  getWikiLintRun as getWikiLintRunV1,
  listWikiLintRuns as listWikiLintRunsV1,
  runWikiLint as runWikiLintV1,
  saveQueryArtifactToWiki as saveQueryArtifactToWikiV1,
  writeCompilerSummaryMarkdown,
} from '../services/wiki-service';

const router = Router();
const OBSIDIAN_VAULT_PATH_KEY = 'obsidian_vault_path';

function resolveVaultPath(explicit?: string): string {
  const raw = explicit?.trim() || getAppSetting(OBSIDIAN_VAULT_PATH_KEY) || '';
  if (!raw) {
    throw new Error('Obsidian vault path is not configured');
  }
  return raw;
}

function mergeWikiUpdate(primary: any, extra: any) {
  if (!primary) return extra;
  if (!extra) return primary;
  return {
    ensuredFiles: Array.from(new Set([...(primary.ensuredFiles ?? []), ...(extra.ensuredFiles ?? [])])),
    writtenFiles: Array.from(new Set([...(primary.writtenFiles ?? []), ...(extra.writtenFiles ?? [])])),
    updatedFiles: Array.from(new Set([...(primary.updatedFiles ?? []), ...(extra.updatedFiles ?? [])])),
    createdDrafts: Array.from(new Set([...(primary.createdDrafts ?? []), ...(extra.createdDrafts ?? [])])),
    indexUpdated: Boolean(primary.indexUpdated || extra.indexUpdated),
    logAppended: Boolean(primary.logAppended || extra.logAppended),
    logEntry: extra.logEntry ?? primary.logEntry ?? null,
  };
}

router.post('/compile-source', async (req, res) => {
  try {
    const sourceKind = req.body?.sourceKind === 'native' ? 'native' : 'imported';
    const sourceId =
      typeof req.body?.sourceId === 'string'
        ? req.body.sourceId.trim()
        : typeof req.body?.conversationId === 'string'
          ? req.body.conversationId.trim()
          : typeof req.body?.sessionId === 'string'
            ? req.body.sessionId.trim()
            : '';
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId is required' });
    }
    const vaultPath = resolveVaultPath(typeof req.body?.vaultPath === 'string' ? req.body.vaultPath : undefined);
    const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : undefined;
    const result = await compileSourceToPlan({
      sourceKind,
      sourceId,
      vaultPath,
      model,
    });
    res.json({ ok: true, plan: result.plan, compilerRun: result.compilerRun });
  } catch (error: any) {
    console.error('[wiki] compile-source failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to compile source to wiki plan' });
  }
});

router.get('/backfill-plan', async (req, res) => {
  try {
    const platform = typeof req.query.platform === 'string' ? req.query.platform.trim() : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
    const plan = await buildWikiBackfillPlan({
      platform: platform as any,
      search: search || undefined,
      limit: Number.isFinite(limit as number) ? limit : undefined,
    });
    res.json({ ok: true, plan });
  } catch (error: any) {
    console.error('[wiki] backfill-plan failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to build backfill plan' });
  }
});

router.post('/backfill-apply', async (req, res) => {
  try {
    const vaultPath = resolveVaultPath(typeof req.body?.vaultPath === 'string' ? req.body.vaultPath : undefined);
    const items = Array.isArray(req.body?.items)
      ? req.body.items.filter((item: any) =>
          item &&
          typeof item.conversationId === 'string' &&
          typeof item.action === 'string' &&
          ['compile_now', 'archive_only', 'skip'].includes(item.action)
        )
      : [];
    if (!items.length) {
      return res.status(400).json({ error: 'items are required' });
    }
    const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : undefined;
    const result = await applyWikiBackfillPlan({
      vaultPath,
      items,
      model,
    });
    res.json({ ok: true, result });
  } catch (error: any) {
    console.error('[wiki] backfill-apply failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to apply backfill plan' });
  }
});

router.post('/backfill-jobs', async (req, res) => {
  try {
    const vaultPath = resolveVaultPath(typeof req.body?.vaultPath === 'string' ? req.body.vaultPath : undefined);
    const platform = typeof req.body?.platform === 'string' ? req.body.platform.trim() : undefined;
    const search = typeof req.body?.search === 'string' ? req.body.search.trim() : undefined;
    const limit = typeof req.body?.limit === 'number' ? req.body.limit : undefined;
    const batchSize = typeof req.body?.batchSize === 'number' ? req.body.batchSize : undefined;
    const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : undefined;
    const items = Array.isArray(req.body?.items)
      ? req.body.items.filter((item: any) =>
          item &&
          typeof item.conversationId === 'string' &&
          typeof item.action === 'string' &&
          ['compile_now', 'archive_only', 'skip'].includes(item.action)
        )
      : undefined;
    const result = await startWikiBackfillJob({
      vaultPath,
      model,
      platform: platform as any,
      search: search || undefined,
      limit,
      batchSize,
      items,
    });
    res.json({ ok: true, ...result });
  } catch (error: any) {
    console.error('[wiki] backfill-jobs create failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to start backfill job' });
  }
});

router.get('/backfill-jobs', (req, res) => {
  const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
  res.json({ ok: true, jobs: listWikiBackfillJobsWithCounts(limit && Number.isFinite(limit) ? limit : 10) });
});

router.get('/backfill-jobs/:id', (req, res) => {
  const result = getWikiBackfillJobWithItems(req.params.id);
  if (!result) {
    return res.status(404).json({ error: 'Backfill job not found' });
  }
  res.json({ ok: true, ...result, ...getWikiBackfillJobState(req.params.id) });
});

router.post('/backfill-jobs/:id/pause', async (req, res) => {
  try {
    const job = await pauseWikiBackfillJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Backfill job not found' });
    }
    res.json({ ok: true, job, ...getWikiBackfillJobState(req.params.id) });
  } catch (error: any) {
    console.error('[wiki] backfill-jobs pause failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to pause backfill job' });
  }
});

router.post('/backfill-jobs/:id/resume', async (req, res) => {
  try {
    const result = await resumeWikiBackfillJob(req.params.id);
    if (!result) {
      return res.status(404).json({ error: 'Backfill job not found' });
    }
    res.json({ ok: true, ...result, ...getWikiBackfillJobState(req.params.id) });
  } catch (error: any) {
    console.error('[wiki] backfill-jobs resume failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to resume backfill job' });
  }
});

router.get('/compile-plans', (req, res) => {
  const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
  const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;
  const sourceType = typeof req.query.sourceType === 'string' ? (req.query.sourceType as CompiledSourceType) : undefined;
  res.json({
    plans: listCompilePlans({
      sourceId,
      sourceType,
      limit: limit && Number.isFinite(limit) ? limit : 20,
    }),
  });
});

router.get('/compile-plans/:id', (req, res) => {
  const plan = getCompilePlan(req.params.id);
  if (!plan) {
    return res.status(404).json({ error: 'Compile plan not found' });
  }
  res.json({ plan });
});

router.post('/compile-plans/:id/apply', async (req, res) => {
  try {
    const vaultPath = resolveVaultPath(typeof req.body?.vaultPath === 'string' ? req.body.vaultPath : undefined);
    const itemIds = Array.isArray(req.body?.itemIds)
      ? req.body.itemIds.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
      : undefined;
    const result = await applyCompilePlan({
      planId: req.params.id,
      vaultPath,
      itemIds,
    });
    res.json({ ok: true, ...result });
  } catch (error: any) {
    console.error('[wiki] apply compile plan failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to apply compile plan' });
  }
});

router.post('/compile-plans/:id/reject', async (req, res) => {
  try {
    const vaultPath = resolveVaultPath(typeof req.body?.vaultPath === 'string' ? req.body.vaultPath : undefined);
    const plan = await rejectCompilePlan(req.params.id, vaultPath);
    if (!plan) {
      return res.status(404).json({ error: 'Compile plan not found' });
    }
    res.json({ ok: true, plan });
  } catch (error: any) {
    console.error('[wiki] reject compile plan failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to reject compile plan' });
  }
});

router.post('/ingest-source', async (req, res) => {
  try {
    const sourceKind = req.body?.sourceKind === 'native' ? 'native' : 'imported';
    const sourceId =
      typeof req.body?.sourceId === 'string'
        ? req.body.sourceId.trim()
        : typeof req.body?.conversationId === 'string'
          ? req.body.conversationId.trim()
          : '';
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId is required' });
    }
    const vaultPath = resolveVaultPath(typeof req.body?.vaultPath === 'string' ? req.body.vaultPath : undefined);
    const result = sourceKind === 'native'
      ? await exportNativeSessionSourceWithWikiV1({ vaultPath, sessionId: sourceId })
      : await (async () => {
          const { conversation, messages } = assertImportedConversation(sourceId);
          return exportImportedRawSourceWithWikiV1({ vaultPath, conversation, messages });
        })();
    res.json(result);
  } catch (error: any) {
    console.error('[wiki] ingest-source failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to ingest source into wiki' });
  }
});

router.post('/export-note', async (req, res) => {
  try {
    const body = req.body as KnowledgeNoteExportRequest & { compilerRunId?: string | null };
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId.trim() : '';
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    if (!conversationId || !content) {
      return res.status(400).json({ error: 'conversationId and content are required' });
    }
    const vaultPath = resolveVaultPath(typeof body?.vaultPath === 'string' ? body.vaultPath : undefined);
    const { conversation } = assertImportedConversation(conversationId);
    const routing = normalizeKnowledgeDestination(typeof body?.destinationType === 'string' ? body.destinationType : undefined);
    const result = await exportImportedKnowledgeNoteWithWikiV1({
      vaultPath,
      conversation,
      content,
      title: body.title,
      destinationType: routing.destinationType,
      knowledgeMaturity: routing.knowledgeMaturity as 'context' | 'incubating' | 'evergreen',
      compilerRunId: typeof body?.compilerRunId === 'string' ? body.compilerRunId : null,
    });
    const compilerRun =
      typeof body?.compilerRunId === 'string' && body.compilerRunId.trim()
        ? getCompilerRun(body.compilerRunId.trim())
        : null;
    if (compilerRun) {
      const summaryUpdate = await writeCompilerSummaryMarkdown(vaultPath, compilerRun);
      result.wikiUpdate = mergeWikiUpdate(result.wikiUpdate, summaryUpdate);
    }
    res.json(result);
  } catch (error: any) {
    console.error('[wiki] export-note failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to export note into wiki' });
  }
});

router.post('/lint/run', async (req, res) => {
  try {
    const vaultPath = resolveVaultPath(typeof req.body?.vaultPath === 'string' ? req.body.vaultPath : undefined);
    const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : null;
    const run = await runWikiLintV1({ vaultPath, model });
    res.json({ ok: true, run });
  } catch (error: any) {
    console.error('[wiki] lint run failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to run wiki lint' });
  }
});

router.get('/lint/runs', (req, res) => {
  const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
  res.json({ runs: listWikiLintRunsV1(limit && Number.isFinite(limit) ? limit : 10) });
});

router.get('/lint/runs/:id', (req, res) => {
  const run = getWikiLintRunV1(req.params.id);
  if (!run) {
    return res.status(404).json({ error: 'Wiki lint run not found' });
  }
  res.json({ run });
});

router.post('/save-query-artifact', async (req, res) => {
  try {
    const body = req.body as SaveQueryArtifactRequest & { vaultPath?: string };
    if (!body?.sessionId || !body?.content || !body?.artifactType) {
      return res.status(400).json({ error: 'sessionId, content, and artifactType are required' });
    }
    const vaultPath = resolveVaultPath(typeof body?.vaultPath === 'string' ? body.vaultPath : undefined);
    const result = await saveQueryArtifactToWikiV1({
      vaultPath,
      request: {
        sessionId: body.sessionId,
        messageId: body.messageId,
        sourceModel: body.sourceModel,
        title: body.title,
        content: body.content,
        artifactType: body.artifactType,
        streamTarget: body.streamTarget,
        promoteTo: body.promoteTo ?? null,
      },
    });
    res.json(result);
  } catch (error: any) {
    console.error('[wiki] save-query-artifact failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to save query artifact to wiki' });
  }
});

export default router;
