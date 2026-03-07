import { v4 as uuid } from 'uuid';
import type { ExternalThread, ExternalMessage, CommProvider, ConnectorType } from '@prism/shared';
import { BaseConnector } from './base-connector';
import { ConnectorRegistry } from './registry';
import { getDb } from '../memory/db';
import {
  fetchInboxMessagesAsync,
  fetchInboxMessagesForAccountAsync,
  sendOutlookReply,
  isOutlookRunning,
  getDefaultEmail,
  type AppleScriptMailMessage,
  type OutlookAccountType,
} from '../services/outlook-applescript';

/**
 * OutlookLocalConnector — reads from the macOS Outlook desktop app via AppleScript.
 *
 * No OAuth or API keys required. The Outlook desktop app is already authenticated
 * on the user's Mac.
 *
 * Multi-account: each instance is tied to one accountId.
 */
export class OutlookLocalConnector extends BaseConnector {
  provider: CommProvider = 'outlook';
  connectorType: ConnectorType = 'outlook-local';
  override readonly isLocal: boolean = true;

  private cachedUserEmail: string | null = null;
  private accountType: OutlookAccountType | null = null;
  private accountIndex: number | null = null;

  constructor(accountId: string) {
    super(accountId);
  }

  /**
   * Set the account type and index for per-account fetching.
   * Called during the multi-account discovery connect flow.
   */
  setAccountRef(type: OutlookAccountType, index: number): void {
    this.accountType = type;
    this.accountIndex = index;
  }

  /**
   * Restore accountType/accountIndex from the stored config JSON.
   * Called from ensureValidToken() so restored-from-DB instances work.
   */
  private restoreAccountRef(): void {
    if (this.accountType !== null) return; // already set
    const config = this.loadConfig();
    if (!config) return;
    const raw = config as any;
    if (raw.accountType && raw.accountIndex != null) {
      this.accountType = raw.accountType as OutlookAccountType;
      this.accountIndex = raw.accountIndex as number;
    }
  }

  // --- OAuth methods (no-ops for local connector) ---

  getOAuthUrl(): string {
    throw new Error('Local Outlook connector does not use OAuth. The Outlook desktop app handles authentication.');
  }

  async exchangeCodeForToken(_code: string): Promise<void> {
    throw new Error('Local Outlook connector does not use OAuth.');
  }

  async refreshToken(): Promise<void> {
    // No-op: local connector doesn't have tokens to refresh
  }

  async disconnect(): Promise<void> {
    this.cachedUserEmail = null;
    this.deactivateConfig();
  }

  /**
   * Override ensureValidToken: for local connector we just check that
   * Outlook is running. We create/maintain a synthetic config record
   * so the polling service recognizes this connector as active.
   */
  protected async ensureValidToken() {
    if (!isOutlookRunning()) {
      throw new Error('Outlook for macOS is not running. Please open it to sync emails.');
    }

    // Ensure we have an active config row in the DB
    const existing = this.loadConfig();
    if (!existing) {
      // Create a synthetic config so the connector shows as active
      this.activateLocalConnector();
    }

    // Restore per-account ref from stored config (for DB-restored instances)
    this.restoreAccountRef();

    return existing ?? {
      accessToken: 'local',
      refreshToken: 'local',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // Never expires
      scope: 'local',
    };
  }

  /**
   * Create an active config record in the DB so the connector
   * appears as "connected" in the registry status checks.
   */
  activateLocalConnector(email?: string, displayName?: string): void {
    const syntheticConfig: Record<string, unknown> = {
      accessToken: 'local',
      refreshToken: 'local',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      scope: 'local',
    };

    // Persist per-account reference in config so restoreAccountRef() can recover it
    if (this.accountType !== null && this.accountIndex !== null) {
      syntheticConfig.accountType = this.accountType;
      syntheticConfig.accountIndex = this.accountIndex;
    }

    this.saveConfig(syntheticConfig as any);

    // Store the user's email — use provided value or fall back to AppleScript lookup
    const resolvedEmail = email ?? this.getUserEmail();
    const resolvedName = displayName ?? 'Local Outlook';

    if (resolvedEmail) {
      this.cachedUserEmail = resolvedEmail;
    }

    const db = getDb();
    db.prepare('UPDATE connectors SET email = ?, display_name = ? WHERE id = ?')
      .run(resolvedEmail ?? null, resolvedName, this.accountId);
  }

  /**
   * Check if the local connector is effectively connected
   * (Outlook is installed and running on macOS).
   */
  isLocalConnected(): boolean {
    return isOutlookRunning();
  }

  /**
   * Get the user's email address from Outlook.
   */
  private getUserEmail(): string | null {
    if (this.cachedUserEmail) return this.cachedUserEmail;

    // Try DB first (populated during activation)
    const db = getDb();
    const row = db.prepare('SELECT email FROM connectors WHERE id = ?')
      .get(this.accountId) as { email: string | null } | undefined;
    if (row?.email) {
      this.cachedUserEmail = row.email;
      return this.cachedUserEmail;
    }

    // Fall back to AppleScript default email
    this.cachedUserEmail = getDefaultEmail();
    return this.cachedUserEmail;
  }

  // --- Data access methods ---

  async fetchThreads(since?: number): Promise<ExternalThread[]> {
    await this.ensureValidToken();
    const userEmail = this.getUserEmail();

    console.log(`[outlook-local] fetchThreads for ${this.accountId}, since=${since ? new Date(since).toISOString() : 'none'}, accountType=${this.accountType}, accountIndex=${this.accountIndex}`);

    // Limit to 15 messages per sync to avoid AppleScript timeout on Exchange accounts.
    // Content is lazy-loaded when user clicks a thread, so this is just metadata.
    const SYNC_LIMIT = 15;
    const messages = this.accountType !== null && this.accountIndex !== null
      ? await fetchInboxMessagesForAccountAsync(this.accountType, this.accountIndex, SYNC_LIMIT, since)
      : await fetchInboxMessagesAsync(SYNC_LIMIT, since);

    console.log(`[outlook-local] fetchThreads got ${messages.length} messages from AppleScript`);
    if (messages.length > 0) {
      const newest = new Date(Math.max(...messages.map(m => m.receivedAt))).toISOString();
      const oldest = new Date(Math.min(...messages.map(m => m.receivedAt))).toISOString();
      console.log(`[outlook-local] message date range: ${oldest} to ${newest}`);
    }

    if (messages.length === 0) return [];

    // Group by conversation ID
    const threadMap = new Map<string, AppleScriptMailMessage[]>();
    for (const msg of messages) {
      const key = msg.conversationId;
      const group = threadMap.get(key);
      if (group) {
        group.push(msg);
      } else {
        threadMap.set(key, [msg]);
      }
    }

    const db = getDb();
    const now = Date.now();
    const threads: ExternalThread[] = [];

    const upsertThread = db.prepare(`
      INSERT INTO external_threads (id, provider, account_id, external_id, session_id, display_name, subject, sender_name, sender_email, is_group, message_count, last_message_at, last_synced_at, created_at)
      VALUES (?, 'outlook', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, external_id) DO UPDATE SET
        display_name = excluded.display_name,
        subject = excluded.subject,
        message_count = excluded.message_count,
        last_message_at = excluded.last_message_at,
        last_synced_at = excluded.last_synced_at
    `);

    const upsertMessage = db.prepare(`
      INSERT INTO external_messages (id, thread_id, provider, account_id, external_id, sender_id, sender_name, sender_email, subject, content, timestamp, is_inbound, metadata, created_at)
      VALUES (?, ?, 'outlook', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, external_id) DO UPDATE SET
        content = CASE WHEN excluded.content != '' THEN excluded.content ELSE external_messages.content END,
        sender_name = excluded.sender_name,
        subject = excluded.subject,
        metadata = excluded.metadata
    `);

    const txn = db.transaction(() => {
      for (const [convId, msgs] of threadMap) {
        // Sort oldest first
        const sorted = [...msgs].sort((a, b) => a.receivedAt - b.receivedAt);

        const firstMsg = sorted[0];
        const latestMsg = sorted[sorted.length - 1];
        const subject = firstMsg.subject || '(no subject)';
        const isGroup = firstMsg.toRecipients.length > 1;

        // Look up existing thread to preserve its ID
        const existingRow = db.prepare(
          "SELECT id FROM external_threads WHERE account_id = ? AND external_id = ?"
        ).get(this.accountId, convId) as { id: string } | undefined;

        const threadId = existingRow?.id ?? uuid();
        const lastMsgTime = latestMsg.receivedAt;

        upsertThread.run(
          threadId,
          this.accountId,
          convId,
          subject,
          subject,
          firstMsg.senderName || null,
          firstMsg.senderEmail || null,
          isGroup ? 1 : 0,
          sorted.length,
          lastMsgTime,
          now,
          now
        );

        // Persist individual messages
        for (const msg of sorted) {
          const isInbound = !userEmail || msg.senderEmail.toLowerCase() !== userEmail.toLowerCase();

          upsertMessage.run(
            uuid(),
            threadId,
            this.accountId,
            msg.id,
            msg.senderEmail || 'unknown',
            msg.senderName || 'Unknown',
            msg.senderEmail || null,
            msg.subject,
            msg.content,
            msg.receivedAt,
            isInbound ? 1 : 0,
            JSON.stringify({ isRead: msg.isRead }),
            now
          );
        }

        threads.push({
          id: threadId,
          provider: 'outlook',
          accountId: this.accountId,
          externalId: convId,
          sessionId: null,
          displayName: subject,
          subject,
          senderName: firstMsg.senderName || null,
          senderEmail: firstMsg.senderEmail || null,
          isGroup,
          messageCount: sorted.length,
          lastMessageAt: lastMsgTime,
          lastSyncedAt: now,
          createdAt: now,
        });
      }
    });

    txn();
    return threads;
  }

  async fetchThreadMessages(threadId: string, limit: number = 50): Promise<ExternalMessage[]> {
    // For local connector, we read from the DB (populated by fetchThreads polling).
    const db = getDb();

    const rows = db.prepare(
      `SELECT * FROM external_messages
       WHERE thread_id = ? AND account_id = ?
       ORDER BY timestamp ASC
       LIMIT ?`
    ).all(threadId, this.accountId, limit) as any[];

    return rows.map((row) => mapDbRowToExternalMessage(row, this.accountId));
  }

  async sendReply(threadId: string, content: string, replyToId?: string): Promise<void> {
    await this.ensureValidToken();

    // Find the message ID to reply to
    let messageId = replyToId;
    if (!messageId) {
      const db = getDb();
      const latest = db.prepare(
        `SELECT external_id FROM external_messages
         WHERE thread_id = ? AND account_id = ? AND is_inbound = 1
         ORDER BY timestamp DESC LIMIT 1`
      ).get(threadId, this.accountId) as { external_id: string } | undefined;

      if (!latest) {
        throw new Error('No inbound message found to reply to in this thread');
      }
      messageId = latest.external_id;
    }

    sendOutlookReply(messageId, content);
  }
}

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

// --- Register CLASS (not instance) ---
ConnectorRegistry.registerType('outlook-local', OutlookLocalConnector);
