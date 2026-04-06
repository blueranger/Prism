'use client';

import { useEffect, useState } from 'react';
import { fetchSessionCost } from '@/lib/api';

interface SessionCostBannerProps {
  sessionId: string;
}

export default function SessionCostBanner({ sessionId }: SessionCostBannerProps) {
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof fetchSessionCost>>>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSessionCost(sessionId).then((result) => {
      if (!cancelled) setSummary(result);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!summary || summary.totalEstimatedUsd <= 0) return null;

  const providerEntries = Object.entries(summary.byProvider).sort((a, b) => b[1].estimatedUsd - a[1].estimatedUsd);

  return (
    <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm font-semibold text-emerald-300">
          Session cost: ${summary.totalEstimatedUsd.toFixed(4)}
        </div>
        <div className="text-xs text-emerald-100/80">
          {summary.events.length} usage event{summary.events.length === 1 ? '' : 's'}
        </div>
        {providerEntries.map(([provider, data]) => (
          <span key={provider} className="rounded bg-emerald-900/30 px-2 py-1 text-[11px] text-emerald-100">
            {provider}: ${data.estimatedUsd.toFixed(4)}
          </span>
        ))}
      </div>
    </div>
  );
}
