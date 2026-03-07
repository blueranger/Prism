import { v4 as uuid } from 'uuid';
import type { ExternalThread, ExternalMessage, CommProvider, ConnectorType } from '@prism/shared';
import { BaseConnector } from './base-connector';
import { ConnectorRegistry } from './registry';
import { getDb } from '../memory/db';
import {
  connectToLine,
  disconnectLine,
  isLineConnected,
  readChatList,
  openChat,
  readChatMessages,
  sendMessage,
  type LineChatItem,
} from '../services/line-puppeteer';

/**
 * Per-chat monitoring configuration.
 * Each monitored chat can have its own persona, tone, and instruction.
 */
export interface LineChatConfig {
  /** Chat display name (used as identifier) */
  name: string;
  /** Whether monitoring is enabled for this chat */
  enabled: boolean;
  /** Role/persona for this chat (e.g. "Product Manager", "朋友") */
  persona?: string;
  /** Default tone for replies in this chat (e.g. "professional", "casual") */
  tone?: string;
  /** Standing instruction for replies (e.g. "用中文回覆", "Keep replies brief") */
  instruction?: string;
  /** Reply language override (e.g. "Chinese", "English", "auto") */
  language?: string;
}

/**
 * LineConnector — reads from the LINE Chrome Extension via Puppeteer.
 *
 * Connects to a Chrome instance with --remote-debugging-port=9222 that has
 * the LINE Chrome Extension installed and logged in.
 *
 * No OAuth required — LINE Extension handles authentication.
 * Multi-account: each LINE account is a separate connector instance.
 */
export class LineConnector extends BaseConnector {
  provider: CommProvider = 'line';
  connectorType: ConnectorType = 'line';
  override readonly isLocal: boolean = true;

  /** Per-chat monitoring configs. null = monitor ALL chats with defaults */
  private chatConfigs: LineChatConfig[] | null = null;

  constructor(accountId: string) {
    super(accountId);
  }

  // --- OAuth methods (not applicable for LINE Puppeteer connector) ---

  getOAuthUrl(): string {
    throw new Error('LINE connector does not use OAuth. It connects via Chrome Puppeteer.');
  }

  async exchangeCodeForToken(_code: string): Promise<void> {
    throw new Error('LINE connector does not use OAuth.');
  }

  async refreshToken(): Promise<void> {
    // No-op: Puppeteer connector doesn't have tokens
  }

  async disconnect(): Promise<void> {
    await disconnectLine();
    this.deactivateConfig();
  }

  /**
   * Override ensureValidToken: for LINE we check Puppeteer connection.
   */
  protected async ensureValidToken() {
    if (!isLineConnected()) {
      await connectToLine();
    }

    const existing = this.loadConfig();
    if (!existing) {
      this.activateLineConnector();
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
   * Activate the LINE connector — create a config record in the DB.
   */
  activateLineConnector(displayName?: string): void {
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
      .run(displayName ?? 'LINE', this.accountId);
  }

  /**
   * Set per-chat monitoring configurations.
   * Pass null to monitor ALL chats with default settings.
   */
  setChatConfigs(configs: LineChatConfig[] | null): void {
    this.chatConfigs = configs;
    this.persistChatConfigs();
  }

  /**
   * Update a single chat's config. Creates the entry if it doesn't exist.
   */
  updateChatConfig(chatName: string, update: Partial<Omit<LineChatConfig, 'name'>>): void {
    this.restoreChatConfigs();
    if (!this.chatConfigs) {
      this.chatConfigs = [];
    }

    // Strip undefined values to prevent overwriting existing config with undefined
    const cleanUpdate: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(update)) {
      if (value !== undefined) cleanUpdate[key] = value;
    }

    const idx = this.chatConfigs.findIndex(c => c.name === chatName);
    if (idx >= 0) {
      this.chatConfigs[idx] = { ...this.chatConfigs[idx], ...cleanUpdate };
    } else {
      this.chatConfigs.push({ name: chatName, enabled: true, ...cleanUpdate });
    }
    this.persistChatConfigs();
  }

  /**
   * Get all chat configs.
   */
  getChatConfigs(): LineChatConfig[] | null {
    this.restoreChatConfigs();
    return this.chatConfigs;
  }

  /**
   * Get config for a specific chat by name.
   */
  getChatConfig(chatName: string): LineChatConfig | undefined {
    this.restoreChatConfigs();
    return this.chatConfigs?.find(c => c.name === chatName);
  }

  /**
   * Get the list of enabled monitored chat names (for backward compat with fetchThreads filter).
   */
  getMonitoredChatNames(): string[] | null {
    this.restoreChatConfigs();
    if (!this.chatConfigs) return null; // null = no config, monitor ALL
    const enabled = this.chatConfigs.filter(c => c.enabled);
    return enabled.map(c => c.name); // empty array = config exists, monitor NONE
  }

  /**
   * Restore chatConfigs from stored config JSON.
   */
  private restoreChatConfigs(): void {
    if (this.chatConfigs !== null) return;
    const config = this.loadConfig();
    if (!config) return;
    const raw = config as any;
    if (Array.isArray(raw.chatConfigs)) {
      this.chatConfigs = raw.chatConfigs;
    } else if (Array.isArray(raw.monitoredChats)) {
      // Migrate from old format: string[] → LineChatConfig[]
      this.chatConfigs = raw.monitoredChats.map((name: string) => ({
        name,
        enabled: true,
      }));
    }
  }

  /**
   * Persist chatConfigs to the DB config JSON.
   */
  private persistChatConfigs(): void {
    const config = this.loadConfig();
    if (config) {
      const raw = config as any;
      raw.chatConfigs = this.chatConfigs;
      delete raw.monitoredChats; // Remove old format
      this.saveConfig(raw);
    }
  }

  // --- Data access methods ---

  /**
   * Fetch LINE chat threads.
   * Reads from the LINE Chrome Extension via Puppeteer.
   */
  async fetchThreads(since?: number): Promise<ExternalThread[]> {
    await this.ensureValidToken();

    console.log(`[line] fetchThreads for ${this.accountId}, since=${since ? new Date(since).toISOString() : 'none'}`);

    let chatItems: LineChatItem[];
    try {
      chatItems = await readChatList();
    } catch (err: any) {
      console.error(`[line] Failed to read chat list:`, err.message);
      throw err;
    }

    console.log(`[line] readChatList returned ${chatItems.length} items`);

    // Filter to monitored chats if configured
    // null = no config, monitor ALL; string[] = only monitor those (empty = none)
    const monitoredNames = this.getMonitoredChatNames();
    if (monitoredNames !== null) {
      if (monitoredNames.length === 0) {
        console.log(`[line] All chats disabled, skipping sync`);
        return [];
      }
      const monitored = new Set(monitoredNames.map(n => n.toLowerCase()));
      chatItems = chatItems.filter(item => monitored.has(item.name.toLowerCase()));
      console.log(`[line] Filtered to ${chatItems.length} monitored chat(s)`);
    }

    if (chatItems.length === 0) return [];

    const db = getDb();
    const now = Date.now();
    const threads: ExternalThread[] = [];

    const upsertThread = db.prepare(`
      INSERT INTO external_threads (id, provider, account_id, external_id, session_id, display_name, subject, sender_name, sender_email, is_group, message_count, last_message_at, last_synced_at, created_at)
      VALUES (?, 'line', ?, ?, NULL, ?, NULL, ?, NULL, ?, 0, ?, ?, ?)
      ON CONFLICT(account_id, external_id) DO UPDATE SET
        display_name = excluded.display_name,
        last_message_at = CASE WHEN excluded.last_message_at > external_threads.last_message_at THEN excluded.last_message_at ELSE external_threads.last_message_at END,
        last_synced_at = excluded.last_synced_at
    `);

    const txn = db.transaction(() => {
      for (const chat of chatItems) {
        // Use chat name as external_id (LINE Extension doesn't expose chat IDs)
        const externalId = `line-chat-${chat.name}`;
        const isGroup = chat.name.includes('(') || false; // Heuristic: groups often have member count

        // Look up existing thread
        const existingRow = db.prepare(
          "SELECT id FROM external_threads WHERE account_id = ? AND external_id = ?"
        ).get(this.accountId, externalId) as { id: string } | undefined;

        const threadId = existingRow?.id ?? uuid();
        const lastMsgAt = parseLineTime(chat.time);

        upsertThread.run(
          threadId,
          this.accountId,
          externalId,
          chat.name,           // display_name
          chat.name,           // sender_name
          isGroup ? 1 : 0,
          lastMsgAt,
          now,
          now
        );

        // If there's a last message preview, store it
        if (chat.lastMessage) {
          const msgExternalId = `line-preview-${chat.name}-${lastMsgAt}`;
          const existingMsg = db.prepare(
            "SELECT id FROM external_messages WHERE account_id = ? AND external_id = ?"
          ).get(this.accountId, msgExternalId) as { id: string } | undefined;

          if (!existingMsg) {
            db.prepare(`
              INSERT OR IGNORE INTO external_messages
              (id, thread_id, provider, account_id, external_id, sender_id, sender_name, sender_email, subject, content, timestamp, is_inbound, metadata, created_at)
              VALUES (?, ?, 'line', ?, ?, ?, ?, NULL, NULL, ?, ?, 1, ?, ?)
            `).run(
              uuid(),
              threadId,
              this.accountId,
              msgExternalId,
              chat.name,
              chat.name,
              chat.lastMessage,
              lastMsgAt,
              JSON.stringify({ unreadCount: chat.unreadCount, isPreview: true }),
              now
            );
          }
        }

        threads.push({
          id: threadId,
          provider: 'line',
          accountId: this.accountId,
          externalId,
          sessionId: null,
          displayName: chat.name,
          subject: null,
          senderName: chat.name,
          senderEmail: null,
          isGroup,
          messageCount: 0,
          lastMessageAt: lastMsgAt,
          lastSyncedAt: now,
          createdAt: now,
        });
      }
    });

    txn();
    console.log(`[line] Persisted ${threads.length} threads`);
    return threads;
  }

  /**
   * Fetch messages for a specific LINE chat.
   * Opens the chat in the LINE Extension and reads visible messages.
   */
  async fetchThreadMessages(threadId: string, limit: number = 50): Promise<ExternalMessage[]> {
    await this.ensureValidToken();

    const db = getDb();

    // Look up thread to get the chat name
    const thread = db.prepare(
      "SELECT * FROM external_threads WHERE id = ? AND account_id = ?"
    ).get(threadId, this.accountId) as any;

    if (!thread) {
      console.warn(`[line] Thread ${threadId} not found`);
      return [];
    }

    const chatName = thread.display_name;
    console.log(`[line] Fetching messages for chat: ${chatName}`);

    // Find the chat in the chat list and open it
    let chatItems: LineChatItem[];
    try {
      chatItems = await readChatList();
    } catch (err: any) {
      console.error(`[line] Failed to read chat list:`, err.message);
      return this.loadMessagesFromDb(threadId, limit);
    }

    const chatIndex = chatItems.findIndex(item => item.name === chatName);
    if (chatIndex === -1) {
      console.warn(`[line] Chat "${chatName}" not found in chat list`);
      return this.loadMessagesFromDb(threadId, limit);
    }

    // Open the chat
    const opened = await openChat(chatIndex, chatName);
    if (!opened) {
      console.warn(`[line] Could not open chat "${chatName}"`);
      return this.loadMessagesFromDb(threadId, limit);
    }

    // Read messages from the open chat
    const messages = await readChatMessages();
    console.log(`[line] Read ${messages.length} messages from "${chatName}"`);

    // Persist new messages to DB
    const now = Date.now();
    const upsertMsg = db.prepare(`
      INSERT OR IGNORE INTO external_messages
      (id, thread_id, provider, account_id, external_id, sender_id, sender_name, sender_email, subject, content, timestamp, is_inbound, metadata, created_at)
      VALUES (?, ?, 'line', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
    `);

    const txn = db.transaction(() => {
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        // Generate a deterministic external ID from content hash
        const msgExternalId = `line-msg-${chatName}-${i}-${hashString(msg.content.slice(0, 50))}`;

        const isInbound = !msg.isMe;
        const senderName = msg.sender || chatName;

        upsertMsg.run(
          uuid(),
          threadId,
          this.accountId,
          msgExternalId,
          senderName,
          senderName,
          msg.content,
          msg.time ? parseLineTime(msg.time) : now - (messages.length - i) * 60000,
          isInbound ? 1 : 0,
          JSON.stringify({ isMe: msg.isMe }),
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

    return this.loadMessagesFromDb(threadId, limit);
  }

  /**
   * Send a reply to a LINE chat.
   * Types and sends the message via Puppeteer.
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

    const chatName = thread.display_name;
    console.log(`[line] Sending reply to chat: ${chatName}`);

    // Open the chat first
    const chatItems = await readChatList();
    const chatIndex = chatItems.findIndex(item => item.name === chatName);

    if (chatIndex === -1) {
      throw new Error(`Chat "${chatName}" not found in LINE`);
    }

    const opened = await openChat(chatIndex, chatName);
    if (!opened) {
      throw new Error(`Could not open chat "${chatName}"`);
    }

    // Send the message
    const sent = await sendMessage(content);
    if (!sent) {
      throw new Error(`Failed to send message to "${chatName}" — could not find input field`);
    }

    // Persist the sent message to DB
    const now = Date.now();
    db.prepare(`
      INSERT INTO external_messages
      (id, thread_id, provider, account_id, external_id, sender_id, sender_name, sender_email, subject, content, timestamp, is_inbound, metadata, created_at)
      VALUES (?, ?, 'line', ?, ?, 'me', 'Me', NULL, NULL, ?, ?, 0, '{}', ?)
    `).run(
      uuid(),
      threadId,
      this.accountId,
      `line-sent-${now}`,
      content,
      now,
      now
    );

    console.log(`[line] Message sent to "${chatName}"`);
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
 * Parse LINE time strings into timestamps.
 * LINE shows: "8:35 PM", "Yesterday", "2/19", "Monday", etc.
 */
function parseLineTime(timeStr: string): number {
  if (!timeStr) return Date.now();

  const now = new Date();

  // Time format: "8:35 PM" or "13:05"
  const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const ampm = timeMatch[3]?.toUpperCase();
    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
    const d = new Date(now);
    d.setHours(hours, minutes, 0, 0);
    return d.getTime();
  }

  // Date format: "2/19" or "12/25"
  const dateMatch = timeStr.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (dateMatch) {
    const month = parseInt(dateMatch[1], 10) - 1;
    const day = parseInt(dateMatch[2], 10);
    const d = new Date(now.getFullYear(), month, day);
    return d.getTime();
  }

  // "Yesterday"
  if (/yesterday/i.test(timeStr) || /昨天/i.test(timeStr)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d.getTime();
  }

  // Day of week
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const lowerTime = timeStr.toLowerCase();
  const dayIndex = days.indexOf(lowerTime);
  if (dayIndex >= 0) {
    const d = new Date(now);
    const currentDay = d.getDay();
    const diff = currentDay - dayIndex;
    d.setDate(d.getDate() - (diff > 0 ? diff : diff + 7));
    return d.getTime();
  }

  return Date.now();
}

/**
 * Simple hash function for creating deterministic message IDs.
 */
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
ConnectorRegistry.registerType('line', LineConnector);
