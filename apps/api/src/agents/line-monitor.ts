import { v4 as uuid } from 'uuid';
import type { AgentInputSchema, AgentResult, ExternalMessage, CommNotification } from '@prism/shared';
import { BaseAgent, type MemoryContext } from './base';
import { agentRegistry } from './registry';
import { getDb } from '../memory/db';
import { broadcast, broadcastNotification } from '../services/ws';

/** Polling interval for LINE chat monitoring: 30 seconds */
const LINE_POLL_INTERVAL_MS = 30_000;

/** Track running monitor loops by accountId */
const activeMonitors = new Map<string, ReturnType<typeof setTimeout>>();

/** Track last known message count per thread to detect new messages */
const lastKnownCounts = new Map<string, number>();

/**
 * LineMonitorAgent — autonomous agent that monitors LINE chats
 * and auto-drafts replies when new inbound messages arrive.
 *
 * Unlike the generic monitor-engine (which requires manual rule setup),
 * this agent:
 *   1. Runs on a 30-second loop (not Outlook's 5-minute round-robin)
 *   2. Auto-starts when LINE connector is connected
 *   3. Monitors chats from the connector's monitoredChats list
 *   4. Auto-triggers ReplyDraftAgent for each new inbound message
 *   5. Pushes WebSocket notifications so the user can review drafts
 *
 * Flow:
 *   startMonitoring(accountId) → loop every 30s →
 *     connector.fetchThreads() → detect new messages →
 *       for each new inbound message → ReplyDraftAgent.execute() →
 *         save draft (status=pending) → WebSocket notify frontend
 */
class LineMonitorAgent extends BaseAgent {
  name = 'line-monitor';
  description =
    'Autonomously monitors LINE chats and drafts replies for new inbound messages. ' +
    'Runs on a 30-second polling loop. Monitored chats are configured per connector.';

  inputSchema: AgentInputSchema = {
    type: 'object',
    properties: {
      accountId: { type: 'string', description: 'LINE connector account ID' },
      action: {
        type: 'string',
        description: 'start | stop | status — control the monitoring loop',
      },
    },
    required: ['accountId', 'action'],
  };

  async execute(
    input: Record<string, unknown>,
    _context: MemoryContext
  ): Promise<AgentResult> {
    const accountId = input.accountId as string;
    const action = input.action as string;

    switch (action) {
      case 'start':
        return this.startMonitoring(accountId);
      case 'stop':
        return this.stopMonitoring(accountId);
      case 'status':
        return this.getStatus(accountId);
      default:
        return this.fail(`Unknown action: ${action}. Use start, stop, or status.`);
    }
  }

  // --- Monitoring lifecycle ---

  private startMonitoring(accountId: string): AgentResult {
    if (activeMonitors.has(accountId)) {
      return this.ok(`LINE monitor already running for ${accountId}`, {
        log: ['Monitor already active'],
      });
    }

    // Initialize last known counts from DB
    this.initializeLastKnownCounts(accountId);

    // Start the polling loop
    const run = async () => {
      try {
        await this.pollOnce(accountId);
      } catch (err: any) {
        console.error(`[line-monitor] Poll error for ${accountId}:`, err.message);
      }

      // Schedule next poll if still active
      if (activeMonitors.has(accountId)) {
        const timer = setTimeout(run, LINE_POLL_INTERVAL_MS);
        activeMonitors.set(accountId, timer);
      }
    };

    // First poll immediately
    const timer = setTimeout(run, 0);
    activeMonitors.set(accountId, timer);

    console.log(`[line-monitor] Started monitoring for ${accountId} (interval: ${LINE_POLL_INTERVAL_MS / 1000}s)`);

    broadcast({
      type: 'comm:lineMonitor',
      accountId,
      status: 'started',
      interval: LINE_POLL_INTERVAL_MS,
    });

    return this.ok(`LINE monitor started for ${accountId}`, {
      log: [`Polling every ${LINE_POLL_INTERVAL_MS / 1000}s`],
    });
  }

  private stopMonitoring(accountId: string): AgentResult {
    const timer = activeMonitors.get(accountId);
    if (!timer) {
      return this.ok(`No active monitor for ${accountId}`, {
        log: ['Monitor was not running'],
      });
    }

    clearTimeout(timer);
    activeMonitors.delete(accountId);
    // Clean up cached counts for this account
    for (const key of lastKnownCounts.keys()) {
      if (key.startsWith(`${accountId}:`)) {
        lastKnownCounts.delete(key);
      }
    }

    console.log(`[line-monitor] Stopped monitoring for ${accountId}`);

    broadcast({
      type: 'comm:lineMonitor',
      accountId,
      status: 'stopped',
    });

    return this.ok(`LINE monitor stopped for ${accountId}`, {
      log: ['Monitor stopped'],
    });
  }

  private getStatus(accountId: string): AgentResult {
    const isRunning = activeMonitors.has(accountId);
    const db = getDb();

    // Count monitored threads
    const threadCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM external_threads WHERE account_id = ? AND provider = 'line'"
    ).get(accountId) as { cnt: number })?.cnt ?? 0;

    // Count pending drafts
    const draftCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM draft_replies WHERE account_id = ? AND provider = 'line' AND status = 'pending'"
    ).get(accountId) as { cnt: number })?.cnt ?? 0;

    return this.ok(
      JSON.stringify({ running: isRunning, threadCount, pendingDrafts: draftCount }),
      { log: [`Running: ${isRunning}, Threads: ${threadCount}, Pending drafts: ${draftCount}`] }
    );
  }

  // --- Core polling logic ---

  /**
   * Poll LINE once: sync threads → detect new messages → auto-draft replies.
   */
  private async pollOnce(accountId: string): Promise<void> {
    const { ConnectorRegistry } = await import('../connectors/registry');
    const connector = ConnectorRegistry.get(accountId);
    if (!connector || connector.provider !== 'line') {
      console.warn(`[line-monitor] Connector ${accountId} not found or not LINE, stopping`);
      this.stopMonitoring(accountId);
      return;
    }

    const db = getDb();

    // Fetch threads (reads chat list from LINE Extension)
    let threads;
    try {
      threads = await connector.fetchThreads();
    } catch (err: any) {
      console.error(`[line-monitor] fetchThreads failed:`, err.message);
      return;
    }

    if (threads.length === 0) return;

    // Check each thread for new inbound messages
    for (const thread of threads) {
      const cacheKey = `${accountId}:${thread.id}`;
      const prevCount = lastKnownCounts.get(cacheKey) ?? 0;

      // Count current inbound messages in DB
      const currentCount = (db.prepare(
        'SELECT COUNT(*) as cnt FROM external_messages WHERE thread_id = ? AND account_id = ? AND is_inbound = 1'
      ).get(thread.id, accountId) as { cnt: number })?.cnt ?? 0;

      lastKnownCounts.set(cacheKey, currentCount);

      // No new inbound messages
      if (currentCount <= prevCount) continue;

      const newCount = currentCount - prevCount;
      console.log(`[line-monitor] ${thread.displayName}: ${newCount} new inbound message(s)`);

      // Fetch the new inbound messages
      const newMessages = db.prepare(
        `SELECT * FROM external_messages
         WHERE thread_id = ? AND account_id = ? AND is_inbound = 1
         ORDER BY timestamp DESC
         LIMIT ?`
      ).all(thread.id, accountId, newCount) as any[];

      if (newMessages.length === 0) continue;

      // Get the latest inbound message to draft a reply for
      const latestMsg = newMessages[0];

      // Check if we already have a pending draft for this thread
      const existingDraft = db.prepare(
        "SELECT id FROM draft_replies WHERE thread_id = ? AND account_id = ? AND status = 'pending' AND provider = 'line'"
      ).get(thread.id, accountId) as { id: string } | undefined;

      if (existingDraft) {
        console.log(`[line-monitor] Skipping draft for "${thread.displayName}" — pending draft already exists (${existingDraft.id})`);
        // Still notify about new messages
        this.notifyNewMessage(accountId, thread, latestMsg, existingDraft.id);
        continue;
      }

      // Auto-draft reply with per-chat config
      console.log(`[line-monitor] Auto-drafting reply for "${thread.displayName}"...`);
      const draftId = await this.triggerAutoDraft(accountId, thread.id, latestMsg, thread.displayName);

      // Notify frontend
      this.notifyNewMessage(accountId, thread, latestMsg, draftId);
    }
  }

  /**
   * Trigger the ReplyDraftAgent to generate a draft for a LINE message.
   * Loads per-chat config (persona, tone, instruction) from the LINE connector.
   */
  private async triggerAutoDraft(
    accountId: string,
    threadId: string,
    message: any,
    chatName?: string
  ): Promise<string | null> {
    try {
      const replyAgent = agentRegistry.get('reply-draft');
      if (!replyAgent) {
        console.error('[line-monitor] ReplyDraftAgent not registered');
        return null;
      }

      const db = getDb();

      // Load per-chat config from LINE connector
      let chatPersona: string | undefined;
      let chatTone: string | undefined;
      let chatInstruction: string | undefined;
      let chatLanguage: string | undefined;

      if (chatName) {
        const { ConnectorRegistry } = await import('../connectors/registry');
        const connector = ConnectorRegistry.get(accountId);
        if (connector && connector.provider === 'line') {
          const { LineConnector } = await import('../connectors/line');
          const lineConn = connector as InstanceType<typeof LineConnector>;
          const chatConfig = lineConn.getChatConfig(chatName);
          if (chatConfig) {
            chatPersona = chatConfig.persona;
            chatTone = chatConfig.tone;
            chatInstruction = chatConfig.instruction;
            chatLanguage = chatConfig.language;
            console.log(`[line-monitor] Per-chat config for "${chatName}": persona="${chatPersona ?? '(none)'}", tone="${chatTone ?? '(none)'}"`);
          }
        }
      }

      // Fall back to account-level persona if no per-chat persona
      if (!chatPersona) {
        const connRow = db.prepare('SELECT persona FROM connectors WHERE id = ?')
          .get(accountId) as { persona: string | null } | undefined;
        chatPersona = connRow?.persona ?? undefined;
      }

      // Build combined instruction: persona context + user instruction
      const instructionParts: string[] = [];
      if (chatPersona) {
        instructionParts.push(`你的角色/身份：${chatPersona}`);
      }
      if (chatInstruction) {
        instructionParts.push(chatInstruction);
      }
      const combinedInstruction = instructionParts.length > 0 ? instructionParts.join('\n') : undefined;

      const input: Record<string, unknown> = {
        threadId,
        messageId: message.id,
        provider: 'line',
        accountId,
        ...(chatTone && { tone: chatTone }),
        ...(combinedInstruction && { instruction: combinedInstruction }),
        ...(chatLanguage && { language: chatLanguage }),
      };

      const result = await replyAgent.execute(input, {
        sessionId: `line-monitor-${accountId}-${Date.now()}`,
        messages: [],
        artifacts: [],
      });

      if (result.success) {
        // Fetch the draft ID
        const draft = db.prepare(
          `SELECT id FROM draft_replies WHERE thread_id = ? AND account_id = ? ORDER BY created_at DESC LIMIT 1`
        ).get(threadId, accountId) as { id: string } | undefined;

        console.log(`[line-monitor] Draft created: ${draft?.id}`);
        return draft?.id ?? null;
      }

      console.error(`[line-monitor] Draft failed: ${result.output}`);
      return null;
    } catch (err: any) {
      console.error(`[line-monitor] Draft trigger error:`, err.message);
      return null;
    }
  }

  /**
   * Push a WebSocket notification about a new LINE message.
   */
  private notifyNewMessage(
    accountId: string,
    thread: { id: string; displayName: string },
    message: any,
    draftId: string | null
  ): void {
    const notification: CommNotification = {
      type: 'rule_matched',
      ruleId: 'line-monitor-auto',
      ruleName: `LINE: ${thread.displayName}`,
      threadId: thread.id,
      message: {
        sender: message.sender_name ?? thread.displayName,
        subject: null,
        preview: (message.content ?? '').slice(0, 100),
      },
      action: draftId ? 'draft_and_notify' : 'notify',
      draftId,
      timestamp: Date.now(),
    };

    broadcastNotification(notification);

    // Also broadcast a specific LINE event for the frontend
    broadcast({
      type: 'comm:lineNewMessage',
      accountId,
      threadId: thread.id,
      chatName: thread.displayName,
      preview: (message.content ?? '').slice(0, 100),
      senderName: message.sender_name ?? thread.displayName,
      draftId,
      timestamp: Date.now(),
    });
  }

  /**
   * Initialize the lastKnownCounts from the current DB state.
   * This prevents treating all existing messages as "new" on first poll.
   */
  private initializeLastKnownCounts(accountId: string): void {
    const db = getDb();
    const threads = db.prepare(
      "SELECT id FROM external_threads WHERE account_id = ? AND provider = 'line'"
    ).all(accountId) as { id: string }[];

    for (const thread of threads) {
      const cacheKey = `${accountId}:${thread.id}`;
      const count = (db.prepare(
        'SELECT COUNT(*) as cnt FROM external_messages WHERE thread_id = ? AND account_id = ? AND is_inbound = 1'
      ).get(thread.id, accountId) as { cnt: number })?.cnt ?? 0;

      lastKnownCounts.set(cacheKey, count);
    }

    console.log(`[line-monitor] Initialized counts for ${threads.length} thread(s)`);
  }
}

// --- Module-level helpers for external callers ---

/**
 * Start LINE monitoring for an account.
 * Called from connector-service when a LINE connector is activated.
 */
export function startLineMonitoring(accountId: string): void {
  const agent = agentRegistry.get('line-monitor') as LineMonitorAgent | undefined;
  if (agent) {
    agent.execute({ accountId, action: 'start' }, { sessionId: '', messages: [], artifacts: [] });
  }
}

/**
 * Stop LINE monitoring for an account.
 * Called when a LINE connector is disconnected.
 */
export function stopLineMonitoring(accountId: string): void {
  const agent = agentRegistry.get('line-monitor') as LineMonitorAgent | undefined;
  if (agent) {
    agent.execute({ accountId, action: 'stop' }, { sessionId: '', messages: [], artifacts: [] });
  }
}

/**
 * Check if LINE monitoring is running for an account.
 */
export function isLineMonitoringActive(accountId: string): boolean {
  return activeMonitors.has(accountId);
}

// --- Self-register ---
const lineMonitorAgent = new LineMonitorAgent();
agentRegistry.register(lineMonitorAgent);

export { lineMonitorAgent };
