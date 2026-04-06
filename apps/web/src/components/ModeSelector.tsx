'use client';

import type { OperationMode } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';

const MODES: { id: OperationMode; label: string; description: string }[] = [
  { id: 'observer', label: 'Observer', description: 'Work with one active model while others watch silently' },
  { id: 'parallel', label: 'Parallel', description: 'Send to all models at once' },
  { id: 'handoff', label: 'Handoff', description: 'Transfer context between models' },
  { id: 'compare', label: 'Compare', description: 'Cross-model evaluation and critique' },
  { id: 'synthesize', label: 'Synthesize', description: 'Merge best parts of multiple responses' },
  { id: 'agents', label: 'Agents', description: 'Execute tasks with specialized agents' },
  { id: 'flow', label: 'Flow', description: 'Visualize cross-model conversation flow' },
  { id: 'communication', label: 'Comms', description: 'Monitor and reply to external messages' },
  { id: 'library', label: 'Library', description: 'Browse imported conversation archives' },
  { id: 'knowledge', label: 'Knowledge', description: 'Explore knowledge graph from conversations' },
  { id: 'memory', label: 'Memory', description: 'Review curated assistant memory' },
  { id: 'triggers', label: 'Triggers', description: 'Review trigger candidates, schedules, and history' },
  { id: 'costs', label: 'Costs', description: 'Track per-turn, session, and monthly LLM spend' },
  { id: 'provenance', label: 'Provenance', description: 'Track & trace AI outputs' },
  { id: 'rag', label: 'KB', description: 'Search & ask questions across your knowledge base' },
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
