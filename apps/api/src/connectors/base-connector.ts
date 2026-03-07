import type {
  CommProvider,
  ConnectorType,
  ExternalThread,
  ExternalMessage,
  ConnectorConfig,
} from '@prism/shared';
import { getDb } from '../memory/db';

/**
 * Abstract base class for all communication connectors.
 *
 * Each connector normalizes a communication platform (Outlook, Teams, Line)
 * into Prism's unified ExternalThread / ExternalMessage format.
 *
 * Connectors are stateless — OAuth tokens and config live in the `connectors` DB table.
 * The registry manages connector lifecycle and lookup.
 *
 * Multi-account: each instance is tied to one accountId (connectors.id).
 * The connectorType identifies the class of connector.
 */
export abstract class BaseConnector {
  abstract provider: CommProvider;
  abstract connectorType: ConnectorType;

  /** The unique account ID for this connector instance (connectors.id in DB) */
  accountId: string;

  /** Whether this is a local connector (no OAuth, e.g. macOS AppleScript) */
  readonly isLocal: boolean = false;

  constructor(accountId?: string) {
    // accountId is optional for type-registration template instances (no DB row yet)
    this.accountId = accountId ?? '';
  }

  /**
   * Generate the OAuth authorization URL for the user to grant access.
   */
  abstract getOAuthUrl(): string;

  /**
   * Exchange an OAuth authorization code for access + refresh tokens.
   * Persists the token set to the connectors table.
   */
  abstract exchangeCodeForToken(code: string): Promise<void>;

  /**
   * Refresh the access token using the stored refresh token.
   * Updates the connectors table with the new token set.
   */
  abstract refreshToken(): Promise<void>;

  /**
   * Disconnect the connector — revoke tokens and mark as inactive.
   */
  abstract disconnect(): Promise<void>;

  /**
   * Fetch threads (email threads, chat threads) since a given timestamp.
   * Returns normalized ExternalThread objects.
   */
  abstract fetchThreads(since?: number): Promise<ExternalThread[]>;

  /**
   * Fetch messages for a specific thread.
   * Returns normalized ExternalMessage objects ordered by timestamp.
   */
  abstract fetchThreadMessages(threadId: string, limit?: number): Promise<ExternalMessage[]>;

  /**
   * Send a reply to a thread.
   * @param threadId - The external thread ID
   * @param content - The reply content
   * @param replyToId - Optional: the specific message being replied to
   */
  abstract sendReply(threadId: string, content: string, replyToId?: string): Promise<void>;

  // --- Shared helpers for token persistence ---

  /**
   * Load the stored connector config from the database.
   * Returns null if no active connector exists for this account.
   */
  protected loadConfig(): ConnectorConfig | null {
    const db = getDb();
    const row = db.prepare(
      'SELECT config FROM connectors WHERE id = ? AND active = 1'
    ).get(this.accountId) as { config: string } | undefined;

    if (!row) return null;

    try {
      return JSON.parse(row.config) as ConnectorConfig;
    } catch {
      return null;
    }
  }

  /**
   * Save or update the connector config in the database.
   */
  protected saveConfig(config: ConnectorConfig): void {
    if (!this.accountId) {
      throw new Error('Cannot save config: accountId is empty');
    }
    const db = getDb();
    const now = Date.now();
    const configJson = JSON.stringify(config);

    const existing = db.prepare(
      'SELECT id FROM connectors WHERE id = ?'
    ).get(this.accountId) as { id: string } | undefined;

    if (existing) {
      db.prepare(
        'UPDATE connectors SET config = ?, active = 1, updated_at = ? WHERE id = ?'
      ).run(configJson, now, this.accountId);
    } else {
      db.prepare(
        'INSERT INTO connectors (id, provider, connector_type, config, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)'
      ).run(this.accountId, this.provider, this.connectorType, configJson, now, now);
    }
  }

  /**
   * Deactivate the connector record in the database.
   */
  protected deactivateConfig(): void {
    const db = getDb();
    db.prepare(
      'UPDATE connectors SET active = 0, updated_at = ? WHERE id = ?'
    ).run(Date.now(), this.accountId);
  }

  /**
   * Check if the stored access token is expired (or will expire within bufferMs).
   */
  protected isTokenExpired(config: ConnectorConfig, bufferMs: number = 5 * 60 * 1000): boolean {
    return Date.now() >= config.expiresAt - bufferMs;
  }

  /**
   * Ensure we have a valid (non-expired) access token.
   * Automatically refreshes if needed.
   * Throws if no config exists or refresh fails.
   */
  protected async ensureValidToken(): Promise<ConnectorConfig> {
    const config = this.loadConfig();
    if (!config) {
      throw new Error(`No active connector configured for account ${this.accountId}`);
    }

    if (this.isTokenExpired(config)) {
      await this.refreshToken();
      const refreshed = this.loadConfig();
      if (!refreshed) {
        throw new Error(`Failed to refresh token for account ${this.accountId}`);
      }
      return refreshed;
    }

    return config;
  }
}
