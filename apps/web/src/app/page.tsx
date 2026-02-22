'use client';

import { useEffect } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { restoreSession, fetchSessionLinks } from '@/lib/api';
import { useCommWebSocket } from '@/lib/useCommWebSocket';
import ModelSelector from '@/components/ModelSelector';
import ModeSelector from '@/components/ModeSelector';
import ParallelView from '@/components/ParallelView';
import HandoffPanel from '@/components/HandoffPanel';
import ComparePanel from '@/components/ComparePanel';
import SynthesizePanel from '@/components/SynthesizePanel';
import AgentDashboard from '@/components/AgentDashboard';
import FlowVisualizer from '@/components/FlowVisualizer';
import Timeline from '@/components/Timeline';
import PromptInput from '@/components/PromptInput';
import SessionDrawer from '@/components/SessionDrawer';
import SessionLinkPicker from '@/components/SessionLinkPicker';
import LinkedSessionsBadge from '@/components/LinkedSessionsBadge';
import CommunicationView from '@/components/CommunicationView';
import CommNotificationBadge from '@/components/CommNotificationBadge';
import LibraryView from '@/components/LibraryView';
import SearchBar from '@/components/SearchBar';
import SearchResults from '@/components/SearchResults';

export default function Home() {
  const mode = useChatStore((s) => s.mode);
  const timeline = useChatStore((s) => s.timeline);
  const sessionId = useChatStore((s) => s.sessionId);
  const searchQuery = useChatStore((s) => s.searchQuery);

  // Connect to backend WebSocket for real-time notifications
  useCommWebSocket();

  // Restore session from localStorage on page load
  useEffect(() => {
    const stored = localStorage.getItem('prism_sessionId');
    if (stored && !useChatStore.getState().sessionId) {
      restoreSession(stored).then(() => {
        fetchSessionLinks(stored).then((links) => {
          useChatStore.getState().setLinkedSessions(links);
        });
      });
    }
  }, []);

  const showTimeline = timeline.length > 0;

  return (
    <div className="h-screen flex flex-col p-4 gap-4">
      {/* Header */}
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold tracking-tight text-gray-100">
            Prism
          </h1>
          <button
            onClick={() => useChatStore.getState().newSession()}
            className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 border border-gray-600 transition-colors"
          >
            + New
          </button>
          <button
            onClick={() => useChatStore.getState().setSessionDrawerOpen(true)}
            className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 border border-gray-600 transition-colors"
          >
            Sessions
          </button>
          {sessionId && <LinkedSessionsBadge />}
          <CommNotificationBadge />
          <ModeSelector />
        </div>
        <div className="flex items-center gap-3">
          <SearchBar />
          {mode === 'parallel' && <ModelSelector />}
        </div>
      </header>

      {/* Main content area */}
      <div className="flex-1 flex gap-4 min-h-0">
        {searchQuery ? (
          /* Search results overlay */
          <SearchResults />
        ) : (
          <>
            {/* Timeline sidebar (shows when there's history, hidden in flow/communication mode) */}
            {showTimeline && mode !== 'flow' && mode !== 'communication' && mode !== 'library' && (
              <div className="w-80 flex-shrink-0 flex flex-col border-r border-gray-800 pr-4">
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                  Timeline
                </h2>
                <Timeline />
              </div>
            )}

            {/* Active view */}
            <div className="flex-1 flex flex-col gap-4 min-h-0">
              {mode === 'parallel' && <ParallelView />}
              {mode === 'handoff' && <HandoffPanel />}
              {mode === 'compare' && <ComparePanel />}
              {mode === 'synthesize' && <SynthesizePanel />}
              {mode === 'agents' && <AgentDashboard />}
              {mode === 'flow' && <FlowVisualizer />}
              {mode === 'communication' && <CommunicationView />}
              {mode === 'library' && <LibraryView />}
            </div>
          </>
        )}
      </div>

      {/* Prompt input (visible for parallel and communication modes) */}
      {(mode === 'parallel' || mode === 'communication') && <PromptInput />}

      {/* Session management overlays */}
      <SessionDrawer />
      <SessionLinkPicker />
    </div>
  );
}
