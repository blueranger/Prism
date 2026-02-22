'use client';

import { useCallback } from 'react';
import { useChatStore } from '@/stores/chat-store';
import type { SearchResult, ImportPlatform } from '@prism/shared';

const SOURCE_TABS: { id: string; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'imported', label: 'Imported' },
  { id: 'native', label: 'Native' },
];

const PLATFORM_TABS: { id: string; label: string }[] = [
  { id: 'all', label: 'All Platforms' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
  { id: 'gemini', label: 'Gemini' },
];

function sourceBadge(source: string, platform?: string) {
  if (source === 'native') {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-900/50 text-indigo-400">Prism</span>;
  }
  switch (platform) {
    case 'chatgpt': return <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/50 text-green-400">ChatGPT</span>;
    case 'claude': return <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-900/50 text-orange-400">Claude</span>;
    case 'gemini': return <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-400">Gemini</span>;
    default: return <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">Imported</span>;
  }
}

function highlightSnippet(snippet: string, query: string) {
  if (!query.trim()) return snippet;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  // Build regex to highlight matching words
  const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = snippet.split(regex);

  return parts.map((part, i) => {
    const isMatch = words.some(w => part.toLowerCase() === w);
    return isMatch
      ? <mark key={i} className="bg-yellow-500/30 text-yellow-200 rounded px-0.5">{part}</mark>
      : <span key={i}>{part}</span>;
  });
}

export default function SearchResults() {
  const searchQuery = useChatStore((s) => s.searchQuery);
  const results = useChatStore((s) => s.searchResults);
  const total = useChatStore((s) => s.searchTotal);
  const loading = useChatStore((s) => s.searchLoading);
  const filters = useChatStore((s) => s.searchFilters);
  const setSearchFilters = useChatStore((s) => s.setSearchFilters);
  const performSearch = useChatStore((s) => s.performSearch);
  const navigate = useChatStore((s) => s.navigateToSearchResult);

  const handleSourceFilter = useCallback((source: string) => {
    const newFilters = {
      ...filters,
      source: source === 'all' ? undefined : source as 'imported' | 'native',
    };
    setSearchFilters(newFilters);
    // Re-trigger search with new filters
    setTimeout(() => performSearch(), 0);
  }, [filters, setSearchFilters, performSearch]);

  const handlePlatformFilter = useCallback((platform: string) => {
    const newFilters = {
      ...filters,
      platform: platform === 'all' ? undefined : platform as ImportPlatform,
    };
    setSearchFilters(newFilters);
    setTimeout(() => performSearch(), 0);
  }, [filters, setSearchFilters, performSearch]);

  const handleResultClick = useCallback((result: SearchResult) => {
    navigate(result);
  }, [navigate]);

  if (!searchQuery) return null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Filter chips */}
      <div className="flex gap-4 mb-3 flex-wrap">
        {/* Source filter */}
        <div className="flex gap-1">
          {SOURCE_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleSourceFilter(tab.id)}
              className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                (filters.source || 'all') === tab.id
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {/* Platform filter (only when not filtering to native only) */}
        {filters.source !== 'native' && (
          <div className="flex gap-1">
            {PLATFORM_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handlePlatformFilter(tab.id)}
                className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                  (filters.platform || 'all') === tab.id
                    ? 'bg-gray-700 text-white'
                    : 'bg-gray-800 text-gray-500 hover:text-gray-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto space-y-2 pr-2">
        {loading ? (
          <p className="text-xs text-gray-600 text-center py-8">Searching...</p>
        ) : results.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-sm text-gray-500">No results found for &quot;{searchQuery}&quot;</p>
            <p className="text-xs text-gray-600 mt-1">Try different keywords or adjust filters</p>
          </div>
        ) : (
          results.map((result) => (
            <button
              key={result.id}
              onClick={() => handleResultClick(result)}
              className="w-full text-left p-3 rounded-lg bg-gray-800/50 hover:bg-gray-800 border border-transparent hover:border-gray-700 transition-colors"
            >
              {/* Header row */}
              <div className="flex items-center gap-2 mb-1.5">
                {sourceBadge(result.source, result.sourcePlatform)}
                <span className="text-[10px] font-medium uppercase text-gray-500">{result.role}</span>
                {result.sourceModel && (
                  <span className="text-[10px] text-gray-600">{result.sourceModel}</span>
                )}
                <span className="text-[10px] text-gray-700 ml-auto">
                  {new Date(result.timestamp).toLocaleDateString()}
                </span>
              </div>
              {/* Conversation title */}
              <p className="text-xs text-gray-400 mb-1 truncate">
                {result.conversationTitle}
              </p>
              {/* Snippet with highlighting */}
              <p className="text-xs text-gray-500 leading-relaxed line-clamp-3">
                {highlightSnippet(result.snippet, searchQuery)}
              </p>
            </button>
          ))
        )}
        {results.length > 0 && results.length < total && (
          <p className="text-[10px] text-gray-600 text-center py-2">
            Showing {results.length} of {total} results
          </p>
        )}
      </div>
    </div>
  );
}
