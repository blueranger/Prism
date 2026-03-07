'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { MODELS } from '@prism/shared';
import type { FlowNode, FlowEdge, FlowConnectionType } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';
import { fetchFlowGraph } from '@/lib/api';

// --- Layout constants ---
const NODE_W = 200;
const NODE_H = 70;
const NODE_RX = 10;
const ROW_GAP = 110;
const COL_GAP = 240;
const PAD_TOP = 60;
const PAD_LEFT = 40;
const USER_NODE_W = 280;
/** Horizontal padding inside node for text */
const TEXT_PAD = 10;

// --- Color map per model ---
const MODEL_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  'gpt-4o':                    { bg: '#1a2636', border: '#3b82f6', text: '#93c5fd' },
  'claude-sonnet-4-20250514':  { bg: '#261a2e', border: '#a855f7', text: '#d8b4fe' },
  'gemini-2.5-flash':          { bg: '#1a2e26', border: '#22c55e', text: '#86efac' },
  user:                        { bg: '#262626', border: '#6b7280', text: '#d1d5db' },
};
const DEFAULT_COLOR = { bg: '#1f1f1f', border: '#f97316', text: '#fdba74' };

// --- Edge style per connection type ---
const EDGE_STYLES: Record<FlowConnectionType, { stroke: string; dasharray: string; label: string }> = {
  parallel:   { stroke: '#4b5563', dasharray: '',       label: '' },
  handoff:    { stroke: '#f97316', dasharray: '8 4',    label: 'Handoff' },
  compare:    { stroke: '#a855f7', dasharray: '4 4',    label: 'Compare' },
  synthesize: { stroke: '#22c55e', dasharray: '',       label: 'Synthesize' },
  agent:      { stroke: '#ef4444', dasharray: '6 3',    label: 'Agent' },
};

// --- Mode filter labels ---
const MODE_FILTERS: { id: FlowConnectionType | 'all'; label: string }[] = [
  { id: 'all',        label: 'All' },
  { id: 'parallel',   label: 'Parallel' },
  { id: 'handoff',    label: 'Handoff' },
  { id: 'compare',    label: 'Compare' },
  { id: 'synthesize', label: 'Synthesize' },
  { id: 'agent',      label: 'Agent' },
];

/** Positioned node for rendering. */
interface PositionedNode extends FlowNode {
  x: number;
  y: number;
  w: number;
  h: number;
}

export default function FlowVisualizer() {
  const sessionId = useChatStore((s) => s.sessionId);
  const flowGraph = useChatStore((s) => s.flowGraph);
  const selectedNode = useChatStore((s) => s.flowSelectedNode);
  const setFlowGraph = useChatStore((s) => s.setFlowGraph);
  const setSelectedNode = useChatStore((s) => s.setFlowSelectedNode);

  const [modeFilter, setModeFilter] = useState<FlowConnectionType | 'all'>('all');
  const svgRef = useRef<SVGSVGElement>(null);

  // Load flow graph when session changes
  useEffect(() => {
    if (sessionId) {
      fetchFlowGraph(sessionId).then(setFlowGraph);
    } else {
      setFlowGraph(null);
    }
  }, [sessionId, setFlowGraph]);

  // --- Layout calculation ---
  const layout = useCallback((): { nodes: PositionedNode[]; width: number; height: number } => {
    if (!flowGraph || flowGraph.nodes.length === 0) {
      return { nodes: [], width: 800, height: 400 };
    }

    const { nodes } = flowGraph;

    // Assign columns based on sourceModel
    const modelOrder = Object.keys(MODELS);
    const modelCol = new Map<string, number>();
    modelOrder.forEach((m, i) => modelCol.set(m, i));

    // Group nodes into rows by timestamp clustering.
    // Each user message starts a new "row group".
    // Consecutive assistant messages with the SAME mode fan out horizontally on one row.
    // When the mode changes (e.g. compare → synthesize), a new row begins.
    const positioned: PositionedNode[] = [];
    let currentRow = 0;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];

      if (node.type === 'user') {
        // User nodes span the center
        const totalWidth = modelOrder.length * COL_GAP;
        positioned.push({
          ...node,
          x: PAD_LEFT + (totalWidth - USER_NODE_W) / 2,
          y: PAD_TOP + currentRow * ROW_GAP,
          w: USER_NODE_W,
          h: NODE_H,
        });
        currentRow++;
      } else {
        // If this assistant node has a different mode from the previous
        // assistant node on the same row, start a new row first.
        const prev = nodes[i - 1];
        if (
          prev &&
          prev.type === 'assistant' &&
          prev.role === 'assistant' &&
          node.mode !== prev.mode
        ) {
          currentRow++;
        }

        // Assistant/agent nodes position by their model column
        const col = modelCol.get(node.sourceModel) ?? modelOrder.length;
        positioned.push({
          ...node,
          x: PAD_LEFT + col * COL_GAP + (COL_GAP - NODE_W) / 2,
          y: PAD_TOP + currentRow * ROW_GAP,
          w: NODE_W,
          h: NODE_H,
        });

        // Advance row when the next node is not a same-mode assistant
        const next = nodes[i + 1];
        if (!next || next.type === 'user' || next.type === 'agent') {
          currentRow++;
        }
      }
    }

    const maxX = Math.max(...positioned.map((n) => n.x + n.w), 800) + PAD_LEFT;
    const maxY = Math.max(...positioned.map((n) => n.y + n.h), 400) + PAD_TOP;

    return { nodes: positioned, width: maxX, height: maxY };
  }, [flowGraph]);

  const { nodes: positioned, width: svgW, height: svgH } = layout();

  // Filter edges by mode
  const filteredEdges = flowGraph?.edges.filter((e) =>
    modeFilter === 'all' || e.type === modeFilter
  ) ?? [];

  // Build node lookup for edge rendering
  const nodeMap = new Map(positioned.map((n) => [n.id, n]));

  if (!sessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600">
        Send a prompt in Parallel mode first to create a session.
      </div>
    );
  }

  if (!flowGraph || flowGraph.nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600">
        No conversation events yet. Interact in other modes to build the flow graph.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Mode filter toolbar */}
      <div className="flex items-center gap-2 mb-3 flex-shrink-0">
        <span className="text-xs text-gray-500 mr-1">Filter:</span>
        {MODE_FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setModeFilter(f.id)}
            className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
              modeFilter === f.id
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {f.label}
          </button>
        ))}

        {/* Legend */}
        <div className="ml-auto flex items-center gap-3">
          {Object.entries(EDGE_STYLES)
            .filter(([key]) => key !== 'parallel')
            .map(([key, style]) => (
              <div key={key} className="flex items-center gap-1">
                <svg width="24" height="8">
                  <line
                    x1="0" y1="4" x2="24" y2="4"
                    stroke={style.stroke}
                    strokeWidth="2"
                    strokeDasharray={style.dasharray}
                  />
                </svg>
                <span className="text-[10px] text-gray-500 capitalize">{key}</span>
              </div>
            ))}
        </div>
      </div>

      {/* Graph + Detail panel */}
      <div className="flex-1 flex gap-4 min-h-0">
        {/* SVG canvas */}
        <div className="flex-1 overflow-auto bg-gray-950 rounded-lg border border-gray-800">
          <svg
            ref={svgRef}
            width={svgW}
            height={svgH}
            className="select-none"
          >
            <defs>
              {/* Arrow markers for each edge type */}
              {Object.entries(EDGE_STYLES).map(([key, style]) => (
                <marker
                  key={key}
                  id={`arrow-${key}`}
                  markerWidth="8"
                  markerHeight="6"
                  refX="8"
                  refY="3"
                  orient="auto"
                >
                  <path d="M0,0 L8,3 L0,6 Z" fill={style.stroke} />
                </marker>
              ))}
            </defs>

            {/* Column headers */}
            {Object.keys(MODELS).map((modelId, i) => {
              const color = MODEL_COLORS[modelId] ?? DEFAULT_COLOR;
              const centerX = PAD_LEFT + i * COL_GAP + COL_GAP / 2;
              return (
                <text
                  key={modelId}
                  x={centerX}
                  y={24}
                  textAnchor="middle"
                  fill={color.text}
                  fontSize="12"
                  fontWeight="600"
                  opacity="0.5"
                >
                  {MODELS[modelId].displayName}
                </text>
              );
            })}

            {/* Edges */}
            {filteredEdges.map((edge) => {
              const from = nodeMap.get(edge.from);
              const to = nodeMap.get(edge.to);
              if (!from || !to) return null;

              const style = EDGE_STYLES[edge.type] ?? EDGE_STYLES.parallel;

              // Compute start/end points at node borders
              const startX = from.x + from.w / 2;
              const startY = from.y + from.h;
              const endX = to.x + to.w / 2;
              const endY = to.y;

              // Use a curved path for cross-column edges
              const isStraight = Math.abs(startX - endX) < 10;
              const midY = (startY + endY) / 2;

              const path = isStraight
                ? `M${startX},${startY} L${endX},${endY}`
                : `M${startX},${startY} C${startX},${midY} ${endX},${midY} ${endX},${endY}`;

              return (
                <g key={edge.id}>
                  <path
                    d={path}
                    fill="none"
                    stroke={style.stroke}
                    strokeWidth="2"
                    strokeDasharray={style.dasharray}
                    markerEnd={`url(#arrow-${edge.type})`}
                    opacity="0.7"
                  />
                  {/* Edge label for non-parallel */}
                  {edge.label && (
                    <text
                      x={(startX + endX) / 2 + (startX < endX ? 8 : -8)}
                      y={midY - 4}
                      fill={style.stroke}
                      fontSize="9"
                      fontWeight="500"
                      textAnchor="middle"
                      opacity="0.8"
                    >
                      {edge.label}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Nodes */}
            {positioned.map((node) => {
              const isUser = node.type === 'user';
              const isAgent = node.type === 'agent';
              const color = isAgent
                ? DEFAULT_COLOR
                : MODEL_COLORS[node.sourceModel] ?? DEFAULT_COLOR;
              const isSelected = selectedNode?.id === node.id;

              // Visible based on filter
              if (modeFilter !== 'all' && node.mode !== modeFilter && !isUser) {
                return null;
              }

              const displayName = isUser
                ? 'User'
                : isAgent
                  ? node.sourceModel
                  : MODELS[node.sourceModel]?.displayName ?? node.sourceModel;

              // Truncate content for preview — use a safe char limit
              // that fits within node width at ~5.5px per char (9px font)
              const maxChars = Math.floor((node.w - TEXT_PAD * 2) / 5.5);
              const contentLine1 = node.content.replace(/\n/g, ' ').slice(0, maxChars);
              const remaining = node.content.replace(/\n/g, ' ').slice(maxChars);
              const contentLine2 = remaining
                ? remaining.length > maxChars
                  ? remaining.slice(0, maxChars - 3) + '...'
                  : remaining
                : '';

              const clipId = `clip-${node.id.replace(/[^a-zA-Z0-9]/g, '')}`;

              return (
                <g
                  key={node.id}
                  onClick={() => setSelectedNode(isSelected ? null : node)}
                  className="cursor-pointer"
                >
                  {/* Clip path to prevent text overflow */}
                  <clipPath id={clipId}>
                    <rect
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={node.h}
                      rx={NODE_RX}
                    />
                  </clipPath>

                  {/* Node background */}
                  <rect
                    x={node.x}
                    y={node.y}
                    width={node.w}
                    height={node.h}
                    rx={NODE_RX}
                    fill={color.bg}
                    stroke={isSelected ? '#fff' : color.border}
                    strokeWidth={isSelected ? 2.5 : 1.5}
                    opacity={isSelected ? 1 : 0.9}
                  />

                  <g clipPath={`url(#${clipId})`}>
                    {/* Model label */}
                    <text
                      x={node.x + TEXT_PAD}
                      y={node.y + 18}
                      fill={color.text}
                      fontSize="11"
                      fontWeight="600"
                    >
                      {displayName}
                    </text>

                    {/* Mode badge */}
                    {!isUser && (
                      <text
                        x={node.x + node.w - TEXT_PAD}
                        y={node.y + 18}
                        fill={EDGE_STYLES[node.mode]?.stroke ?? '#666'}
                        fontSize="8"
                        fontWeight="500"
                        textAnchor="end"
                      >
                        {node.mode}
                      </text>
                    )}

                    {/* Content preview — up to 2 lines */}
                    <text
                      x={node.x + TEXT_PAD}
                      y={node.y + 36}
                      fill="#9ca3af"
                      fontSize="9"
                    >
                      {contentLine1}
                    </text>
                    {contentLine2 && (
                      <text
                        x={node.x + TEXT_PAD}
                        y={node.y + 50}
                        fill="#9ca3af"
                        fontSize="9"
                      >
                        {contentLine2}
                      </text>
                    )}
                  </g>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Detail panel */}
        {selectedNode && (
          <div className="w-80 flex-shrink-0 flex flex-col bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <div>
                <span
                  className="text-sm font-semibold"
                  style={{
                    color: (MODEL_COLORS[selectedNode.sourceModel] ?? DEFAULT_COLOR).text,
                  }}
                >
                  {selectedNode.type === 'user'
                    ? 'User'
                    : MODELS[selectedNode.sourceModel]?.displayName ?? selectedNode.sourceModel}
                </span>
                <span
                  className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded"
                  style={{
                    color: EDGE_STYLES[selectedNode.mode]?.stroke ?? '#666',
                    border: `1px solid ${EDGE_STYLES[selectedNode.mode]?.stroke ?? '#666'}`,
                  }}
                >
                  {selectedNode.mode}
                </span>
              </div>
              <button
                onClick={() => setSelectedNode(null)}
                className="text-gray-500 hover:text-gray-300 text-lg leading-none"
              >
                &times;
              </button>
            </div>

            <div className="px-4 py-2 border-b border-gray-800 text-[10px] text-gray-500">
              {new Date(selectedNode.timestamp).toLocaleString()}
              <span className="ml-2">ID: {selectedNode.id.slice(0, 8)}</span>
            </div>

            <div className="flex-1 p-4 overflow-auto">
              <p className="text-gray-300 text-sm whitespace-pre-wrap leading-relaxed">
                {selectedNode.content}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
