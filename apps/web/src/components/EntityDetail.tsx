'use client';

import { useCallback } from 'react';
import { useChatStore } from '@/stores/chat-store';
import type { EntityType } from '@prism/shared';

const TYPE_COLORS: Record<EntityType, string> = {
  technology: 'bg-blue-900/50 text-blue-400',
  concept: 'bg-purple-900/50 text-purple-400',
  person: 'bg-green-900/50 text-green-400',
  project: 'bg-amber-900/50 text-amber-400',
  organization: 'bg-red-900/50 text-red-400',
  topic: 'bg-indigo-900/50 text-indigo-400',
};

const PLATFORM_BADGE: Record<string, { label: string; cls: string }> = {
  chatgpt: { label: 'GPT', cls: 'bg-green-900/50 text-green-400' },
  claude: { label: 'Claude', cls: 'bg-orange-900/50 text-orange-400' },
  gemini: { label: 'Gemini', cls: 'bg-blue-900/50 text-blue-400' },
};

export default function EntityDetail() {
  const detail = useChatStore((s) => s.knowledgeEntityDetail);
  const selectEntity = useChatStore((s) => s.selectKnowledgeEntity);
  const fetchGraph = useChatStore((s) => s.fetchKnowledgeGraph);
  const selectLibraryConversation = useChatStore((s) => s.selectLibraryConversation);
  const switchSession = useChatStore((s) => s.switchSession);
  const setMode = useChatStore((s) => s.setMode);

  const handleMentionClick = useCallback((m: any) => {
    if (m.source === 'imported' && m.conversationId) {
      // Navigate to Library mode and select this conversation
      setMode('library');
      selectLibraryConversation(m.conversationId);
    } else if (m.source === 'native' && m.sessionId) {
      // Navigate to the native Prism session
      setMode('parallel');
      switchSession(m.sessionId);
    }
  }, [setMode, selectLibraryConversation, switchSession]);

  if (!detail) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600 text-xs">
        Select an entity to view details
      </div>
    );
  }

  const { entity, mentions, relations } = detail;

  return (
    <div className="flex flex-col gap-3 overflow-y-auto">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${TYPE_COLORS[entity.entityType as EntityType] || 'bg-gray-700 text-gray-400'}`}>
            {entity.entityType}
          </span>
          <span className="text-[10px] text-gray-600">{entity.mentionCount} mentions</span>
        </div>
        <h3 className="text-sm font-semibold text-gray-200">{entity.name}</h3>
        {entity.description && (
          <p className="text-xs text-gray-400 mt-1">{entity.description}</p>
        )}
      </div>

      {/* Aliases */}
      {entity.aliases && entity.aliases.length > 0 && (
        <div>
          <h4 className="text-[10px] font-medium text-gray-500 uppercase mb-1">Aliases</h4>
          <div className="flex flex-wrap gap-1">
            {entity.aliases.map((alias: string, i: number) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 bg-gray-800 text-gray-400 rounded">
                {alias}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Meta */}
      <div className="text-[10px] text-gray-600 space-y-0.5">
        {entity.firstSeenAt && <p>First seen: {new Date(entity.firstSeenAt).toLocaleDateString()}</p>}
        <p>Created: {new Date(entity.createdAt).toLocaleDateString()}</p>
      </div>

      {/* Related Entities */}
      {relations.length > 0 && (
        <div>
          <h4 className="text-[10px] font-medium text-gray-500 uppercase mb-1">
            Related ({relations.length})
          </h4>
          <div className="space-y-1">
            {relations.map((rel: any) => (
              <button
                key={rel.id}
                onClick={() => {
                  const targetId = rel.sourceEntityId === entity.id ? rel.targetEntityId : rel.sourceEntityId;
                  selectEntity(targetId);
                  fetchGraph({ center: targetId });
                }}
                className="w-full text-left px-2 py-1 rounded bg-gray-800/50 hover:bg-gray-800 text-xs transition-colors"
              >
                <span className="text-gray-300">{rel.targetName}</span>
                <span className="text-[10px] text-gray-600 ml-1">({rel.relationType.replace('_', ' ')})</span>
                <span className={`text-[10px] ml-1 px-1 rounded ${TYPE_COLORS[rel.targetType as EntityType] || 'bg-gray-700 text-gray-400'}`}>
                  {rel.targetType}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Mentions */}
      {mentions.length > 0 && (
        <div>
          <h4 className="text-[10px] font-medium text-gray-500 uppercase mb-1">
            Conversations ({mentions.length})
          </h4>
          <div className="space-y-1">
            {mentions.map((m: any, i: number) => {
              const badge = m.sourcePlatform ? PLATFORM_BADGE[m.sourcePlatform] : null;
              return (
                <button
                  key={i}
                  onClick={() => handleMentionClick(m)}
                  className="w-full text-left px-2 py-1.5 rounded bg-gray-800/50 hover:bg-gray-700/50 text-xs transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-1.5">
                    {badge && (
                      <span className={`text-[9px] px-1 py-0.5 rounded flex-shrink-0 ${badge.cls}`}>
                        {badge.label}
                      </span>
                    )}
                    {m.source === 'native' && (
                      <span className="text-[9px] px-1 py-0.5 rounded flex-shrink-0 bg-gray-700 text-gray-400">
                        Prism
                      </span>
                    )}
                    <span className="text-gray-300 truncate">{m.conversationTitle || 'Untitled'}</span>
                  </div>
                  {m.contextSnippet && (
                    <p className="text-[10px] text-gray-600 mt-0.5 truncate">{m.contextSnippet}</p>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
