import { v4 as uuid } from 'uuid';
import type { AgentInputSchema, AgentResult, CommNotification } from '@prism/shared';
import { BaseAgent, type MemoryContext } from './base';
import { agentRegistry } from './registry';
import { getDb } from '../memory/db';
import { broadcast, broadcastNotification } from '../services/ws';

/** Polling interval for Teams chat monitoring: 30 seconds */
const TEAMS_POLL_INTERVAL_MS = 30_000;

/** Track running monitor loops by accountId */
const activeMonitors = new Map<string, ReturnType<typeof setTimeout>>();

/** Track last known message count per thread to detect new messages */
const lastKnownCounts = new Map<string, number>();

/**
 * TeamsMonitorAgent — autonomous agent that monitors Teams chats
 * and auto-drafts replies when new inbound messages arrive.
 *
 * Mirrors the LINE monitor agent pattern but uses the Teams
 * Network Interception layer (direct API fetch when token is available,
 * which is much lighter than DOM scraping).
 *
 * Flow:
 *   startMonitoring(accountId) → loop every 30s →
 *     connector.fetchThreads() → detect new messages →
 *       for each new inbound message → ReplyDraftAgent.execute() →
 *         save draft (status=pending) → WebSocket notify frontend
 */
class TeamsMonitorAgent extends BaseAgent {
  name = 'teams-monitor';
  description =
    'Autonomously monitors Teams chats and drafts replies for new inbound messages. ' +
    'Runs on a 30-second polling loop. Uses network interception for lightweight polling.';

  inputSchema: AgentInputSchema = {
    type: 'object',
    properties: {
      accountId: { type: 'string', description: 'Teams connector account ID' },
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
      return this.ok(`Teams monitor already running for ${accountId}`, {
        log: ['Monitor already active'],
      });
    }

    this.initializeLastKnownCounts(accountId);

    const run = async () => {
      try {
        await this.pollOnce(accountId);
      } catch (err: any) {
        console.error(`[teams-monitor] Poll error for ${accountId}:`, err.message);
      }

      if (activeMonitors.has(accountId)) {
        const timer = setTimeout(run, TEAMS_POLL_INTERVAL_MS);
        activeMonitors.set(accountId, timer);
      }
    };

    const timer = setTimeout(run, 0);
    activeMonitors.set(accountId, timer);

    console.log(`[teams-monitor] Started monitoring for ${accountId} (interval: ${TEAMS_POLL_INTERVAL_MS / 1000}s)`);

    broadcast({
      type: 'comm:teamsMonitor',
      accountId,
      status: 'started',
      interval: TEAMS_POLL_INTERVAL_MS,
    });

    return this.ok(`Teams monitor started for ${accountId}`, {
      log: [`Polling every ${TEAMS_POLL_INTERVAL_MS / 1000}s`],
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
    for (const key of lastKnownCounts.keys()) {
      if (key.startsWith(`${accountId}:`)) {
        lastKnownCounts.delete(key);
      }
    }

    console.log(`[teams-monitor] Stopped monitoring for ${accountId}`);

    broadcast({
      type: 'comm:teamsMonitor',
      accountId,
      status: 'stopped',
    });

    return this.ok(`Teams monitor stopped for ${accountId}`, {
      log: ['Monitor stopped'],
    });
  }

  private getStatus(accountId: string): AgentResult {
    const isRunning = activeMonitors.has(accountId);
    const db = getDb();

    const threadCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM external_threads WHERE account_id = ? AND provider = 'teams'"
    ).get(accountId) as { cnt: number })?.cnt ?? 0;

    const draftCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM draft_replies WHERE account_id = ? AND provider = 'teams' AND status = 'pending'"
    ).get(accountId) as { cnt: number })?.cnt ?? 0;

    return this.ok(
      JSON.stringify({ running: isRunning, threadCount, pendingDrafts: draftCount }),
      { log: [`Running: ${isRunning}, Threads: ${threadCount}, Pending drafts: ${draftCount}`] }
    );
  }

  // --- Core polling logic ---

  private async pollOnce(accountId: string): Promise<void> {
    const { ConnectorRegistry } = await import('../connectors/registry');
    const connector = ConnectorRegistry.get(accountId);
    if (!connector || connector.provider !== 'teams') {
      console.warn(`[teams-monitor] Connector ${accountId} not found or not Teams, stopping`);
      this.stopMonitoring(accountId);
      return;
    }

    const db = getDb();

    let threads;
    try {
      threads = await connector.fetchThreads();
    } catch (err: any) {
      console.error(`[teams-monitor] fetchThreads failed:`, err.message);
      return;
    }

    if (threads.length === 0) return;

    for (const thread of threads) {
      const cacheKey = `${accountId}:${thread.id}`;
      const prevCount = lastKnownCounts.get(cacheKey) ?? 0;

      const currentCount = (db.prepare(
        'SELECT COUNT(*) as cnt FROM external_messages WHERE thread_id = ? AND account_id = ? AND is_inbound = 1'
      ).get(thread.id, accountId) as { cnt: number })?.cnt ?? 0;

      lastKnownCounts.set(cacheKey, currentCount);

      if (currentCount <= prevCount) continue;

      const newCount = currentCount - prevCount;
      console.log(`[teams-monitor] ${thread.displayName}: ${newCount} new inbound message(s)`);

      const newMessages = db.prepare(
        `SELECT * FROM external_messages
         WHERE thread_id = ? AND account_id = ? AND is_inbound = 1
         ORDER BY timestamp DESC
         LIMIT ?`
      ).all(thread.id, accountId, newCount) as any[];

      if (newMessages.length === 0) continue;

      const latestMsg = newMessages[0];

      const existingDraft = db.prepare(
        "SELECT id FROM draft_replies WHERE thread_id = ? AND account_id = ? AND status = 'pending' AND provider = 'teams'"
      ).get(thread.id, accountId) as { id: string } | undefined;

      if (existingDraft) {
        console.log(`[teams-monitor] Skipping draft for "${thread.displayName}" — pending draft already exists (${existingDraft.id})`);
        this.notifyNewMessage(accountId, thread, latestMsg, existingDraft.id);
        continue;
      }

      console.log(`[teams-monitor] Auto-drafting reply for "${thread.displayName}"...`);
      const draftId = await this.triggerAutoDraft(accountId, thread.id, latestMsg, thread.displayName);
      this.notifyNewMessage(accountId, thread, latestMsg, draftId);
    }
  }

  private async triggerAutoDraft(
    accountId: string,
    threadId: string,
    message: any,
    chatName?: string
  ): Promise<string | null> {
    try {
      const replyAgent = agentRegistry.get('reply-draft');
      if (!replyAgent) {
        console.error('[teams-monitor] ReplyDraftAgent not registered');
        return null;
      }

      const db = getDb();

      let chatPersona: string | undefined;
      let chatTone: string | undefined;
      let chatInstruction: string | undefined;
      let chatLanguage: string | undefined;

      if (chatName) {
        const { ConnectorRegistry } = await import('../connectors/registry');
        const connector = ConnectorRegistry.get(accountId);
        if (connector && connector.provider === 'teams') {
          const { TeamsConnector } = await import('../connectors/teams');
          const teamsConn = connector as InstanceType<typeof TeamsConnector>;
          const chatConfig = teamsConn.getChatConfig(chatName);
          if (chatConfig) {
            chatPersona = chatConfig.persona;
            chatTone = chatConfig.tone;
            chatInstruction = chatConfig.instruction;
            chatLanguage = chatConfig.language;
            console.log(`[teams-monitor] Per-chat config for "${chatName}": persona="${chatPersona ?? '(none)'}", tone="${chatTone ?? '(none)'}"`);
          }
        }
      }

      if (!chatPersona) {
        const connRow = db.prepare('SELECT persona FROM connectors WHERE id = ?')
          .get(accountId) as { persona: string | null } | undefined;
        chatPersona = connRow?.persona ?? undefined;
      }

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
        provider: 'teams',
        accountId,
        ...(chatTone && { tone: chatTone }),
        ...(combinedInstruction && { instruction: combinedInstruction }),
        ...(chatLanguage && { language: chatLanguage }),
      };

      const result = await replyAgent.execute(input, {
        sessionId: `teams-monitor-${accountId}-${Date.now()}`,
        messages: [],
        artifacts: [],
      });

      if (result.success) {
        const draft = db.prepare(
          `SELECT id FROM draft_replies WHERE thread_id = ? AND account_id = ? ORDER BY created_at DESC LIMIT 1`
        ).get(threadId, accountId) as { id: string } | undefined;

        console.log(`[teams-monitor] Draft created: ${draft?.id}`);
        return draft?.id ?? null;
      }

      console.error(`[teams-monitor] Draft failed: ${result.output}`);
      return null;
    } catch (err: any) {
      console.error(`[teams-monitor] Draft trigger error:`, err.message);
      return null;
    }
  }

  private notifyNewMessage(
    accountId: string,
    thread: { id: string; displayName: string },
    message: any,
    draftId: string | null
  ): void {
    const notification: CommNotification = {
      type: 'rule_matched',
      ruleId: 'teams-monitor-auto',
      ruleName: `Teams: ${thread.displayName}`,
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

    broadcast({
      type: 'comm:teamsNewMessage',
      accountId,
      threadId: thread.id,
      chatName: thread.displayName,
      preview: (message.content ?? '').slice(0, 100),
      senderName: message.sender_name ?? thread.displayName,
      draftId,
      timestamp: Date.now(),
    });
  }

  private initializeLastKnownCounts(accountId: string): void {
    const db = getDb();
    const threads = db.prepare(
      "SELECT id FROM external_threads WHERE account_id = ? AND provider = 'teams'"
    ).all(accountId) as { id: string }[];

    for (const thread of threads) {
      const cacheKey = `${accountId}:${thread.id}`;
      const count = (db.prepare(
        'SELECT COUNT(*) as cnt FROM external_messages WHERE thread_id = ? AND account_id = ? AND is_inbound = 1'
      ).get(thread.id, accountId) as { cnt: number })?.cnt ?? 0;

      lastKnownCounts.set(cacheKey, count);
    }

    console.log(`[teams-monitor] Initialized counts for ${threads.length} thread(s)`);
  }
}

// --- Module-level helpers ---

export function startTeamsMonitoring(accountId: string): void {
  const agent = agentRegistry.get('teams-monitor') as TeamsMonitorAgent | undefined;
  if (agent) {
    agent.execute({ accountId, action: 'start' }, { sessionId: '', messages: [], artifacts: [] });
  }
}

export function stopTeamsMonitoring(accountId: string): void {
  const agent = agentRegistry.get('teams-monitor') as TeamsMonitorAgent | undefined;
  if (agent) {
    agent.execute({ accountId, action: 'stop' }, { sessionId: '', messages: [], artifacts: [] });
  }
}

export function isTeamsMonitoringActive(accountId: string): boolean {
  return activeMonitors.has(accountId);
}

// --- Self-register ---
const teamsMonitorAgent = new TeamsMonitorAgent();
agentRegistry.register(teamsMonitorAgent);

export { teamsMonitorAgent };
