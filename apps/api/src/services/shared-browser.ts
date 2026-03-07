/**
 * SharedBrowserManager — manages a single Puppeteer connection to Chrome
 * shared by all local connectors (LINE, Teams, etc.).
 *
 * Solves the problem of multiple connectors competing for the same
 * Chrome instance on port 9222. Each connector gets its own Page (tab),
 * but they share one Browser connection.
 *
 * Usage:
 *   const page = await sharedBrowser.getOrCreatePage('teams', 'https://teams.microsoft.com');
 *   const page = await sharedBrowser.getOrCreatePage('line', LINE_CHATS_URL);
 */

import puppeteer, { type Browser, type Page } from 'puppeteer-core';

const CHROME_DEBUG_URL = 'http://127.0.0.1:9222';

class SharedBrowserManager {
  private browser: Browser | null = null;
  private pages = new Map<string, Page>();
  private connecting = false;

  /**
   * Connect to Chrome via remote debugging (or return existing connection).
   */
  async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    // Avoid concurrent connect attempts
    if (this.connecting) {
      await this.waitForConnection();
      if (this.browser && this.browser.isConnected()) return this.browser;
    }

    this.connecting = true;
    try {
      console.log(`[shared-browser] Connecting to Chrome at ${CHROME_DEBUG_URL}...`);
      this.browser = await puppeteer.connect({
        browserURL: CHROME_DEBUG_URL,
        defaultViewport: null,
      });

      // Clean up on disconnect
      this.browser.on('disconnected', () => {
        console.log('[shared-browser] Chrome disconnected');
        this.browser = null;
        this.pages.clear();
      });

      console.log('[shared-browser] Connected to Chrome');
      return this.browser;
    } catch (err: any) {
      throw new Error(
        `Cannot connect to Chrome. Launch it with:\n` +
        `  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome ` +
        `--remote-debugging-port=9222 --user-data-dir="$HOME/prism-chrome-profile"\n` +
        `Error: ${err.message}`
      );
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Get or create a page (tab) for a specific connector.
   *
   * If the page already exists and is alive, returns it.
   * If a matching existing tab is found in Chrome, reuses it.
   * Otherwise, creates a new tab and navigates to the URL.
   *
   * @param key - Unique identifier for the connector ('line', 'teams', etc.)
   * @param matchUrl - URL pattern to find an existing tab (e.g., 'teams.microsoft.com')
   * @param navigateUrl - URL to navigate to if creating a new tab
   */
  async getOrCreatePage(key: string, matchUrl?: string, navigateUrl?: string): Promise<Page> {
    // Return cached page if alive
    const existing = this.pages.get(key);
    if (existing && !existing.isClosed()) {
      return existing;
    }

    const browser = await this.getBrowser();

    // Search for an existing matching tab
    if (matchUrl) {
      const pages = await browser.pages();
      for (const p of pages) {
        try {
          const url = p.url();
          if (url.includes(matchUrl)) {
            console.log(`[shared-browser] Found existing tab for "${key}": ${url}`);
            this.pages.set(key, p);
            return p;
          }
        } catch {
          // Page might have been closed
        }
      }
    }

    // Create new tab
    const page = await browser.newPage();
    this.pages.set(key, page);

    if (navigateUrl) {
      console.log(`[shared-browser] Navigating "${key}" to ${navigateUrl}`);
      try {
        await page.goto(navigateUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch {
        // SPA may not fire standard load events
      }
    }

    return page;
  }

  /**
   * Get an existing page (tab) without creating one.
   * Returns null if the page doesn't exist or has been closed.
   */
  getPage(key: string): Page | null {
    const page = this.pages.get(key);
    if (page && !page.isClosed()) return page;
    this.pages.delete(key);
    return null;
  }

  /**
   * Check if a page is alive.
   */
  isPageAlive(key: string): boolean {
    const page = this.pages.get(key);
    return !!page && !page.isClosed();
  }

  /**
   * Close a specific page (tab).
   */
  async closePage(key: string): Promise<void> {
    const page = this.pages.get(key);
    if (page && !page.isClosed()) {
      await page.close();
    }
    this.pages.delete(key);
    console.log(`[shared-browser] Closed page "${key}"`);
  }

  /**
   * Check if browser is connected.
   */
  isConnected(): boolean {
    return !!this.browser && this.browser.isConnected();
  }

  /**
   * Disconnect all pages (but don't close Chrome itself).
   */
  async disconnectAll(): Promise<void> {
    for (const [key, page] of this.pages) {
      try {
        if (!page.isClosed()) await page.close();
      } catch {
        // Ignore
      }
    }
    this.pages.clear();
    this.browser = null;
    console.log('[shared-browser] Disconnected all');
  }

  // --- Internal ---

  private waitForConnection(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.connecting) return resolve();
        setTimeout(check, 100);
      };
      check();
    });
  }
}

/** Singleton shared browser instance */
export const sharedBrowser = new SharedBrowserManager();
