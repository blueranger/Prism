'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useChatStore } from '@/stores/chat-store';

export default function SearchBar() {
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchQuery = useChatStore((s) => s.searchQuery);
  const searchLoading = useChatStore((s) => s.searchLoading);
  const searchTotal = useChatStore((s) => s.searchTotal);
  const searchTimeMs = useChatStore((s) => s.searchTimeMs);
  const setSearchQuery = useChatStore((s) => s.setSearchQuery);
  const performSearch = useChatStore((s) => s.performSearch);
  const clearSearch = useChatStore((s) => s.clearSearch);

  // Debounced search
  const handleChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value.trim()) {
      clearSearch();
      return;
    }
    debounceRef.current = setTimeout(() => {
      performSearch();
    }, 300);
  }, [setSearchQuery, performSearch, clearSearch]);

  // Cmd+K / Ctrl+K keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape' && searchQuery) {
        clearSearch();
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchQuery, clearSearch]);

  return (
    <div className="relative flex items-center gap-2">
      <div className="relative flex-1 max-w-md">
        {/* Magnifying glass icon */}
        <svg
          className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500"
          fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          placeholder="Search all conversations... (Cmd+K)"
          value={searchQuery}
          onChange={(e) => handleChange(e.target.value)}
          className="w-full pl-8 pr-8 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-600 transition-colors"
        />
        {/* Clear button */}
        {searchQuery && (
          <button
            onClick={() => { clearSearch(); inputRef.current?.focus(); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-xs"
          >
            &times;
          </button>
        )}
      </div>
      {/* Search meta info */}
      {searchQuery && !searchLoading && searchTotal > 0 && (
        <span className="text-[10px] text-gray-600 whitespace-nowrap">
          {searchTotal} results ({searchTimeMs}ms)
        </span>
      )}
      {searchLoading && (
        <span className="text-[10px] text-gray-600 whitespace-nowrap">Searching...</span>
      )}
    </div>
  );
}
