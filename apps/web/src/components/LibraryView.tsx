'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { searchAll } from '@/lib/api';
import ImportDialog from './ImportDialog';
import SessionOutline from './SessionOutline';
import ConversationKnowledge from './ConversationKnowledge';
import CopyWithProvenance from './CopyWithProvenance';
import type { ImportPlatform, SearchResult, OutlineSection } from '@prism/shared';

const PLATFORM_TABS: { id: string; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
  { id: 'gemini', label: 'Gemini' },
];

function platformBadge(platform: string) {
  switch (platform) {
    case 'chatgpt': return <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/50 text-green-400">GPT</span>;
    case 'claude': return <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-900/50 text-orange-400">Claude</span>;
    case 'gemini': return <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-400">Gemini</span>;
    default: return null;
  }
}

export default function LibraryView() {
  const [importOpen, setImportOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [ftsResults, setFtsResults] = useState<SearchResult[]>([]);
  const [ftsSearching, setFtsSearching] = useState(false);
  const [libraryDetailTab, setLibraryDetailTab] = useState<'messages' | 'topics' | 'knowledge'>('messages');
  const [libraryHighlightRange, setLibraryHighlightRange] = useState<{ start: number; end: number } | null>(null);
  const libraryMessagesRef = useRef<HTMLDivElement>(null);

  // Resizable left panel width
  const [leftPanelWidth, setLeftPanelWidth] = useState(320);
  const lpDragging = useRef(false);
  const lpDragStartX = useRef(0);
  const lpDragStartW = useRef(0);

  const handleLeftPanelDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    lpDragging.current = true;
    lpDragStartX.current = e.clientX;
    lpDragStartW.current = leftPanelWidth;

    const onMove = (ev: MouseEvent) => {
      if (!lpDragging.current) return;
      const delta = ev.clientX - lpDragStartX.current;
      setLeftPanelWidth(Math.max(200, Math.min(500, lpDragStartW.current + delta)));
    };
    const onUp = () => {
      lpDragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [leftPanelWidth]);

  const conversations = useChatStore((s) => s.libraryConversations);
  const total = useChatStore((s) => s.libraryTotal);
  const selectedId = useChatStore((s) => s.librarySelectedId);
  const messages = useChatStore((s) => s.libraryMessages);
  const loading = useChatStore((s) => s.libraryLoading);
  const stats = useChatStore((s) => s.libraryStats);
  const fetchLibrary = useChatStore((s) => s.fetchLibrary);
  const selectConversation = useChatStore((s) => s.selectLibraryConversation);
  const fetchLibraryStats = useChatStore((s) => s.fetchLibraryStats);

  // Initial load
  useEffect(() => {
    fetchLibrary();
    fetchLibraryStats();
  }, [fetchLibrary, fetchLibraryStats]);

  // Reset detail tab when conversation changes
  useEffect(() => {
    setLibraryDetailTab('messages');
    setLibraryHighlightRange(null);
  }, [selectedId]);

  // Filter by platform tab
  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab);
    fetchLibrary({ platform: tab === 'all' ? undefined : tab });
  }, [fetchLibrary]);

  // Search — use FTS API for content search, fall back to title filter for empty query
  const handleSearch = useCallback(async () => {
    if (!searchInput.trim()) {
      setFtsResults([]);
      fetchLibrary({ platform: activeTab === 'all' ? undefined : activeTab });
      return;
    }
    setFtsSearching(true);
    try {
      const result = await searchAll({
        query: searchInput,
        source: 'imported',
        platform: activeTab === 'all' ? undefined : activeTab,
      });
      setFtsResults(result.results);
    } catch (err) {
      console.error('[library] FTS search error:', err);
    } finally {
      setFtsSearching(false);
    }
  }, [searchInput, activeTab, fetchLibrary]);

  // Load more
  const handleLoadMore = useCallback(() => {
    fetchLibrary({
      platform: activeTab === 'all' ? undefined : activeTab,
      search: searchInput || undefined,
      offset: conversations.length,
    });
  }, [fetchLibrary, activeTab, searchInput, conversations.length]);

  const selectedConv = conversations.find(c => c.id === selectedId);

  return (
    <div className="flex-1 flex gap-4 min-h-0">
      {/* Left sidebar: conversation list */}
      <div className="flex-shrink-0 flex flex-col min-h-0" style={{ width: leftPanelWidth }}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-300">
            Library
            {stats && <span className="text-gray-500 font-normal ml-1">({stats.total})</span>}
          </h2>
          <button
            onClick={() => setImportOpen(true)}
            className="px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
          >
            Import
          </button>
        </div>

        {/* Platform filter tabs */}
        <div className="flex gap-1 mb-3">
          {PLATFORM_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                activeTab === tab.id
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab.label}
              {tab.id !== 'all' && stats?.byPlatform[tab.id] ? (
                <span className="ml-1 text-gray-600">{stats.byPlatform[tab.id]}</span>
              ) : null}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex gap-1 mb-3">
          <input
            type="text"
            placeholder="Search by title..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="flex-1 px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500"
          />
          <button
            onClick={handleSearch}
            className="px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-400 hover:text-gray-200"
          >
            Search
          </button>
        </div>

        {/* Conversation list / FTS results */}
        <div className="flex-1 overflow-y-auto space-y-1">
          {ftsSearching ? (
            <p className="text-xs text-gray-600 text-center py-4">Searching...</p>
          ) : searchInput.trim() && ftsResults.length > 0 ? (
            /* FTS search results */
            ftsResults.map((result) => (
              <button
                key={result.id}
                onClick={() => selectConversation(result.conversationId)}
                className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                  selectedId === result.conversationId
                    ? 'bg-gray-700 border border-gray-600'
                    : 'hover:bg-gray-800/50 border border-transparent'
                }`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  {result.sourcePlatform && platformBadge(result.sourcePlatform)}
                  <span className="text-xs text-gray-300 truncate flex-1">{result.conversationTitle}</span>
                </div>
                <p className="text-[10px] text-gray-500 truncate">{result.snippet}</p>
              </button>
            ))
          ) : searchInput.trim() && ftsResults.length === 0 ? (
            <p className="text-xs text-gray-600 text-center py-4">No results found</p>
          ) : loading && conversations.length === 0 ? (
            <p className="text-xs text-gray-600 text-center py-4">Loading...</p>
          ) : conversations.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-gray-500 mb-2">No imported conversations</p>
              <button
                onClick={() => setImportOpen(true)}
                className="text-xs text-indigo-400 hover:text-indigo-300"
              >
                Import your first archive
              </button>
            </div>
          ) : (
            <>
              {conversations.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => selectConversation(conv.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                    selectedId === conv.id
                      ? 'bg-gray-700 border border-gray-600'
                      : 'hover:bg-gray-800/50 border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    {platformBadge(conv.sourcePlatform)}
                    <span className="text-xs text-gray-300 truncate flex-1">{conv.title}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-gray-600">
                    <span>{conv.messageCount} msgs</span>
                    <span>{new Date(conv.createdAt).toLocaleDateString()}</span>
                  </div>
                </button>
              ))}
              {conversations.length < total && (
                <button
                  onClick={handleLoadMore}
                  className="w-full py-2 text-xs text-gray-500 hover:text-gray-300"
                >
                  Load more ({total - conversations.length} remaining)
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Horizontal drag handle */}
      <div
        onMouseDown={handleLeftPanelDragStart}
        className="group w-2 flex-shrink-0 flex items-center justify-center cursor-col-resize select-none"
        title="Drag to resize"
      >
        <div className="w-0.5 h-12 rounded-full bg-gray-700 group-hover:bg-indigo-500 transition-colors" />
      </div>

      {/* Right panel: conversation detail */}
      <div className="flex-1 flex flex-col min-h-0 pl-2">
        {selectedConv ? (
          <>
            <div className="flex items-center gap-2 mb-3">
              {platformBadge(selectedConv.sourcePlatform)}
              <h3 className="text-sm font-semibold text-gray-200 truncate">{selectedConv.title}</h3>
              <span className="text-[10px] text-gray-600">
                {new Date(selectedConv.createdAt).toLocaleString()}
              </span>
            </div>

            {/* Tab switcher */}
            <div className="flex items-center gap-2 mb-3">
              <button
                onClick={() => setLibraryDetailTab('messages')}
                className={`text-xs font-semibold uppercase tracking-wider transition-colors ${
                  libraryDetailTab === 'messages' ? 'text-gray-300' : 'text-gray-600 hover:text-gray-400'
                }`}
              >
                Messages
              </button>
              <span className="text-gray-700">|</span>
              <button
                onClick={() => {
                  setLibraryDetailTab('topics');
                  if (selectedId) {
                    useChatStore.getState().fetchSessionOutline(selectedId, 'imported');
                  }
                }}
                className={`text-xs font-semibold uppercase tracking-wider transition-colors ${
                  libraryDetailTab === 'topics' ? 'text-gray-300' : 'text-gray-600 hover:text-gray-400'
                }`}
              >
                Topics
              </button>
              <span className="text-gray-700">|</span>
              <button
                onClick={() => {
                  setLibraryDetailTab('knowledge');
                  if (selectedId) {
                    useChatStore.getState().fetchConversationKnowledge(selectedId, 'imported');
                  }
                }}
                className={`text-xs font-semibold uppercase tracking-wider transition-colors ${
                  libraryDetailTab === 'knowledge' ? 'text-gray-300' : 'text-gray-600 hover:text-gray-400'
                }`}
              >
                Knowledge
              </button>
            </div>

            {libraryDetailTab === 'messages' ? (
              <div ref={libraryMessagesRef} className="flex-1 overflow-y-auto space-y-3 pr-2">
                {messages.length === 0 ? (
                  <p className="text-xs text-gray-600 text-center py-4">Loading messages...</p>
                ) : (
                  messages.map((msg, idx) => (
                    <div
                      key={msg.id}
                      data-message-index={idx}
                      className={`rounded-lg p-3 text-sm transition-colors ${
                        msg.role === 'user'
                          ? 'bg-gray-800 text-gray-300'
                          : 'bg-gray-800/50 text-gray-400 border-l-2 border-indigo-600'
                      } ${
                        libraryHighlightRange &&
                        idx >= libraryHighlightRange.start &&
                        idx <= libraryHighlightRange.end
                          ? 'ring-1 ring-indigo-500/50'
                          : ''
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-medium uppercase text-gray-500">
                          {msg.role}
                        </span>
                        {msg.sourceModel && (
                          <span className="text-[10px] text-gray-600">{msg.sourceModel}</span>
                        )}
                        <span className="text-[10px] text-gray-700">
                          {new Date(msg.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="flex items-start gap-2">
                        <div className="whitespace-pre-wrap break-words text-xs leading-relaxed flex-1">
                          {msg.content}
                        </div>
                        {msg.role === 'assistant' && selectedId && (
                          <CopyWithProvenance
                            content={msg.content}
                            messageId={msg.id}
                            sourceType="imported"
                            sourceId={selectedId}
                            sourceModel={msg.sourceModel || 'unknown'}
                          />
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : libraryDetailTab === 'topics' ? (
              selectedId ? (
                <SessionOutline
                  sessionId={selectedId}
                  sourceType="imported"
                  onSectionClick={(section: OutlineSection) => {
                    setLibraryDetailTab('messages');
                    setLibraryHighlightRange({
                      start: section.startMessageIndex,
                      end: section.endMessageIndex,
                    });
                    // Scroll to section after tab switch
                    setTimeout(() => {
                      const container = libraryMessagesRef.current;
                      if (container) {
                        const targetEl = container.querySelector(
                          `[data-message-index="${section.startMessageIndex}"]`
                        );
                        if (targetEl) {
                          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                      }
                    }, 100);
                  }}
                />
              ) : null
            ) : libraryDetailTab === 'knowledge' ? (
              selectedId ? (
                <ConversationKnowledge
                  conversationId={selectedId}
                  sourceType="imported"
                />
              ) : null
            ) : null}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            Select a conversation to view its messages
          </div>
        )}
      </div>

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
