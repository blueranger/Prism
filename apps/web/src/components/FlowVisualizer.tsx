'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { MODELS } from '@prism/shared';
import type { FlowNode, FlowEdge, FlowConnectionType } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';
import { fetchFlowGraph } from '@/lib/api';

// --- Layout constants ---
const NODE_W = 300;
const NODE_H = 70;
const NODE_RX = 10;
const ROW_GAP = 120;
const PAD_TOP = 60;
const PAD_LEFT = 60;
const USER_NODE_W = 760;
const ACTION_NODE_W = 360;
const BRANCH_GAP = 36;
const CANVAS_W = 1100;
/** Horizontal padding inside node for text */
const TEXT_PAD = 10;

// --- Color map per model ---
const MODEL_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  'gpt-4o':                    { bg: '#1a2636', border: '#3b82f6', text: '#93c5fd' },
  'claude-sonnet-4-20250514':  { bg: '#261a2e', border: '#a855f7', text: '#d8b4fe' },
  'gemini-2.5-flash':          { bg: '#1a2e26', border: '#22c55e', text: '#86efac' },
  user:                        { bg: '#262626', border: '#6b7280', text: '#d1d5db' },
  action:                      { bg: '#2d1f14', border: '#f59e0b', text: '#fcd34d' },
};
const DEFAULT_COLOR = { bg: '#1f1f1f', border: '#f97316', text: '#fdba74' };

// --- Edge style per connection type ---
const EDGE_STYLES: Record<FlowConnectionType, { stroke: string; dasharray: string; label: string }> = {
  parallel:   { stroke: '#4b5563', dasharray: '',       label: '' },
  handoff:    { stroke: '#f97316', dasharray: '8 4',    label: 'Handoff' },
  compare:    { stroke: '#a855f7', dasharray: '4 4',    label: 'Compare' },
  synthesize: { stroke: '#22c55e', dasharray: '',       label: 'Synthesize' },
  observer:   { stroke: '#10b981', dasharray: '',       label: 'Observer' },
  observer_review: { stroke: '#14b8a6', dasharray: '4 4', label: 'Observer Review' },
  observer_alternative: { stroke: '#0ea5e9', dasharray: '4 4', label: 'Alternative' },
  observer_synthesize: { stroke: '#34d399', dasharray: '', label: 'Observer Synthesize' },
  agent:      { stroke: '#ef4444', dasharray: '6 3',    label: 'Agent' },
  action_spawn: { stroke: '#f59e0b', dasharray: '8 4', label: 'Spawn Action' },
  action_writeback: { stroke: '#38bdf8', dasharray: '3 4', label: 'Write Back' },
};

// --- Mode filter labels ---
const MODE_FILTERS: { id: FlowConnectionType | 'all'; label: string }[] = [
  { id: 'all',        label: 'All' },
  { id: 'parallel',   label: 'Parallel' },
  { id: 'handoff',    label: 'Handoff' },
  { id: 'compare',    label: 'Compare' },
  { id: 'synthesize', label: 'Synthesize' },
  { id: 'observer', label: 'Observer' },
  { id: 'observer_review', label: 'Observer Review' },
  { id: 'observer_alternative', label: 'Alternative' },
  { id: 'observer_synthesize', label: 'Observer Synth' },
  { id: 'agent',      label: 'Agent' },
  { id: 'action_spawn', label: 'Action' },
  { id: 'action_writeback', label: 'Writeback' },
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
      return { nodes: [], width: CANVAS_W + PAD_LEFT * 2, height: 400 };
    }

    const { nodes } = flowGraph;
    const mainCenterX = PAD_LEFT + CANVAS_W / 2;
    const userX = mainCenterX - USER_NODE_W / 2;
    const positioned: PositionedNode[] = [];
    const positionedMap = new Map<string, PositionedNode>();
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const outgoing = new Map<string, FlowEdge[]>();
    const incoming = new Map<string, FlowEdge[]>();

    for (const edge of flowGraph.edges) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      if (!incoming.has(edge.to)) incoming.set(edge.to, []);
      outgoing.get(edge.from)!.push(edge);
      incoming.get(edge.to)!.push(edge);
    }

    const placeNode = (node: FlowNode, row: number, x: number, w: number) => {
      const placed: PositionedNode = {
        ...node,
        x,
        y: PAD_TOP + row * ROW_GAP,
        w,
        h: NODE_H,
      };
      positioned.push(placed);
      positionedMap.set(node.id, placed);
    };

    const placeSpread = (group: FlowNode[], row: number, centerX: number, width: number) => {
      const totalWidth = group.length * width + Math.max(0, group.length - 1) * BRANCH_GAP;
      const startX = centerX - totalWidth / 2;
      group.forEach((node, index) => {
        placeNode(node, row, startX + index * (width + BRANCH_GAP), width);
      });
    };

    const handled = new Set<string>();
    let currentRow = 0;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (handled.has(node.id)) continue;

      if (node.type === 'user') {
        placeNode(node, currentRow, userX, USER_NODE_W);
        handled.add(node.id);

        const parallelChildren = (outgoing.get(node.id) ?? [])
          .filter((edge) => edge.type === 'parallel')
          .map((edge) => nodesById.get(edge.to))
          .filter((child): child is FlowNode => child !== undefined && !handled.has(child.id));

        if (parallelChildren.length > 0) {
          currentRow += 1;
          placeSpread(parallelChildren, currentRow, mainCenterX, NODE_W);
          parallelChildren.forEach((child) => handled.add(child.id));
        }

        currentRow += 1;
        continue;
      }

      const compareParents = (incoming.get(node.id) ?? []).filter((edge) => edge.type === 'compare');
      if (compareParents.length > 0) {
        const originId = compareParents[0].from;
        const siblingIds = (outgoing.get(originId) ?? [])
          .filter((edge) => edge.type === 'compare')
          .map((edge) => edge.to);
        const siblings = siblingIds
          .map((id) => nodesById.get(id))
          .filter((candidate): candidate is FlowNode => candidate !== undefined && !handled.has(candidate.id));

        if (siblings.length > 0) {
          const originPlaced = positionedMap.get(originId);
          const centerX = originPlaced ? originPlaced.x + originPlaced.w / 2 : mainCenterX;
          placeSpread(siblings, currentRow, centerX, NODE_W);
          siblings.forEach((sibling) => handled.add(sibling.id));
          currentRow += 1;
          continue;
        }
      }

      const synthParents = (incoming.get(node.id) ?? []).filter((edge) => edge.type === 'synthesize');
      if (synthParents.length > 0) {
        const parentCenters = synthParents
          .map((edge) => positionedMap.get(edge.from))
          .filter((parent): parent is PositionedNode => Boolean(parent))
          .map((parent) => parent.x + parent.w / 2);
        const centerX = parentCenters.length > 0
          ? parentCenters.reduce((sum, value) => sum + value, 0) / parentCenters.length
          : mainCenterX;
        placeNode(node, currentRow, centerX - NODE_W / 2, NODE_W);
        handled.add(node.id);
        currentRow += 1;
        continue;
      }

      const handoffParents = (incoming.get(node.id) ?? []).filter((edge) => edge.type === 'handoff');
      if (handoffParents.length > 0) {
        const parent = positionedMap.get(handoffParents[0].from);
        const x = parent ? parent.x : mainCenterX - NODE_W / 2;
        placeNode(node, currentRow, x, NODE_W);
        handled.add(node.id);
        currentRow += 1;
        continue;
      }

      if (node.type === 'action') {
        placeNode(node, currentRow, PAD_LEFT + CANVAS_W - ACTION_NODE_W, ACTION_NODE_W);
        handled.add(node.id);
        currentRow += 1;
        continue;
      }

      placeNode(node, currentRow, mainCenterX - NODE_W / 2, NODE_W);
      handled.add(node.id);
      currentRow += 1;
    }

    const maxX = Math.max(...positioned.map((n) => n.x + n.w), CANVAS_W) + PAD_LEFT;
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

            <text
              x={PAD_LEFT}
              y={26}
              fill="#6b7280"
              fontSize="12"
              fontWeight="600"
            >
              Session flow in time order
            </text>

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

              // Use a curved path only when action/writeback creates a visible branch
              const isStraight = Math.abs(startX - endX) < 24;
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
              const isAction = node.type === 'action';
              const color = isAction
                ? MODEL_COLORS.action
                : isAgent
                ? DEFAULT_COLOR
                : MODEL_COLORS[node.sourceModel] ?? DEFAULT_COLOR;
              const isSelected = selectedNode?.id === node.id;

              // Visible based on filter
              if (modeFilter !== 'all' && node.mode !== modeFilter && !isUser) {
                return null;
              }

              const displayName = isUser
                ? 'User'
                : isAction
                  ? node.actionType ? `${node.actionType} action` : 'Action'
                : isAgent
                  ? 'Agent'
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
                    {/* Node label */}
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

                    {/* Model / execution detail */}
                    {!isUser && !isAction && (
                      <text
                        x={node.x + TEXT_PAD}
                        y={node.y + 31}
                        fill="#6b7280"
                        fontSize="9"
                      >
                        {MODELS[node.sourceModel]?.displayName ?? node.sourceModel}
                      </text>
                    )}

                    {/* Content preview — up to 2 lines */}
                    <text
                      x={node.x + TEXT_PAD}
                      y={node.y + (isUser || isAction ? 36 : 45)}
                      fill="#9ca3af"
                      fontSize="9"
                    >
                      {contentLine1}
                    </text>
                    {contentLine2 && (
                      <text
                        x={node.x + TEXT_PAD}
                        y={node.y + (isUser || isAction ? 50 : 58)}
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
                    color: (
                      selectedNode.type === 'action'
                        ? MODEL_COLORS.action
                        : MODEL_COLORS[selectedNode.sourceModel]
                    )?.text ?? DEFAULT_COLOR.text,
                  }}
                >
                  {selectedNode.type === 'user'
                    ? 'User'
                    : selectedNode.type === 'action'
                      ? selectedNode.content
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

            {selectedNode.type === 'action' && (
              <div className="border-b border-gray-800 px-4 py-3 text-xs text-gray-400 space-y-1">
                <div>Type: {selectedNode.actionType ?? 'custom'}</div>
                <div>Status: {selectedNode.actionStatus ?? 'draft'}</div>
                {selectedNode.targetLabel && <div>Target: {selectedNode.targetLabel}</div>}
                {selectedNode.parentSessionId && <div>Parent: {selectedNode.parentSessionId.slice(0, 8)}</div>}
                {selectedNode.resultSummary && (
                  <div className="pt-1 text-gray-300">
                    Result: {selectedNode.resultSummary}
                  </div>
                )}
              </div>
            )}

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
