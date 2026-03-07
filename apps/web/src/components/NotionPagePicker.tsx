'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchNotionPages, attachContextSource, fetchContextSources, detachContextSource } from '@/lib/api';

interface NotionPagePickerProps {
  sessionId: string;
  onClose: () => void;
  onSourcesChanged?: () => void;
}

export default function NotionPagePicker({ sessionId, onClose, onSourcesChanged }: NotionPagePickerProps) {
  const [pages, setPages] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [attachedSources, setAttachedSources] = useState<any[]>([]);
  const [attaching, setAttaching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load pages and existing sources
  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchNotionPages(),
      fetchContextSources(sessionId),
    ]).then(([p, s]) => {
      setPages(p);
      setAttachedSources(s);
    }).finally(() => setLoading(false));
  }, [sessionId]);

  // Search
  const handleSearch = useCallback(async (q: string) => {
    setSearch(q);
    setLoading(true);
    const p = await fetchNotionPages(q || undefined);
    setPages(p);
    setLoading(false);
  }, []);

  const toggleSelect = (pageId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  };

  const isAlreadyAttached = (pageId: string) => {
    return attachedSources.some(s => s.sourceId === pageId);
  };

  const handleAttach = async () => {
    if (selectedIds.size === 0) return;
    setAttaching(true);
    for (const pageId of selectedIds) {
      if (isAlreadyAttached(pageId)) continue;
      const page = pages.find(p => p.id === pageId);
      if (page) {
        await attachContextSource(sessionId, pageId, page.title);
      }
    }
    const updated = await fetchContextSources(sessionId);
    setAttachedSources(updated);
    setSelectedIds(new Set());
    setAttaching(false);
    onSourcesChanged?.();
  };

  const handleDetach = async (sourceId: string) => {
    await detachContextSource(sourceId);
    const updated = await fetchContextSources(sessionId);
    setAttachedSources(updated);
    onSourcesChanged?.();
  };

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Auto-focus search
  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-[520px] max-h-[600px] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h3 className="text-sm font-medium text-gray-200">Attach Notion Pages</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg">✕</button>
        </div>

        {/* Currently attached */}
        {attachedSources.length > 0 && (
          <div className="px-4 py-2 border-b border-gray-800">
            <div className="text-[10px] text-gray-500 mb-1">Currently attached</div>
            <div className="flex flex-wrap gap-1">
              {attachedSources.map(s => (
                <span key={s.id} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 bg-indigo-900/40 text-indigo-300 rounded-full border border-indigo-800">
                  {s.sourceLabel}
                  <button onClick={() => handleDetach(s.id)} className="hover:text-red-400 text-[10px]">✕</button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Search */}
        <div className="px-4 py-2">
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Search pages..."
            className="w-full px-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200 placeholder-gray-500 focus:outline-none focus:border-indigo-500"
          />
        </div>

        {/* Page list */}
        <div className="flex-1 overflow-y-auto px-2 pb-2 min-h-0">
          {loading ? (
            <div className="text-center text-gray-500 text-sm py-8">Loading...</div>
          ) : pages.length === 0 ? (
            <div className="text-center text-gray-500 text-sm py-8">
              {search ? 'No pages match your search' : 'No Notion pages synced yet'}
            </div>
          ) : (
            pages.map(page => {
              const attached = isAlreadyAttached(page.id);
              const selected = selectedIds.has(page.id);
              return (
                <button
                  key={page.id}
                  onClick={() => !attached && toggleSelect(page.id)}
                  disabled={attached}
                  className={`w-full text-left px-3 py-2 rounded-lg mb-0.5 transition-colors flex items-center gap-2 ${
                    attached
                      ? 'opacity-50 cursor-not-allowed bg-gray-800/30'
                      : selected
                        ? 'bg-indigo-900/30 border border-indigo-700'
                        : 'hover:bg-gray-800/50 border border-transparent'
                  }`}
                >
                  <span className="text-base flex-shrink-0">{page.iconEmoji || '📄'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-200 truncate">{page.title}</div>
                    <div className="text-[10px] text-gray-500">
                      {page.lastEditedAt ? new Date(page.lastEditedAt).toLocaleDateString() : 'Unknown date'}
                      {attached && ' • Already attached'}
                    </div>
                  </div>
                  {selected && !attached && (
                    <span className="w-4 h-4 rounded bg-indigo-500 flex items-center justify-center text-white text-[10px]">✓</span>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800">
          <span className="text-[10px] text-gray-500">
            {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select pages to attach as context'}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1 text-xs text-gray-400 hover:text-gray-200">
              Cancel
            </button>
            <button
              onClick={handleAttach}
              disabled={selectedIds.size === 0 || attaching}
              className="px-3 py-1 text-xs bg-indigo-600 text-white rounded-md hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {attaching ? 'Attaching...' : 'Attach'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
