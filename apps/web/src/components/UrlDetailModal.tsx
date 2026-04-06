'use client';

import { useEffect, useMemo, useState } from 'react';
import type { LinkedPageCandidate, UrlPreview, WebPagePreviewResponse } from '@prism/shared';
import { toast } from '@/stores/toast-store';
import { fetchWebContextPreview } from '@/lib/api';

interface UrlDetailModalProps {
  data: WebPagePreviewResponse;
  attachedUrls?: string[];
  onClose: () => void;
  onAttach?: (selectedUrls: string[]) => Promise<void> | void;
}

export default function UrlDetailModal({ data, attachedUrls = [], onClose, onAttach }: UrlDetailModalProps) {
  const [copied, setCopied] = useState(false);
  const [selectedUrls, setSelectedUrls] = useState<string[]>([]);
  const [attachBusy, setAttachBusy] = useState(false);
  const [previewCache, setPreviewCache] = useState<Record<string, UrlPreview>>({});
  const [previewLoadingUrl, setPreviewLoadingUrl] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const attachedSet = useMemo(() => new Set(attachedUrls), [attachedUrls]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(data.page.content);
      setCopied(true);
      toast.success('Copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  };

  const toggleSelection = (candidate: LinkedPageCandidate) => {
    setSelectedUrls((prev) =>
      prev.includes(candidate.url)
        ? prev.filter((url) => url !== candidate.url)
        : [...prev, candidate.url],
    );
  };

  const handleAttach = async () => {
    if (!onAttach) return;
    setAttachBusy(true);
    try {
      await onAttach(selectedUrls);
      setSelectedUrls([]);
      onClose();
    } finally {
      setAttachBusy(false);
    }
  };

  const handlePreviewLinkedPage = async (candidate: LinkedPageCandidate) => {
    setPreviewLoadingUrl(candidate.url);
    try {
      const preview = await fetchWebContextPreview(candidate.url);
      if (!preview) {
        toast.error('Failed to preview linked page.');
        return;
      }
      setPreviewCache((prev) => ({ ...prev, [candidate.normalizedUrl]: preview.page }));
    } finally {
      setPreviewLoadingUrl(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 p-6 animate-fade-in-scale" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-gray-800 px-5 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-gray-100">{data.page.title ?? data.page.url}</div>
            <div className="truncate text-xs text-gray-500">{data.page.url}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="rounded-md border border-gray-600 px-3 py-1 text-xs font-medium text-gray-300 transition-colors hover:bg-gray-800 hover:text-gray-100"
            >
              {copied ? '\u2713 Copied' : 'Copy Page'}
            </button>
            <button onClick={onClose} className="text-lg leading-none text-gray-500 transition-colors hover:text-gray-300">
              &times;
            </button>
          </div>
        </div>

        <div className="grid flex-1 min-h-0 grid-cols-[minmax(0,1.3fr)_minmax(320px,1fr)]">
          <div className="min-w-0 overflow-y-auto border-r border-gray-800 p-5">
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-gray-500">Page Content</div>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-gray-300">
              {data.page.content}
            </pre>
          </div>

          <div className="flex min-h-0 min-w-0 flex-col">
            <div className="border-b border-gray-800 px-4 py-3">
              <div className="text-[10px] font-medium uppercase tracking-wider text-gray-500">Linked Pages</div>
              <div className="mt-1 text-xs text-gray-500">Same domain only · 1 level deep</div>
            </div>

            <div className="min-w-0 flex-1 overflow-y-auto p-4">
              {data.links.length === 0 ? (
                <div className="rounded border border-dashed border-gray-800 px-3 py-4 text-center text-xs text-gray-600">
                  No linked pages found
                </div>
              ) : (
                <div className="space-y-2">
                  {data.links.map((link) => {
                    const checked = selectedUrls.includes(link.url);
                    const attached = attachedSet.has(link.normalizedUrl);
                    return (
                      <label
                        key={link.normalizedUrl}
                        className={`block rounded-lg border px-3 py-2 text-left transition-colors ${
                          attached
                            ? 'border-emerald-800/50 bg-emerald-950/20'
                            : checked
                              ? 'border-cyan-700/60 bg-gray-800'
                              : 'border-gray-800 bg-gray-950/40 hover:border-gray-700'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={checked || attached}
                            disabled={attached}
                            onChange={() => toggleSelection(link)}
                            className="mt-0.5"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-gray-200">
                              {link.title ?? link.anchorText ?? link.url}
                            </div>
                            <div className="truncate text-[11px] text-gray-500">{link.url}</div>
                            {link.anchorText && (
                              <div className="mt-1 text-[11px] text-gray-400">{link.anchorText}</div>
                            )}
                            <div className="mt-1 flex items-center gap-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  handlePreviewLinkedPage(link);
                                }}
                                className="text-[11px] text-cyan-400 hover:text-cyan-300"
                              >
                                {previewLoadingUrl === link.url ? 'Previewing...' : 'Preview'}
                              </button>
                              {link.snippet && !previewCache[link.normalizedUrl] && (
                                <div className="line-clamp-2 text-[11px] text-gray-500">{link.snippet}</div>
                              )}
                            </div>
                            {previewCache[link.normalizedUrl] && (
                              <div className="mt-2 rounded bg-gray-900/70 px-2 py-2 text-[11px] text-gray-400">
                                <div className="mb-1 font-medium text-gray-300">
                                  {previewCache[link.normalizedUrl].title ?? link.url}
                                </div>
                                <div className="line-clamp-4 whitespace-pre-wrap">
                                  {previewCache[link.normalizedUrl].content}
                                </div>
                              </div>
                            )}
                          </div>
                          {attached && (
                            <span className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] text-emerald-300">
                              Attached
                            </span>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-800 px-4 py-3">
              <div className="text-xs text-gray-500">
                {selectedUrls.length} selected
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={onClose}
                  className="rounded-md border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAttach}
                  disabled={attachBusy || !onAttach}
                  className="rounded-md bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {attachBusy ? 'Attaching...' : 'Attach Selected Pages'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
