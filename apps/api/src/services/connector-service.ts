import type { ExternalMessage } from '@prism/shared';
import { ConnectorRegistry } from '../connectors/registry';
import { getDb } from '../memory/db';
import { evaluateMessages, processMatches } from './monitor-engine';
import { broadcast, broadcastNotification, broadcastNewMessages, broadcastSyncError } from './ws';
import { upsertNotionPage } from '../memory/notion-store';

/** Default pause between full rounds: 5 minutes */
const ROUND_PAUSE_MS = 5 * 60 * 1000;

/** Pause between individual account syncs within a round: 3 seconds */
const INTER_ACCOUNT_PAUSE_MS = 3_000;

/** Max backoff: 30 minutes */
const MAX_BACKOFF_MS = 30 * 60 * 1000;

/** Consecutive failure counts for exponential backoff */
const failureCounts = new Map<string, number>();

/**
 * Priority queue for Outlook AppleScript operations.
 *
 * AppleScript can only run one operation at a time (concurrent calls freeze Outlook).
 * Instead of a simple FIFO chain, we use a priority queue so that:
 *   - HIGH priority (content fetch when user clicks an email) runs ASAP
 *   - LOW priority (background sync polling) yields to any waiting HIGH tasks
 *
 * After each task completes, the queue picks the highest-priority waiting task.
 */

type QueuePriority = 'high' | 'low';

interface QueuedTask {
  fn: () => Promise<any>;
  priority: QueuePriority;
  resolve: (value: any) => void;
  reject: (err: any) => void;
  label?: string;
}

const taskQueue: QueuedTask[] = [];
let queueRunning = false;

/** Broadcast current queue status to frontend so the UI can show what's happening */
function broadcastQueueStatus(currentLabel: string | undefined, pending: number): void {
  broadcast({
    type: 'comm:queueStatus',
    currentTask: currentLabel ?? null,
    pendingCount: pending,
  });
}

async function processQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;

  while (taskQueue.length > 0) {
    // Pick highest-priority task (high before low); among same priority, FIFO
    const highIdx = taskQueue.findIndex((t) => t.priority === 'high');
    const idx = highIdx >= 0 ? highIdx : 0;
    const task = taskQueue.splice(idx, 1)[0];

    const tag = task.label ? `[queue:${task.label}]` : '[queue]';
    console.log(`${tag} Starting (priority=${task.priority}, pending=${taskQueue.length})`);

    // Notify frontend what's currently running
    broadcastQueueStatus(task.label, taskQueue.length);

    try {
      const result = await task.fn();
      task.resolve(result);
    } catch (err) {
      task.reject(err);
    }
  }

  queueRunning = false;
  // Queue empty — notify frontend
  broadcastQueueStatus(undefined, 0);
}

/**
 * Enqueue a LOW-priority operation (background sync, polling).
 * These yield to any pending high-priority tasks between executions.
 */
export function enqueueOutlookTask<T>(fn: () => Promise<T>, label?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    taskQueue.push({ fn, priority: 'low', resolve, reject, label });
    processQueue();
  });
}

/**
 * Enqueue a HIGH-priority operation (content fetch when user clicks a thread).
 * These jump ahead of pending low-priority sync tasks.
 */
export function enqueueOutlookTaskHighPriority<T>(fn: () => Promise<T>, label?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    taskQueue.push({ fn, priority: 'high', resolve, reject, label });
    processQueue();
  });
}

/** Tracks last sync result per accountId for the status endpoint */
interface SyncState {
  lastSyncAt: number | null;
  lastError: string | null;
  threadCount: number;
  lastDurationMs?: number;
}
const syncStates = new Map<string, SyncState>();

/**
 * Get the last sync state for an account.
 */
export function getSyncState(accountId: string): SyncState | undefined {
  return syncStates.get(accountId);
}

/**
 * Get sync states for all accounts.
 */
export function getAllSyncStates(): Map<string, SyncState> {
  return syncStates;
}

// --- Round-Robin Polling ---

/** Whether the round-robin loop is active */
let roundRobinActive = false;

/** Timer ref for the pause between rounds */
let roundRobinTimer: ReturnType<typeof setTimeout> | null = null;

/** The list of account IDs being polled */
let pollingAccountIds: string[] = [];

/**
 * Sync a single account: fetch threads since last sync, persist to DB.
 * This is the core function called by polling, manual sync, and webhooks.
 *
 * Outlook connectors use the AppleScript queue (only ONE operation at a time).
 * LINE connectors bypass the queue (Puppeteer is independent of AppleScript).
 */
export function syncAccount(accountId: string): Promise<{ threadCount: number; error?: string }> {
  const connector = ConnectorRegistry.get(accountId);
  if (connector && (connector.provider === 'line' || connector.provider === 'teams')) {
    // LINE/Teams use Puppeteer — runs directly without the Outlook AppleScript queue
    return syncAccountInternal(accountId);
  }
  return enqueueOutlookTask(() => syncAccountInternal(accountId), `sync-${accountId}`);
}

async function syncAccountInternal(accountId: string): Promise<{ threadCount: number; error?: string }> {
  const startTime = Date.now();

  const connector = ConnectorRegistry.get(accountId);
  if (!connector) {
    return { threadCount: 0, error: `No connector instance for account ${accountId}` };
  }

  // Check if connector is still active
  const db = getDb();
  const activeRow = db.prepare(
    'SELECT id FROM connectors WHERE id = ? AND active = 1'
  ).get(accountId);

  if (!activeRow) {
    console.log(`[connector-service] Connector for account ${accountId} is no longer active, skipping`);
    return { threadCount: 0, error: `Connector for account ${accountId} is disconnected` };
  }

  // Determine "since" from the latest last_synced_at for this account
  const row = db.prepare(
    'SELECT MAX(last_synced_at) as last_synced FROM external_threads WHERE account_id = ?'
  ).get(accountId) as { last_synced: number | null } | undefined;

  const since = row?.last_synced ?? undefined;

  try {
    const threads = await connector.fetchThreads(since);
    const durationMs = Date.now() - startTime;
    console.log(`[connector-service] Synced account ${accountId}: ${threads.length} thread(s) in ${(durationMs / 1000).toFixed(1)}s`);

    // Reset failure count on success
    failureCounts.delete(accountId);

    // Update sync state: count total threads for this account
    const totalThreadCount = (db.prepare(
      'SELECT COUNT(*) as cnt FROM external_threads WHERE account_id = ?'
    ).get(accountId) as { cnt: number })?.cnt ?? 0;

    syncStates.set(accountId, {
      lastSyncAt: Date.now(),
      lastError: null,
      threadCount: totalThreadCount,
      lastDurationMs: durationMs,
    });

    // Broadcast new messages event via WebSocket
    if (threads.length > 0) {
      broadcastNewMessages(accountId, threads.length);
    }

    // Run monitor rules against newly synced inbound messages
    if (threads.length > 0) {
      try {
        const syncTimestamp = since ?? 0;
        const rows = db.prepare(
          `SELECT * FROM external_messages
           WHERE account_id = ? AND is_inbound = 1 AND created_at > ?
           ORDER BY created_at ASC`
        ).all(accountId, syncTimestamp) as any[];

        if (rows.length > 0) {
          const newMessages: ExternalMessage[] = rows.map((r: any) => {
            let metadata: Record<string, unknown> = {};
            try { metadata = r.metadata ? JSON.parse(r.metadata) : {}; } catch { /* ignore */ }
            return {
              id: r.id,
              threadId: r.thread_id,
              provider: r.provider,
              accountId: r.account_id ?? accountId,
              externalId: r.external_id,
              senderId: r.sender_id,
              senderName: r.sender_name,
              senderEmail: r.sender_email ?? null,
              subject: r.subject ?? null,
              content: r.content,
              timestamp: r.timestamp,
              isInbound: r.is_inbound === 1,
              metadata,
              createdAt: r.created_at,
            };
          });

          const matches = evaluateMessages(newMessages);
          if (matches.length > 0) {
            console.log(`[connector-service] ${matches.length} monitor rule match(es) for account ${accountId}`);
            const notifications = await processMatches(matches);
            // Push each notification to connected WebSocket clients
            for (const notification of notifications) {
              broadcastNotification(notification);
            }
            if (notifications.length > 0) {
              console.log(`[connector-service] ${notifications.length} notification(s) pushed via WebSocket`);
            }
          }
        }
      } catch (ruleErr: any) {
        console.error(`[connector-service] Monitor rule evaluation error:`, ruleErr.message);
      }
    }

    // Run email triage agent on new inbound messages (async, non-blocking)
    if (threads.length > 0) {
      triggerEmailTriage(accountId, since ?? 0).catch((triageErr: any) => {
        console.error(`[connector-service] Triage error for account ${accountId}:`, triageErr.message);
      });
    }

    // For Notion connectors: cache page content in notion_pages table
    if (connector.provider === 'notion' && threads.length > 0) {
      try {
        for (const thread of threads) {
          const messages = await connector.fetchThreadMessages(thread.id);
          const pageContent = messages[0]?.content ?? null;
          upsertNotionPage(accountId, {
            notionPageId: thread.externalId,
            title: thread.displayName,
            url: `https://notion.so/${thread.externalId.replace(/-/g, '')}`,
            contentMd: pageContent,
            lastEditedAt: thread.lastMessageAt ?? undefined,
          });
        }
        console.log(`[connector-service] Cached ${threads.length} Notion page(s) for account ${accountId}`);
      } catch (notionErr: any) {
        console.error(`[connector-service] Notion page cache error:`, notionErr.message);
      }
    }

    return { threadCount: threads.length };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err.message ?? 'Sync failed';
    console.error(`[connector-service] Sync failed for account ${accountId} (${(durationMs / 1000).toFixed(1)}s): ${errorMsg}`);

    // Track failure for backoff
    const failures = (failureCounts.get(accountId) ?? 0) + 1;
    failureCounts.set(accountId, failures);

    // Update sync state with error
    const prevState = syncStates.get(accountId);
    syncStates.set(accountId, {
      lastSyncAt: prevState?.lastSyncAt ?? null,
      lastError: errorMsg,
      threadCount: prevState?.threadCount ?? 0,
      lastDurationMs: durationMs,
    });

    // Broadcast error to frontend
    broadcastSyncError(accountId, errorMsg);

    // If the error is an auth failure, deactivate and stop
    if (errorMsg.includes('401') || errorMsg.includes('No active') || errorMsg.includes('re-authenticate')) {
      console.error(`[connector-service] Auth failure for account ${accountId}, removing from polling`);
      pollingAccountIds = pollingAccountIds.filter((id) => id !== accountId);
    }

    // Log actionable info for timeout errors
    if (errorMsg.includes('TIMEOUT')) {
      const consecutiveFails = failureCounts.get(accountId) ?? 0;
      console.warn(
        `[connector-service] Account ${accountId} has timed out ${consecutiveFails} consecutive time(s). ` +
        `This account's Outlook mailbox may have too many messages or a slow Exchange server. ` +
        `Consider reducing the SYNC_LIMIT or checking Outlook connectivity for this account.`
      );
    }

    return { threadCount: 0, error: errorMsg };
  }
}

/**
 * Convenience wrapper: sync ALL accounts for a given provider.
 * Used by webhooks when we know the provider but not the specific account.
 */
export async function syncProvider(provider: string): Promise<{ threadCount: number; error?: string }> {
  const connectors = ConnectorRegistry.getByProvider(provider as any);
  let totalThreads = 0;
  let lastError: string | undefined;

  for (const connector of connectors) {
    const result = await syncAccount(connector.accountId);
    totalThreads += result.threadCount;
    if (result.error) lastError = result.error;
  }

  return { threadCount: totalThreads, error: lastError };
}

/**
 * Run one full round: sync each account sequentially, then schedule next round.
 */
async function runRound(): Promise<void> {
  if (!roundRobinActive) return;

  const roundStart = Date.now();
  const accountIds = [...pollingAccountIds]; // snapshot
  console.log(`[polling] === Round start: ${accountIds.length} account(s) ===`);

  for (let i = 0; i < accountIds.length; i++) {
    if (!roundRobinActive) return; // stopped mid-round

    const accountId = accountIds[i];
    console.log(`[polling] [${i + 1}/${accountIds.length}] Syncing account ${accountId}`);

    await syncAccount(accountId).catch(() => {
      // Error already logged inside syncAccount
    });

    // Small pause between accounts to let Outlook breathe
    if (i < accountIds.length - 1 && roundRobinActive) {
      await sleep(INTER_ACCOUNT_PAUSE_MS);
    }
  }

  const roundDurationMs = Date.now() - roundStart;
  console.log(`[polling] === Round complete in ${(roundDurationMs / 1000).toFixed(1)}s ===`);

  // Print timing summary
  for (const accountId of accountIds) {
    const state = syncStates.get(accountId);
    if (state) {
      const dur = state.lastDurationMs != null ? `${(state.lastDurationMs / 1000).toFixed(1)}s` : 'N/A';
      const err = state.lastError ? ` (error: ${state.lastError})` : '';
      console.log(`[polling]   ${accountId}: ${dur}${err}`);
    }
  }

  // Schedule next round
  if (roundRobinActive) {
    console.log(`[polling] Next round in ${ROUND_PAUSE_MS / 1000}s`);
    roundRobinTimer = setTimeout(() => {
      runRound().catch((err) => {
        console.error('[polling] Round error:', err);
        // Still try to schedule next round
        if (roundRobinActive) {
          roundRobinTimer = setTimeout(() => runRound(), ROUND_PAUSE_MS);
        }
      });
    }, ROUND_PAUSE_MS);
  }
}

/**
 * Initialize round-robin polling for all active connectors.
 * Syncs accounts one-by-one in sequence, then pauses before the next round.
 * Call this at server startup.
 */
export function initPolling(): void {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id FROM connectors WHERE active = 1'
  ).all() as { id: string }[];

  pollingAccountIds = rows
    .filter((row) => {
      const conn = ConnectorRegistry.get(row.id);
      // Exclude LINE/Teams connectors — they use their own monitor agents (30s loop)
      return conn != null && conn.provider !== 'line' && conn.provider !== 'teams';
    })
    .map((row) => row.id);

  if (pollingAccountIds.length === 0) {
    console.log('[polling] No active connectors found, polling not started');
    return;
  }

  console.log(`[polling] Starting round-robin polling for ${pollingAccountIds.length} account(s), round interval: ${ROUND_PAUSE_MS / 1000}s`);
  roundRobinActive = true;

  // First round starts after a short delay to let the HTTP server finish startup
  roundRobinTimer = setTimeout(() => {
    runRound().catch((err) => {
      console.error('[polling] First round error:', err);
    });
  }, 5_000);
}

/**
 * Start polling for a specific account (add to round-robin).
 * If round-robin isn't active yet, start it.
 *
 * Note: LINE connectors should use startLineMonitoring() instead.
 */
export function startPolling(accountId: string): void {
  // LINE/Teams connectors use their own monitor agents, not the Outlook round-robin
  const connector = ConnectorRegistry.get(accountId);
  if (connector && (connector.provider === 'line' || connector.provider === 'teams')) {
    console.log(`[polling] Skipping round-robin for ${connector.provider} account ${accountId} — uses dedicated monitor agent`);
    return;
  }

  if (!pollingAccountIds.includes(accountId)) {
    pollingAccountIds.push(accountId);
    console.log(`[polling] Added account ${accountId} to round-robin (${pollingAccountIds.length} total)`);
  }

  if (!roundRobinActive) {
    roundRobinActive = true;
    console.log(`[polling] Starting round-robin polling`);
    roundRobinTimer = setTimeout(() => {
      runRound().catch((err) => {
        console.error('[polling] Round error:', err);
      });
    }, 5_000);
  }
}

/**
 * Stop polling for a specific account (remove from round-robin).
 */
export function stopPolling(accountId: string): void {
  pollingAccountIds = pollingAccountIds.filter((id) => id !== accountId);
  failureCounts.delete(accountId);
  syncStates.delete(accountId);
  console.log(`[polling] Removed account ${accountId} from round-robin (${pollingAccountIds.length} remaining)`);

  // If no more accounts, stop the loop
  if (pollingAccountIds.length === 0) {
    stopAllPolling();
  }
}

/**
 * Stop all polling.
 */
export function stopAllPolling(): void {
  roundRobinActive = false;
  if (roundRobinTimer) {
    clearTimeout(roundRobinTimer);
    roundRobinTimer = null;
  }
  pollingAccountIds = [];
  failureCounts.clear();
  syncStates.clear();
  console.log('[polling] All polling stopped');
}

/**
 * Check if polling is active for an account.
 */
export function isPolling(accountId: string): boolean {
  return roundRobinActive && pollingAccountIds.includes(accountId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Trigger the email triage agent on new inbound messages for an account.
 * Runs asynchronously — does NOT block the sync flow.
 *
 * Only runs if triage_enabled is set on the connector.
 */
async function triggerEmailTriage(accountId: string, sinceTsMs: number): Promise<void> {
  const db = getDb();

  // Check if triage is enabled for this account
  const connRow = db.prepare(
    'SELECT triage_enabled, triage_filter_commercial, triage_auto_instruction, provider FROM connectors WHERE id = ?'
  ).get(accountId) as {
    triage_enabled: number | null;
    triage_filter_commercial: number | null;
    triage_auto_instruction: string | null;
    provider: string;
  } | undefined;

  if (!connRow || connRow.triage_enabled !== 1) {
    console.log(`[triage] Skipped account ${accountId} — triage not enabled (triage_enabled=${connRow?.triage_enabled})`);
    return;
  }

  // Use created_at (DB insert time) instead of timestamp (email receivedAt) because
  // Outlook may return emails whose receivedAt is older than the last sync time,
  // but created_at always reflects when the message was first persisted during this sync.
  const rows = db.prepare(
    `SELECT id FROM external_messages
     WHERE account_id = ? AND is_inbound = 1 AND created_at > ?
     ORDER BY created_at ASC`
  ).all(accountId, sinceTsMs) as { id: string }[];

  if (rows.length === 0) {
    console.log(`[triage] No new inbound messages for account ${accountId} since ${new Date(sinceTsMs).toISOString()}`);
    return;
  }

  console.log(`[triage] Triggering triage for ${rows.length} new inbound message(s) on account ${accountId}`);

  // Dynamically import triage agent to avoid circular deps
  const { agentRegistry } = await import('../agents/registry');
  const triageAgent = agentRegistry.get('email-triage');
  if (!triageAgent) {
    console.warn('[connector-service] email-triage agent not registered');
    return;
  }

  const input = {
    accountId,
    provider: connRow.provider,
    messageIds: rows.map((r) => r.id),
    filterCommercial: connRow.triage_filter_commercial !== 0,
    autoReplyInstruction: connRow.triage_auto_instruction,
  };

  const result = await triageAgent.execute(input, {
    sessionId: `triage-${accountId}-${Date.now()}`,
    messages: [],
    artifacts: [],
  });

  console.log(`[triage] Result for ${accountId}: ${result.output}`);
  if (result.log.length > 0) {
    console.log(`[triage] Log: ${result.log.join('; ')}`);
  }
}
