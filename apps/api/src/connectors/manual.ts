import { v4 as uuid } from 'uuid';
import type { ExternalThread, ExternalMessage, ConnectorConfig, CommProvider, ConnectorType } from '@prism/shared';
import { BaseConnector } from './base-connector';
import { ConnectorRegistry } from './registry';
import { getDb } from '../memory/db';

/**
 * ManualConnector — a local connector for manually managed conversations.
 *
 * No external API integration. Users create threads and paste messages
 * manually. Designed for workflows like email/message drafting where
 * the user copies content from their email client, gets AI assistance,
 * then copies the result back.
 *
 * Fully reuses the Communication mode infrastructure:
 * - ThreadList / ThreadDetail UI
 * - Draft generation (ReplyDraftAgent)
 * - Reply Learning (tone per sender)
 * - Monitor Rules (optional)
 */
export class ManualConnector extends BaseConnector {
  provider: CommProvider = 'manual';
  connectorType: ConnectorType = 'manual';
  override readonly isLocal: boolean = true;

  constructor(accountId?: string) {
    super(accountId);
  }

  // --- OAuth methods: not applicable for Manual connector ---

  getOAuthUrl(): string {
    throw new Error('Manual connector does not use OAuth');
  }

  async exchangeCodeForToken(_code: string): Promise<void> {
    throw new Error('Manual connector does not use OAuth');
  }

  async refreshToken(): Promise<void> {
    // No-op: manual connector tokens never expire
  }

  async disconnect(): Promise<void> {
    this.deactivateConfig();
  }

  // --- Setup ---

  /**
   * Set up the manual connector with a display name.
   * Creates a connector DB record with a dummy token that never expires.
   */
  async setupManual(displayName: string): Promise<void> {
    const config: ConnectorConfig = {
      accessToken: 'manual-local',
      refreshToken: '',
      expiresAt: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000, // 100 years
      scope: 'manual',
    };

    this.saveConfig(config);

    const db = getDb();
    db.prepare('UPDATE connectors SET display_name = ?, connector_type = ? WHERE id = ?')
      .run(displayName, 'manual', this.accountId);
  }

  // --- Thread/Message operations ---

  /**
   * Fetch all manual threads for this account.
   * Unlike external connectors, we just read from DB (no API call).
   */
  async fetchThreads(_since?: number): Promise<ExternalThread[]> {
    const db = getDb();
    const rows = db.prepare(
      'SELECT * FROM external_threads WHERE account_id = ? AND provider = ? ORDER BY last_message_at DESC'
    ).all(this.accountId, 'manual') as any[];

    return rows.map(rowToThread);
  }

  /**
   * Fetch messages for a specific thread.
   */
  async fetchThreadMessages(threadId: string, limit?: number): Promise<ExternalMessage[]> {
    const db = getDb();
    let query = 'SELECT * FROM external_messages WHERE thread_id = ? ORDER BY timestamp ASC';
    const params: any[] = [threadId];

    if (limit) {
      query += ' LIMIT ?';
      params.push(limit);
    }

    const rows = db.prepare(query).all(...params) as any[];
    return rows.map(rowToMessage);
  }

  /**
   * Store an approved reply as an outbound message in the thread.
   */
  async sendReply(threadId: string, content: string, _replyToId?: string): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const msgId = uuid();

    db.prepare(`
      INSERT INTO external_messages
      (id, thread_id, provider, account_id, external_id, sender_id, sender_name,
       sender_email, subject, content, timestamp, is_inbound, metadata, created_at)
      VALUES (?, ?, 'manual', ?, ?, 'user', 'Me', NULL, NULL, ?, ?, 0, '{}', ?)
    `).run(msgId, threadId, this.accountId, msgId, content, now, now);

    // Update thread metadata
    db.prepare(
      'UPDATE external_threads SET message_count = message_count + 1, last_message_at = ?, last_synced_at = ? WHERE id = ?'
    ).run(now, now, threadId);
  }

  // --- Manual-specific methods ---

  /**
   * Create a new thread manually.
   */
  createThread(opts: {
    displayName: string;
    subject?: string;
    senderName?: string;
    senderEmail?: string;
    isGroup?: boolean;
  }): ExternalThread {
    const db = getDb();
    const now = Date.now();
    const threadId = uuid();
    const externalId = `manual-${threadId}`;

    db.prepare(`
      INSERT INTO external_threads
      (id, provider, account_id, external_id, session_id, display_name, subject,
       sender_name, sender_email, is_group, message_count, last_message_at, last_synced_at, created_at)
      VALUES (?, 'manual', ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      threadId,
      this.accountId,
      externalId,
      opts.displayName,
      opts.subject || null,
      opts.senderName || null,
      opts.senderEmail || null,
      opts.isGroup ? 1 : 0,
      now,
      now,
      now,
    );

    return {
      id: threadId,
      provider: 'manual',
      accountId: this.accountId,
      externalId,
      sessionId: null,
      displayName: opts.displayName,
      subject: opts.subject || null,
      senderName: opts.senderName || null,
      senderEmail: opts.senderEmail || null,
      isGroup: opts.isGroup || false,
      messageCount: 0,
      lastMessageAt: now,
      lastSyncedAt: now,
      createdAt: now,
    };
  }

  /**
   * Add a message to an existing thread manually.
   * Used when the user pastes in a received email/message.
   */
  addMessage(opts: {
    threadId: string;
    content: string;
    senderName: string;
    senderEmail?: string;
    isInbound: boolean;
    subject?: string;
  }): ExternalMessage {
    const db = getDb();
    const now = Date.now();
    const msgId = uuid();

    db.prepare(`
      INSERT INTO external_messages
      (id, thread_id, provider, account_id, external_id, sender_id, sender_name,
       sender_email, subject, content, timestamp, is_inbound, metadata, created_at)
      VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
    `).run(
      msgId,
      opts.threadId,
      this.accountId,
      msgId,
      opts.senderEmail || opts.senderName,
      opts.senderName,
      opts.senderEmail || null,
      opts.subject || null,
      opts.content,
      now,
      opts.isInbound ? 1 : 0,
      now,
    );

    // Update thread metadata
    db.prepare(
      'UPDATE external_threads SET message_count = message_count + 1, last_message_at = ?, last_synced_at = ? WHERE id = ?'
    ).run(now, now, opts.threadId);

    return {
      id: msgId,
      threadId: opts.threadId,
      provider: 'manual',
      accountId: this.accountId,
      externalId: msgId,
      senderId: opts.senderEmail || opts.senderName,
      senderName: opts.senderName,
      senderEmail: opts.senderEmail || null,
      subject: opts.subject || null,
      content: opts.content,
      timestamp: now,
      isInbound: opts.isInbound,
      metadata: {},
      createdAt: now,
    };
  }
}

// --- Helpers ---

function rowToThread(row: any): ExternalThread {
  return {
    id: row.id,
    provider: row.provider,
    accountId: row.account_id,
    externalId: row.external_id,
    sessionId: row.session_id || null,
    displayName: row.display_name,
    subject: row.subject || null,
    senderName: row.sender_name || null,
    senderEmail: row.sender_email || null,
    isGroup: row.is_group === 1,
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
  };
}

function rowToMessage(row: any): ExternalMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    provider: row.provider,
    accountId: row.account_id,
    externalId: row.external_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderEmail: row.sender_email || null,
    subject: row.subject || null,
    content: row.content,
    timestamp: row.timestamp,
    isInbound: row.is_inbound === 1,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    createdAt: row.created_at,
  };
}

// Register at module load
ConnectorRegistry.registerType('manual', ManualConnector);
