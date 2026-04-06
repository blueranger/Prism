'use client';

import { useEffect, useMemo, useState } from 'react';
import { fetchCostSummary, syncProviderCosts } from '@/lib/api';

function currentMonthKey(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export default function CostsView() {
  const [month] = useState(currentMonthKey());
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<'openai' | 'anthropic' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchCostSummary>>>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchCostSummary(month);
      setData(result);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load cost summary');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [month]);

  const providerCards = useMemo(() => data?.summary.providerBreakdown ?? [], [data]);
  const modelRows = useMemo(() => data?.summary.modelBreakdown ?? [], [data]);
  const modeRows = useMemo(() => data?.summary.modeBreakdown ?? [], [data]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xl font-semibold text-gray-100">Costs</div>
          <div className="text-sm text-gray-500">Per-turn ledger plus monthly provider reconciliation.</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setSyncing('openai');
              syncProviderCosts('openai', month).finally(() => {
                setSyncing(null);
                void load();
              });
            }}
            className="rounded border border-gray-700 px-3 py-2 text-sm text-gray-200 transition-colors hover:bg-gray-800"
          >
            {syncing === 'openai' ? 'Syncing OpenAI...' : 'Sync OpenAI'}
          </button>
          <button
            type="button"
            onClick={() => {
              setSyncing('anthropic');
              syncProviderCosts('anthropic', month).finally(() => {
                setSyncing(null);
                void load();
              });
            }}
            className="rounded border border-gray-700 px-3 py-2 text-sm text-gray-200 transition-colors hover:bg-gray-800"
          >
            {syncing === 'anthropic' ? 'Syncing Anthropic...' : 'Sync Anthropic'}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded border border-gray-700 px-3 py-2 text-sm text-gray-200 transition-colors hover:bg-gray-800"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="rounded border border-red-900/40 bg-red-950/20 px-4 py-3 text-sm text-red-300">{error}</div>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-gray-800 bg-gray-900/70 p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500">Month</div>
          <div className="mt-2 text-2xl font-semibold text-gray-100">{month}</div>
        </div>
        <div className="rounded-xl border border-gray-800 bg-gray-900/70 p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500">Estimated</div>
          <div className="mt-2 text-2xl font-semibold text-gray-100">
            ${data?.summary.totalEstimatedUsd.toFixed(4) ?? '0.0000'}
          </div>
        </div>
        <div className="rounded-xl border border-gray-800 bg-gray-900/70 p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500">Reconciled</div>
          <div className="mt-2 text-2xl font-semibold text-gray-100">
            ${data?.summary.totalReconciledUsd.toFixed(4) ?? '0.0000'}
          </div>
        </div>
        <div className="rounded-xl border border-gray-800 bg-gray-900/70 p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500">Provider records</div>
          <div className="mt-2 text-2xl font-semibold text-gray-100">
            {data?.providerRecords.length ?? 0}
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[1.2fr_1fr_1fr]">
        <div className="min-h-0 rounded-xl border border-gray-800 bg-gray-900/70 p-4">
          <div className="mb-3 text-sm font-semibold text-gray-200">Providers</div>
          <div className="space-y-3 overflow-auto">
            {loading && <div className="text-sm text-gray-500">Loading provider costs...</div>}
            {!loading && providerCards.map((card) => (
              <div key={card.provider} className="rounded-lg border border-gray-800 bg-gray-950/50 p-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-gray-100">{card.provider}</div>
                  <span className="rounded bg-gray-800 px-2 py-0.5 text-[11px] text-gray-300">
                    {card.displayStatus}
                  </span>
                </div>
                <div className="mt-2 text-sm text-gray-300">Estimated: ${card.estimatedUsd.toFixed(4)}</div>
                <div className="text-sm text-gray-400">Reconciled: ${card.reconciledUsd.toFixed(4)}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="min-h-0 rounded-xl border border-gray-800 bg-gray-900/70 p-4">
          <div className="mb-3 text-sm font-semibold text-gray-200">Top Models</div>
          <div className="space-y-2 overflow-auto">
            {loading && <div className="text-sm text-gray-500">Loading models...</div>}
            {!loading && modelRows.map((row) => (
              <div key={`${row.provider}:${row.model}`} className="rounded-lg border border-gray-800 bg-gray-950/50 p-3">
                <div className="text-sm font-medium text-gray-100">{row.model}</div>
                <div className="mt-1 text-xs text-gray-500">{row.provider}</div>
                <div className="mt-2 text-sm text-gray-300">${row.estimatedUsd.toFixed(4)}</div>
                <div className="text-xs text-gray-500">{row.totalTokens.toLocaleString()} tokens</div>
              </div>
            ))}
          </div>
        </div>

        <div className="min-h-0 rounded-xl border border-gray-800 bg-gray-900/70 p-4">
          <div className="mb-3 text-sm font-semibold text-gray-200">Top Modes</div>
          <div className="space-y-2 overflow-auto">
            {loading && <div className="text-sm text-gray-500">Loading modes...</div>}
            {!loading && modeRows.map((row) => (
              <div key={row.mode} className="rounded-lg border border-gray-800 bg-gray-950/50 p-3">
                <div className="text-sm font-medium text-gray-100">{row.mode}</div>
                <div className="mt-2 text-sm text-gray-300">${row.estimatedUsd.toFixed(4)}</div>
                <div className="text-xs text-gray-500">{row.totalTokens.toLocaleString()} tokens</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
