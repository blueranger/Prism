'use client';

import { useRef, useCallback, useMemo, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useChatStore } from '@/stores/chat-store';
import type { KnowledgeGraphData, EntityType } from '@prism/shared';

// Dynamic import to avoid SSR issues with canvas
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

const ENTITY_TYPE_COLORS: Record<EntityType, string> = {
  technology: '#3B82F6',
  concept: '#8B5CF6',
  person: '#10B981',
  project: '#F59E0B',
  organization: '#EF4444',
  topic: '#6366F1',
};

const TYPE_FILTERS: { id: EntityType | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'technology', label: 'Tech' },
  { id: 'concept', label: 'Concept' },
  { id: 'person', label: 'Person' },
  { id: 'project', label: 'Project' },
  { id: 'organization', label: 'Org' },
  { id: 'topic', label: 'Topic' },
];

export default function KnowledgeGraph() {
  const graphRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 600, height: 400 });
  const [typeFilter, setTypeFilter] = useState<EntityType | 'all'>('all');
  const [minMentions, setMinMentions] = useState(1);

  const graphData = useChatStore((s) => s.knowledgeGraphData);
  const loading = useChatStore((s) => s.knowledgeLoading);
  const selectEntity = useChatStore((s) => s.selectKnowledgeEntity);
  const fetchGraph = useChatStore((s) => s.fetchKnowledgeGraph);

  // Measure container size
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Reload graph when filters change
  useEffect(() => {
    fetchGraph({
      type: typeFilter === 'all' ? undefined : typeFilter,
      minMentions,
    });
  }, [typeFilter, minMentions, fetchGraph]);

  // Convert our data format to react-force-graph format
  const forceGraphData = useMemo(() => {
    if (!graphData) return { nodes: [], links: [] };
    return {
      nodes: graphData.nodes.map(n => ({
        id: n.id,
        label: n.label,
        type: n.type,
        size: n.size,
        color: n.color,
        val: n.size / 10,
      })),
      links: graphData.edges.map(e => ({
        source: e.source,
        target: e.target,
        label: e.label,
        weight: e.weight,
      })),
    };
  }, [graphData]);

  const handleNodeClick = useCallback((node: any) => {
    selectEntity(node.id);
    fetchGraph({ center: node.id });
    // Center the graph on clicked node
    if (graphRef.current) {
      graphRef.current.centerAt(node.x, node.y, 500);
      graphRef.current.zoom(2, 500);
    }
  }, [selectEntity, fetchGraph]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-2">
        <div className="flex gap-0.5">
          {TYPE_FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setTypeFilter(f.id)}
              className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                typeFilter === f.id
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-500 hover:text-gray-300'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-[10px] text-gray-500">
          <span>Min mentions:</span>
          <input
            type="range"
            min="1"
            max="10"
            value={minMentions}
            onChange={(e) => setMinMentions(parseInt(e.target.value))}
            className="w-16 h-1 accent-indigo-500"
          />
          <span className="text-gray-400 w-3">{minMentions}</span>
        </div>
        {graphData && (
          <span className="text-[10px] text-gray-600 ml-auto">
            {graphData.nodes.length} nodes, {graphData.edges.length} edges
          </span>
        )}
      </div>

      {/* Graph canvas */}
      <div ref={containerRef} className="flex-1 bg-gray-900/50 rounded-lg overflow-hidden relative">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-600">
            Loading graph...
          </div>
        ) : forceGraphData.nodes.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-600">
            No entities to display. Run extraction first.
          </div>
        ) : (
          <ForceGraph2D
            ref={graphRef}
            graphData={forceGraphData}
            width={dimensions.width}
            height={dimensions.height}
            backgroundColor="transparent"
            nodeLabel={(node: any) => `${node.label} (${node.type})`}
            nodeColor={(node: any) => node.color || '#6B7280'}
            nodeVal={(node: any) => node.val || 1}
            linkColor={() => '#374151'}
            linkWidth={(link: any) => Math.max(0.5, link.weight || 1)}
            linkLabel={(link: any) => link.label?.replace('_', ' ') || ''}
            linkDirectionalArrowLength={3}
            linkDirectionalArrowRelPos={1}
            onNodeClick={handleNodeClick}
            enableNodeDrag={true}
            cooldownTicks={100}
            nodeCanvasObjectMode={() => 'after'}
            nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
              const label = node.label;
              const fontSize = Math.max(8, 12 / globalScale);
              ctx.font = `${fontSize}px sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'top';
              ctx.fillStyle = '#9CA3AF';
              ctx.fillText(label, node.x!, (node.y || 0) + (node.val || 1) * 1.5 + 2);
            }}
          />
        )}

        {/* Legend */}
        <div className="absolute bottom-2 left-2 flex flex-wrap gap-2">
          {Object.entries(ENTITY_TYPE_COLORS).map(([type, color]) => (
            <div key={type} className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
              <span className="text-[9px] text-gray-500">{type}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
