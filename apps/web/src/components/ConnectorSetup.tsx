'use client';

import { useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chat-store';
import {
  fetchConnectors,
  fetchConnectorTypes,
  fetchConnectorStatus,
  fetchCommThreads,
  connectAccount,
  disconnectConnector,
  syncConnector,
  updateConnectorPersona,
  updateTriageSettings,
  setupManualConnector,
} from '@/lib/api';
import type { AccountSyncStatus } from '@/lib/api';
import type { ConnectorStatus } from '@prism/shared';
import LineChatSettings from './LineChatSettings';

const PROVIDER_ICONS: Record<string, string> = {
  outlook: '\u{1F4E7}',
  teams: '\u{1F4AC}',
  line: '\u{1F7E2}',
  manual: '\u{270F}\u{FE0F}',
};

export default function ConnectorSetup() {
  const open = useChatStore((s) => s.commConnectorSetupOpen);
  const setOpen = useChatStore((s) => s.setCommConnectorSetupOpen);
  const connectors = useChatStore((s) => s.commConnectors);
  const setConnectors = useChatStore((s) => s.setCommConnectors);
  const setThreads = useChatStore((s) => s.setCommThreads);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<{ accountId: string; ok: boolean; error?: string; threadCount?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [availableTypes, setAvailableTypes] = useState<{ connectorType: string; provider: string; isLocal: boolean; label: string }[]>([]);
  const [accountStatuses, setAccountStatuses] = useState<AccountSyncStatus[]>([]);
  const [personaEdits, setPersonaEdits] = useState<Record<string, string>>({});
  const [triageToggles, setTriageToggles] = useState<Record<string, boolean>>({});
  const [lineChatSettingsAccount, setLineChatSettingsAccount] = useState<string | null>(null);
  const [showManualSetup, setShowManualSetup] = useState(false);
  const [manualName, setManualName] = useState('');

  useEffect(() => {
    if (open) {
      setError(null);
      setSuccessMsg(null);
      setSyncResult(null);
      fetchConnectors().then(setConnectors);
      fetchConnectorTypes().then(setAvailableTypes);
      fetchConnectorStatus().then(setAccountStatuses);
    }
  }, [open, setConnectors]);

  if (!open) return null;

  const handleManualSetup = async () => {
    if (!manualName.trim()) return;
    setError(null);
    setConnecting('manual');
    const result = await setupManualConnector(manualName.trim());
    setConnecting(null);
    if (result.ok) {
      setSuccessMsg(`Manual connector "${manualName.trim()}" created`);
      setManualName('');
      setShowManualSetup(false);
      const updated = await fetchConnectors();
      setConnectors(updated);
      setAccountStatuses(await fetchConnectorStatus());
    } else {
      setError(result.error ?? 'Failed to set up manual connector');
    }
  };

  const handleConnect = async (connectorType: string) => {
    if (connectorType === 'manual') {
      setShowManualSetup(true);
      return;
    }

    setError(null);
    setSuccessMsg(null);
    setConnecting(connectorType);

    const result = await connectAccount(connectorType);
    setConnecting(null);

    if (result.error) {
      setError(result.error);
      return;
    }

    if (result.url) {
      // OAuth flow — open popup
      window.open(result.url, '_blank', 'width=600,height=700');
      // Poll for updated connectors after a short delay (user may complete OAuth)
      setTimeout(async () => {
        const updated = await fetchConnectors();
        setConnectors(updated);
        setAccountStatuses(await fetchConnectorStatus());
      }, 3000);
    } else if (result.ok) {
      // Local connector — may have connected multiple accounts
      if (result.accounts && result.accounts.length > 0) {
        const labels = result.accounts.map((a: any) => a.email || a.name).filter(Boolean);
        setSuccessMsg(`Connected ${result.accounts.length} account(s): ${labels.join(', ')}`);
      } else if (result.message) {
        setSuccessMsg(result.message);
      }
      const updated = await fetchConnectors();
      setConnectors(updated);
      setAccountStatuses(await fetchConnectorStatus());
    }
  };

  const handleDisconnect = async (accountId: string) => {
    setError(null);
    const ok = await disconnectConnector(accountId);
    if (ok) {
      const updated = await fetchConnectors();
      setConnectors(updated);
      setAccountStatuses(await fetchConnectorStatus());
      // Reload all threads (the disconnected account's threads may be removed)
      const allThreads = await fetchCommThreads();
      setThreads(allThreads);
      if (syncResult?.accountId === accountId) setSyncResult(null);
    } else {
      setError('Failed to disconnect account. Please try again.');
    }
  };

  const handleSync = async (accountId: string) => {
    setSyncing(accountId);
    setSyncResult(null);

    const result = await syncConnector(accountId);

    setSyncResult({
      accountId,
      ok: result.ok,
      error: result.error,
      threadCount: result.ok ? result.threadCount : undefined,
    });

    // Always reload ALL threads from the server (not just this account's)
    const allThreads = await fetchCommThreads();
    setThreads(allThreads);

    const updated = await fetchConnectors();
    setConnectors(updated);
    setAccountStatuses(await fetchConnectorStatus());
    setSyncing(null);
  };

  const handleRefresh = async () => {
    const updated = await fetchConnectors();
    setConnectors(updated);
    setAccountStatuses(await fetchConnectorStatus());
  };

  // Build a lookup from accountId to sync status
  const statusMap = new Map<string, AccountSyncStatus>();
  for (const s of accountStatuses) {
    statusMap.set(s.accountId, s);
  }

  function renderSyncStatus(c: ConnectorStatus) {
    const status = statusMap.get(c.accountId);

    if (!status) {
      // No status data yet — fall back to basic display
      if (c.lastSyncedAt) {
        return (
          <span className="text-gray-500">
            Last synced {new Date(c.lastSyncedAt).toLocaleTimeString()}
          </span>
        );
      }
      return <span className="text-gray-500">{
        c.provider === 'line' ? 'Connected via Chrome Extension'
        : c.provider === 'teams' ? 'Connected via Teams Web'
        : c.isLocal ? 'Connected via macOS app'
        : c.connected ? 'Connected'
        : 'Not connected'
      }</span>;
    }

    if (status.lastError) {
      return (
        <span className="text-red-400">
          Sync error: {status.lastError.length > 60 ? status.lastError.slice(0, 60) + '...' : status.lastError}
        </span>
      );
    }

    if (status.lastSyncAt) {
      return (
        <span className="text-gray-500">
          {status.threadCount} thread{status.threadCount !== 1 ? 's' : ''} &middot; synced {new Date(status.lastSyncAt).toLocaleTimeString()}
        </span>
      );
    }

    return <span className="text-gray-500">Never synced</span>;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-gray-100">Connect Accounts</h2>
          <button
            onClick={() => setOpen(false)}
            className="text-gray-500 hover:text-gray-300 text-xl leading-none"
          >
            &times;
          </button>
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 bg-red-900/30 border border-red-800/50 rounded-lg">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}

        {successMsg && (
          <div className="mb-4 px-4 py-3 bg-green-900/20 border border-green-800/50 rounded-lg">
            <p className="text-xs text-green-400">{successMsg}</p>
          </div>
        )}

        {/* Sync result feedback */}
        {syncResult && (
          <div className={`mb-4 px-4 py-3 rounded-lg border ${
            syncResult.ok
              ? 'bg-green-900/20 border-green-800/50'
              : 'bg-red-900/20 border-red-800/50'
          }`}>
            <p className={`text-xs ${syncResult.ok ? 'text-green-400' : 'text-red-400'}`}>
              {syncResult.ok
                ? `Sync complete: ${syncResult.threadCount ?? 0} thread(s) updated`
                : `Sync failed: ${syncResult.error ?? 'Unknown error'}`}
            </p>
          </div>
        )}

        {/* Connected Accounts */}
        <div className="space-y-3 mb-6">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Connected Accounts</h3>
            <button
              onClick={handleRefresh}
              className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
            >
              Refresh
            </button>
          </div>

          {connectors.length === 0 && (
            <p className="text-sm text-gray-500">No accounts connected.</p>
          )}

          {connectors.map((c: ConnectorStatus) => {
            const icon = PROVIDER_ICONS[c.provider] ?? '\u{1F517}';
            const displayName = c.email ?? c.displayName ?? c.displayLabel ?? c.provider;
            const personaValue = personaEdits[c.accountId] ?? c.persona ?? '';

            return (
              <div
                key={c.accountId}
                className="bg-gray-800 rounded-lg px-4 py-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-lg shrink-0">{icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <p className="text-sm font-medium text-gray-200 truncate">{displayName}</p>
                      {c.isLocal && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/40 text-green-400 border border-green-800/50 shrink-0">
                          Local
                        </span>
                      )}
                    </div>
                    <p className="text-xs truncate">
                      {renderSyncStatus(c)}
                    </p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {(c.provider === 'line' || c.provider === 'teams') && (
                      <button
                        onClick={() => setLineChatSettingsAccount(c.accountId)}
                        className={`text-xs px-2 py-1.5 rounded border transition-colors whitespace-nowrap ${
                          c.provider === 'teams'
                            ? 'bg-blue-900/40 hover:bg-blue-800/50 text-blue-400 border-blue-800/50'
                            : 'bg-green-900/40 hover:bg-green-800/50 text-green-400 border-green-800/50'
                        }`}
                      >
                        Chats
                      </button>
                    )}
                    <button
                      onClick={() => handleSync(c.accountId)}
                      disabled={syncing === c.accountId}
                      className="text-xs px-2 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors disabled:opacity-50 whitespace-nowrap"
                    >
                      {syncing === c.accountId ? 'Syncing...' : 'Sync'}
                    </button>
                    <button
                      onClick={() => handleDisconnect(c.accountId)}
                      className="text-xs px-2 py-1.5 rounded bg-red-900/50 hover:bg-red-800/50 text-red-400 transition-colors whitespace-nowrap"
                    >
                      &times;
                    </button>
                  </div>
                </div>
                {/* Persona textarea */}
                <textarea
                  value={personaValue}
                  onChange={(e) => setPersonaEdits((prev) => ({ ...prev, [c.accountId]: e.target.value }))}
                  onBlur={() => {
                    const val = personaEdits[c.accountId];
                    if (val !== undefined && val !== (c.persona ?? '')) {
                      updateConnectorPersona(c.accountId, val);
                    }
                  }}
                  placeholder="e.g. Product Manager at Acme Corp"
                  rows={1}
                  className="mt-2 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
                />
                {/* Auto-triage toggle */}
                <label className="flex items-center gap-2 mt-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={triageToggles[c.accountId] ?? c.triageEnabled ?? false}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setTriageToggles((prev) => ({ ...prev, [c.accountId]: enabled }));
                      updateTriageSettings(c.accountId, { triageEnabled: enabled });
                    }}
                    className="w-3.5 h-3.5 accent-indigo-500"
                  />
                  <span className="text-[11px] text-gray-400">
                    Auto-Triage (classify &amp; auto-draft incoming emails)
                  </span>
                </label>
              </div>
            );
          })}
        </div>

        {/* Add Account */}
        {availableTypes.length > 0 && (
          <div className="mb-6">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Add Account</h3>
            <div className="flex gap-2 flex-wrap">
              {availableTypes.map((t) => (
                <button
                  key={t.connectorType}
                  onClick={() => handleConnect(t.connectorType)}
                  disabled={connecting === t.connectorType}
                  className="text-xs px-3 py-2 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50"
                >
                  {connecting === t.connectorType
                    ? 'Connecting...'
                    : `+ ${t.label}`}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Manual Connector Setup Form */}
        {showManualSetup && (
          <div className="mb-6 bg-gray-800 rounded-lg px-4 py-3">
            <h3 className="text-xs font-semibold text-gray-400 mb-2">Set Up Manual Connector</h3>
            <p className="text-[10px] text-gray-500 mb-3">
              Create a local connector for managing email/message drafts manually. No external API required.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder='e.g. "My Email Drafts"'
                autoFocus
                className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleManualSetup();
                }}
              />
              <button
                onClick={handleManualSetup}
                disabled={connecting === 'manual' || !manualName.trim()}
                className="text-xs px-3 py-2 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50"
              >
                {connecting === 'manual' ? 'Creating...' : 'Create'}
              </button>
              <button
                onClick={() => setShowManualSetup(false)}
                className="text-xs px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <button
            onClick={() => setOpen(false)}
            className="text-sm px-4 py-2 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
          >
            Close
          </button>
        </div>
      </div>

      {/* LINE Chat Settings Modal */}
      {lineChatSettingsAccount && (
        <LineChatSettings
          accountId={lineChatSettingsAccount}
          onClose={() => setLineChatSettingsAccount(null)}
        />
      )}
    </div>
  );
}
