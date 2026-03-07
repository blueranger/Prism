import type { CommProvider, ConnectorStatus, ConnectorType } from '@prism/shared';
import { BaseConnector } from './base-connector';
import { getDb } from '../memory/db';

/**
 * Connector class constructor type.
 */
type ConnectorClass = new (accountId: string) => BaseConnector;

/**
 * ConnectorRegistry — manages type registration and active account instances.
 *
 * Two registries:
 * - types: Map<ConnectorType, ConnectorClass> — populated at import time by each connector module
 * - instances: Map<accountId, BaseConnector> — active account instances loaded from DB or created on connect
 */
class ConnectorRegistryImpl {
  /** Connector classes registered by type (populated at module load time) */
  private types = new Map<ConnectorType, ConnectorClass>();

  /** Active connector instances keyed by accountId */
  private instances = new Map<string, BaseConnector>();

  // --- Type registration ---

  /**
   * Register a connector class for a given type.
   * Called at import time by each connector module.
   */
  registerType(type: ConnectorType, cls: ConnectorClass): void {
    this.types.set(type, cls);
  }

  /**
   * Get all available connector types with metadata.
   */
  getAvailableTypes(): { connectorType: ConnectorType; provider: CommProvider; isLocal: boolean; label: string }[] {
    const result: { connectorType: ConnectorType; provider: CommProvider; isLocal: boolean; label: string }[] = [];

    for (const [type, cls] of this.types) {
      // Create a throwaway instance to read provider/isLocal
      const tmp = new cls('__probe__');
      result.push({
        connectorType: type,
        provider: tmp.provider,
        isLocal: tmp.isLocal,
        label: tmp.provider === 'line'
          ? 'LINE (Chrome Extension)'
          : tmp.provider === 'notion'
            ? 'Notion (OAuth)'
          : tmp.provider === 'manual'
            ? 'Manual (Local)'
          : tmp.isLocal
            ? `Local ${tmp.provider.charAt(0).toUpperCase() + tmp.provider.slice(1)} (macOS)`
            : `${tmp.provider.charAt(0).toUpperCase() + tmp.provider.slice(1)} (M365)`,
      });
    }

    return result;
  }

  // --- Instance management ---

  /**
   * Create a new connector instance for a given type and accountId.
   * Registers it in the instance map.
   */
  createInstance(type: ConnectorType, accountId: string): BaseConnector {
    const cls = this.types.get(type);
    if (!cls) {
      throw new Error(`No connector class registered for type: ${type}`);
    }
    const instance = new cls(accountId);
    this.instances.set(accountId, instance);
    return instance;
  }

  /**
   * Get a connector instance by accountId.
   */
  get(accountId: string): BaseConnector | undefined {
    return this.instances.get(accountId);
  }

  /**
   * Get a connector instance by accountId, throwing if not found.
   */
  getOrThrow(accountId: string): BaseConnector {
    const instance = this.instances.get(accountId);
    if (!instance) {
      throw new Error(`No active connector instance for account: ${accountId}`);
    }
    return instance;
  }

  /**
   * Remove a connector instance (e.g. on disconnect).
   */
  removeInstance(accountId: string): void {
    this.instances.delete(accountId);
  }

  /**
   * Get all active connector instances for a given provider.
   */
  getByProvider(provider: CommProvider): BaseConnector[] {
    const result: BaseConnector[] = [];
    for (const instance of this.instances.values()) {
      if (instance.provider === provider) {
        result.push(instance);
      }
    }
    return result;
  }

  /**
   * List all active account IDs.
   */
  listAccountIds(): string[] {
    return Array.from(this.instances.keys());
  }

  /**
   * Get the status of all active connector accounts.
   */
  getStatuses(): ConnectorStatus[] {
    const db = getDb();
    const statuses: ConnectorStatus[] = [];

    for (const [accountId, instance] of this.instances) {
      const row = db.prepare(
        'SELECT active, display_name, email, connector_type, persona, triage_enabled FROM connectors WHERE id = ?'
      ).get(accountId) as { active: number; display_name: string | null; email: string | null; connector_type: string | null; persona: string | null; triage_enabled: number | null } | undefined;

      const syncRow = db.prepare(
        'SELECT MAX(last_synced_at) as last_synced FROM external_threads WHERE account_id = ?'
      ).get(accountId) as { last_synced: number | null } | undefined;

      statuses.push({
        accountId,
        provider: instance.provider,
        connectorType: instance.connectorType,
        connected: !!row?.active,
        active: !!row?.active,
        lastSyncedAt: syncRow?.last_synced ?? null,
        isLocal: instance.isLocal,
        displayLabel: instance.provider === 'line'
          ? 'LINE (Chrome Extension)'
          : instance.provider === 'manual'
            ? 'Manual (Local)'
          : instance.isLocal
            ? 'Local Outlook (macOS)'
            : undefined,
        displayName: row?.display_name ?? null,
        email: row?.email ?? null,
        persona: row?.persona ?? null,
        triageEnabled: row?.triage_enabled === 1,
      });
    }

    return statuses;
  }

  /**
   * Restore all active connectors from DB at startup.
   * Creates instances for each active connector row.
   */
  restoreFromDb(): void {
    const db = getDb();
    const rows = db.prepare(
      'SELECT id, provider, connector_type FROM connectors WHERE active = 1'
    ).all() as { id: string; provider: string; connector_type: string | null }[];

    for (const row of rows) {
      if (!row.id) {
        console.warn('[registry] Skipping connector row with empty id');
        continue;
      }

      const connectorType = row.connector_type as ConnectorType | null;
      if (!connectorType) {
        // Legacy row without connector_type — try to infer from provider
        const inferredType = this.inferType(row.provider);
        if (inferredType && this.types.has(inferredType)) {
          this.createInstance(inferredType, row.id);
          // Backfill connector_type
          db.prepare('UPDATE connectors SET connector_type = ? WHERE id = ?').run(inferredType, row.id);
        }
        continue;
      }

      if (this.types.has(connectorType)) {
        this.createInstance(connectorType, row.id);
      } else {
        console.warn(`[registry] Unknown connector_type "${connectorType}" for account ${row.id}, skipping`);
      }
    }

    console.log(`[registry] Restored ${this.instances.size} active connector(s) from DB`);
  }

  /**
   * Infer connector type from provider string for legacy data.
   */
  private inferType(provider: string): ConnectorType | null {
    switch (provider) {
      case 'outlook': return 'outlook-oauth';
      case 'teams': return 'teams';
      case 'line': return 'line';
      case 'notion': return 'notion-internal';
      case 'manual': return 'manual';
      default: return null;
    }
  }
}

export const ConnectorRegistry = new ConnectorRegistryImpl();
