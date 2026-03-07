import { Router } from 'express';
import { getClientState, getAccountIdForSubscription } from '../services/graph-subscriptions';
import { syncAccount } from '../services/connector-service';

const router = Router();

/**
 * POST /api/webhooks/graph
 *
 * Receives Microsoft Graph change notifications.
 *
 * Graph sends two types of requests:
 * 1. Validation: includes ?validationToken=<token> — must respond with the token as plain text
 * 2. Notification: JSON body with value[] array of change notifications
 *
 * On receiving a notification for new inbox messages, we look up the accountId
 * from the subscription and trigger a sync for that specific account.
 */
router.post('/graph', (req, res) => {
  // --- Subscription validation handshake ---
  const validationToken = req.query.validationToken as string | undefined;
  if (validationToken) {
    console.log('[webhooks/graph] Subscription validation received');
    res.set('Content-Type', 'text/plain');
    res.status(200).send(validationToken);
    return;
  }

  // --- Change notification ---
  const body = req.body;
  if (!body?.value || !Array.isArray(body.value)) {
    res.status(400).json({ error: 'Invalid notification payload' });
    return;
  }

  // Respond immediately — Graph requires a 2xx within 3 seconds
  res.status(202).json({ ok: true });

  // Process notifications asynchronously
  processGraphNotifications(body.value).catch((err: any) => {
    console.error('[webhooks/graph] Error processing notifications:', err.message);
  });
});

interface GraphNotification {
  subscriptionId: string;
  clientState?: string;
  changeType: string;
  resource: string;
  resourceData?: {
    '@odata.type': string;
    id: string;
  };
  subscriptionExpirationDateTime?: string;
  tenantId?: string;
}

async function processGraphNotifications(notifications: GraphNotification[]): Promise<void> {
  // Group notifications by subscription to avoid duplicate syncs
  const accountsToSync = new Set<string>();

  for (const notification of notifications) {
    // Look up which account this subscription belongs to
    const accountId = getAccountIdForSubscription(notification.subscriptionId);
    if (!accountId) {
      console.warn(`[webhooks/graph] Unknown subscription ${notification.subscriptionId}, ignoring`);
      continue;
    }

    // Validate client state to prevent spoofed notifications
    const expectedState = getClientState(accountId);
    if (expectedState && notification.clientState && notification.clientState !== expectedState) {
      console.warn('[webhooks/graph] Client state mismatch — ignoring notification');
      continue;
    }

    if (notification.changeType === 'created' && notification.resource.includes('messages')) {
      console.log(`[webhooks/graph] New message notification for account ${accountId}`);
      accountsToSync.add(accountId);
    }
  }

  // Trigger sync for each affected account
  for (const accountId of accountsToSync) {
    await syncAccount(accountId);
  }
}

export default router;
