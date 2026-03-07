import { v4 as uuid } from 'uuid';
import { getDb } from '../memory/db';
import { ConnectorRegistry } from '../connectors/registry';

/**
 * Microsoft Graph change notification subscription manager.
 *
 * Creates a subscription on /me/mailFolders/inbox/messages so Graph pushes
 * new-mail events to our webhook endpoint instead of relying solely on polling.
 *
 * Graph subscriptions have a max lifetime of 3 days (4230 minutes).
 * We renew automatically before expiry.
 *
 * Multi-account: subscriptions are keyed by accountId.
 */

const MS_GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const MAX_SUBSCRIPTION_MINUTES = 4230; // 3 days minus a few minutes
const RENEW_BEFORE_MS = 30 * 60 * 1000; // Renew 30 minutes before expiry

/** In-memory tracking of active subscriptions */
interface ActiveSubscription {
  subscriptionId: string;
  accountId: string;
  expirationDateTime: string;
  renewTimer: ReturnType<typeof setTimeout> | null;
}

const activeSubscriptions = new Map<string, ActiveSubscription>();

/**
 * Get the webhook notification URL.
 * Must be publicly reachable for Graph to POST to.
 */
function getNotificationUrl(): string {
  return process.env.GRAPH_WEBHOOK_URL ?? 'http://localhost:3001/api/webhooks/graph';
}

/**
 * Graph API fetch helper with access token.
 */
async function graphFetch<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {}
): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : `${MS_GRAPH_BASE}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API ${res.status}: ${body}`);
  }

  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return {} as T;
  }

  return res.json() as Promise<T>;
}

/**
 * Get the access token for an account from the connector config.
 */
async function getAccessToken(accountId: string): Promise<string> {
  const connector = ConnectorRegistry.get(accountId);
  if (!connector) throw new Error(`No connector for account ${accountId}`);

  const db = getDb();
  const row = db.prepare(
    'SELECT config FROM connectors WHERE id = ? AND active = 1'
  ).get(accountId) as { config: string } | undefined;
  if (!row) throw new Error(`No active config for account ${accountId}`);

  const config = JSON.parse(row.config);

  // Check if token needs refresh (5-min buffer)
  if (Date.now() >= config.expiresAt - 5 * 60 * 1000) {
    await connector.refreshToken();
    const refreshedRow = db.prepare(
      'SELECT config FROM connectors WHERE id = ? AND active = 1'
    ).get(accountId) as { config: string } | undefined;
    if (!refreshedRow) throw new Error(`Token refresh failed for account ${accountId}`);
    return JSON.parse(refreshedRow.config).accessToken;
  }

  return config.accessToken;
}

/**
 * Create a Graph subscription for inbox messages for a specific account.
 * Returns the subscription ID or null if creation fails.
 */
export async function createSubscription(accountId: string): Promise<string | null> {
  // Only Outlook OAuth connectors support Graph subscriptions
  const connector = ConnectorRegistry.get(accountId);
  if (!connector || connector.connectorType !== 'outlook-oauth') return null;

  try {
    const accessToken = await getAccessToken(accountId);
    const expiration = new Date(Date.now() + MAX_SUBSCRIPTION_MINUTES * 60 * 1000);

    const body = {
      changeType: 'created',
      notificationUrl: getNotificationUrl(),
      resource: '/me/mailFolders/inbox/messages',
      expirationDateTime: expiration.toISOString(),
      clientState: generateClientState(accountId),
    };

    const result = await graphFetch<{
      id: string;
      expirationDateTime: string;
    }>('/subscriptions', accessToken, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    console.log(`[graph-subscriptions] Created subscription ${result.id} for account ${accountId}, expires ${result.expirationDateTime}`);

    // Persist to DB for recovery after restart
    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT OR REPLACE INTO graph_subscriptions (id, provider, account_id, subscription_id, expiration, client_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuid(),
      connector.provider,
      accountId,
      result.id,
      new Date(result.expirationDateTime).getTime(),
      body.clientState,
      now,
      now
    );

    // Track in memory and schedule renewal
    scheduleRenewal(accountId, result.id, result.expirationDateTime);

    return result.id;
  } catch (err: any) {
    console.error(`[graph-subscriptions] Failed to create subscription for account ${accountId}:`, err.message);
    return null;
  }
}

/**
 * Renew an existing subscription.
 */
export async function renewSubscription(accountId: string): Promise<boolean> {
  const sub = activeSubscriptions.get(accountId);
  if (!sub) return false;

  try {
    const accessToken = await getAccessToken(accountId);
    const expiration = new Date(Date.now() + MAX_SUBSCRIPTION_MINUTES * 60 * 1000);

    await graphFetch<{ id: string; expirationDateTime: string }>(
      `/subscriptions/${sub.subscriptionId}`,
      accessToken,
      {
        method: 'PATCH',
        body: JSON.stringify({
          expirationDateTime: expiration.toISOString(),
        }),
      }
    );

    console.log(`[graph-subscriptions] Renewed subscription ${sub.subscriptionId} for account ${accountId}`);

    // Update DB
    const db = getDb();
    db.prepare(
      'UPDATE graph_subscriptions SET expiration = ?, updated_at = ? WHERE subscription_id = ?'
    ).run(expiration.getTime(), Date.now(), sub.subscriptionId);

    // Reschedule renewal
    scheduleRenewal(accountId, sub.subscriptionId, expiration.toISOString());

    return true;
  } catch (err: any) {
    console.error(`[graph-subscriptions] Failed to renew subscription for account ${accountId}:`, err.message);
    // Clear the failed subscription and fall back to polling
    clearSubscription(accountId);
    return false;
  }
}

/**
 * Delete a subscription from Graph API.
 */
export async function deleteSubscription(accountId: string): Promise<void> {
  const sub = activeSubscriptions.get(accountId);
  if (!sub) return;

  try {
    const accessToken = await getAccessToken(accountId);
    await graphFetch<void>(
      `/subscriptions/${sub.subscriptionId}`,
      accessToken,
      { method: 'DELETE' }
    );
    console.log(`[graph-subscriptions] Deleted subscription ${sub.subscriptionId} for account ${accountId}`);
  } catch (err: any) {
    console.error(`[graph-subscriptions] Failed to delete subscription for account ${accountId}:`, err.message);
  }

  clearSubscription(accountId);
}

/**
 * Check if an account has an active webhook subscription.
 */
export function hasActiveSubscription(accountId: string): boolean {
  return activeSubscriptions.has(accountId);
}

/**
 * Get the stored client state for validating webhook payloads.
 */
export function getClientState(accountId: string): string | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT client_state FROM graph_subscriptions WHERE account_id = ? ORDER BY updated_at DESC LIMIT 1'
  ).get(accountId) as { client_state: string } | undefined;
  return row?.client_state ?? null;
}

/**
 * Look up accountId from a subscription_id (for webhook processing).
 */
export function getAccountIdForSubscription(subscriptionId: string): string | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT account_id FROM graph_subscriptions WHERE subscription_id = ?'
  ).get(subscriptionId) as { account_id: string } | undefined;
  return row?.account_id ?? null;
}

/**
 * Restore subscriptions from DB after server restart.
 * Renews any that are still valid; deletes expired ones.
 */
export async function restoreSubscriptions(): Promise<void> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM graph_subscriptions ORDER BY updated_at DESC'
  ).all() as any[];

  const seen = new Set<string>();

  for (const row of rows) {
    const accountId = row.account_id as string;
    if (!accountId) continue;

    // Skip duplicate accounts — only use the latest
    if (seen.has(accountId)) continue;
    seen.add(accountId);

    const expiration = row.expiration as number;
    const now = Date.now();

    if (expiration <= now) {
      // Expired — try to re-create
      console.log(`[graph-subscriptions] Subscription for account ${accountId} expired, re-creating`);
      db.prepare('DELETE FROM graph_subscriptions WHERE id = ?').run(row.id);
      await createSubscription(accountId);
    } else {
      // Still valid — track and schedule renewal
      console.log(`[graph-subscriptions] Restoring subscription ${row.subscription_id} for account ${accountId}`);
      scheduleRenewal(accountId, row.subscription_id, new Date(expiration).toISOString());
    }
  }
}

// --- Internal helpers ---

function scheduleRenewal(
  accountId: string,
  subscriptionId: string,
  expirationDateTime: string
): void {
  // Clear any existing timer
  const existing = activeSubscriptions.get(accountId);
  if (existing?.renewTimer) {
    clearTimeout(existing.renewTimer);
  }

  const expiresAt = new Date(expirationDateTime).getTime();
  const renewAt = expiresAt - RENEW_BEFORE_MS;
  const delayMs = Math.max(renewAt - Date.now(), 60 * 1000); // At least 1 minute

  const timer = setTimeout(async () => {
    console.log(`[graph-subscriptions] Auto-renewing subscription for account ${accountId}`);
    const success = await renewSubscription(accountId);
    if (!success) {
      console.log(`[graph-subscriptions] Renewal failed for account ${accountId}, re-creating`);
      await createSubscription(accountId);
    }
  }, delayMs);

  activeSubscriptions.set(accountId, {
    subscriptionId,
    accountId,
    expirationDateTime,
    renewTimer: timer,
  });
}

function clearSubscription(accountId: string): void {
  const sub = activeSubscriptions.get(accountId);
  if (sub?.renewTimer) {
    clearTimeout(sub.renewTimer);
  }
  activeSubscriptions.delete(accountId);

  // Remove from DB
  const db = getDb();
  db.prepare('DELETE FROM graph_subscriptions WHERE account_id = ?').run(accountId);
}

function generateClientState(accountId: string): string {
  return `prism-${accountId.slice(0, 8)}-${uuid().slice(0, 8)}`;
}
