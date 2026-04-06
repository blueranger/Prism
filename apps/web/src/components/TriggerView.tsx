'use client';

import { useEffect, useMemo, useState } from 'react';
import type { TriggerCandidate, TriggerNotification, TriggerRule, TriggerRun } from '@prism/shared';
import {
  acceptTriggerCandidateApi,
  fetchTriggers,
  rejectTriggerCandidateApi,
  resetTriggersApi,
  scanTriggersApi,
  sendTestNotificationApi,
  snoozeTriggerCandidateApi,
} from '@/lib/api';

type TriggerTab = 'candidates' | 'scheduled' | 'history' | 'notifications';

export default function TriggerView() {
  const [tab, setTab] = useState<TriggerTab>('candidates');
  const [candidates, setCandidates] = useState<TriggerCandidate[]>([]);
  const [rules, setRules] = useState<TriggerRule[]>([]);
  const [history, setHistory] = useState<TriggerRun[]>([]);
  const [notifications, setNotifications] = useState<TriggerNotification[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = async () => {
    const data = await fetchTriggers();
    setCandidates(data.candidates);
    setRules(data.rules);
    setHistory(data.history);
    setNotifications(data.notifications);
    setSelectedId((prev) => prev ?? data.candidates[0]?.id ?? data.rules[0]?.id ?? data.history[0]?.id ?? null);
  };

  useEffect(() => {
    void load();
  }, []);

  const list = useMemo(() => {
    switch (tab) {
      case 'scheduled':
        return rules;
      case 'history':
        return history;
      case 'notifications':
        return notifications;
      default:
        return candidates;
    }
  }, [tab, candidates, rules, history, notifications]);

  const selected = list.find((item: any) => item.id === selectedId) ?? null;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-gray-300">Trigger Workspace</h2>
        <span className="text-[11px] text-gray-500">{candidates.length} candidates · {rules.length} scheduled · {history.length} history</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={async () => {
              const created = await scanTriggersApi();
              setFlash(created.length > 0 ? `Generated ${created.length} trigger candidate${created.length === 1 ? '' : 's'}.` : 'No new triggers were generated.');
              await load();
            }}
            className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-200 hover:bg-gray-800"
          >
            Scan Triggers
          </button>
          <button
            onClick={async () => {
              const notification = await sendTestNotificationApi();
              setFlash(notification ? 'Test notification created.' : 'Failed to create test notification.');
              await load();
            }}
            className="rounded border border-indigo-700 px-2 py-1 text-xs text-indigo-200 hover:bg-indigo-950/30"
          >
            Send Test Notification
          </button>
          <button
            onClick={async () => {
              if (!window.confirm('Reset all trigger candidates, rules, runs, and notifications?')) return;
              const ok = await resetTriggersApi();
              setFlash(ok ? 'All triggers were cleared.' : 'Failed to reset triggers.');
              await load();
            }}
            className="rounded border border-rose-700 px-2 py-1 text-xs text-rose-200 hover:bg-rose-950/30"
          >
            Reset Triggers
          </button>
        </div>
      </div>

      {flash && (
        <div className="rounded-lg border border-emerald-800/80 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-200">
          {flash}
        </div>
      )}

      <div className="flex-1 min-h-0 flex gap-3">
        <div className="w-72 flex-shrink-0 min-h-0 flex flex-col rounded-lg border border-gray-800 bg-gray-900">
          <div className="border-b border-gray-800 p-3">
            <div className="flex flex-wrap gap-1">
              {[
                ['candidates', 'Candidates'],
                ['scheduled', 'Scheduled'],
                ['history', 'History'],
                ['notifications', 'Notifications'],
              ].map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setTab(id as TriggerTab)}
                  className={`rounded px-2 py-1 text-[11px] ${tab === id ? 'bg-gray-700 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
            {list.length === 0 ? (
              <div className="p-3 text-xs text-gray-500">Nothing here yet.</div>
            ) : (
              list.map((item: any) => (
                <button
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  className={`w-full rounded border px-3 py-2 text-left ${selectedId === item.id ? 'border-indigo-700 bg-indigo-950/20' : 'border-gray-800 bg-gray-950/30 hover:border-gray-700'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-gray-200">{item.title}</span>
                    <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">{item.triggerType ?? item.status ?? item.channel}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-gray-400 line-clamp-2">{item.summary ?? item.body ?? ''}</p>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 rounded-lg border border-gray-800 bg-gray-900 p-4 overflow-y-auto">
          {!selected ? (
            <div className="text-sm text-gray-500">Select a trigger item to inspect it.</div>
          ) : (
            <div className="space-y-4">
              <div>
                <div className="text-sm font-semibold text-gray-100">{(selected as any).title}</div>
                <div className="mt-1 text-xs text-gray-400">{(selected as any).summary ?? (selected as any).body}</div>
              </div>
              {'action' in (selected as any) && (selected as any).action ? (
                <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-3 text-xs text-gray-300">
                  <div className="font-medium text-gray-200">Proposed action</div>
                  <div className="mt-1">{(selected as any).action.label}</div>
                  <div className="mt-1 text-gray-500">Type: {(selected as any).action.type}</div>
                </div>
              ) : null}
              {'deliveryChannel' in (selected as any) ? (
                <div className="text-xs text-gray-500">Delivery channel: {(selected as any).deliveryChannel}</div>
              ) : null}
              {'triggerAt' in (selected as any) && (selected as any).triggerAt ? (
                <div className="text-xs text-gray-500">Trigger at: {new Date((selected as any).triggerAt).toLocaleString()}</div>
              ) : null}

              {'action' in (selected as any) ? (
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      const result = await acceptTriggerCandidateApi((selected as any).id);
                      setFlash(result ? 'Trigger accepted and scheduled.' : 'Failed to accept trigger.');
                      await load();
                    }}
                    className="rounded border border-emerald-700 px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-950/30"
                  >
                    Accept
                  </button>
                  <button
                    onClick={async () => {
                      const ok = await rejectTriggerCandidateApi((selected as any).id);
                      setFlash(ok ? 'Trigger rejected.' : 'Failed to reject trigger.');
                      await load();
                    }}
                    className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-200 hover:bg-gray-800"
                  >
                    Reject
                  </button>
                  <button
                    onClick={async () => {
                      const result = await snoozeTriggerCandidateApi((selected as any).id);
                      setFlash(result ? 'Trigger snoozed for one day.' : 'Failed to snooze trigger.');
                      await load();
                    }}
                    className="rounded border border-amber-700 px-2 py-1 text-xs text-amber-200 hover:bg-amber-950/30"
                  >
                    Snooze
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
