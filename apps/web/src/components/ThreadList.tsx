'use client';

import { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { fetchConnectors } from '@/lib/api';
import ManualThreadCreator from './ManualThreadCreator';
import type { ExternalThread, CommProvider, ConnectorStatus } from '@prism/shared';

const PROVIDER_ICONS: Record<CommProvider, string> = {
  outlook: '\u{1F4E7}',
  teams: '\u{1F4AC}',
  line: '\u{1F7E2}',
  notion: '\u{1F4C4}',
  manual: '\u{270F}\u{FE0F}',
};

interface AccountGroup {
  accountId: string;
  label: string;
  icon: string;
  threads: ExternalThread[];
  hasError: boolean;
}

function groupByAccount(
  threads: ExternalThread[],
  connectors: ConnectorStatus[]
): AccountGroup[] {
  // Build thread groups from actual threads
  const threadsByAccount = new Map<string, ExternalThread[]>();

  for (const t of threads) {
    const key = t.accountId || '__unknown__';
    const group = threadsByAccount.get(key);
    if (group) {
      group.push(t);
    } else {
      threadsByAccount.set(key, [t]);
    }
  }

  // Build a lookup: provider → first connector accountId (for merging orphans)
  const connectorByProvider = new Map<string, string>();
  for (const c of connectors) {
    if (!connectorByProvider.has(c.provider)) {
      connectorByProvider.set(c.provider, c.accountId);
    }
  }

  // Start with all connected accounts (ensures zero-thread accounts appear)
  const result: AccountGroup[] = [];
  const seen = new Set<string>();
  const groupIndex = new Map<string, number>(); // accountId → index in result

  for (const c of connectors) {
    seen.add(c.accountId);
    const provider = c.provider;
    const icon = PROVIDER_ICONS[provider] ?? '\u{1F517}';
    const label = c.email ?? c.displayName ?? c.displayLabel ?? provider.charAt(0).toUpperCase() + provider.slice(1);
    const accountThreads = threadsByAccount.get(c.accountId) ?? [];
    const hasError = !!(c.lastSyncError);

    groupIndex.set(c.accountId, result.length);
    result.push({ accountId: c.accountId, label, icon, threads: accountThreads, hasError });
  }

  // Merge orphaned threads into matching provider's connector group
  for (const [accountId, threadList] of threadsByAccount) {
    if (seen.has(accountId)) continue;

    const provider = threadList[0]?.provider ?? 'outlook';
    const targetAccountId = connectorByProvider.get(provider);

    if (targetAccountId !== undefined) {
      // Merge into the existing connector group for this provider
      const idx = groupIndex.get(targetAccountId)!;
      result[idx].threads = [...result[idx].threads, ...threadList];
    }
    // Drop orphans with no matching connector — they're from disconnected accounts
  }

  return result;
}

function formatTime(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function ThreadList() {
  const threads = useChatStore((s) => s.commThreads);
  const connectors = useChatStore((s) => s.commConnectors);
  const setConnectors = useChatStore((s) => s.setCommConnectors);
  const selectedId = useChatStore((s) => s.commSelectedThreadId);
  const setSelectedId = useChatStore((s) => s.setCommSelectedThreadId);
  const setConnectorSetupOpen = useChatStore((s) => s.setCommConnectorSetupOpen);
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  const [showNewThread, setShowNewThread] = useState(false);

  // Check if any manual connector is active
  const manualAccounts = useMemo(
    () => connectors.filter((c) => c.provider === 'manual'),
    [connectors]
  );

  // Refresh connector statuses on mount (run once)
  useEffect(() => {
    fetchConnectors().then((c) => useChatStore.getState().setCommConnectors(c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = useMemo(() => groupByAccount(threads, connectors), [threads, connectors]);

  // Default all accounts to collapsed on first load,
  // but auto-expand the group containing the selected thread
  useEffect(() => {
    if (groups.length === 0) return;

    if (collapsed === null) {
      // First load: collapse all, except the group containing the selected thread
      const allIds = new Set(groups.map((g) => g.accountId));
      if (selectedId) {
        const selectedGroup = groups.find((g) => g.threads.some((t) => t.id === selectedId));
        if (selectedGroup) allIds.delete(selectedGroup.accountId);
      }
      setCollapsed(allIds);
    } else if (selectedId) {
      // Subsequent selection: auto-expand the group containing the selected thread
      const selectedGroup = groups.find((g) => g.threads.some((t) => t.id === selectedId));
      if (selectedGroup && collapsed.has(selectedGroup.accountId)) {
        setCollapsed((prev) => {
          const next = new Set(prev);
          next.delete(selectedGroup.accountId);
          return next;
        });
      }
    }
  }, [groups, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps
  console.log('[ThreadList] threads:', threads.length, 'connectors:', connectors.length, 'groups:', groups.length);

  const toggleCollapse = (accountId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev ?? groups.map((g) => g.accountId));
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto space-y-1">
        {groups.length === 0 && (
          <div className="text-center py-8">
            <p className="text-sm text-gray-500 mb-3">No threads yet.</p>
            <p className="text-xs text-gray-600">Connect an account to get started.</p>
          </div>
        )}

        {groups.map((group) => {
          const isCollapsed = collapsed === null || collapsed.has(group.accountId);
          const threadCount = group.threads.length;

          return (
            <div key={group.accountId}>
              <button
                onClick={() => toggleCollapse(group.accountId)}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-gray-800/50 transition-colors group"
              >
                <span className="text-[10px] text-gray-600 w-3 text-center transition-transform" style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>
                  &#9660;
                </span>
                <span className="text-sm">{group.icon}</span>
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider truncate">
                  {group.label}
                </span>
                <span className="text-[10px] text-gray-600 ml-auto shrink-0">
                  {threadCount > 0 ? threadCount : ''}
                </span>
              </button>

              {!isCollapsed && (
                <>
                  {group.threads.length === 0 && (
                    <p className={`text-xs px-6 py-2 ${group.hasError ? 'text-red-400' : 'text-gray-600'}`}>
                      {group.hasError
                        ? 'Sync failed \u2014 check connector status'
                        : 'No threads yet'}
                    </p>
                  )}

                  <div className="space-y-0.5 ml-3">
                    {group.threads.map((thread) => (
                      <button
                        key={thread.id}
                        onClick={() => setSelectedId(thread.id)}
                        className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                          selectedId === thread.id
                            ? 'bg-indigo-600/20 border border-indigo-500/30'
                            : 'hover:bg-gray-800 border border-transparent'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-gray-200 truncate">
                              {thread.senderName ?? thread.displayName}
                            </p>
                            <p className="text-xs text-gray-500 truncate">
                              {thread.subject ?? thread.displayName}
                            </p>
                          </div>
                          <div className="flex flex-col items-end gap-1 shrink-0">
                            <span className="text-[10px] text-gray-600">
                              {formatTime(thread.lastMessageAt)}
                            </span>
                            {thread.messageCount > 0 && (
                              <span className="text-[10px] text-gray-600">
                                {thread.messageCount}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom actions */}
      <div className="mt-3 pt-3 border-t border-gray-800 space-y-2">
        {manualAccounts.length > 0 && (
          <button
            onClick={() => setShowNewThread(true)}
            className="w-full text-left text-xs px-3 py-2 rounded-lg text-indigo-400 hover:text-indigo-300 hover:bg-gray-800 transition-colors font-medium"
          >
            + New Thread
          </button>
        )}
        <button
          onClick={() => setConnectorSetupOpen(true)}
          className="w-full text-left text-xs px-3 py-2 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
        >
          Connect Account
        </button>
      </div>

      {/* Manual Thread Creator Modal */}
      {showNewThread && manualAccounts.length > 0 && (
        <ManualThreadCreator
          accounts={manualAccounts}
          onClose={() => setShowNewThread(false)}
          onCreated={(thread) => {
            setShowNewThread(false);
            // Refresh threads and select the new one
            const store = useChatStore.getState();
            store.setCommThreads([thread, ...threads]);
            store.setCommSelectedThreadId(thread.id);
          }}
        />
      )}
    </div>
  );
}
