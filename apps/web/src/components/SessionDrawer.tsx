'use client';

import { useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chat-store';
import {
  fetchSessions, deleteSessionApi, updateSessionTitle, switchToSession,
  fetchDecisions, createDecisionApi, deleteDecisionApi,
} from '@/lib/api';
import type { Session, Decision, DecisionType } from '@prism/shared';
import { MODELS } from '@prism/shared';

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const MODEL_COLORS: Record<string, string> = {
  openai: 'bg-green-500',
  anthropic: 'bg-orange-500',
  google: 'bg-blue-500',
};

export default function SessionDrawer() {
  const open = useChatStore((s) => s.sessionDrawerOpen);
  const setOpen = useChatStore((s) => s.setSessionDrawerOpen);
  const currentSessionId = useChatStore((s) => s.sessionId);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Tab: 'sessions' | 'preferences'
  const [tab, setTab] = useState<'sessions' | 'preferences'>('sessions');

  // Preferences state
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [newPrefContent, setNewPrefContent] = useState('');
  const [newPrefType, setNewPrefType] = useState<DecisionType>('preference');
  const [newPrefModel, setNewPrefModel] = useState('');

  useEffect(() => {
    if (open) {
      fetchSessions().then(setSessions);
      fetchDecisions().then(setDecisions);
    }
  }, [open]);

  if (!open) return null;

  const handleSwitch = async (id: string) => {
    await switchToSession(id);
    setOpen(false);
  };

  const handleDelete = async (id: string) => {
    await deleteSessionApi(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setConfirmDeleteId(null);
    // If we deleted the current session, start fresh
    if (id === currentSessionId) {
      useChatStore.getState().newSession();
    }
  };

  const handleTitleSave = async (id: string) => {
    if (editTitle.trim()) {
      await updateSessionTitle(id, editTitle.trim());
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title: editTitle.trim() } : s))
      );
    }
    setEditingId(null);
  };

  const handleAddDecision = async () => {
    const content = newPrefContent.trim();
    if (!content) return;
    const created = await createDecisionApi(
      newPrefType,
      content,
      newPrefModel || undefined
    );
    if (created) {
      setDecisions((prev) => [created, ...prev]);
      setNewPrefContent('');
      setNewPrefModel('');
    }
  };

  const handleDeleteDecision = async (id: string) => {
    await deleteDecisionApi(id);
    setDecisions((prev) => prev.filter((d) => d.id !== id));
  };

  return (
    <div className="fixed inset-y-0 right-0 w-80 bg-gray-900 border-l border-gray-700 z-50 flex flex-col shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTab('sessions')}
            className={`text-sm font-semibold transition-colors ${
              tab === 'sessions' ? 'text-gray-200' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            Sessions
          </button>
          <span className="text-gray-600">|</span>
          <button
            onClick={() => setTab('preferences')}
            className={`text-sm font-semibold transition-colors ${
              tab === 'preferences' ? 'text-gray-200' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            Preferences
          </button>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="text-gray-400 hover:text-gray-200 text-lg"
        >
          &times;
        </button>
      </div>

      {/* Preferences tab */}
      {tab === 'preferences' && (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Add new preference */}
          <div className="px-4 py-3 border-b border-gray-800 space-y-2">
            <div className="flex gap-2">
              <select
                value={newPrefType}
                onChange={(e) => setNewPrefType(e.target.value as DecisionType)}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
              >
                <option value="preference">Preference</option>
                <option value="observation">Observation</option>
              </select>
              <select
                value={newPrefModel}
                onChange={(e) => setNewPrefModel(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 flex-1"
              >
                <option value="">All models</option>
                {Object.keys(MODELS).map((id) => (
                  <option key={id} value={id}>{MODELS[id].displayName}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newPrefContent}
                onChange={(e) => setNewPrefContent(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddDecision(); }}
                placeholder="e.g. Always use Claude for diagrams"
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 placeholder-gray-500 outline-none focus:border-gray-500"
              />
              <button
                onClick={handleAddDecision}
                disabled={!newPrefContent.trim()}
                className="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Add
              </button>
            </div>
          </div>

          {/* Decision list */}
          <div className="flex-1 overflow-y-auto">
            {decisions.length === 0 && (
              <div className="px-4 py-6 text-center">
                <p className="text-gray-500 text-sm">No preferences yet</p>
                <p className="text-gray-600 text-xs mt-1">
                  Add preferences and observations to guide how LLMs respond.
                </p>
              </div>
            )}

            {decisions.map((d) => (
              <div
                key={d.id}
                className="px-4 py-2.5 border-b border-gray-800 group hover:bg-gray-800/30"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                          d.type === 'preference'
                            ? 'bg-blue-900/50 text-blue-300'
                            : 'bg-amber-900/50 text-amber-300'
                        }`}
                      >
                        {d.type}
                      </span>
                      {d.model && (
                        <span className="text-[10px] text-gray-500">
                          {MODELS[d.model]?.displayName ?? d.model}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-300 leading-relaxed">{d.content}</p>
                  </div>
                  <button
                    onClick={() => handleDeleteDecision(d.id)}
                    className="text-gray-600 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5"
                  >
                    Del
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Footer info */}
          <div className="px-4 py-2 border-t border-gray-800">
            <p className="text-[10px] text-gray-600">
              Active preferences are injected as system messages into every LLM call.
            </p>
          </div>
        </div>
      )}

      {/* Sessions tab */}
      {tab === 'sessions' && (
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 && (
          <p className="text-gray-500 text-sm px-4 py-6 text-center">No sessions yet</p>
        )}

        {sessions.map((session) => {
          const isCurrent = session.id === currentSessionId;
          const displayTitle = session.title || session.preview || session.id.slice(0, 8);

          return (
            <div
              key={session.id}
              className={`px-4 py-3 border-b border-gray-800 hover:bg-gray-800/50 cursor-pointer ${
                isCurrent ? 'bg-gray-800/70 border-l-2 border-l-blue-500' : ''
              }`}
            >
              {/* Title */}
              <div className="flex items-start justify-between gap-2">
                {editingId === session.id ? (
                  <input
                    autoFocus
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={() => handleTitleSave(session.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleTitleSave(session.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    className="flex-1 bg-gray-700 text-gray-100 text-sm px-2 py-0.5 rounded border border-gray-600 outline-none"
                  />
                ) : (
                  <button
                    onClick={() => handleSwitch(session.id)}
                    className="flex-1 text-left"
                  >
                    <span
                      className="text-sm text-gray-200 truncate block"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingId(session.id);
                        setEditTitle(session.title || '');
                      }}
                    >
                      {displayTitle}
                    </span>
                  </button>
                )}

                {/* Delete */}
                {confirmDeleteId === session.id ? (
                  <div className="flex gap-1">
                    <button
                      onClick={() => handleDelete(session.id)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="text-xs text-gray-500 hover:text-gray-300"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(session.id);
                    }}
                    className="text-gray-600 hover:text-red-400 text-xs"
                    title="Delete session"
                  >
                    Del
                  </button>
                )}
              </div>

              {/* Metadata */}
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-gray-500">
                  {session.messageCount} msgs
                </span>
                <span className="text-xs text-gray-600">&middot;</span>
                <span className="text-xs text-gray-500">
                  {formatRelativeTime(session.updatedAt)}
                </span>

                {/* Model color dots */}
                <div className="flex gap-1 ml-auto">
                  {session.models.map((model) => {
                    const provider = MODELS[model]?.provider;
                    const color = provider ? MODEL_COLORS[provider] : 'bg-gray-500';
                    return (
                      <span
                        key={model}
                        className={`w-2 h-2 rounded-full ${color}`}
                        title={MODELS[model]?.displayName ?? model}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
