'use client';

import { useEffect, useMemo, useState } from 'react';
import { fetchSessionBootstrap } from '@/lib/api';
import type { SessionBootstrapRecord } from '@prism/shared';

function formatBootstrapDate(value?: string | number | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SessionBootstrapBanner({ sessionId }: { sessionId: string }) {
  const [bootstrap, setBootstrap] = useState<SessionBootstrapRecord | null>(null);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setBootstrap(null);
    fetchSessionBootstrap(sessionId).then((record) => {
      if (!cancelled) {
        setBootstrap(record);
        setExpanded(Boolean(record));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const selectedSources = useMemo(
    () => bootstrap?.payload.selectedSources ?? [],
    [bootstrap]
  );

  if (!bootstrap) return null;

  return (
    <div className="rounded-xl border border-emerald-800/60 bg-emerald-950/20 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-emerald-900/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
              {bootstrap.bootstrapType === 'kb' ? 'Bootstrapped from KB' : 'Bootstrapped from Library'}
            </span>
            <span className="text-[11px] text-gray-500">
              {selectedSources.length} source{selectedSources.length === 1 ? '' : 's'}
            </span>
          </div>
          <p className="mt-2 text-xs text-gray-400">
            This session already carries forward the summary and cited source excerpts below, so we can continue the discussion without reloading everything manually.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="rounded border border-gray-700 px-2 py-1 text-[10px] text-gray-300 transition-colors hover:bg-gray-800"
        >
          {expanded ? 'Hide Details' : 'Show Details'}
        </button>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3">
          {bootstrap.payload.query ? (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500">Original question</div>
              <div className="mt-1 rounded-lg bg-gray-900/70 px-3 py-2 text-xs text-gray-300">
                {bootstrap.payload.query}
              </div>
            </div>
          ) : null}

          {bootstrap.payload.answer ? (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500">Carried summary</div>
              <div className="mt-1 max-h-32 overflow-y-auto rounded-lg bg-gray-900/70 px-3 py-2 text-xs text-gray-300 whitespace-pre-wrap">
                {bootstrap.payload.answer}
              </div>
            </div>
          ) : null}

          <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500">
              Included sources ({selectedSources.length})
            </div>
            <div className="mt-2 space-y-2">
              {selectedSources.map((source, index) => (
                <div key={`${source.sourceId}-${index}`} className="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 text-xs text-gray-200 truncate">{source.sourceLabel}</div>
                    <div className="text-[10px] text-gray-500 whitespace-nowrap">
                      {formatBootstrapDate(source.citedAt) || formatBootstrapDate(source.sourceLastActivityAt) || formatBootstrapDate(source.sourceCreatedAt) || 'No timestamp'}
                    </div>
                  </div>
                  {source.excerpt ? (
                    <div className="mt-1 text-[11px] text-gray-400 line-clamp-3">
                      {source.excerpt}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
