import { v4 as uuid } from 'uuid';
import type { ExternalThread, ExternalMessage, ConnectorConfig, CommProvider, ConnectorType } from '@prism/shared';
import { BaseConnector } from './base-connector';
import { ConnectorRegistry } from './registry';
import { getDb } from '../memory/db';

// --- Microsoft Identity Platform constants ---

const MS_AUTHORITY = 'https://login.microsoftonline.com/common';
const MS_GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const MS_SCOPES = 'offline_access Mail.ReadWrite Mail.Send User.Read';

function getClientId(): string {
  const id = process.env.MICROSOFT_CLIENT_ID;
  if (!id) throw new Error('MICROSOFT_CLIENT_ID is not set');
  return id;
}

function getClientSecret(): string {
  const secret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!secret) throw new Error('MICROSOFT_CLIENT_SECRET is not set');
  return secret;
}

function getRedirectUri(): string {
  return process.env.MICROSOFT_REDIRECT_URI ?? 'http://localhost:3001/api/connectors/outlook/callback';
}

// --- Graph API response types ---

interface GraphMailMessage {
  id: string;
  conversationId: string;
  subject: string | null;
  bodyPreview: string;
  body?: { contentType: string; content: string };
  from?: { emailAddress: { name: string; address: string } };
  sender?: { emailAddress: { name: string; address: string } };
  receivedDateTime: string;
  isRead: boolean;
  isDraft: boolean;
  toRecipients?: { emailAddress: { name: string; address: string } }[];
  ccRecipients?: { emailAddress: { name: string; address: string } }[];
}

interface GraphResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

// --- Helpers ---

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

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

  // Some endpoints (reply) return 202 with no body
  if (res.status === 202 || res.headers.get('content-length') === '0') {
    return {} as T;
  }

  return res.json() as Promise<T>;
}

/**
 * Determine if a mail message is inbound (sent by someone else) based on
 * the "from" address. We compare against the authenticated user's email.
 * When the user's email is unknown, we treat all messages as inbound.
 */
function isMessageInbound(msg: GraphMailMessage, userEmail: string | null): boolean {
  if (!userEmail) return true;
  const from = msg.from?.emailAddress?.address?.toLowerCase();
  return from !== userEmail.toLowerCase();
}

// --- Outlook Connector ---

export class OutlookConnector extends BaseConnector {
  provider: CommProvider = 'outlook';
  connectorType: ConnectorType = 'outlook-oauth';

  private cachedUserEmail: string | null = null;

  constructor(accountId: string) {
    super(accountId);
  }

  getOAuthUrl(): string {
    const params = new URLSearchParams({
      client_id: getClientId(),
      response_type: 'code',
      redirect_uri: getRedirectUri(),
      response_mode: 'query',
      scope: MS_SCOPES,
      prompt: 'consent',
      state: this.accountId,
    });

    return `${MS_AUTHORITY}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<void> {
    const body = new URLSearchParams({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      code,
      redirect_uri: getRedirectUri(),
      grant_type: 'authorization_code',
      scope: MS_SCOPES,
    });

    const res = await fetch(`${MS_AUTHORITY}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Token exchange failed: ${errBody}`);
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };

    const config: ConnectorConfig = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: data.scope,
    };

    this.saveConfig(config);

    // Fetch user profile and store email/display_name
    try {
      const profile = await graphFetch<{ mail?: string; userPrincipalName?: string; displayName?: string }>(
        '/me?$select=mail,userPrincipalName,displayName',
        data.access_token
      );
      const email = profile.mail ?? profile.userPrincipalName ?? null;
      const displayName = profile.displayName ?? null;
      this.cachedUserEmail = email;

      const db = getDb();
      db.prepare('UPDATE connectors SET email = ?, display_name = ? WHERE id = ?')
        .run(email, displayName, this.accountId);
    } catch {
      // Non-critical — continue without profile info
    }
  }

  async refreshToken(): Promise<void> {
    const current = this.loadConfig();
    if (!current?.refreshToken) {
      throw new Error('No refresh token available — re-authenticate required');
    }

    const body = new URLSearchParams({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      refresh_token: current.refreshToken,
      grant_type: 'refresh_token',
      scope: MS_SCOPES,
    });

    const res = await fetch(`${MS_AUTHORITY}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const errBody = await res.text();
      // If refresh fails, deactivate so user knows to re-auth
      this.deactivateConfig();
      throw new Error(`Token refresh failed: ${errBody}`);
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
    };

    const config: ConnectorConfig = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? current.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: data.scope,
    };

    this.saveConfig(config);
  }

  async disconnect(): Promise<void> {
    this.cachedUserEmail = null;
    this.deactivateConfig();
  }

  /**
   * Fetch the authenticated user's email address (cached per session).
   */
  private async getUserEmail(accessToken: string): Promise<string | null> {
    if (this.cachedUserEmail) return this.cachedUserEmail;

    try {
      const profile = await graphFetch<{ mail?: string; userPrincipalName?: string }>(
        '/me?$select=mail,userPrincipalName',
        accessToken
      );
      this.cachedUserEmail = profile.mail ?? profile.userPrincipalName ?? null;
    } catch {
      this.cachedUserEmail = null;
    }

    return this.cachedUserEmail;
  }

  /**
   * Fetch inbox messages from Graph API, grouped into ExternalThreads by conversationId.
   */
  async fetchThreads(since?: number): Promise<ExternalThread[]> {
    const { accessToken } = await this.ensureValidToken();
    const userEmail = await this.getUserEmail(accessToken);

    let endpoint = '/me/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime desc&$select=id,conversationId,subject,bodyPreview,from,sender,receivedDateTime,isRead,isDraft,toRecipients,ccRecipients';
    if (since) {
      const isoDate = new Date(since).toISOString();
      endpoint += `&$filter=receivedDateTime ge ${isoDate}`;
    }

    const data = await graphFetch<GraphResponse<GraphMailMessage>>(endpoint, accessToken);
    const messages = data.value ?? [];

    // Group by conversationId
    const threadMap = new Map<string, GraphMailMessage[]>();
    for (const msg of messages) {
      if (msg.isDraft) continue;
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
      ON CONFLICT(account_id, external_id) DO NOTHING
    `);

    const txn = db.transaction(() => {
      for (const [convId, msgs] of threadMap) {
        // Sort oldest first to get first sender info
        const sorted = [...msgs].sort(
          (a, b) => new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime()
        );

        const firstMsg = sorted[0];
        const latestMsg = sorted[sorted.length - 1];
        const fromAddr = firstMsg.from?.emailAddress;
        const subject = firstMsg.subject ?? '(no subject)';
        const isGroup = (firstMsg.toRecipients?.length ?? 0) + (firstMsg.ccRecipients?.length ?? 0) > 1;

        // Look up existing thread to preserve its ID, or generate new
        const existingRow = db.prepare(
          "SELECT id FROM external_threads WHERE account_id = ? AND external_id = ?"
        ).get(this.accountId, convId) as { id: string } | undefined;

        const threadId = existingRow?.id ?? uuid();

        const lastMsgTime = new Date(latestMsg.receivedDateTime).getTime();

        upsertThread.run(
          threadId,
          this.accountId,
          convId,
          subject,
          subject,
          fromAddr?.name ?? null,
          fromAddr?.address ?? null,
          isGroup ? 1 : 0,
          sorted.length,
          lastMsgTime,
          now,
          now
        );

        // Persist individual messages
        for (const msg of sorted) {
          const sender = msg.from?.emailAddress;
          const content = msg.body?.content
            ? stripHtml(msg.body.content)
            : msg.bodyPreview ?? '';

          upsertMessage.run(
            uuid(),
            threadId,
            this.accountId,
            msg.id,
            sender?.address ?? 'unknown',
            sender?.name ?? 'Unknown',
            sender?.address ?? null,
            msg.subject,
            content,
            new Date(msg.receivedDateTime).getTime(),
            isMessageInbound(msg, userEmail) ? 1 : 0,
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
          senderName: fromAddr?.name ?? null,
          senderEmail: fromAddr?.address ?? null,
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

  /**
   * Fetch messages for a specific thread (by internal thread ID).
   */
  async fetchThreadMessages(threadId: string, limit: number = 50): Promise<ExternalMessage[]> {
    const db = getDb();

    // Look up external_id for this thread
    const thread = db.prepare(
      'SELECT external_id FROM external_threads WHERE id = ?'
    ).get(threadId) as { external_id: string } | undefined;

    if (!thread) {
      // Fallback: return what we have in DB
      return this.loadMessagesFromDb(threadId, limit);
    }

    // Fetch fresh messages from Graph API for this conversation
    const { accessToken } = await this.ensureValidToken();
    const userEmail = await this.getUserEmail(accessToken);

    const endpoint = `/me/messages?$filter=conversationId eq '${thread.external_id}'&$top=${limit}&$orderby=receivedDateTime asc&$select=id,conversationId,subject,bodyPreview,body,from,sender,receivedDateTime,isRead,isDraft,toRecipients,ccRecipients`;

    const data = await graphFetch<GraphResponse<GraphMailMessage>>(endpoint, accessToken);
    const graphMsgs = (data.value ?? []).filter((m) => !m.isDraft);

    // Persist any new messages
    const now = Date.now();
    const upsertMessage = db.prepare(`
      INSERT INTO external_messages (id, thread_id, provider, account_id, external_id, sender_id, sender_name, sender_email, subject, content, timestamp, is_inbound, metadata, created_at)
      VALUES (?, ?, 'outlook', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, external_id) DO NOTHING
    `);

    const txn = db.transaction(() => {
      for (const msg of graphMsgs) {
        const sender = msg.from?.emailAddress;
        const content = msg.body?.content
          ? stripHtml(msg.body.content)
          : msg.bodyPreview ?? '';

        upsertMessage.run(
          uuid(),
          threadId,
          this.accountId,
          msg.id,
          sender?.address ?? 'unknown',
          sender?.name ?? 'Unknown',
          sender?.address ?? null,
          msg.subject,
          content,
          new Date(msg.receivedDateTime).getTime(),
          isMessageInbound(msg, userEmail) ? 1 : 0,
          JSON.stringify({ isRead: msg.isRead }),
          now
        );
      }

      // Update thread sync time
      db.prepare(
        'UPDATE external_threads SET last_synced_at = ?, message_count = ? WHERE id = ?'
      ).run(now, graphMsgs.length, threadId);
    });

    txn();

    return this.loadMessagesFromDb(threadId, limit);
  }

  /**
   * Reply to a message via Graph API.
   */
  async sendReply(threadId: string, content: string, replyToId?: string): Promise<void> {
    const { accessToken } = await this.ensureValidToken();

    // If no specific message ID given, find the latest inbound message in the thread
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

    await graphFetch<void>(
      `/me/messages/${messageId}/reply`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          message: {
            body: {
              contentType: 'Text',
              content,
            },
          },
        }),
      }
    );
  }

  /**
   * Load messages from the local DB for a thread.
   */
  private loadMessagesFromDb(threadId: string, limit: number): ExternalMessage[] {
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
ConnectorRegistry.registerType('outlook-oauth', OutlookConnector);
