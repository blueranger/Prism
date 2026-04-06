'use client';

import { useEffect, useMemo, useState } from 'react';
import type { MemoryCandidate, MemoryExtractionRun, MemoryExtractionRunItem, MemoryItem, MemoryTimelineEvent, MemoryType, MemoryUsageRun, WorkingMemoryItem } from '@prism/shared';
import {
  archiveMemoryItemApi,
  confirmMemoryCandidateApi,
  extractSessionMemory,
  fetchMemory,
  fetchMemoryExtractionRuns,
  fetchMemoryExtractionRunItems,
  fetchMemoryGraph,
  fetchMemoryItem,
  fetchMemoryReviewQueue,
  fetchMemoryTimeline,
  fetchMemoryUsageRuns,
  fetchWorkingMemory,
  rejectMemoryCandidateApi,
  resetMemoryApi,
} from '@/lib/api';
import { useChatStore } from '@/stores/chat-store';

type MemoryFilter = MemoryType | 'all' | 'review';

const FILTERS: Array<{ id: MemoryFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'profile', label: 'Profile' },
  { id: 'relationship', label: 'Relationships' },
  { id: 'situation', label: 'Situations' },
  { id: 'event', label: 'Timeline' },
  { id: 'claim', label: 'Claims' },
  { id: 'review', label: 'Review Queue' },
];

export default function MemoryView() {
  const sessionId = useChatStore((s) => s.sessionId);
  const [filter, setFilter] = useState<MemoryFilter>(() => {
    try {
      return sessionStorage.getItem('prism:memory:focus-candidates') ? 'review' : 'all';
    } catch {
      return 'all';
    }
  });
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [reviewQueue, setReviewQueue] = useState<MemoryCandidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<MemoryItem | null>(null);
  const [graph, setGraph] = useState<{ nodes: any[]; edges: any[] }>({ nodes: [], edges: [] });
  const [timeline, setTimeline] = useState<MemoryTimelineEvent[]>([]);
  const [workingMemory, setWorkingMemory] = useState<WorkingMemoryItem[]>([]);
  const [extractionRuns, setExtractionRuns] = useState<MemoryExtractionRun[]>([]);
  const [extractionRunItems, setExtractionRunItems] = useState<Record<string, MemoryExtractionRunItem[]>>({});
  const [usageRuns, setUsageRuns] = useState<MemoryUsageRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [flashMessage, setFlashMessage] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [memory, queue, graphData, timelineData, working, extraction, usage] = await Promise.all([
        fetchMemory({ type: filter !== 'all' && filter !== 'review' ? filter : 'all', search }),
        fetchMemoryReviewQueue(),
        fetchMemoryGraph(),
        fetchMemoryTimeline(),
        fetchWorkingMemory(sessionId),
        fetchMemoryExtractionRuns(),
        fetchMemoryUsageRuns(),
      ]);
      setItems(memory.items);
      setTotal(memory.total);
      setReviewQueue(queue);
      setGraph(graphData);
      setTimeline(timelineData);
      setWorkingMemory(working);
      setExtractionRuns(extraction);
      setUsageRuns(usage);
      const runItems = await Promise.all(extraction.slice(0, 6).map(async (run) => [run.id, await fetchMemoryExtractionRunItems(run.id)] as const));
      setExtractionRunItems(Object.fromEntries(runItems));
      let preferredId: string | null = null;
      try {
        const raw = sessionStorage.getItem('prism:memory:focus-candidates');
        if (raw) {
          const ids = JSON.parse(raw) as string[];
          preferredId = ids.find((id) => queue.some((candidate) => candidate.id === id)) ?? null;
          if (preferredId) {
            setFilter('review');
          }
          sessionStorage.removeItem('prism:memory:focus-candidates');
        }
        const flash = sessionStorage.getItem('prism:memory:last-action');
        if (flash) {
          const parsed = JSON.parse(flash) as { message?: string };
          setFlashMessage(parsed.message ?? null);
          sessionStorage.removeItem('prism:memory:last-action');
        }
      } catch {}
      const first = filter === 'review' ? queue[0]?.id ?? null : memory.items[0]?.id ?? null;
      setSelectedId((prev) => preferredId ?? prev ?? first);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [filter, search]);

  useEffect(() => {
    if (!selectedId || filter === 'review') {
      setSelectedItem(null);
      return;
    }
    fetchMemoryItem(selectedId).then(setSelectedItem);
  }, [filter, selectedId]);

  const selectedCandidate = useMemo(
    () => (filter === 'review' ? reviewQueue.find((item) => item.id === selectedId) ?? null : null),
    [filter, reviewQueue, selectedId]
  );

  const selectedCandidateRouting = selectedCandidate?.payload?.relationshipRoutingDecision as string | undefined;
  const selectedCandidatePromotionReason = selectedCandidate?.payload?.relationshipPromotionReason as string | undefined;

  const handleExtractSession = async () => {
    if (!sessionId) return;
    const result = await extractSessionMemory(sessionId);
    if (result) {
      setFlashMessage(
        result.added > 0
          ? `Added ${result.added} memory candidate${result.added === 1 ? '' : 's'} from this session${result.skippedDuplicates > 0 ? ` and skipped ${result.skippedDuplicates} duplicate${result.skippedDuplicates === 1 ? '' : 's'}` : ''}.`
          : `No new memory candidates were added from this session${result.skippedDuplicates > 0 ? `; skipped ${result.skippedDuplicates} duplicate${result.skippedDuplicates === 1 ? '' : 's'}` : ''}.`
      );
    }
    await load();
    setFilter('review');
  };

  const handleConfirm = async (id: string) => {
    await confirmMemoryCandidateApi(id);
    await load();
    setFilter('all');
  };

  const handleReject = async (id: string) => {
    await rejectMemoryCandidateApi(id);
    await load();
  };

  const handleArchive = async (id: string) => {
    await archiveMemoryItemApi(id);
    await load();
  };

  const handleReset = async () => {
    if (!window.confirm('Reset all memory items and review-queue candidates? This cannot be undone.')) return;
    const ok = await resetMemoryApi();
    if (!ok) {
      setFlashMessage('Failed to reset memory.');
      return;
    }
    setSelectedId(null);
    setSelectedItem(null);
    setFilter('all');
    setFlashMessage('All memory items and candidates were cleared.');
    await load();
  };

  const list = filter === 'review' ? reviewQueue : items;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-gray-300">Structured Memory</h2>
        <span className="text-[11px] text-gray-500">{filter === 'review' ? `${reviewQueue.length} candidates` : `${total} memories`}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleReset}
            className="rounded border border-rose-700 px-2 py-1 text-xs text-rose-200 transition-colors hover:bg-rose-950/30"
          >
            Reset Memory
          </button>
          {sessionId && (
            <button
              onClick={handleExtractSession}
              className="rounded bg-indigo-600 px-2 py-1 text-xs text-white transition-colors hover:bg-indigo-500"
            >
              Extract From Session
            </button>
          )}
        </div>
      </div>

      {flashMessage && (
        <div className="flex items-center gap-3 rounded-lg border border-emerald-800/80 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-200">
          <span className="flex-1">{flashMessage}</span>
          <button
            onClick={() => setFlashMessage(null)}
            className="rounded border border-emerald-800 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-900/20"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex gap-3">
        <div className="w-72 flex-shrink-0 min-h-0 flex flex-col rounded-lg border border-gray-800 bg-gray-900">
          <div className="border-b border-gray-800 p-3">
            <div className="mb-2 flex flex-wrap gap-1">
              {FILTERS.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => setFilter(entry.id)}
                  className={`rounded px-2 py-1 text-[11px] transition-colors ${
                    filter === entry.id ? 'bg-gray-700 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                  }`}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search memory..."
              className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 placeholder-gray-500 outline-none"
            />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
          {loading ? (
              <div className="p-3 text-xs text-gray-500">Loading memory…</div>
            ) : list.length === 0 ? (
              <div className="p-3 text-xs text-gray-500">No memory items yet.</div>
            ) : (
              list.map((item: any) => (
                <button
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  className={`w-full rounded border px-3 py-2 text-left transition-colors ${
                    selectedId === item.id ? 'border-indigo-700 bg-indigo-950/20' : 'border-gray-800 bg-gray-950/30 hover:border-gray-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-gray-200">{item.title}</span>
                    <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
                      {filter === 'review' ? item.memoryType : item.memoryType}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-gray-400 line-clamp-2">{item.summary}</p>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 flex flex-col gap-3">
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Memory Graph</div>
            <div className="flex flex-wrap gap-2">
              {graph.nodes.slice(0, 18).map((node) => (
                <span
                  key={node.id}
                  className="rounded-full border px-2 py-1 text-[11px]"
                  style={{ borderColor: `${node.color}66`, color: node.color }}
                >
                  {node.label}
                </span>
              ))}
            </div>
            {graph.edges.length > 0 && (
              <div className="mt-3 text-[11px] text-gray-500">
                {graph.edges.length} graph edges connecting memories and related entities.
              </div>
            )}
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Extraction Log</div>
              <div className="space-y-2">
                {extractionRuns.slice(0, 6).map((run) => (
                  <div key={run.id} className="rounded border border-gray-800 bg-gray-950/40 px-2.5 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-gray-200">{run.trigger}</span>
                      <span className="text-gray-500">{new Date(run.createdAt).toLocaleString()}</span>
                    </div>
                    <div className="mt-1 text-gray-400">
                      Added {run.addedCount} · Duplicates {run.duplicateCount} · Sources {run.sourceMessageIds.length}
                    </div>
                    {extractionRunItems[run.id]?.length ? (
                      <div className="mt-1 text-[11px] text-gray-500">
                        Relationships:{' '}
                        {extractionRunItems[run.id].filter((item) => item.memoryType === 'relationship' && item.outcome === 'graph_only').length} graph-only ·{' '}
                        {extractionRunItems[run.id].filter((item) => item.memoryType === 'relationship' && item.outcome === 'added').length} memory candidates ·{' '}
                        {extractionRunItems[run.id].filter((item) => item.memoryType === 'relationship' && item.outcome === 'trigger_candidate').length} trigger candidates
                      </div>
                    ) : null}
                  </div>
                ))}
                {extractionRuns.length === 0 && <div className="text-xs text-gray-500">No extraction runs yet.</div>}
              </div>
            </div>

            <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Usage / Injection</div>
              <div className="space-y-2">
                {usageRuns.slice(0, 6).map((run) => (
                  <div key={run.id} className="rounded border border-gray-800 bg-gray-950/40 px-2.5 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-gray-200">{run.model}</span>
                      <span className="text-gray-500">{new Date(run.createdAt).toLocaleString()}</span>
                    </div>
                    <div className="mt-1 text-gray-400">
                      Retrieved {run.totalRetrieved} · Injected {run.totalInjected} · Omitted {run.totalOmitted}
                    </div>
                    <div className="mt-1 line-clamp-2 text-[11px] text-gray-500">{run.promptPreview}</div>
                  </div>
                ))}
                {usageRuns.length === 0 && <div className="text-xs text-gray-500">No memory usage runs yet.</div>}
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Working Memory</div>
            <div className="space-y-2">
              {workingMemory.slice(0, 8).map((item) => (
                <div key={item.id} className="rounded border border-gray-800 bg-gray-950/40 px-2.5 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-gray-200">{item.title}</span>
                    <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">{item.status}</span>
                  </div>
                  <div className="mt-1 text-gray-400">{item.summary}</div>
                </div>
              ))}
              {workingMemory.length === 0 && <div className="text-xs text-gray-500">No working memory items yet.</div>}
            </div>
          </div>

          <div className="flex-1 min-h-0 rounded-lg border border-gray-800 bg-gray-900 p-3 overflow-y-auto">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Timeline</div>
            <div className="space-y-2">
              {timeline.length === 0 ? (
                <div className="text-xs text-gray-500">No timeline memory yet.</div>
              ) : (
                timeline.slice(0, 30).map((event) => (
                  <div key={event.id} className="rounded border border-gray-800 bg-gray-950/40 px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-gray-200">{event.title}</span>
                      <span className="text-[10px] text-gray-500">{new Date(event.startedAt).toLocaleString()}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-gray-400">{event.summary}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="w-80 flex-shrink-0 min-h-0 rounded-lg border border-gray-800 bg-gray-900 p-3 overflow-y-auto">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Details</div>
          {filter === 'review' ? (
            selectedCandidate ? (
              <div className="space-y-3">
                <div>
                  <div className="text-sm font-semibold text-gray-200">{selectedCandidate.title}</div>
                  <div className="mt-1 text-xs text-gray-400">{selectedCandidate.summary}</div>
                </div>
                <div className="flex flex-wrap gap-2 text-[11px] text-gray-500">
                  <span className="rounded bg-gray-800 px-2 py-1">{selectedCandidate.memoryType}</span>
                  <span className="rounded bg-gray-800 px-2 py-1">confidence {selectedCandidate.confidence.toFixed(2)}</span>
                  {selectedCandidateRouting && (
                    <span className="rounded bg-gray-800 px-2 py-1">
                      {selectedCandidateRouting === 'memory_candidate'
                        ? 'Memory candidate'
                        : selectedCandidateRouting === 'trigger_candidate'
                          ? 'Trigger candidate'
                          : 'Graph-only'}
                    </span>
                  )}
                </div>
                {selectedCandidatePromotionReason && (
                  <div className="rounded border border-gray-800 bg-gray-950/40 px-2 py-1.5 text-[11px] text-gray-400">
                    Routing reason: {selectedCandidatePromotionReason}
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={() => handleConfirm(selectedCandidate.id)} className="rounded bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500">
                    Confirm
                  </button>
                  <button onClick={() => handleReject(selectedCandidate.id)} className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800">
                    Reject
                  </button>
                </div>
                {selectedCandidate.payload && (
                  <pre className="overflow-x-auto rounded border border-gray-800 bg-gray-950/50 p-3 text-[11px] text-gray-400">
                    {JSON.stringify(selectedCandidate.payload, null, 2)}
                  </pre>
                )}
              </div>
            ) : (
              <div className="text-xs text-gray-500">Select a candidate from the review queue.</div>
            )
          ) : selectedItem ? (
            <div className="space-y-3">
              <div>
                <div className="text-sm font-semibold text-gray-200">{selectedItem.title}</div>
                <div className="mt-1 text-xs text-gray-400">{selectedItem.summary}</div>
              </div>
              <div className="flex flex-wrap gap-2 text-[11px] text-gray-500">
                <span className="rounded bg-gray-800 px-2 py-1">{selectedItem.memoryType}</span>
                <span className="rounded bg-gray-800 px-2 py-1">{selectedItem.status}</span>
                <span className="rounded bg-gray-800 px-2 py-1">confidence {selectedItem.confidence.toFixed(2)}</span>
              </div>
              {selectedItem.attributes.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Attributes</div>
                  <div className="space-y-1">
                    {selectedItem.attributes.map((attr) => (
                      <div key={attr.id} className="rounded border border-gray-800 bg-gray-950/40 px-2 py-1 text-[11px] text-gray-300">
                        <span className="text-gray-500">{attr.key}</span>: {attr.value}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {selectedItem.entityLinks.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Linked Entities</div>
                  <div className="flex flex-wrap gap-2">
                    {selectedItem.entityLinks.map((link) => (
                      <span key={link.id} className="rounded border border-gray-800 bg-gray-950/40 px-2 py-1 text-[11px] text-gray-300">
                        {link.entityName} · {link.linkRole}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {selectedItem.sources.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Sources</div>
                  <div className="space-y-2">
                    {selectedItem.sources.map((source) => (
                      <div key={source.id} className="rounded border border-gray-800 bg-gray-950/40 px-2 py-2 text-[11px] text-gray-400">
                        <div className="mb-1 text-gray-500">
                          session {source.sessionId ?? 'n/a'} · message {source.messageId ?? 'n/a'}
                        </div>
                        <div>{source.excerpt}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={() => handleArchive(selectedItem.id)} className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800">
                  Archive
                </button>
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-500">Select a memory item to inspect its details.</div>
          )}
        </div>
      </div>
    </div>
  );
}
