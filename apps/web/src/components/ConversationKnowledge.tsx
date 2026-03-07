'use client';

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useChatStore } from '@/stores/chat-store';
import type { EntityType, KnowledgeEntity } from '@prism/shared';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

const ENTITY_COLORS: Record<EntityType, string> = {
  technology: '#3B82F6',
  concept: '#8B5CF6',
  person: '#10B981',
  project: '#F59E0B',
  organization: '#EF4444',
  topic: '#6366F1',
};

const MIN_GRAPH_HEIGHT = 120;
const DEFAULT_GRAPH_RATIO = 0.6;
const MAX_GRAPH_RATIO = 0.85;

interface ConversationKnowledgeProps {
  conversationId: string;
  sourceType: 'native' | 'imported';
}

/* ─────────────────── Shared Graph Renderer ─────────────────── */
function GraphCanvas({
  graphRef,
  containerRef,
  graphData,
  dimensions,
  onNodeClick,
}: {
  graphRef: React.RefObject<any>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  graphData: { nodes: any[]; links: any[] };
  dimensions: { width: number; height: number };
  onNodeClick: (node: any) => void;
}) {
  return (
    <ForceGraph2D
      ref={graphRef}
      graphData={graphData}
      width={dimensions.width}
      height={dimensions.height}
      backgroundColor="transparent"
      nodeLabel={(node: any) => `${node.label} (${node.type})`}
      nodeColor={(node: any) => node.color || '#6B7280'}
      nodeVal={(node: any) => Math.max(1, (node.val || 1) * 0.7)}
      linkColor={() => '#374151'}
      linkWidth={(link: any) => Math.max(0.5, link.weight || 1)}
      linkDirectionalArrowLength={3}
      linkDirectionalArrowRelPos={1}
      onNodeClick={onNodeClick}
      enableNodeDrag={true}
      cooldownTicks={80}
      nodeCanvasObjectMode={() => 'after'}
      nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const label = node.label;
        const fontSize = Math.max(7, 10 / globalScale);
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#9CA3AF';
        ctx.fillText(label, node.x!, (node.y || 0) + (node.val || 1) * 1.2 + 1);
      }}
    />
  );
}

/* ─────────────────── Fullscreen Overlay ─────────────────── */
function FullscreenGraph({
  graphData,
  entities,
  tags,
  onClose,
}: {
  graphData: { nodes: any[]; links: any[] };
  entities: KnowledgeEntity[];
  tags: { id: string; name: string }[];
  onClose: () => void;
}) {
  const fgRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 800, height: 600 });
  const [selectedEntity, setSelectedEntity] = useState<KnowledgeEntity | null>(null);

  // Measure the graph area
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setDims({ width, height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Imperatively sync dimensions
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    if (typeof fg.width === 'function') fg.width(dims.width);
    if (typeof fg.height === 'function') fg.height(dims.height);
  }, [dims.width, dims.height]);

  const handleNodeClick = useCallback((node: any) => {
    const entity = entities.find(e => e.id === node.id);
    if (entity) setSelectedEntity(entity);
  }, [entities]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex">
      {/* Graph area */}
      <div ref={containerRef} className="flex-1 relative min-w-0">
        <GraphCanvas
          graphRef={fgRef}
          containerRef={containerRef}
          graphData={graphData}
          dimensions={dims}
          onNodeClick={handleNodeClick}
        />
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 rounded-lg bg-gray-800/80 hover:bg-gray-700 text-gray-300 hover:text-white flex items-center justify-center transition-colors text-lg"
          title="Close (Esc)"
        >
          ✕
        </button>
        {/* Hint */}
        <div className="absolute bottom-4 left-4 text-[10px] text-gray-600">
          Scroll to zoom · Drag nodes to rearrange · Click node to select · Esc to close
        </div>
      </div>

      {/* Right sidebar: entities + tags */}
      <div className="w-72 flex-shrink-0 flex flex-col border-l border-gray-800 bg-gray-950/80">
        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 p-3 border-b border-gray-800">
            {tags.map(tag => (
              <span
                key={tag.id}
                className="text-[10px] px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700"
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}
        {/* Entity list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          <div className="text-[10px] text-gray-600 mb-1 px-1">
            {entities.length} entities
          </div>
          {entities.map(entity => (
            <button
              key={entity.id}
              onClick={() => setSelectedEntity(selectedEntity?.id === entity.id ? null : entity)}
              className={`w-full text-left px-2 py-1.5 rounded transition-colors ${
                selectedEntity?.id === entity.id
                  ? 'bg-gray-700 border border-gray-600'
                  : 'hover:bg-gray-800/50 border border-transparent'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: ENTITY_COLORS[entity.entityType as EntityType] || '#6B7280' }}
                />
                <span className="text-xs text-gray-300 truncate flex-1">{entity.name}</span>
                <span className="text-[10px] text-gray-600">{entity.mentionCount}</span>
              </div>
              {selectedEntity?.id === entity.id && entity.description && (
                <p className="text-[11px] text-gray-500 mt-1 ml-3.5 leading-relaxed">{entity.description}</p>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────── Main Component ─────────────────── */
export default function ConversationKnowledge({ conversationId, sourceType }: ConversationKnowledgeProps) {
  const knowledge = useChatStore((s) => s.conversationKnowledge);
  const fetchKnowledge = useChatStore((s) => s.fetchConversationKnowledge);
  const [selectedEntity, setSelectedEntity] = useState<KnowledgeEntity | null>(null);
  const [expanded, setExpanded] = useState(false);
  const graphRef = useRef<any>(null);
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const [graphDimensions, setGraphDimensions] = useState({ width: 300, height: 300 });
  const [graphHeight, setGraphHeight] = useState(300);
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);
  const hasAutoSized = useRef(false);

  // Load knowledge on mount or when conversation changes
  useEffect(() => {
    fetchKnowledge(conversationId, sourceType);
    setSelectedEntity(null);
  }, [conversationId, sourceType, fetchKnowledge]);

  // Auto-size graph to 60% of outer container on first layout
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const { height } = entries[0].contentRect;
      if (!hasAutoSized.current && height > 100) {
        hasAutoSized.current = true;
        setGraphHeight(Math.max(MIN_GRAPH_HEIGHT, Math.floor(height * DEFAULT_GRAPH_RATIO)));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Track graph container's actual pixel size for ForceGraph2D
  useEffect(() => {
    const el = graphContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        setGraphDimensions({ width, height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Imperatively resize ForceGraph2D when dimensions change
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg) return;
    if (typeof fg.width === 'function') fg.width(graphDimensions.width);
    if (typeof fg.height === 'function') fg.height(graphDimensions.height);
  }, [graphDimensions.width, graphDimensions.height]);

  // Drag-to-resize handlers (vertical)
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartY.current = e.clientY;
    dragStartHeight.current = graphHeight;

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = ev.clientY - dragStartY.current;
      const outerEl = outerRef.current;
      const maxH = outerEl ? outerEl.clientHeight * MAX_GRAPH_RATIO : 600;
      const newHeight = Math.max(MIN_GRAPH_HEIGHT, Math.min(maxH, dragStartHeight.current + delta));
      setGraphHeight(newHeight);
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [graphHeight]);

  const forceGraphData = useMemo(() => {
    if (!knowledge?.graphData) return { nodes: [], links: [] };
    return {
      nodes: knowledge.graphData.nodes.map(n => ({
        id: n.id,
        label: n.label,
        type: n.type,
        size: n.size,
        color: n.color,
        val: n.size / 10,
      })),
      links: knowledge.graphData.edges.map(e => ({
        source: e.source,
        target: e.target,
        label: e.label,
        weight: e.weight,
      })),
    };
  }, [knowledge?.graphData]);

  const handleNodeClick = useCallback((node: any) => {
    const entity = knowledge?.entities.find(e => e.id === node.id);
    if (entity) setSelectedEntity(entity);
  }, [knowledge?.entities]);

  if (!knowledge || knowledge.loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-pulse text-indigo-400 text-sm">Loading knowledge...</div>
      </div>
    );
  }

  if (knowledge.entities.length === 0 && knowledge.tags.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-gray-500 mb-1">No entities found</p>
          <p className="text-[10px] text-gray-600">Run extraction from the Knowledge page first</p>
        </div>
      </div>
    );
  }

  const hasGraph = forceGraphData.nodes.length > 0;

  return (
    <>
      {/* Fullscreen overlay */}
      {expanded && hasGraph && (
        <FullscreenGraph
          graphData={forceGraphData}
          entities={knowledge.entities}
          tags={knowledge.tags}
          onClose={() => setExpanded(false)}
        />
      )}

      {/* Inline view */}
      <div ref={outerRef} className="flex-1 flex flex-col min-h-0">
        {/* Tags */}
        {knowledge.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2 flex-shrink-0">
            {knowledge.tags.map(tag => (
              <span
                key={tag.id}
                className="text-[10px] px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700"
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}

        {/* Force Graph (inline mini view) */}
        {hasGraph && (
          <div
            ref={graphContainerRef}
            className="bg-gray-900/50 rounded-lg overflow-hidden relative flex-shrink-0"
            style={{ height: graphHeight }}
          >
            <GraphCanvas
              graphRef={graphRef}
              containerRef={graphContainerRef}
              graphData={forceGraphData}
              dimensions={graphDimensions}
              onNodeClick={handleNodeClick}
            />
            {/* Expand button */}
            <button
              onClick={() => setExpanded(true)}
              className="absolute top-2 right-2 w-7 h-7 rounded-md bg-gray-800/70 hover:bg-gray-700 text-gray-400 hover:text-white flex items-center justify-center transition-colors"
              title="Expand to fullscreen"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          </div>
        )}

        {/* Drag handle to resize graph vs entity list */}
        {hasGraph && (
          <div
            onMouseDown={handleDragStart}
            className="group flex items-center justify-center h-3 cursor-row-resize flex-shrink-0 select-none"
            title="Drag to resize"
          >
            <div className="w-8 h-0.5 rounded-full bg-gray-700 group-hover:bg-indigo-500 transition-colors" />
          </div>
        )}

        {/* Entity list */}
        <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
          <div className="text-[10px] text-gray-600 mb-1">
            {knowledge.entities.length} entities
          </div>
          {knowledge.entities.map(entity => (
            <button
              key={entity.id}
              onClick={() => setSelectedEntity(selectedEntity?.id === entity.id ? null : entity)}
              className={`w-full text-left px-2 py-1.5 rounded transition-colors ${
                selectedEntity?.id === entity.id
                  ? 'bg-gray-700 border border-gray-600'
                  : 'hover:bg-gray-800/50 border border-transparent'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: ENTITY_COLORS[entity.entityType as EntityType] || '#6B7280' }}
                />
                <span className="text-xs text-gray-300 truncate flex-1">{entity.name}</span>
                <span className="text-[10px] text-gray-600">{entity.mentionCount}</span>
              </div>
              {selectedEntity?.id === entity.id && entity.description && (
                <p className="text-[10px] text-gray-500 mt-1 ml-3">{entity.description}</p>
              )}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
