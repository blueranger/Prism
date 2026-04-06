/**
 * Model Refresh Scheduler
 *
 * Periodically refreshes the model registry by querying provider APIs.
 * Controlled via environment variables:
 *   MODEL_DISCOVERY_ENABLED=true  — enable automatic refresh (default: false)
 *   MODEL_DISCOVERY_CRON=0 2 * * *  — cron expression (default: daily at 2 AM)
 */

import { modelRegistry } from './model-registry';

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Default: once every 24 hours (in ms) */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function parseRefreshIntervalMs(): number {
  const raw = parseInt(process.env.MODEL_DISCOVERY_INTERVAL_MS ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_INTERVAL_MS;
  }
  return raw;
}

export function isModelDiscoveryEnabled(): boolean {
  return process.env.MODEL_DISCOVERY_ENABLED === 'true';
}

export function getModelDiscoveryIntervalMs(): number {
  return parseRefreshIntervalMs();
}

/**
 * Start the model refresh scheduler.
 * Runs an initial refresh on startup, then repeats at the configured interval.
 */
export function startModelRefreshScheduler(): void {
  const enabled = isModelDiscoveryEnabled();
  if (!enabled) {
    console.log('[model-refresh] MODEL_DISCOVERY_ENABLED is not true, scheduler disabled');
    return;
  }

  const intervalMs = parseRefreshIntervalMs();

  console.log(`[model-refresh] Scheduler started (interval: ${intervalMs / 1000}s)`);

  // Initial refresh (non-blocking)
  console.log('[model-refresh] Running initial refresh');
  modelRegistry.refresh().catch((err) => {
    console.error('[model-refresh] Initial refresh failed:', err);
  });

  // Periodic refresh
  intervalHandle = setInterval(async () => {
    try {
      console.log('[model-refresh] Running scheduled refresh');
      const result = await modelRegistry.refresh();
      console.log(`[model-refresh] Scheduled refresh done: ${result.total} models`);
    } catch (err) {
      console.error('[model-refresh] Scheduled refresh failed:', err);
    }
  }, intervalMs);
}

/** Stop the scheduler (for graceful shutdown / testing) */
export function stopModelRefreshScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[model-refresh] Scheduler stopped');
  }
}
