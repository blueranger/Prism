'use client';

import { useState, useCallback } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { fetchEntityDetail } from '@/lib/api';
import type { EntityType, EntityMention, KnowledgeHintMatch } from '@prism/shared';

const TYPE_COLORS: Record<EntityType, string> = {
  technology: 'bg-blue-900/50 text-blue-400',
  concept: 'bg-purple-900/50 text-purple-400',
  person: 'bg-green-900/50 text-green-400',
  project: 'bg-amber-900/50 text-amber-400',
  organization: 'bg-red-900/50 text-red-400',
  topic: 'bg-indigo-900/50 text-indigo-400',
};

interface ExpandedMentions {
  [entityId: string]: {
    mentions: EntityMention[];
    loading: boolean;
  };
}

export default function ContextualHintsPanel() {
  const matches = useChatStore((s) => s.knowledgeHintMatches);
  const dismissed = useChatStore((s) => s.knowledgeHintDismissed);
  const loading = useChatStore((s) => s.knowledgeHintLoading);
  const dismissHints = useChatStore((s) => s.dismissKnowledgeHints);

  const [expanded, setExpanded] = useState<ExpandedMentions>({});

  const handleToggleExpand = useCallback(async (match: KnowledgeHintMatch) => {
    const entityId = match.entity.id;

    // If already expanded, collapse
    if (expanded[entityId]) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[entityId];
        return next;
      });
      return;
    }

    // If mentions already loaded in the match, use them
    if (match.mentions.length > 0) {
      setExpanded((prev) => ({
        ...prev,
        [entityId]: { mentions: match.mentions, loading: false },
      }));
      return;
    }

    // Fetch entity detail to get mentions
    setExpanded((prev) => ({
      ...prev,
      [entityId]: { mentions: [], loading: true },
    }));

    try {
      const detail = await fetchEntityDetail(entityId);
      const mentions: EntityMention[] = detail.mentions ?? [];
      setExpanded((prev) => ({
        ...prev,
        [entityId]: { mentions, loading: false },
      }));
    } catch (err) {
      console.error('[ContextualHints] fetch mentions error:', err);
      setExpanded((prev) => ({
        ...prev,
        [entityId]: { mentions: [], loading: false },
      }));
    }
  }, [expanded]);

  const handleMentionClick = useCallback((mention: EntityMention) => {
    const store = useChatStore.getState();
    if (mention.sessionId) {
      store.setMode('parallel');
      store.switchSession(mention.sessionId);
    } else if (mention.conversationId) {
      store.setMode('library');
    }
  }, []);

  // Don't render if no matches, dismissed, or still loading with no results
  if (dismissed || (matches.length === 0 && !loading)) return null;

  return (
    <div className="bg-gray-800/60 border border-gray-700 rounded-lg px-3 py-2 text-sm animate-in fade-in slide-in-from-top-1 duration-200">
      {/* Header */}
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-gray-400 text-xs font-medium flex items-center gap-1.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow-500">
            <path d="M9 18h6" />
            <path d="M10 22h4" />
            <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
          </svg>
          Knowledge Hints
        </span>
        <button
          onClick={dismissHints}
          className="text-gray-600 hover:text-gray-400 transition-colors text-xs leading-none"
          title="Dismiss hints"
        >
          &times;
        </button>
      </div>

      {/* Loading state */}
      {loading && matches.length === 0 && (
        <div className="text-xs text-gray-500 py-1">Searching knowledge graph...</div>
      )}

      {/* Matched entities */}
      <div className="space-y-1.5">
        {matches.map((match) => {
          const { entity, totalConversations, matchedKeyword } = match;
          const entityExpanded = expanded[entity.id];
          const isExpanded = !!entityExpanded;

          return (
            <div key={entity.id} className="rounded px-2 py-1.5 hover:bg-gray-700/30 transition-colors">
              {/* Entity row */}
              <div className="flex items-center gap-2">
                <span className="text-gray-300 text-xs font-medium">{entity.name}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${TYPE_COLORS[entity.entityType as EntityType] || 'bg-gray-700 text-gray-400'}`}>
                  {entity.entityType}
                </span>
                <span className="text-gray-500 text-[10px]">
                  {entity.mentionCount} mention{entity.mentionCount !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Match reason + conversation hint */}
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <span className="text-gray-500 text-[10px]">
                  {matchedKeyword ? (
                    <>Matched by <span className="text-indigo-400/80">&quot;{matchedKeyword}&quot;</span> &mdash; {totalConversations} related conversation{totalConversations !== 1 ? 's' : ''}</>
                  ) : (
                    <>Previously discussed &mdash; {totalConversations} related conversation{totalConversations !== 1 ? 's' : ''}</>
                  )}
                </span>
                {totalConversations > 0 && (
                  <button
                    onClick={() => handleToggleExpand(match)}
                    className="text-indigo-400 hover:text-indigo-300 text-[10px] transition-colors"
                  >
                    {isExpanded ? '▾ collapse' : '▸ show conversations'}
                  </button>
                )}
              </div>

              {/* Expanded mentions list */}
              {isExpanded && entityExpanded && (
                <div className="mt-1.5 ml-2 space-y-0.5 border-l border-gray-700 pl-2">
                  {entityExpanded.loading ? (
                    <div className="text-[10px] text-gray-500">Loading...</div>
                  ) : entityExpanded.mentions.length === 0 ? (
                    <div className="text-[10px] text-gray-600">No conversation records found</div>
                  ) : (
                    entityExpanded.mentions.slice(0, 5).map((mention, idx) => (
                      <button
                        key={`${mention.entityId}-${mention.sessionId || mention.conversationId}-${idx}`}
                        onClick={() => handleMentionClick(mention)}
                        className="block w-full text-left text-[10px] text-gray-400 hover:text-indigo-300 transition-colors truncate"
                        title={mention.contextSnippet || undefined}
                      >
                        <span className="text-gray-500 mr-1">•</span>
                        {mention.conversationTitle || (mention.sessionId ? `Session ${mention.sessionId.slice(0, 8)}…` : 'Unknown')}
                        {mention.sessionId && !mention.conversationId && (
                          <span className="text-gray-600 ml-1">(session)</span>
                        )}
                        {mention.conversationId && (
                          <span className="text-gray-600 ml-1">(imported)</span>
                        )}
                      </button>
                    ))
                  )}
                  {entityExpanded.mentions.length > 5 && (
                    <div className="text-[10px] text-gray-600">
                      +{entityExpanded.mentions.length - 5} more
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
