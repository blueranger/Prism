'use client';

import { useChatStore } from '@/stores/chat-store';

export default function LinkedSessionsBadge() {
  const sessionId = useChatStore((s) => s.sessionId);
  const linkedSessions = useChatStore((s) => s.linkedSessions);
  const setLinkPickerOpen = useChatStore((s) => s.setLinkPickerOpen);

  if (!sessionId) return null;

  const hasLinks = linkedSessions.length > 0;

  return (
    <button
      onClick={() => setLinkPickerOpen(true)}
      className={`px-2 py-1 text-xs rounded border transition-colors ${
        hasLinks
          ? 'bg-purple-900/50 text-purple-300 border-purple-700 hover:bg-purple-800/50'
          : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600'
      }`}
    >
      {hasLinks ? `${linkedSessions.length} linked` : 'Link Memory'}
    </button>
  );
}
