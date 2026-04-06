import { Router } from 'express';
import { createTriggerNotification, listTriggerNotifications } from '../memory/trigger-store';

const router = Router();

router.post('/test', (req, res) => {
  const notification = createTriggerNotification({
    triggerRunId: req.body?.triggerRunId ?? null,
    channel: req.body?.channel ?? 'web',
    title: req.body?.title ?? 'Test notification',
    body: req.body?.body ?? 'This is a test notification from Prism.',
    status: 'sent',
    deepLink: req.body?.deepLink ?? '/triggers',
  });
  res.json({ status: 'ok', notification });
});

router.post('/send', (req, res) => {
  const notification = createTriggerNotification({
    triggerRunId: req.body?.triggerRunId ?? null,
    channel: req.body?.channel ?? 'web',
    title: req.body?.title ?? 'Notification',
    body: req.body?.body ?? '',
    status: 'sent',
    deepLink: req.body?.deepLink ?? '/triggers',
  });
  res.json({ status: 'ok', notification });
});

router.post('/quick-action', (req, res) => {
  const notification = createTriggerNotification({
    triggerRunId: req.body?.triggerRunId ?? null,
    channel: req.body?.channel ?? 'web',
    title: `Quick action: ${req.body?.action ?? 'unknown'}`,
    body: req.body?.body ?? '',
    status: 'sent',
    deepLink: req.body?.deepLink ?? '/triggers',
  });
  res.json({ status: 'ok', notification });
});

router.get('/', (_req, res) => {
  res.json({ notifications: listTriggerNotifications() });
});

export default router;
