import { v4 as uuid } from 'uuid';
import type { ExternalThread, ExternalMessage, ConnectorConfig, CommProvider, ConnectorType } from '@prism/shared';
import { BaseConnector } from './base-connector';
import { ConnectorRegistry } from './registry';
import { getDb } from '../memory/db';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_API_VERSION = '2022-06-28';

// --- Environment helpers (only needed for OAuth mode) ---

function getNotionClientId(): string {
  const id = process.env.NOTION_CLIENT_ID;
  if (!id) throw new Error('NOTION_CLIENT_ID is not set');
  return id;
}

function getNotionClientSecret(): string {
  const secret = process.env.NOTION_CLIENT_SECRET;
  if (!secret) throw new Error('NOTION_CLIENT_SECRET is not set');
  return secret;
}

function getNotionRedirectUri(): string {
  return process.env.NOTION_REDIRECT_URI ?? 'http://localhost:3001/api/connectors/notion/callback';
}

// Helper: Make authenticated Notion API requests
async function notionFetch<T>(endpoint: string, accessToken: string, options: RequestInit = {}): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : `${NOTION_API_BASE}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_API_VERSION,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// Convert Notion blocks to markdown
function notionBlocksToMarkdown(blocks: any[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const type = block.type;
    const data = block[type];
    if (!data) continue;

    const text = data.rich_text?.map((t: any) => t.plain_text).join('') ?? '';

    switch (type) {
      case 'paragraph': lines.push(text); break;
      case 'heading_1': lines.push(`# ${text}`); break;
      case 'heading_2': lines.push(`## ${text}`); break;
      case 'heading_3': lines.push(`### ${text}`); break;
      case 'bulleted_list_item': lines.push(`- ${text}`); break;
      case 'numbered_list_item': lines.push(`1. ${text}`); break;
      case 'to_do': lines.push(`- [${data.checked ? 'x' : ' '}] ${text}`); break;
      case 'toggle': lines.push(`> ${text}`); break;
      case 'code': lines.push(`\`\`\`${data.language ?? ''}\n${text}\n\`\`\``); break;
      case 'quote': lines.push(`> ${text}`); break;
      case 'divider': lines.push('---'); break;
      case 'callout': lines.push(`> ${data.icon?.emoji ?? '💡'} ${text}`); break;
      case 'image': {
        const url = data.file?.url ?? data.external?.url ?? '';
        lines.push(`![image](${url})`);
        break;
      }
      default: if (text) lines.push(text); break;
    }
  }
  return lines.join('\n\n');
}

/**
 * Notion API limits each rich_text content to 2000 characters.
 * Split long text into multiple rich_text segments.
 */
const NOTION_TEXT_LIMIT = 2000;

function makeRichText(content: string): { type: string; text: { content: string } }[] {
  if (content.length <= NOTION_TEXT_LIMIT) {
    return [{ type: 'text', text: { content } }];
  }
  // Split into chunks without breaking words when possible
  const chunks: { type: string; text: { content: string } }[] = [];
  let remaining = content;
  while (remaining.length > 0) {
    if (remaining.length <= NOTION_TEXT_LIMIT) {
      chunks.push({ type: 'text', text: { content: remaining } });
      break;
    }
    // Try to break at a space near the limit
    let splitAt = remaining.lastIndexOf(' ', NOTION_TEXT_LIMIT);
    if (splitAt < NOTION_TEXT_LIMIT * 0.5) splitAt = NOTION_TEXT_LIMIT; // no good break point
    chunks.push({ type: 'text', text: { content: remaining.slice(0, splitAt) } });
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

// Convert markdown to Notion blocks (basic)
function markdownToNotionBlocks(md: string): any[] {
  const blocks: any[] = [];
  const lines = md.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('### ')) {
      blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: makeRichText(trimmed.slice(4)) } });
    } else if (trimmed.startsWith('## ')) {
      blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: makeRichText(trimmed.slice(3)) } });
    } else if (trimmed.startsWith('# ')) {
      blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: makeRichText(trimmed.slice(2)) } });
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: makeRichText(trimmed.slice(2)) } });
    } else if (/^\d+\.\s/.test(trimmed)) {
      blocks.push({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: makeRichText(trimmed.replace(/^\d+\.\s/, '')) } });
    } else if (trimmed.startsWith('> ')) {
      blocks.push({ object: 'block', type: 'quote', quote: { rich_text: makeRichText(trimmed.slice(2)) } });
    } else if (trimmed === '---') {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
    } else {
      blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: makeRichText(trimmed) } });
    }
  }
  return blocks;
}

/**
 * NotionConnector — supports two modes:
 *
 * 1. **Internal Integration** (notion-internal): Uses a static bearer token from
 *    Notion's Internal Integration. No OAuth flow needed. The user provides the
 *    token via the setup API, and it's stored directly. This is the recommended
 *    mode for personal / team use.
 *
 * 2. **Public OAuth** (notion-oauth): Full OAuth2 flow. Requires NOTION_CLIENT_ID
 *    and NOTION_CLIENT_SECRET. Suitable for multi-tenant deployments.
 */
export class NotionConnector extends BaseConnector {
  provider: CommProvider = 'notion';
  connectorType: ConnectorType = 'notion-internal';

  /** Whether this instance uses Internal Integration (static token) vs OAuth */
  private _isInternal: boolean = true;

  constructor(accountId: string, connectorType?: ConnectorType) {
    super(accountId);
    if (connectorType) {
      this.connectorType = connectorType;
      this._isInternal = connectorType === 'notion-internal';
    }
  }

  /**
   * Set up an Internal Integration by directly storing the bearer token.
   * Call this instead of the OAuth flow when using Internal Integration.
   */
  async setupInternal(token: string): Promise<void> {
    // Validate the token by calling /users/me
    const data = await notionFetch<{ bot: { owner: { workspace: boolean }; workspace_name?: string } }>(
      '/users/me',
      token,
    );

    const workspaceName = data.bot?.workspace_name ?? 'Notion Workspace';

    // Notion internal tokens don't expire
    const config: ConnectorConfig = {
      accessToken: token,
      refreshToken: '',
      expiresAt: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000, // 10 years
      scope: 'read_content,update_content,insert_content',
    };

    this.connectorType = 'notion-internal';
    this._isInternal = true;
    this.saveConfig(config);

    // Update display name
    const db = getDb();
    db.prepare('UPDATE connectors SET display_name = ?, connector_type = ? WHERE id = ?')
      .run(workspaceName, 'notion-internal', this.accountId);
  }

  // --- OAuth methods (only used when connectorType === 'notion-oauth') ---

  getOAuthUrl(): string {
    if (this._isInternal) {
      throw new Error('OAuth not applicable for Internal Integration. Use setupInternal() instead.');
    }

    const params = new URLSearchParams({
      client_id: getNotionClientId(),
      response_type: 'code',
      redirect_uri: getNotionRedirectUri(),
      owner: 'user',
      state: this.accountId,
    });
    return `https://api.notion.com/v1/oauth/authorize?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<void> {
    if (this._isInternal) {
      throw new Error('OAuth not applicable for Internal Integration.');
    }

    const credentials = Buffer.from(`${getNotionClientId()}:${getNotionClientSecret()}`).toString('base64');

    const res = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: getNotionRedirectUri(),
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Notion token exchange failed: ${errBody}`);
    }

    const data = await res.json() as {
      access_token: string;
      workspace_id: string;
      workspace_name: string;
      workspace_icon: string | null;
      bot_id: string;
      owner: any;
    };

    const config: ConnectorConfig = {
      accessToken: data.access_token,
      refreshToken: '',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      scope: 'read_content,update_content,insert_content',
    };

    this.saveConfig(config);

    const db = getDb();
    db.prepare('UPDATE connectors SET email = ?, display_name = ? WHERE id = ?')
      .run(data.workspace_id, data.workspace_name, this.accountId);
  }

  async refreshToken(): Promise<void> {
    // Notion tokens (both Internal and OAuth) don't expire, no-op
  }

  async disconnect(): Promise<void> {
    this.deactivateConfig();
  }

  /**
   * Fetch pages from Notion via Search API. Maps each page to an ExternalThread.
   */
  async fetchThreads(since?: number): Promise<ExternalThread[]> {
    const { accessToken } = await this.ensureValidToken();

    const body: any = {
      filter: { value: 'page', property: 'object' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 100,
    };

    const data = await notionFetch<{ results: any[] }>('/search', accessToken, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const pages = data.results ?? [];
    const db = getDb();
    const now = Date.now();
    const threads: ExternalThread[] = [];

    const upsertThread = db.prepare(`
      INSERT INTO external_threads (id, provider, account_id, external_id, session_id, display_name, subject, sender_name, sender_email, is_group, message_count, last_message_at, last_synced_at, created_at)
      VALUES (?, 'notion', ?, ?, NULL, ?, NULL, NULL, NULL, 0, 1, ?, ?, ?)
      ON CONFLICT(account_id, external_id) DO UPDATE SET
        display_name = excluded.display_name,
        last_message_at = excluded.last_message_at,
        last_synced_at = excluded.last_synced_at
    `);

    const txn = db.transaction(() => {
      for (const page of pages) {
        const pageId = page.id;
        const lastEdited = new Date(page.last_edited_time).getTime();

        if (since && lastEdited < since) continue;

        const title = page.properties?.title?.title?.[0]?.plain_text
          ?? page.properties?.Name?.title?.[0]?.plain_text
          ?? extractPageTitle(page)
          ?? 'Untitled';

        const existingRow = db.prepare(
          "SELECT id FROM external_threads WHERE account_id = ? AND external_id = ?"
        ).get(this.accountId, pageId) as { id: string } | undefined;

        const threadId = existingRow?.id ?? uuid();

        upsertThread.run(threadId, this.accountId, pageId, title, lastEdited, now, now);

        threads.push({
          id: threadId,
          provider: 'notion',
          accountId: this.accountId,
          externalId: pageId,
          sessionId: null,
          displayName: title,
          subject: null,
          senderName: null,
          senderEmail: null,
          isGroup: false,
          messageCount: 1,
          lastMessageAt: lastEdited,
          lastSyncedAt: now,
          createdAt: now,
        });
      }
    });

    txn();
    return threads;
  }

  /**
   * Fetch page content as blocks, convert to markdown, return as single ExternalMessage.
   */
  async fetchThreadMessages(threadId: string, _limit?: number): Promise<ExternalMessage[]> {
    const db = getDb();
    const thread = db.prepare(
      'SELECT external_id, display_name FROM external_threads WHERE id = ?'
    ).get(threadId) as { external_id: string; display_name: string } | undefined;

    if (!thread) return [];

    const { accessToken } = await this.ensureValidToken();

    const blocks = await this.fetchAllBlocks(thread.external_id, accessToken);
    const markdown = notionBlocksToMarkdown(blocks);
    const now = Date.now();

    const msgId = `${this.accountId}-${thread.external_id}-content`;
    const existingMsg = db.prepare(
      "SELECT id FROM external_messages WHERE account_id = ? AND external_id = ?"
    ).get(this.accountId, msgId) as { id: string } | undefined;

    const id = existingMsg?.id ?? uuid();

    db.prepare(`
      INSERT INTO external_messages (id, thread_id, provider, account_id, external_id, sender_id, sender_name, sender_email, subject, content, timestamp, is_inbound, metadata, created_at)
      VALUES (?, ?, 'notion', ?, ?, 'notion', ?, NULL, ?, ?, ?, 1, '{}', ?)
      ON CONFLICT(account_id, external_id) DO UPDATE SET
        content = excluded.content,
        timestamp = excluded.timestamp
    `).run(id, threadId, this.accountId, msgId, thread.display_name, thread.display_name, markdown, now, now);

    return [{
      id,
      threadId,
      provider: 'notion',
      accountId: this.accountId,
      externalId: msgId,
      senderId: 'notion',
      senderName: thread.display_name,
      senderEmail: null,
      subject: thread.display_name,
      content: markdown,
      timestamp: now,
      isInbound: true,
      metadata: {},
      createdAt: now,
    }];
  }

  /**
   * Append content as blocks to a Notion page.
   * Notion API limits to 100 blocks per request, so we batch large content.
   */
  async sendReply(threadId: string, content: string, _replyToId?: string): Promise<void> {
    const db = getDb();
    const thread = db.prepare(
      'SELECT external_id FROM external_threads WHERE id = ?'
    ).get(threadId) as { external_id: string } | undefined;

    if (!thread) throw new Error('Thread not found');

    const { accessToken } = await this.ensureValidToken();
    const allBlocks = markdownToNotionBlocks(content);

    // Notion API allows max 100 children per PATCH request
    const BATCH_SIZE = 100;
    for (let i = 0; i < allBlocks.length; i += BATCH_SIZE) {
      const batch = allBlocks.slice(i, i + BATCH_SIZE);
      await notionFetch<any>(`/blocks/${thread.external_id}/children`, accessToken, {
        method: 'PATCH',
        body: JSON.stringify({ children: batch }),
      });
    }
  }

  /**
   * Fetch all blocks for a page (handles pagination).
   */
  private async fetchAllBlocks(pageId: string, accessToken: string): Promise<any[]> {
    const allBlocks: any[] = [];
    let cursor: string | undefined;

    do {
      const qs = cursor ? `?start_cursor=${cursor}` : '';
      const data = await notionFetch<{ results: any[]; has_more: boolean; next_cursor: string | null }>(
        `/blocks/${pageId}/children${qs}`,
        accessToken
      );

      allBlocks.push(...(data.results ?? []));
      cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
    } while (cursor);

    return allBlocks;
  }
}

/**
 * Extract page title from various Notion page property formats.
 */
function extractPageTitle(page: any): string | null {
  if (!page.properties) return null;
  for (const prop of Object.values(page.properties) as any[]) {
    if (prop.type === 'title' && prop.title?.length > 0) {
      return prop.title.map((t: any) => t.plain_text).join('');
    }
  }
  return null;
}

// Register both connector types
ConnectorRegistry.registerType('notion-internal', NotionConnector);
ConnectorRegistry.registerType('notion-oauth', NotionConnector);
