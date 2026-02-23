'use client';

import type { OperationMode } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';

const MODES: { id: OperationMode; label: string; description: string }[] = [
  { id: 'parallel', label: 'Parallel', description: 'Send to all models at once' },
  { id: 'handoff', label: 'Handoff', description: 'Transfer context between models' },
  { id: 'compare', label: 'Compare', description: 'Cross-model evaluation and critique' },
  { id: 'synthesize', label: 'Synthesize', description: 'Merge best parts of multiple responses' },
  { id: 'agents', label: 'Agents', description: 'Execute tasks with specialized agents' },
  { id: 'flow', label: 'Flow', description: 'Visualize cross-model conversation flow' },
  { id: 'communication', label: 'Comms', description: 'Monitor and reply to external messages' },
  { id: 'library', label: 'Library', description: 'Browse imported conversation archives' },
  { id: 'knowledge', label: 'Knowledge', description: 'Explore knowledge graph from conversations' },
];

export default function ModeSelector() {
  const mode = useChatStore((s) => s.mode);
  const setMode = useChatStore((s) => s.setMode);
  const isStreaming = useChatStore((s) => s.isStreaming);

  return (
    <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
      {MODES.map((m) => (
        <button
          key={m.id}
          disabled={isStreaming}
          onClick={() => setMode(m.id)}
          title={m.description}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
            mode === m.id
              ? 'bg-indigo-600 text-white'
              : 'text-gray-400 hover:text-gray-200'
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
