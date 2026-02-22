'use client';

import { useEffect, useState, useCallback } from 'react';
import { useChatStore } from '@/stores/chat-store';
import ImportDialog from './ImportDialog';
import type { ImportPlatform } from '@prism/shared';

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

  // Filter by platform tab
  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab);
    fetchLibrary({ platform: tab === 'all' ? undefined : tab });
  }, [fetchLibrary]);

  // Search
  const handleSearch = useCallback(() => {
    fetchLibrary({
      platform: activeTab === 'all' ? undefined : activeTab,
      search: searchInput || undefined,
    });
  }, [fetchLibrary, activeTab, searchInput]);

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
      <div className="w-80 flex-shrink-0 flex flex-col min-h-0">
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

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto space-y-1">
          {loading && conversations.length === 0 ? (
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

      {/* Right panel: conversation detail */}
      <div className="flex-1 flex flex-col min-h-0 border-l border-gray-800 pl-4">
        {selectedConv ? (
          <>
            <div className="flex items-center gap-2 mb-3">
              {platformBadge(selectedConv.sourcePlatform)}
              <h3 className="text-sm font-semibold text-gray-200 truncate">{selectedConv.title}</h3>
              <span className="text-[10px] text-gray-600">
                {new Date(selectedConv.createdAt).toLocaleString()}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 pr-2">
              {messages.length === 0 ? (
                <p className="text-xs text-gray-600 text-center py-4">Loading messages...</p>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`rounded-lg p-3 text-sm ${
                      msg.role === 'user'
                        ? 'bg-gray-800 text-gray-300'
                        : 'bg-gray-800/50 text-gray-400 border-l-2 border-indigo-600'
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
                    <div className="whitespace-pre-wrap break-words text-xs leading-relaxed">
                      {msg.content}
                    </div>
                  </div>
                ))
              )}
            </div>
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
