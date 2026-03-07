import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { ConnectorType } from '@prism/shared';
import { ConnectorRegistry } from '../connectors/registry';
import { getDb } from '../memory/db';
import { startPolling, stopPolling, syncAccount, getSyncState, getAllSyncStates } from '../services/connector-service';
import { createSubscription, deleteSubscription } from '../services/graph-subscriptions';
import { OutlookLocalConnector } from '../connectors/outlook-local';
import { discoverOutlookAccounts } from '../services/outlook-applescript';
import { LineConnector } from '../connectors/line';
import { connectToLine, isLineConnected, readChatList } from '../services/line-puppeteer';
import { startLineMonitoring, stopLineMonitoring } from '../agents/line-monitor';
import { TeamsConnector } from '../connectors/teams';
import { connectToTeams, isTeamsConnected, readChatList as readTeamsChatList } from '../services/teams-puppeteer';
import { startTeamsMonitoring, stopTeamsMonitoring } from '../agents/teams-monitor';

const router = Router();

/**
 * GET /api/connectors
 * List all account statuses (each connected account is a separate entry).
 */
router.get('/', (_req, res) => {
  const statuses = ConnectorRegistry.getStatuses();
  const syncStates = getAllSyncStates();

  // Merge sync state info (lastSyncError, threadCount) into connector statuses
  const enriched = statuses.map((s) => {
    const syncState = syncStates.get(s.accountId);
    return {
      ...s,
      lastSyncError: syncState?.lastError ?? null,
      threadCount: syncState?.threadCount ?? s.threadCount ?? 0,
    };
  });

  res.json({ connectors: enriched });
});

/**
 * GET /api/connectors/types
 * List available connector types (for "Add Account" UI).
 */
router.get('/types', (_req, res) => {
  const types = ConnectorRegistry.getAvailableTypes();
  res.json({ types });
});

/**
 * GET /api/connectors/status
 * Detailed sync state for all connected accounts.
 * Returns: accountId, displayName, email, provider, connectorType, threadCount, lastSyncAt, lastError
 */
router.get('/status', (_req, res) => {
  const statuses = ConnectorRegistry.getStatuses();
  const db = getDb();

  const result = statuses.map((s) => {
    const syncState = getSyncState(s.accountId);

    // Fall back to DB thread count if no sync state yet
    const threadCount = syncState?.threadCount ??
      ((db.prepare(
        'SELECT COUNT(*) as cnt FROM external_threads WHERE account_id = ?'
      ).get(s.accountId) as { cnt: number })?.cnt ?? 0);

    // Fall back to DB last_synced_at if no sync state
    const lastSyncAt = syncState?.lastSyncAt ?? s.lastSyncedAt;

    return {
      accountId: s.accountId,
      provider: s.provider,
      connectorType: s.connectorType,
      displayName: s.displayName ?? null,
      email: s.email ?? null,
      isLocal: s.isLocal ?? false,
      connected: s.connected,
      threadCount,
      lastSyncAt: lastSyncAt ?? null,
      lastError: syncState?.lastError ?? null,
    };
  });

  res.json({ accounts: result });
});

/**
 * POST /api/connectors/connect/:connectorType
 * Initiate connection for a connector type.
 * - For OAuth types: creates pending DB row, returns { url, accountId }
 * - For local types: creates DB row, activates, returns { ok, accountId }
 */
router.post('/connect/:connectorType', async (req, res) => {
  const connectorType = req.params.connectorType as ConnectorType;

  try {
    // Check if this is a local connector type by creating a temporary probe
    const probeId = '__probe__connect__';
    const probeCls = ConnectorRegistry.createInstance(connectorType, probeId);
    const isLocal = probeCls.isLocal;
    ConnectorRegistry.removeInstance(probeId);

    if (connectorType === 'manual') {
      // Manual connector — setup is handled via /api/comm/manual/setup
      res.status(400).json({
        error: 'Manual connectors should be set up via POST /api/comm/manual/setup',
      });
      return;
    }

    if (isLocal && connectorType === 'line') {
      // --- LINE local connector: connect via Puppeteer ---
      const db = getDb();

      // Check if there's already an active LINE connector
      const existingLine = db.prepare(
        "SELECT id FROM connectors WHERE connector_type = 'line' AND active = 1"
      ).get() as { id: string } | undefined;

      if (existingLine) {
        res.json({ ok: true, message: 'LINE is already connected.', accounts: [{ accountId: existingLine.id, name: 'LINE' }] });
        return;
      }

      // Try to connect to Chrome and LINE Extension
      try {
        await connectToLine();
      } catch (err: any) {
        res.status(400).json({
          error: `Cannot connect to LINE Chrome Extension. ${err.message}`,
        });
        return;
      }

      // Read chat list to verify connection
      let chats;
      try {
        chats = await readChatList();
      } catch (err: any) {
        res.status(400).json({
          error: `Connected to Chrome but cannot read LINE chats: ${err.message}`,
        });
        return;
      }

      // Create the LINE connector instance
      const accountId = uuid();
      const instance = ConnectorRegistry.createInstance('line', accountId) as LineConnector;
      instance.activateLineConnector('LINE');

      // Start the LINE monitor agent (30s polling loop, auto-draft)
      // This replaces the generic 5-min round-robin for LINE
      startLineMonitoring(accountId);

      res.json({
        ok: true,
        accounts: [{ accountId, name: 'LINE' }],
        chats: chats.map(c => ({ name: c.name, lastMessage: c.lastMessage, time: c.time, unreadCount: c.unreadCount })),
      });
    } else if (isLocal && connectorType === 'teams') {
      // --- Teams Web connector: connect via Puppeteer ---
      const db = getDb();

      // Check if there's already an active Teams connector
      const existingTeams = db.prepare(
        "SELECT id FROM connectors WHERE connector_type = 'teams' AND active = 1"
      ).get() as { id: string } | undefined;

      if (existingTeams) {
        res.json({ ok: true, message: 'Teams is already connected.', accounts: [{ accountId: existingTeams.id, name: 'Teams' }] });
        return;
      }

      // Try to connect to Chrome and Teams Web
      try {
        await connectToTeams();
      } catch (err: any) {
        res.status(400).json({
          error: `Cannot connect to Teams Web. ${err.message}`,
        });
        return;
      }

      // Read chat list to verify connection
      let chats;
      try {
        chats = await readTeamsChatList();
      } catch (err: any) {
        res.status(400).json({
          error: `Connected to Chrome but cannot read Teams chats: ${err.message}`,
        });
        return;
      }

      // Create the Teams connector instance
      const accountId = uuid();
      const instance = ConnectorRegistry.createInstance('teams', accountId) as TeamsConnector;
      instance.activateTeamsConnector('Teams');

      // Start the Teams monitor agent (30s polling loop)
      startTeamsMonitoring(accountId);

      res.json({
        ok: true,
        accounts: [{ accountId, name: 'Teams' }],
        chats: chats.map(c => ({ name: c.name, lastMessage: c.lastMessage, time: c.time, unreadCount: c.unreadCount, isGroup: c.isGroup })),
      });
    } else if (isLocal) {
      // --- Outlook local connector: discover accounts ---
      const probe = new OutlookLocalConnector('__probe_local__');
      if (!probe.isLocalConnected()) {
        res.status(400).json({
          error: 'Outlook for macOS is not running. Please open it first.',
        });
        return;
      }

      const discovered = discoverOutlookAccounts();
      if (discovered.length === 0) {
        res.status(400).json({
          error: 'No email accounts found in Outlook. Please configure at least one account.',
        });
        return;
      }

      // Check which accounts already have active connectors (by email)
      const db = getDb();
      const existingEmails = new Set<string>();
      const existingRows = db.prepare(
        "SELECT email FROM connectors WHERE connector_type = 'outlook-local' AND active = 1 AND email IS NOT NULL"
      ).all() as { email: string }[];
      for (const row of existingRows) {
        existingEmails.add(row.email.toLowerCase());
      }

      const newAccounts: { accountId: string; email: string; name: string }[] = [];

      for (const acct of discovered) {
        if (existingEmails.has(acct.email.toLowerCase())) continue; // skip duplicates

        const accountId = uuid();
        const instance = ConnectorRegistry.createInstance(connectorType, accountId) as OutlookLocalConnector;
        instance.setAccountRef(acct.accountType, acct.accountIndex);
        instance.activateLocalConnector(acct.email, acct.name);
        startPolling(accountId);
        newAccounts.push({ accountId, email: acct.email, name: acct.name });
      }

      if (newAccounts.length === 0) {
        res.json({ ok: true, message: 'All Outlook accounts are already connected.', accounts: [] });
      } else {
        res.json({ ok: true, accounts: newAccounts });
      }
    } else {
      // OAuth connector: create pending DB row and return auth URL
      const accountId = uuid();
      const instance = ConnectorRegistry.createInstance(connectorType, accountId);
      const db = getDb();
      const now = Date.now();
      db.prepare(
        'INSERT INTO connectors (id, provider, connector_type, config, active, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)'
      ).run(accountId, instance.provider, connectorType, '{}', now, now);

      const url = instance.getOAuthUrl();
      res.json({ url, accountId });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/connectors/outlook/callback
 * OAuth callback from Microsoft. Reads state=<accountId> from query params.
 */
router.get('/outlook/callback', async (req, res) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const error = req.query.error as string | undefined;

  if (error) {
    res.status(400).send(`
      <html><body>
        <h2>Authentication Failed</h2>
        <p>${(req.query.error_description as string ?? 'Unknown error').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
        <p>You can close this window.</p>
      </body></html>
    `);
    return;
  }

  if (!code || !state) {
    res.status(400).send(`
      <html><body>
        <h2>Invalid Callback</h2>
        <p>Missing authorization code or state parameter.</p>
      </body></html>
    `);
    return;
  }

  const accountId = state;
  const connector = ConnectorRegistry.get(accountId);

  if (!connector) {
    res.status(400).send(`
      <html><body>
        <h2>Unknown Account</h2>
        <p>No pending connector found for this authentication request.</p>
      </body></html>
    `);
    return;
  }

  try {
    await connector.exchangeCodeForToken(code);

    // Start polling and create Graph webhook subscription
    startPolling(accountId);
    createSubscription(accountId).catch((err: any) => {
      console.error('[connectors] Failed to create Graph subscription:', err.message);
    });

    res.send(`<!DOCTYPE html>
<html><head><title>Connected</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#e5e7eb;}
.card{text-align:center;padding:2rem;border-radius:12px;background:#1f2937;border:1px solid #374151;}
h1{font-size:1.25rem;margin:0 0 0.5rem;color:#10b981;}
p{font-size:0.875rem;color:#9ca3af;margin:0;}
</style></head>
<body><div class="card">
<h1>Account Connected</h1>
<p>Your Microsoft 365 account has been connected to Prism. You can close this window.</p>
</div>
<script>setTimeout(()=>window.close(),2000)</script>
</body></html>`);
  } catch (err: any) {
    console.error('[connectors] OAuth callback error:', err.message);
    ConnectorRegistry.removeInstance(accountId);

    res.status(500).send(`<!DOCTYPE html>
<html><head><title>Connection Failed</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#e5e7eb;}
.card{text-align:center;padding:2rem;border-radius:12px;background:#1f2937;border:1px solid #374151;max-width:400px;}
h1{font-size:1.25rem;margin:0 0 0.5rem;color:#ef4444;}
p{font-size:0.875rem;color:#9ca3af;margin:0;}
</style></head>
<body><div class="card">
<h1>Connection Failed</h1>
<p>${err.message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
<p>You can close this window and try again.</p>
</div></body></html>`);
  }
});

/**
 * PATCH /api/connectors/:accountId
 * Update connector settings (e.g. persona).
 * Body: { persona?: string }
 */
router.patch('/:accountId', (req, res) => {
  const { accountId } = req.params;
  const { persona } = req.body;

  const db = getDb();
  const row = db.prepare('SELECT id FROM connectors WHERE id = ?').get(accountId) as { id: string } | undefined;

  if (!row) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }

  const now = Date.now();
  db.prepare(
    'UPDATE connectors SET persona = ?, updated_at = ? WHERE id = ?'
  ).run(persona ?? null, now, accountId);

  const statuses = ConnectorRegistry.getStatuses();
  const updated = statuses.find((s) => s.accountId === accountId);
  res.json({ connector: updated ?? { accountId, persona } });
});

/**
 * POST /api/connectors/:accountId/disconnect
 * Disconnect a specific account.
 */
router.post('/:accountId/disconnect', async (req, res) => {
  const { accountId } = req.params;
  const connector = ConnectorRegistry.get(accountId);

  if (!connector) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }

  try {
    // Stop monitor agent if this is a LINE or Teams connector
    if (connector.provider === 'line') {
      stopLineMonitoring(accountId);
    }
    if (connector.provider === 'teams') {
      stopTeamsMonitoring(accountId);
    }
    stopPolling(accountId);
    await deleteSubscription(accountId);
    await connector.disconnect();
    ConnectorRegistry.removeInstance(accountId);

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/connectors/:accountId/sync
 * Manually trigger a sync for a specific account.
 */
router.post('/:accountId/sync', async (req, res) => {
  const { accountId } = req.params;
  const connector = ConnectorRegistry.get(accountId);

  if (!connector) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }

  try {
    const result = await syncAccount(accountId);
    const syncState = getSyncState(accountId);

    if (result.error) {
      // Return 200 with error details so the frontend can display them
      res.json({
        ok: false,
        error: result.error,
        threadCount: syncState?.threadCount ?? 0,
        threads: [],
      });
    } else {
      // Fetch the current threads for this account to return
      const db = getDb();
      const threads = db.prepare(
        `SELECT * FROM external_threads WHERE account_id = ? ORDER BY last_message_at DESC`
      ).all(accountId) as any[];

      res.json({
        ok: true,
        threadCount: result.threadCount,
        totalThreadCount: syncState?.threadCount ?? threads.length,
        threads: threads.map((t: any) => ({
          id: t.id,
          provider: t.provider,
          accountId: t.account_id ?? '',
          externalId: t.external_id,
          sessionId: t.session_id ?? null,
          displayName: t.display_name,
          subject: t.subject ?? null,
          senderName: t.sender_name ?? null,
          senderEmail: t.sender_email ?? null,
          isGroup: t.is_group === 1,
          messageCount: t.message_count ?? 0,
          lastMessageAt: t.last_message_at ?? null,
          lastSyncedAt: t.last_synced_at ?? null,
          createdAt: t.created_at,
        })),
      });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================
// LINE-specific endpoints
// =============================================================

/**
 * GET /api/connectors/:accountId/line/chats
 * List available LINE chats (live from Chrome Extension).
 */
router.get('/:accountId/line/chats', async (req, res) => {
  const { accountId } = req.params;
  const connector = ConnectorRegistry.get(accountId);

  if (!connector || connector.provider !== 'line') {
    res.status(404).json({ error: 'LINE account not found' });
    return;
  }

  try {
    if (!isLineConnected()) {
      await connectToLine();
    }
    const chats = await readChatList();
    const lineConn = connector as LineConnector;
    const monitoredNames = lineConn.getMonitoredChatNames();
    const chatConfigs = lineConn.getChatConfigs();

    res.json({
      chats: chats.map(c => {
        const config = chatConfigs?.find(cfg => cfg.name === c.name);
        return {
          name: c.name,
          lastMessage: c.lastMessage,
          time: c.time,
          unreadCount: c.unreadCount,
          index: c.index,
          isMonitored: monitoredNames === null || monitoredNames.includes(c.name),
          config: config ?? null,
        };
      }),
      chatConfigs,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/connectors/:accountId/line/chat-configs
 * Set per-chat monitoring configurations.
 * Body: { configs: LineChatConfig[] | null }  (null = monitor all with defaults)
 */
router.put('/:accountId/line/chat-configs', (req, res) => {
  const { accountId } = req.params;
  const { configs } = req.body;
  const connector = ConnectorRegistry.get(accountId);

  if (!connector || connector.provider !== 'line') {
    res.status(404).json({ error: 'LINE account not found' });
    return;
  }

  const lineConn = connector as LineConnector;
  lineConn.setChatConfigs(configs ?? null);

  res.json({ ok: true, chatConfigs: lineConn.getChatConfigs() });
});

/**
 * PUT /api/connectors/:accountId/line/chat-configs/:chatName
 * Update config for a single chat.
 * Body: { enabled?, persona?, tone?, instruction?, language? }
 */
router.put('/:accountId/line/chat-configs/:chatName', (req, res) => {
  const { accountId, chatName } = req.params;
  const connector = ConnectorRegistry.get(accountId);

  if (!connector || connector.provider !== 'line') {
    res.status(404).json({ error: 'LINE account not found' });
    return;
  }

  const lineConn = connector as LineConnector;
  // Only include fields that were explicitly sent (not undefined) to avoid overwriting existing values
  const update: Record<string, unknown> = {};
  if (req.body.enabled !== undefined) update.enabled = req.body.enabled;
  if (req.body.persona !== undefined) update.persona = req.body.persona;
  if (req.body.tone !== undefined) update.tone = req.body.tone;
  if (req.body.instruction !== undefined) update.instruction = req.body.instruction;
  if (req.body.language !== undefined) update.language = req.body.language;
  lineConn.updateChatConfig(decodeURIComponent(chatName), update);

  const updated = lineConn.getChatConfig(decodeURIComponent(chatName));
  res.json({ ok: true, config: updated });
});

/**
 * GET /api/connectors/:accountId/line/chat-configs
 * Get all per-chat monitoring configurations.
 */
router.get('/:accountId/line/chat-configs', (req, res) => {
  const { accountId } = req.params;
  const connector = ConnectorRegistry.get(accountId);

  if (!connector || connector.provider !== 'line') {
    res.status(404).json({ error: 'LINE account not found' });
    return;
  }

  const lineConn = connector as LineConnector;
  res.json({ chatConfigs: lineConn.getChatConfigs() });
});

/**
 * POST /api/connectors/:accountId/line/monitor
 * Control the LINE monitor agent.
 * Body: { action: 'start' | 'stop' | 'status' }
 */
router.post('/:accountId/line/monitor', async (req, res) => {
  const { accountId } = req.params;
  const { action } = req.body;
  const connector = ConnectorRegistry.get(accountId);

  if (!connector || connector.provider !== 'line') {
    res.status(404).json({ error: 'LINE account not found' });
    return;
  }

  if (!action || !['start', 'stop', 'status'].includes(action)) {
    res.status(400).json({ error: 'action must be start, stop, or status' });
    return;
  }

  const { isLineMonitoringActive } = await import('../agents/line-monitor');

  if (action === 'start') {
    startLineMonitoring(accountId);
    res.json({ ok: true, running: true });
  } else if (action === 'stop') {
    stopLineMonitoring(accountId);
    res.json({ ok: true, running: false });
  } else {
    res.json({ running: isLineMonitoringActive(accountId) });
  }
});

// ============================================================
//  Teams-specific routes (mirror LINE routes)
// ============================================================

/**
 * GET /api/connectors/:accountId/teams/chats
 * Read the Teams chat list via Puppeteer.
 */
router.get('/:accountId/teams/chats', async (req, res) => {
  const { accountId } = req.params;
  const connector = ConnectorRegistry.get(accountId);

  if (!connector || connector.provider !== 'teams') {
    res.status(404).json({ error: 'Teams account not found' });
    return;
  }

  try {
    const teamsConn = connector as TeamsConnector;
    const monitoredNames = teamsConn.getMonitoredChatNames();
    const chatConfigs = teamsConn.getChatConfigs();
    const chats = await readTeamsChatList();

    res.json({
      chats: chats.map(c => ({
        name: c.name,
        lastMessage: c.lastMessage,
        time: c.time,
        unreadCount: c.unreadCount,
        isGroup: c.isGroup,
        monitored: monitoredNames === null ? true : monitoredNames.includes(c.name),
        config: chatConfigs?.find(cfg => cfg.name === c.name) ?? null,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to read Teams chats: ${err.message}` });
  }
});

/**
 * PUT /api/connectors/:accountId/teams/chat-configs
 * Set per-chat monitoring configurations.
 */
router.put('/:accountId/teams/chat-configs', (req, res) => {
  const { accountId } = req.params;
  const { configs } = req.body;
  const connector = ConnectorRegistry.get(accountId);

  if (!connector || connector.provider !== 'teams') {
    res.status(404).json({ error: 'Teams account not found' });
    return;
  }

  const teamsConn = connector as TeamsConnector;
  teamsConn.setChatConfigs(configs ?? null);

  res.json({ ok: true, chatConfigs: teamsConn.getChatConfigs() });
});

/**
 * PUT /api/connectors/:accountId/teams/chat-configs/:chatName
 * Update a single chat's config.
 */
router.put('/:accountId/teams/chat-configs/:chatName', (req, res) => {
  const { accountId, chatName } = req.params;
  const connector = ConnectorRegistry.get(accountId);

  if (!connector || connector.provider !== 'teams') {
    res.status(404).json({ error: 'Teams account not found' });
    return;
  }

  const teamsConn = connector as TeamsConnector;

  const update: Record<string, unknown> = {};
  if (req.body.enabled !== undefined) update.enabled = req.body.enabled;
  if (req.body.persona !== undefined) update.persona = req.body.persona;
  if (req.body.tone !== undefined) update.tone = req.body.tone;
  if (req.body.instruction !== undefined) update.instruction = req.body.instruction;
  if (req.body.language !== undefined) update.language = req.body.language;
  teamsConn.updateChatConfig(decodeURIComponent(chatName), update);

  const updated = teamsConn.getChatConfig(decodeURIComponent(chatName));
  res.json({ ok: true, config: updated });
});

/**
 * GET /api/connectors/:accountId/teams/chat-configs
 * Get all per-chat monitoring configurations.
 */
router.get('/:accountId/teams/chat-configs', (req, res) => {
  const { accountId } = req.params;
  const connector = ConnectorRegistry.get(accountId);

  if (!connector || connector.provider !== 'teams') {
    res.status(404).json({ error: 'Teams account not found' });
    return;
  }

  const teamsConn = connector as TeamsConnector;
  res.json({ chatConfigs: teamsConn.getChatConfigs() });
});

/**
 * POST /api/connectors/:accountId/teams/monitor
 * Control the Teams monitor agent.
 */
router.post('/:accountId/teams/monitor', async (req, res) => {
  const { accountId } = req.params;
  const { action } = req.body;
  const connector = ConnectorRegistry.get(accountId);

  if (!connector || connector.provider !== 'teams') {
    res.status(404).json({ error: 'Teams account not found' });
    return;
  }

  if (!action || !['start', 'stop', 'status'].includes(action)) {
    res.status(400).json({ error: 'action must be start, stop, or status' });
    return;
  }

  const { isTeamsMonitoringActive } = await import('../agents/teams-monitor');

  if (action === 'start') {
    startTeamsMonitoring(accountId);
    res.json({ ok: true, running: true });
  } else if (action === 'stop') {
    stopTeamsMonitoring(accountId);
    res.json({ ok: true, running: false });
  } else {
    res.json({ running: isTeamsMonitoringActive(accountId) });
  }
});

export default router;
