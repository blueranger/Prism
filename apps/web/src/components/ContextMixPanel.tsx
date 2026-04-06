'use client';

import { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { MODELS } from '@prism/shared';

const CATEGORY_COLORS: Record<string, string> = {
  current_prompt: 'bg-indigo-500',
  recent_messages: 'bg-cyan-500',
  older_messages: 'bg-slate-400',
  older_summary: 'bg-slate-500',
  omission_note: 'bg-slate-600',
  attached_sources: 'bg-emerald-500',
  uploaded_files: 'bg-amber-500',
  linked_sessions: 'bg-violet-500',
  action_context: 'bg-pink-500',
  handoff: 'bg-orange-500',
  decision_memory: 'bg-fuchsia-500',
  url_context: 'bg-sky-500',
  attachment_manifest: 'bg-lime-500',
};

function formatPct(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0%';
  return `${Math.max(1, Math.round(value))}%`;
}

function formatTokens(value: number): string {
  return `${value.toLocaleString()} tok`;
}

const STATUS_CLASSES: Record<string, string> = {
  full: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50',
  summary: 'bg-amber-900/40 text-amber-300 border-amber-700/50',
  omitted: 'bg-slate-800 text-slate-300 border-slate-700',
};

const REASON_LABELS: Record<string, string> = {
  included: 'Sent in full',
  truncated_to_budget: 'Sent as summary',
  budget_exhausted: 'Not sent: budget exhausted',
  lower_priority_than_newer_sources: 'Not sent: lower priority',
  not_ready: 'Not sent: not ready',
};

export default function ContextMixPanel() {
  const lastContextDebug = useChatStore((s) => s.lastContextDebug);
  const [collapsed, setCollapsed] = useState(false);
  const rows = useMemo(() => Object.values(lastContextDebug ?? {}), [lastContextDebug]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('prism_contextMixCollapsed');
      setCollapsed(stored === 'true');
    } catch {
      setCollapsed(false);
    }
  }, []);

  const summary = useMemo(() => {
    const topItems = new Map<string, { label: string; tokens: number }>();
    for (const row of rows) {
      const top = row.breakdown[0];
      if (!top) continue;
      const existing = topItems.get(top.key);
      if (existing) {
        existing.tokens += top.tokens;
      } else {
        topItems.set(top.key, { label: top.label, tokens: top.tokens });
      }
    }
    const winner = Array.from(topItems.values()).sort((a, b) => b.tokens - a.tokens)[0];
    return winner ? `${winner.label} is the largest share right now` : 'No context data yet';
  }, [rows]);

  if (!lastContextDebug || rows.length === 0) {
    return null;
  }

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem('prism_contextMixCollapsed', String(next));
    } catch {}
  };

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/70">
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-gray-200">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">Context Mix</span>
            <span className="text-xs text-gray-500">See what each request actually sent</span>
          </div>
          <div className="mt-1 text-xs text-gray-500">
            {summary} · {rows.length} model{rows.length === 1 ? '' : 's'}
          </div>
        </div>
        <button
          type="button"
          onClick={toggleCollapsed}
          className="shrink-0 rounded border border-gray-700 px-2.5 py-1 text-xs text-gray-300 transition-colors hover:border-gray-600 hover:text-white"
        >
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>

      {!collapsed && (
        <div className="space-y-3 border-t border-gray-800 px-4 py-3">
        {rows.map((info) => {
          const total = Math.max(info.totalTokens, 1);
          const fullDocs = info.documents.filter((doc) => doc.status === 'full');
          const summaryDocs = info.documents.filter((doc) => doc.status === 'summary');
          const omittedDocs = info.documents.filter((doc) => doc.status === 'omitted');
          return (
            <div key={info.model} className="rounded-lg border border-gray-800 bg-gray-950/60 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-gray-100">
                    {MODELS[info.model]?.displayName ?? info.model}
                  </div>
                  <div className="text-xs text-gray-500">
                    Total {formatTokens(info.totalTokens)} · Context {formatTokens(info.contextTokens)} · Prompt {formatTokens(info.promptTokens)}
                  </div>
                </div>
                <div className="text-right text-xs text-gray-500">
                  <div>Budget {formatTokens(info.budget.available)}</div>
                  <div>{formatPct((info.totalTokens / Math.max(info.budget.available, 1)) * 100)} used</div>
                </div>
              </div>

              <div className="mb-3 flex h-2 overflow-hidden rounded-full bg-gray-800">
                {info.breakdown.map((item) => (
                  <div
                    key={item.key}
                    className={CATEGORY_COLORS[item.key] ?? 'bg-gray-500'}
                    style={{ width: `${(item.tokens / total) * 100}%` }}
                    title={`${item.label}: ${formatTokens(item.tokens)}`}
                  />
                ))}
              </div>

              <div className="grid gap-2 md:grid-cols-2">
                {info.breakdown.map((item) => {
                  const pct = (item.tokens / total) * 100;
                  return (
                    <div key={item.key} className="flex items-center justify-between gap-3 rounded border border-gray-800 bg-gray-900/70 px-2.5 py-2 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${CATEGORY_COLORS[item.key] ?? 'bg-gray-500'}`} />
                        <span className="truncate text-gray-200">{item.label}</span>
                        {item.count ? <span className="shrink-0 text-gray-500">×{item.count}</span> : null}
                      </div>
                      <div className="shrink-0 text-right text-gray-400">
                        <div>{formatPct(pct)}</div>
                        <div>{formatTokens(item.tokens)}</div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {info.memoryInjection && (
                <div className="mt-3 rounded-lg border border-gray-800 bg-gray-900/50 p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="text-xs font-medium text-gray-200">Memory Injection</div>
                    <div className="text-[11px] text-gray-500">
                      Retrieved {info.memoryInjection.retrievedItems.length} · Injected {info.memoryInjection.injectedItems.length} · Omitted {info.memoryInjection.omittedItems.length}
                    </div>
                  </div>

                  <div className="mb-3">
                    <div className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">Injected</div>
                    {info.memoryInjection.injectedItems.length === 0 ? (
                      <div className="rounded border border-dashed border-gray-800 px-2.5 py-2 text-[11px] text-gray-600">None</div>
                    ) : (
                      <div className="space-y-2">
                        {info.memoryInjection.injectedItems.slice(0, 8).map((item, idx) => (
                          <div key={`${info.model}-injected-${item.memoryItemId ?? idx}`} className="rounded border border-gray-800 bg-gray-950/80 px-2.5 py-2 text-xs">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="rounded border border-gray-700 bg-gray-900 px-1.5 py-0.5 text-[10px] text-gray-300">
                                {item.memoryType}
                              </span>
                              <span className="text-gray-200">{item.title}</span>
                            </div>
                            <div className="mt-1 text-[11px] text-gray-400">{item.summary}</div>
                            {item.reason ? <div className="mt-1 text-[11px] text-gray-500">Reason: {item.reason}</div> : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">Omitted</div>
                    {info.memoryInjection.omittedItems.length === 0 ? (
                      <div className="rounded border border-dashed border-gray-800 px-2.5 py-2 text-[11px] text-gray-600">None</div>
                    ) : (
                      <div className="space-y-2">
                        {info.memoryInjection.omittedItems.slice(0, 8).map((item, idx) => (
                          <div key={`${info.model}-omitted-${item.memoryItemId ?? idx}`} className="rounded border border-gray-800 bg-gray-950/80 px-2.5 py-2 text-xs">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="rounded border border-gray-700 bg-gray-900 px-1.5 py-0.5 text-[10px] text-gray-300">
                                {item.memoryType}
                              </span>
                              <span className="text-gray-200">{item.title}</span>
                            </div>
                            <div className="mt-1 text-[11px] text-gray-400">{item.summary}</div>
                            {item.reason ? <div className="mt-1 text-[11px] text-gray-500">Reason: {item.reason}</div> : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {info.documents.length > 0 && (
                <div className="mt-3 rounded-lg border border-gray-800 bg-gray-900/50 p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="text-xs font-medium text-gray-200">Documents in Context</div>
                    <div className="text-[11px] text-gray-500">
                      Attached to session {info.documents.length} · Full {fullDocs.length} · Summary {summaryDocs.length} · Not sent {omittedDocs.length}
                    </div>
                  </div>

                  <div className="mb-3">
                    <div className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">Attached to session</div>
                    <div className="flex flex-wrap gap-1.5">
                      {info.documents
                        .slice()
                        .sort((a, b) => (a.priorityOrder ?? 999) - (b.priorityOrder ?? 999))
                        .map((doc) => (
                          <span
                            key={`${info.model}-attached-${doc.id}`}
                            className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-[11px] text-gray-300"
                          >
                            {doc.displayType ?? doc.sourceType} · {doc.label}
                          </span>
                        ))}
                    </div>
                  </div>

                  <div className="space-y-3">
                    {[
                      { title: 'Sent in full', items: fullDocs },
                      { title: 'Sent as summary', items: summaryDocs },
                      { title: 'Not sent', items: omittedDocs },
                    ].map((section) => (
                      <div key={`${info.model}-${section.title}`}>
                        <div className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">
                          {section.title} ({section.items.length})
                        </div>
                        {section.items.length === 0 ? (
                          <div className="rounded border border-dashed border-gray-800 px-2.5 py-2 text-[11px] text-gray-600">
                            None
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {section.items
                              .slice()
                              .sort((a, b) => (a.priorityOrder ?? 999) - (b.priorityOrder ?? 999))
                              .map((doc) => (
                                <div
                                  key={`${info.model}-${section.title}-${doc.id}`}
                                  className="rounded border border-gray-800 bg-gray-950/80 px-2.5 py-2 text-xs"
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <span className="rounded border border-gray-700 bg-gray-900 px-1.5 py-0.5 text-[10px] text-gray-300">
                                          {doc.displayType ?? doc.sourceType}
                                        </span>
                                        <span className={`rounded border px-1.5 py-0.5 text-[10px] ${STATUS_CLASSES[doc.status] ?? STATUS_CLASSES.omitted}`}>
                                          {doc.status}
                                        </span>
                                        {doc.priorityOrder ? (
                                          <span className="text-[10px] text-gray-600">#{doc.priorityOrder}</span>
                                        ) : null}
                                      </div>
                                      <div className="mt-1 break-words text-gray-200">{doc.label}</div>
                                      <div className="mt-1 text-[11px] text-gray-500">
                                        {REASON_LABELS[doc.reason] ?? doc.reason}
                                      </div>
                                    </div>
                                    <div className="shrink-0 text-right text-[11px] text-gray-500">
                                      {doc.tokens > 0 ? formatTokens(doc.tokens) : '0 tok'}
                                    </div>
                                  </div>
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        </div>
      )}
    </div>
  );
}
