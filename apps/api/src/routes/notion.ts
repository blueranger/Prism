import { Router } from 'express';
import {
  getAllNotionPages,
  getNotionPages,
  getNotionPage,
  searchNotionPages,
  addContextSource,
  getContextSources,
  removeContextSource,
  createNotionWrite,
  getNotionWrites,
  upsertNotionPage,
} from '../memory/notion-store';
import { ConnectorRegistry } from '../connectors/registry';
import { NotionConnector } from '../connectors/notion';
import { getDb } from '../memory/db';
import { v4 as uuid } from 'uuid';

const router = Router();

/**
 * POST /api/notion/setup
 * Set up a Notion Internal Integration by providing the secret token.
 * This creates a new connector account and validates the token against the Notion API.
 */
router.post('/setup', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token is required' });

    // Create a connector DB row first
    const accountId = uuid();
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO connectors (id, provider, connector_type, config, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)'
    ).run(accountId, 'notion', 'notion-internal', '{}', now, now);

    // Create connector instance and set up with the token
    const connector = ConnectorRegistry.createInstance('notion-internal', accountId) as NotionConnector;

    await connector.setupInternal(token);

    // Immediately trigger a page sync — fetch threads AND cache page content
    const threads = await connector.fetchThreads();

    for (const thread of threads) {
      const messages = await connector.fetchThreadMessages(thread.id);
      const pageContent = messages[0]?.content ?? null;
      upsertNotionPage(accountId, {
        notionPageId: thread.externalId,
        title: thread.displayName,
        url: `https://notion.so/${thread.externalId.replace(/-/g, '')}`,
        contentMd: pageContent,
        lastEditedAt: thread.lastMessageAt ?? undefined,
      });
    }

    res.json({
      ok: true,
      accountId,
      pagesFound: threads.length,
      message: `Notion connected successfully. Found ${threads.length} pages.`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/notion/status
 * Check if Notion is connected and return account info.
 */
router.get('/status', (_req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT id, display_name, connector_type, active FROM connectors WHERE provider = 'notion' AND active = 1"
    ).all() as { id: string; display_name: string; connector_type: string; active: number }[];

    res.json({
      connected: rows.length > 0,
      accounts: rows.map(r => ({
        accountId: r.id,
        displayName: r.display_name,
        connectorType: r.connector_type,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/notion/sync
 * Trigger a manual page sync for a connected Notion account.
 */
router.post('/sync', async (req, res) => {
  try {
    const { accountId } = req.body;

    // If no accountId given, sync all active Notion connectors
    const db = getDb();
    const accounts = accountId
      ? [{ id: accountId }]
      : db.prepare("SELECT id FROM connectors WHERE provider = 'notion' AND active = 1").all() as { id: string }[];

    if (accounts.length === 0) {
      return res.status(400).json({ error: 'No active Notion connector found' });
    }

    let totalPages = 0;
    for (const acct of accounts) {
      const connector = ConnectorRegistry.get(acct.id);
      if (!connector) continue;
      const threads = await connector.fetchThreads();
      totalPages += threads.length;

      // Also fetch page content and cache in notion_pages
      const { upsertNotionPage } = await import('../memory/notion-store');
      for (const thread of threads) {
        const messages = await connector.fetchThreadMessages(thread.id);
        const pageContent = messages[0]?.content ?? null;
        upsertNotionPage(acct.id, {
          notionPageId: thread.externalId,
          title: thread.displayName,
          url: `https://notion.so/${thread.externalId.replace(/-/g, '')}`,
          contentMd: pageContent,
          lastEditedAt: thread.lastMessageAt ?? undefined,
        });
      }
    }

    res.json({ ok: true, pagesSync: totalPages });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/notion/disconnect/:accountId
 * Disconnect a Notion account and clean up its data.
 */
router.delete('/disconnect/:accountId', (req, res) => {
  try {
    const { accountId } = req.params;
    const db = getDb();

    // Deactivate connector
    db.prepare('UPDATE connectors SET active = 0, updated_at = ? WHERE id = ?')
      .run(Date.now(), accountId);

    // Clean up notion_pages for this account
    db.prepare('DELETE FROM notion_pages WHERE account_id = ?').run(accountId);

    // Clean up external_threads and messages for this account
    const threadIds = db.prepare('SELECT id FROM external_threads WHERE account_id = ?')
      .all(accountId) as { id: string }[];
    for (const t of threadIds) {
      db.prepare('DELETE FROM external_messages WHERE thread_id = ?').run(t.id);
    }
    db.prepare('DELETE FROM external_threads WHERE account_id = ?').run(accountId);

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/notion/pages
 * List synced Notion pages. Supports ?query= for search and ?accountId= for filtering.
 */
router.get('/pages', (req, res) => {
  try {
    const { query, accountId } = req.query as { query?: string; accountId?: string };

    let pages;
    if (query && accountId) {
      pages = searchNotionPages(accountId, query);
    } else if (accountId) {
      pages = getNotionPages(accountId);
    } else if (query) {
      // Search across all accounts
      const allPages = getAllNotionPages();
      const q = query.toLowerCase();
      pages = allPages.filter(p => p.title.toLowerCase().includes(q));
    } else {
      pages = getAllNotionPages();
    }

    res.json({ pages });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/notion/pages/:id/content
 * Get page content as markdown.
 */
router.get('/pages/:id/content', (req, res) => {
  try {
    const page = getNotionPage(req.params.id);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    res.json({ page, content: page.contentMd });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/notion/pages/:pageId/write
 * Write content to a Notion page (append blocks).
 */
router.post('/pages/:pageId/write', async (req, res) => {
  try {
    const page = getNotionPage(req.params.pageId);
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const { content, sessionId, messageId } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    // Find the account for this page
    const db = getDb();
    const pageRow = db.prepare('SELECT account_id FROM notion_pages WHERE id = ?').get(req.params.pageId) as { account_id: string } | undefined;
    if (!pageRow) return res.status(404).json({ error: 'Page not found in DB' });

    let connector = ConnectorRegistry.get(pageRow.account_id);
    if (!connector) {
      // Try to restore the connector from DB (may happen after hot-reload)
      try {
        connector = ConnectorRegistry.createInstance('notion-internal', pageRow.account_id);
      } catch {
        return res.status(400).json({ error: 'Connector not active for this account' });
      }
    }

    // Find the thread for this page
    const thread = db.prepare(
      'SELECT id FROM external_threads WHERE account_id = ? AND external_id = ?'
    ).get(pageRow.account_id, page.notionPageId) as { id: string } | undefined;

    if (thread) {
      await connector.sendReply(thread.id, content);
    }

    // Record the write
    const writeRecord = createNotionWrite({
      sessionId: sessionId ?? '',
      messageId: messageId ?? '',
      accountId: pageRow.account_id,
      notionPageId: page.notionPageId,
      pageTitle: page.title,
      contentPreview: content.slice(0, 200),
    });

    res.json({ ok: true, write: writeRecord });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/notion/context-sources/:sessionId
 * List attached context sources for a session.
 */
router.get('/context-sources/:sessionId', (req, res) => {
  try {
    const sources = getContextSources(req.params.sessionId);
    res.json({ sources });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/notion/context-sources
 * Attach a Notion page as context source for a session.
 */
router.post('/context-sources', (req, res) => {
  try {
    const { sessionId, sourceId, sourceLabel } = req.body;
    if (!sessionId || !sourceId || !sourceLabel) {
      return res.status(400).json({ error: 'sessionId, sourceId, and sourceLabel are required' });
    }

    const source = addContextSource(sessionId, 'notion_page', sourceId, sourceLabel, 'user');
    res.json({ source });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/notion/context-sources/:id
 * Detach a context source.
 */
router.delete('/context-sources/:id', (req, res) => {
  try {
    removeContextSource(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/notion/writes
 * List Notion write records. Supports ?sessionId= filter.
 */
router.get('/writes', (req, res) => {
  try {
    const { sessionId } = req.query as { sessionId?: string };
    const writes = getNotionWrites(sessionId);
    res.json({ writes });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
