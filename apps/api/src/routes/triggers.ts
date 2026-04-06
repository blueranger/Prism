import { Router } from 'express';
import { acceptTriggerCandidate, createTriggerNotification, listTriggerCandidates, listTriggerNotifications, listTriggerRules, listTriggerRuns, rejectTriggerCandidate, resetTriggers, snoozeTriggerCandidate } from '../memory/trigger-store';
import { scanTriggerCandidates } from '../services/memory-trigger-pipeline';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    candidates: listTriggerCandidates(),
    rules: listTriggerRules(),
    history: listTriggerRuns(),
    notifications: listTriggerNotifications(),
  });
});

router.get('/candidates', (_req, res) => {
  res.json({ candidates: listTriggerCandidates() });
});

router.get('/history', (_req, res) => {
  res.json({ history: listTriggerRuns() });
});

router.post('/scan', (_req, res) => {
  const candidates = scanTriggerCandidates();
  res.json({ status: 'ok', candidates });
});

router.post('/reset', (_req, res) => {
  resetTriggers();
  res.json({ status: 'ok' });
});

router.post('/:id/accept', (req, res) => {
  const rule = acceptTriggerCandidate(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Trigger candidate not found' });
  const notification = createTriggerNotification({
    triggerRunId: null,
    channel: 'web',
    title: `Accepted trigger: ${rule.title}`,
    body: rule.summary,
    status: 'sent',
    deepLink: `/triggers?rule=${rule.id}`,
  });
  return res.json({ status: 'ok', rule, notification });
});

router.post('/:id/reject', (req, res) => {
  rejectTriggerCandidate(req.params.id);
  return res.json({ status: 'ok' });
});

router.post('/:id/snooze', (req, res) => {
  const until = typeof req.body?.until === 'number' ? req.body.until : Date.now() + 1000 * 60 * 60 * 24;
  const candidate = snoozeTriggerCandidate(req.params.id, until);
  if (!candidate) return res.status(404).json({ error: 'Trigger candidate not found' });
  return res.json({ status: 'ok', candidate });
});

export default router;
