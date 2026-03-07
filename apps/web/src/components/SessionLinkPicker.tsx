'use client';

import { useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chat-store';
import {
  fetchSessions,
  fetchSessionLinks,
  linkSessionApi,
  unlinkSessionApi,
} from '@/lib/api';
import type { Session } from '@prism/shared';

export default function SessionLinkPicker() {
  const open = useChatStore((s) => s.linkPickerOpen);
  const setOpen = useChatStore((s) => s.setLinkPickerOpen);
  const sessionId = useChatStore((s) => s.sessionId);
  const setLinkedSessions = useChatStore((s) => s.setLinkedSessions);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open && sessionId) {
      setLoading(true);
      Promise.all([fetchSessions(), fetchSessionLinks(sessionId)]).then(
        ([allSessions, links]) => {
          // Exclude the current session
          setSessions(allSessions.filter((s) => s.id !== sessionId));
          setLinkedIds(new Set(links.map((l) => l.linkedSessionId)));
          setLoading(false);
        }
      );
    }
  }, [open, sessionId]);

  if (!open || !sessionId) return null;

  const handleToggle = async (targetId: string) => {
    if (linkedIds.has(targetId)) {
      await unlinkSessionApi(sessionId, targetId);
      setLinkedIds((prev) => {
        const next = new Set(prev);
        next.delete(targetId);
        return next;
      });
    } else {
      await linkSessionApi(sessionId, targetId);
      setLinkedIds((prev) => new Set(prev).add(targetId));
    }
    // Refresh linked sessions in store
    const links = await fetchSessionLinks(sessionId);
    setLinkedSessions(links);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-96 max-h-[80vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-semibold text-gray-200">
            Cross-Session Memory
          </h2>
          <button
            onClick={() => setOpen(false)}
            className="text-gray-400 hover:text-gray-200 text-lg"
          >
            &times;
          </button>
        </div>

        {/* Info text */}
        <p className="px-4 py-2 text-xs text-gray-400">
          Context from selected sessions will be summarized and included when
          you chat.
        </p>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto px-4 py-2">
          {loading && (
            <p className="text-gray-500 text-sm text-center py-4">Loading...</p>
          )}

          {!loading && sessions.length === 0 && (
            <p className="text-gray-500 text-sm text-center py-4">
              No other sessions available
            </p>
          )}

          {!loading &&
            sessions.map((session) => {
              const isLinked = linkedIds.has(session.id);
              const displayTitle =
                session.title || session.preview || session.id.slice(0, 8);

              return (
                <label
                  key={session.id}
                  className="flex items-start gap-3 py-2 border-b border-gray-800 last:border-b-0 cursor-pointer hover:bg-gray-800/30 rounded px-1"
                >
                  <input
                    type="checkbox"
                    checked={isLinked}
                    onChange={() => handleToggle(session.id)}
                    className="mt-0.5 accent-blue-500"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-gray-200 truncate block">
                      {displayTitle}
                    </span>
                    <span className="text-xs text-gray-500">
                      {session.messageCount} messages
                    </span>
                  </div>
                </label>
              );
            })}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-700">
          <button
            onClick={() => setOpen(false)}
            className="w-full px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-gray-200 rounded"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
