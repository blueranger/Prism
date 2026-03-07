import { v4 as uuid } from 'uuid';
import type { ExternalThread, ExternalMessage, CommProvider, ConnectorType } from '@prism/shared';
import { BaseConnector } from './base-connector';
import { ConnectorRegistry } from './registry';
import { getDb } from '../memory/db';
import {
  connectToTeams,
  disconnectTeams,
  isTeamsConnected,
  readChatList,
  readChatMessages,
  sendMessage,
  type TeamsChatItem,
} from '../services/teams-puppeteer';

/**
 * Per-chat monitoring configuration (same shape as LINE).
 */
export interface TeamsChatConfig {
  /** Chat ID (from Teams API — stable identifier) */
  chatId: string;
  /** Chat display name (for UI) */
  name: string;
  /** Whether monitoring is enabled for this chat */
  enabled: boolean;
  /** Role/persona for this chat */
  persona?: string;
  /** Default tone for replies */
  tone?: string;
  /** Standing instruction for replies */
  instruction?: string;
  /** Reply language override */
  language?: string;
}

/**
 * TeamsConnector — reads from Teams Web via Network Interception + Puppeteer.
 *
 * Uses SharedBrowserManager to share Chrome with the LINE connector.
 * Chat data is captured passively from Teams' own API calls (no DOM scraping
 * for data — only the compose box uses DOM interaction for sending messages).
 *
 * No OAuth/Graph API required — Teams Web handles its own authentication.
 */
export class TeamsConnector extends BaseConnector {
  provider: CommProvider = 'teams';
  connectorType: ConnectorType = 'teams';
  override readonly isLocal: boolean = true;

  /** Per-chat monitoring configs. null = monitor ALL chats with defaults */
  private chatConfigs: TeamsChatConfig[] | null = null;

  constructor(accountId: string) {
    super(accountId);
  }

  // --- OAuth methods (not applicable for Teams Puppeteer connector) ---

  getOAuthUrl(): string {
    throw new Error('Teams connector does not use OAuth. It connects via Chrome Puppeteer.');
  }

  async exchangeCodeForToken(_code: string): Promise<void> {
    throw new Error('Teams connector does not use OAuth.');
  }

  async refreshToken(): Promise<void> {
    // No-op: Puppeteer connector doesn't have tokens
  }

  async disconnect(): Promise<void> {
    await disconnectTeams();
    this.deactivateConfig();
  }

  /**
   * Override ensureValidToken: for Teams we check Puppeteer connection.
   */
  protected async ensureValidToken() {
    if (!isTeamsConnected()) {
      await connectToTeams();
    }

    const existing = this.loadConfig();
    if (!existing) {
      this.activateTeamsConnector();
    }

    // Restore chat configs from config
    this.restoreChatConfigs();

    return existing ?? {
      accessToken: 'puppeteer',
      refreshToken: 'puppeteer',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      scope: 'local',
    };
  }

  /**
   * Activate the Teams connector — create a config record in the DB.
   */
  activateTeamsConnector(displayName?: string): void {
    const syntheticConfig: Record<string, unknown> = {
      accessToken: 'puppeteer',
      refreshToken: 'puppeteer',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      scope: 'local',
    };

    if (this.chatConfigs) {
      syntheticConfig.chatConfigs = this.chatConfigs;
    }

    this.saveConfig(syntheticConfig as any);

    const db = getDb();
    db.prepare('UPDATE connectors SET display_name = ? WHERE id = ?')
      .run(displayName ?? 'Teams', this.accountId);
  }

  // --- Per-chat config management (mirrors LINE pattern) ---

  setChatConfigs(configs: TeamsChatConfig[] | null): void {
    this.chatConfigs = configs;
    this.persistChatConfigs();
  }

  updateChatConfig(chatName: string, update: Partial<Omit<TeamsChatConfig, 'chatId' | 'name'>>): void {
    this.restoreChatConfigs();
    if (!this.chatConfigs) {
      this.chatConfigs = [];
    }

    const cleanUpdate: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(update)) {
      if (value !== undefined) cleanUpdate[key] = value;
    }

    // Match by name (UI sends chat name, not chat ID)
    const idx = this.chatConfigs.findIndex(c => c.name === chatName);
    if (idx >= 0) {
      this.chatConfigs[idx] = { ...this.chatConfigs[idx], ...cleanUpdate };
    } else {
      this.chatConfigs.push({ chatId: '', name: chatName, enabled: true, ...cleanUpdate });
    }
    this.persistChatConfigs();
  }

  getChatConfigs(): TeamsChatConfig[] | null {
    this.restoreChatConfigs();
    return this.chatConfigs;
  }

  getChatConfig(chatName: string): TeamsChatConfig | undefined {
    this.restoreChatConfigs();
    return this.chatConfigs?.find(c => c.name === chatName);
  }

  /**
   * Get list of enabled monitored chat names.
   * null = no config, monitor ALL; string[] = only those (empty = none)
   */
  getMonitoredChatNames(): string[] | null {
    this.restoreChatConfigs();
    if (!this.chatConfigs) return null;
    const enabled = this.chatConfigs.filter(c => c.enabled);
    return enabled.map(c => c.name);
  }

  private restoreChatConfigs(): void {
    if (this.chatConfigs !== null) return;
    const config = this.loadConfig();
    if (!config) return;
    const raw = config as any;
    if (Array.isArray(raw.chatConfigs)) {
      this.chatConfigs = raw.chatConfigs;
    }
  }

  private persistChatConfigs(): void {
    const config = this.loadConfig();
    if (config) {
      const raw = config as any;
      raw.chatConfigs = this.chatConfigs;
      this.saveConfig(raw);
    }
  }

  // --- Data access methods ---

  /**
   * Fetch Teams chat threads via Network Interception.
   * Uses captured API responses rather than DOM scraping.
   */
  async fetchThreads(since?: number): Promise<ExternalThread[]> {
    await this.ensureValidToken();

    console.log(`[teams] fetchThreads for ${this.accountId}, since=${since ? new Date(since).toISOString() : 'none'}`);

    let chatItems: TeamsChatItem[];
    try {
      chatItems = await readChatList();
    } catch (err: any) {
      console.error(`[teams] Failed to read chat list:`, err.message);
      throw err;
    }

    console.log(`[teams] readChatList returned ${chatItems.length} items`);

    // Filter to monitored chats if configured
    const monitoredNames = this.getMonitoredChatNames();
    if (monitoredNames !== null) {
      if (monitoredNames.length === 0) {
        console.log(`[teams] All chats disabled, skipping sync`);
        return [];
      }
      const monitored = new Set(monitoredNames.map(n => n.toLowerCase()));
      chatItems = chatItems.filter(item => monitored.has(item.name.toLowerCase()));
      console.log(`[teams] Filtered to ${chatItems.length} monitored chat(s)`);
    }

    if (chatItems.length === 0) return [];

    const db = getDb();
    const now = Date.now();
    const threads: ExternalThread[] = [];

    const upsertThread = db.prepare(`
      INSERT INTO external_threads (id, provider, account_id, external_id, session_id, display_name, subject, sender_name, sender_email, is_group, message_count, last_message_at, last_synced_at, created_at)
      VALUES (?, 'teams', ?, ?, NULL, ?, NULL, ?, NULL, ?, 0, ?, ?, ?)
      ON CONFLICT(account_id, external_id) DO UPDATE SET
        display_name = excluded.display_name,
        last_message_at = CASE WHEN excluded.last_message_at > external_threads.last_message_at THEN excluded.last_message_at ELSE external_threads.last_message_at END,
        last_synced_at = excluded.last_synced_at
    `);

    const txn = db.transaction(() => {
      for (const chat of chatItems) {
        // Use Teams API chat ID as external_id (stable, unlike LINE which uses names)
        const externalId = `teams-chat-${chat.id}`;

        const existingRow = db.prepare(
          "SELECT id FROM external_threads WHERE account_id = ? AND external_id = ?"
        ).get(this.accountId, externalId) as { id: string } | undefined;

        const threadId = existingRow?.id ?? uuid();
        const lastMsgAt = parseTeamsTime(chat.time);

        upsertThread.run(
          threadId,
          this.accountId,
          externalId,
          chat.name,
          chat.name,
          chat.isGroup ? 1 : 0,
          lastMsgAt,
          now,
          now
        );

        // Store last message preview
        if (chat.lastMessage) {
          const msgExternalId = `teams-preview-${chat.id}-${lastMsgAt}`;
          const existingMsg = db.prepare(
            "SELECT id FROM external_messages WHERE account_id = ? AND external_id = ?"
          ).get(this.accountId, msgExternalId) as { id: string } | undefined;

          if (!existingMsg) {
            db.prepare(`
              INSERT OR IGNORE INTO external_messages
              (id, thread_id, provider, account_id, external_id, sender_id, sender_name, sender_email, subject, content, timestamp, is_inbound, metadata, created_at)
              VALUES (?, ?, 'teams', ?, ?, ?, ?, NULL, NULL, ?, ?, 1, ?, ?)
            `).run(
              uuid(),
              threadId,
              this.accountId,
              msgExternalId,
              chat.name,
              chat.name,
              chat.lastMessage,
              lastMsgAt,
              JSON.stringify({ unreadCount: chat.unreadCount, isPreview: true, teamsChatId: chat.id }),
              now
            );
          }
        }

        threads.push({
          id: threadId,
          provider: 'teams',
          accountId: this.accountId,
          externalId,
          sessionId: null,
          displayName: chat.name,
          subject: null,
          senderName: chat.name,
          senderEmail: null,
          isGroup: chat.isGroup,
          messageCount: 0,
          lastMessageAt: lastMsgAt,
          lastSyncedAt: now,
          createdAt: now,
        });
      }
    });

    txn();
    console.log(`[teams] Persisted ${threads.length} threads`);
    return threads;
  }

  /**
   * Fetch messages for a specific Teams chat.
   * Uses direct API call or network interception (not DOM scraping).
   */
  async fetchThreadMessages(threadId: string, limit: number = 50): Promise<ExternalMessage[]> {
    await this.ensureValidToken();

    const db = getDb();

    const thread = db.prepare(
      "SELECT * FROM external_threads WHERE id = ? AND account_id = ?"
    ).get(threadId, this.accountId) as any;

    if (!thread) {
      console.warn(`[teams] Thread ${threadId} not found`);
      return [];
    }

    // Extract Teams chat ID from external_id
    const teamsChatId = thread.external_id.replace('teams-chat-', '');
    console.log(`[teams] Fetching messages for chat: ${thread.display_name} (${teamsChatId})`);

    try {
      const messages = await readChatMessages(teamsChatId);
      console.log(`[teams] Read ${messages.length} messages from "${thread.display_name}"`);

      // Persist new messages to DB
      const now = Date.now();
      const upsertMsg = db.prepare(`
        INSERT OR IGNORE INTO external_messages
        (id, thread_id, provider, account_id, external_id, sender_id, sender_name, sender_email, subject, content, timestamp, is_inbound, metadata, created_at)
        VALUES (?, ?, 'teams', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
      `);

      const txn = db.transaction(() => {
        for (const msg of messages) {
          const msgExternalId = msg.id ? `teams-msg-${msg.id}` : `teams-msg-${teamsChatId}-${hashString(msg.content.slice(0, 50))}-${msg.time}`;
          const isInbound = !msg.isMe;
          const senderName = msg.sender || thread.display_name;
          const timestamp = msg.time ? new Date(msg.time).getTime() || now : now;

          upsertMsg.run(
            uuid(),
            threadId,
            this.accountId,
            msgExternalId,
            senderName,
            senderName,
            msg.content,
            timestamp,
            isInbound ? 1 : 0,
            JSON.stringify({ isMe: msg.isMe, teamsMessageId: msg.id }),
            now
          );
        }

        // Update message count
        const countRow = db.prepare(
          "SELECT COUNT(*) as cnt FROM external_messages WHERE thread_id = ? AND account_id = ?"
        ).get(threadId, this.accountId) as { cnt: number };

        db.prepare(
          "UPDATE external_threads SET message_count = ?, last_synced_at = ? WHERE id = ?"
        ).run(countRow.cnt, now, threadId);
      });

      txn();
    } catch (err: any) {
      console.error(`[teams] Failed to fetch messages:`, err.message);
    }

    return this.loadMessagesFromDb(threadId, limit);
  }

  /**
   * Send a reply to a Teams chat.
   * Uses DOM interaction (compose box) — the only DOM operation.
   */
  async sendReply(threadId: string, content: string, _replyToId?: string): Promise<void> {
    await this.ensureValidToken();

    const db = getDb();
    const thread = db.prepare(
      "SELECT * FROM external_threads WHERE id = ? AND account_id = ?"
    ).get(threadId, this.accountId) as any;

    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    const teamsChatId = thread.external_id.replace('teams-chat-', '');
    console.log(`[teams] Sending reply to chat: ${thread.display_name}`);

    // Open the chat first (to ensure compose box is visible)
    const chatItems = await readChatList();
    const chat = chatItems.find(c => c.id === teamsChatId);

    if (!chat) {
      throw new Error(`Chat "${thread.display_name}" (${teamsChatId}) not found in Teams`);
    }

    // Import openChat from teams-puppeteer
    const { openChat } = await import('../services/teams-puppeteer');
    const opened = await openChat(chat.index, chat.name);
    if (!opened) {
      throw new Error(`Could not open chat "${thread.display_name}"`);
    }

    const sent = await sendMessage(content);
    if (!sent) {
      throw new Error(`Failed to send message to "${thread.display_name}" — could not find compose box`);
    }

    // Persist the sent message to DB
    const now = Date.now();
    db.prepare(`
      INSERT INTO external_messages
      (id, thread_id, provider, account_id, external_id, sender_id, sender_name, sender_email, subject, content, timestamp, is_inbound, metadata, created_at)
      VALUES (?, ?, 'teams', ?, ?, 'me', 'Me', NULL, NULL, ?, ?, 0, '{}', ?)
    `).run(
      uuid(),
      threadId,
      this.accountId,
      `teams-sent-${now}`,
      content,
      now,
      now
    );

    console.log(`[teams] Message sent to "${thread.display_name}"`);
  }

  /**
   * Load messages from the local DB.
   */
  private loadMessagesFromDb(threadId: string, limit: number = 50): ExternalMessage[] {
    const db = getDb();
    const rows = db.prepare(
      `SELECT * FROM external_messages
       WHERE thread_id = ? AND account_id = ?
       ORDER BY timestamp ASC
       LIMIT ?`
    ).all(threadId, this.accountId, limit) as any[];

    return rows.map((row) => mapDbRowToExternalMessage(row, this.accountId));
  }
}

// --- Helpers ---

function mapDbRowToExternalMessage(row: any, accountId: string): ExternalMessage {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    // ignore
  }

  return {
    id: row.id,
    threadId: row.thread_id,
    provider: row.provider,
    accountId: row.account_id ?? accountId,
    externalId: row.external_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderEmail: row.sender_email ?? null,
    subject: row.subject ?? null,
    content: row.content,
    timestamp: row.timestamp,
    isInbound: row.is_inbound === 1,
    metadata,
    createdAt: row.created_at,
  };
}

/**
 * Parse Teams time strings into timestamps.
 * Teams API usually returns ISO dates, but display times can vary.
 */
function parseTeamsTime(timeStr: string): number {
  if (!timeStr) return Date.now();

  // ISO date (from API responses)
  const isoDate = new Date(timeStr);
  if (!isNaN(isoDate.getTime())) return isoDate.getTime();

  // Fallback
  return Date.now();
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// --- Register CLASS ---
ConnectorRegistry.registerType('teams', TeamsConnector);
