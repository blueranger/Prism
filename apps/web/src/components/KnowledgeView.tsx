'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { fetchKnowledgeRelations } from '@/lib/api';
import { useChatStore } from '@/stores/chat-store';
import KnowledgeGraph from './KnowledgeGraph';
import EntityDetail from './EntityDetail';
import TagCloud from './TagCloud';
import type { EntityType, RelationshipEvidence } from '@prism/shared';

const ENTITY_TABS: { id: EntityType | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'technology', label: 'Tech' },
  { id: 'concept', label: 'Concept' },
  { id: 'person', label: 'Person' },
  { id: 'project', label: 'Project' },
  { id: 'organization', label: 'Org' },
  { id: 'topic', label: 'Topic' },
];

export default function KnowledgeView() {
  const [entityFilter, setEntityFilter] = useState<EntityType | 'all'>('all');
  const [entitySearch, setEntitySearch] = useState('');
  const [relations, setRelations] = useState<RelationshipEvidence[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const entities = useChatStore((s) => s.knowledgeEntities);
  const tags = useChatStore((s) => s.knowledgeTags);
  const stats = useChatStore((s) => s.knowledgeStats);
  const selectedEntity = useChatStore((s) => s.knowledgeSelectedEntity);
  const extractionProgress = useChatStore((s) => s.knowledgeExtractionProgress);
  const fetchEntities = useChatStore((s) => s.fetchKnowledgeEntities);
  const fetchTags = useChatStore((s) => s.fetchKnowledgeTags);
  const fetchStats = useChatStore((s) => s.fetchKnowledgeStatsAction);
  const fetchGraph = useChatStore((s) => s.fetchKnowledgeGraph);
  const selectEntity = useChatStore((s) => s.selectKnowledgeEntity);
  const triggerExtraction = useChatStore((s) => s.triggerKnowledgeExtraction);
  const pollProgress = useChatStore((s) => s.pollExtractionProgress);

  // Initial load
  useEffect(() => {
    fetchEntities();
    fetchTags();
    fetchStats();
    fetchGraph();
    void fetchKnowledgeRelations({ limit: 12 }).then(setRelations);
  }, [fetchEntities, fetchTags, fetchStats, fetchGraph]);

  // Poll extraction progress when running
  useEffect(() => {
    if (extractionProgress?.status === 'running') {
      pollRef.current = setInterval(() => {
        pollProgress();
      }, 2000);
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      // Refresh data when extraction completes
      if (extractionProgress?.status === 'completed') {
        fetchEntities();
        fetchTags();
        fetchStats();
        fetchGraph();
        void fetchKnowledgeRelations({ limit: 12 }).then(setRelations);
      }
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [extractionProgress?.status, pollProgress, fetchEntities, fetchTags, fetchStats, fetchGraph]);

  // Filter entities
  const handleEntityFilter = useCallback((tab: EntityType | 'all') => {
    setEntityFilter(tab);
    fetchEntities({
      type: tab === 'all' ? undefined : tab,
      search: entitySearch || undefined,
    });
  }, [fetchEntities, entitySearch]);

  const handleEntitySearch = useCallback(() => {
    fetchEntities({
      type: entityFilter === 'all' ? undefined : entityFilter,
      search: entitySearch || undefined,
    });
  }, [fetchEntities, entityFilter, entitySearch]);

  const handleRunExtraction = useCallback(() => {
    triggerExtraction('openai', 'gpt-4o-mini');
  }, [triggerExtraction]);

  const isExtracting = extractionProgress?.status === 'running';

  return (
    <div className="flex-1 flex flex-col min-h-0 gap-3">
      {/* Top bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-gray-300">Knowledge Graph</h2>

        {/* Stats */}
        {stats && (
          <div className="flex gap-3 text-[10px] text-gray-500">
            <span>{stats.totalEntities} entities</span>
            <span>{stats.totalRelations} relations</span>
            <span>{stats.totalTags} tags</span>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Extraction progress */}
          {isExtracting && extractionProgress && (
            <div className="flex items-center gap-2 text-[10px] text-indigo-400">
              <span className="animate-pulse">Extracting...</span>
              <span>{extractionProgress.processedConversations}/{extractionProgress.totalConversations}</span>
              <span>({extractionProgress.entitiesFound} entities found)</span>
            </div>
          )}
          {extractionProgress?.status === 'completed' && (
            <span className="text-[10px] text-green-500">
              Done: {extractionProgress.entitiesFound} entities, {extractionProgress.relationsFound} relations
            </span>
          )}

          <button
            onClick={handleRunExtraction}
            disabled={isExtracting}
            className="px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isExtracting ? 'Extracting...' : 'Run Extraction'}
          </button>
        </div>
      </div>

      {/* Tag cloud */}
      {tags.length > 0 && (
        <TagCloud
          tags={tags}
          onTagClick={(tag) => {
            setEntitySearch(tag.name);
            fetchEntities({ search: tag.name });
          }}
        />
      )}

      {/* Main three-panel layout */}
      <div className="flex-1 flex gap-3 min-h-0">
        {/* Left: Entity list */}
        <div className="w-56 flex-shrink-0 flex flex-col min-h-0">
          {/* Type tabs */}
          <div className="flex flex-wrap gap-0.5 mb-2">
            {ENTITY_TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => handleEntityFilter(tab.id)}
                className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                  entityFilter === tab.id
                    ? 'bg-gray-700 text-white'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="flex gap-1 mb-2">
            <input
              type="text"
              placeholder="Search entities..."
              value={entitySearch}
              onChange={(e) => setEntitySearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleEntitySearch()}
              className="flex-1 px-2 py-1 text-[10px] bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500"
            />
          </div>

          {/* Entity list */}
          <div className="flex-1 overflow-y-auto space-y-0.5">
            {entities.length === 0 ? (
              <p className="text-[10px] text-gray-600 text-center py-4">No entities found</p>
            ) : (
              entities.map((ent) => (
                <button
                  key={ent.id}
                  onClick={() => {
                    selectEntity(ent.id);
                    fetchGraph({ center: ent.id });
                  }}
                  className={`w-full text-left px-2 py-1.5 rounded transition-colors ${
                    selectedEntity === ent.id
                      ? 'bg-gray-700 border border-gray-600'
                      : 'hover:bg-gray-800/50 border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: entityTypeColor(ent.entityType as EntityType) }}
                    />
                    <span className="text-xs text-gray-300 truncate flex-1">{ent.name}</span>
                    <span className="text-[10px] text-gray-600">{ent.mentionCount}</span>
                  </div>
                  {ent.description && (
                    <p className="text-[10px] text-gray-600 truncate ml-3 mt-0.5">{ent.description}</p>
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Center: Graph */}
        <div className="flex-1 flex flex-col min-h-0">
          <KnowledgeGraph />
        </div>

        {/* Right: Entity detail */}
        <div className="w-64 flex-shrink-0 flex flex-col min-h-0 border-l border-gray-800 pl-3">
          <EntityDetail />
          <div className="mt-3 rounded-lg border border-gray-800 bg-gray-900/60 p-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">Relationship Routing</div>
            <div className="space-y-2">
              {relations.length === 0 ? (
                <div className="text-[11px] text-gray-500">No routed relationship facts yet.</div>
              ) : (
                relations.map((relation) => (
                  <div key={relation.id} className="rounded border border-gray-800 bg-gray-950/40 px-2.5 py-2 text-[11px]">
                    <div className="text-gray-200">
                      {relation.sourceEntityName} {relation.relationType} {relation.targetEntityName}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-300">
                        {relation.routingDecision === 'graph_only'
                          ? 'Graph-only'
                          : relation.routingDecision === 'memory_candidate'
                            ? 'Memory candidate'
                            : 'Trigger candidate'}
                      </span>
                      <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-500">
                        mentions {relation.mentionCount}
                      </span>
                    </div>
                    {relation.promotionReason && (
                      <div className="mt-1 text-[10px] text-gray-500">reason: {relation.promotionReason}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function entityTypeColor(type: EntityType): string {
  const colors: Record<EntityType, string> = {
    technology: '#3B82F6',
    concept: '#8B5CF6',
    person: '#10B981',
    project: '#F59E0B',
    organization: '#EF4444',
    topic: '#6366F1',
  };
  return colors[type] || '#6B7280';
}
