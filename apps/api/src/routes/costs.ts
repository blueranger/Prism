import { Router } from 'express';
import { listUsageEvents, listUsageEventsForSession, listProviderCostRecords, summarizeCostsForMonth } from '../memory/cost-store';
import { syncAnthropicCosts, syncOpenAICosts } from '../services/cost-service';

const router = Router();

function currentMonthKey(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

router.get('/summary', (req, res) => {
  const month = String(req.query.month ?? currentMonthKey());
  const summary = summarizeCostsForMonth(month);
  const providerRecords = listProviderCostRecords(month);
  res.json({ month, summary, providerRecords });
});

router.get('/session/:id', (req, res) => {
  const sessionId = req.params.id;
  const events = listUsageEventsForSession(sessionId);
  const totalEstimatedUsd = events.reduce((sum, event) => sum + (event.estimatedCostUsd ?? 0), 0);
  const byProvider = events.reduce<Record<string, { estimatedUsd: number; totalTokens: number }>>((acc, event) => {
    const existing = acc[event.provider] ?? { estimatedUsd: 0, totalTokens: 0 };
    existing.estimatedUsd += event.estimatedCostUsd ?? 0;
    existing.totalTokens += event.totalTokens ?? 0;
    acc[event.provider] = existing;
    return acc;
  }, {});
  const byModel = events.reduce<Record<string, { estimatedUsd: number; totalTokens: number }>>((acc, event) => {
    const existing = acc[event.model] ?? { estimatedUsd: 0, totalTokens: 0 };
    existing.estimatedUsd += event.estimatedCostUsd ?? 0;
    existing.totalTokens += event.totalTokens ?? 0;
    acc[event.model] = existing;
    return acc;
  }, {});

  res.json({
    sessionId,
    totalEstimatedUsd,
    events,
    byProvider,
    byModel,
  });
});

router.get('/events', (req, res) => {
  const events = listUsageEvents({
    sessionId: typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined,
    provider: typeof req.query.provider === 'string' ? req.query.provider as any : undefined,
    model: typeof req.query.model === 'string' ? req.query.model : undefined,
    limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
  });
  res.json({ events });
});

router.post('/sync/openai', async (req, res) => {
  const month = String(req.body?.month ?? currentMonthKey());
  const result = await syncOpenAICosts(month);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

router.post('/sync/anthropic', async (req, res) => {
  const month = String(req.body?.month ?? currentMonthKey());
  const result = await syncAnthropicCosts(month);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

export default router;
