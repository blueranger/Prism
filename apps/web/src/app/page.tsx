'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { restoreSession, fetchSessionLinks } from '@/lib/api';
import { MODELS, MAX_SELECTED_MODELS, DEFAULT_MODELS } from '@prism/shared';
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
import SessionOutline from '@/components/SessionOutline';
import ConversationKnowledge from '@/components/ConversationKnowledge';
import PromptInput from '@/components/PromptInput';
import SessionDrawer from '@/components/SessionDrawer';
import SessionLinkPicker from '@/components/SessionLinkPicker';
import LinkedSessionsBadge from '@/components/LinkedSessionsBadge';
import CommunicationView from '@/components/CommunicationView';
import CommNotificationBadge from '@/components/CommNotificationBadge';
import LibraryView from '@/components/LibraryView';
import KnowledgeView from '@/components/KnowledgeView';
import ProvenanceView from '@/components/ProvenanceView';
import RAGSearch from '@/components/RAGSearch';
import SearchBar from '@/components/SearchBar';
import SearchResults from '@/components/SearchResults';
import NotionPagePicker from '@/components/NotionPagePicker';
import NotionSourceBadge from '@/components/NotionSourceBadge';

export default function Home() {
  const mode = useChatStore((s) => s.mode);
  const timeline = useChatStore((s) => s.timeline);
  const sessionId = useChatStore((s) => s.sessionId);
  const searchQuery = useChatStore((s) => s.searchQuery);
  const outlineTab = useChatStore((s) => s.outlineTab);
  const notionContextSources = useChatStore((s) => s.notionContextSources);
  const notionPickerOpen = useChatStore((s) => s.notionPickerOpen);
  const knowledgeHintsEnabled = useChatStore((s) => s.knowledgeHintsEnabled);

  // Resizable sidebar width
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const sidebarDragging = useRef(false);
  const sidebarDragStartX = useRef(0);
  const sidebarDragStartW = useRef(0);

  const handleSidebarDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarDragging.current = true;
    sidebarDragStartX.current = e.clientX;
    sidebarDragStartW.current = sidebarWidth;

    const onMove = (ev: MouseEvent) => {
      if (!sidebarDragging.current) return;
      const delta = ev.clientX - sidebarDragStartX.current;
      setSidebarWidth(Math.max(240, Math.min(600, sidebarDragStartW.current + delta)));
    };
    const onUp = () => {
      sidebarDragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarWidth]);

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
        useChatStore.getState().fetchNotionContextSources(stored);
      });
    }

    // Restore selected models from localStorage
    try {
      const savedModels = localStorage.getItem('prism_selectedModels');
      if (savedModels) {
        const parsed = JSON.parse(savedModels) as string[];
        // Validate: only keep model IDs that still exist in MODELS
        const valid = parsed.filter((m) => m in MODELS).slice(0, MAX_SELECTED_MODELS);
        if (valid.length > 0) {
          useChatStore.getState().setSelectedModels(valid);
        }
      }
    } catch {}
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
          <ModelSelector />
        </div>
      </header>

      {/* Main content area */}
      <div className="flex-1 flex gap-4 min-h-0">
        {searchQuery ? (
          /* Search results overlay */
          <SearchResults />
        ) : (
          <>
            {/* Timeline sidebar (shows when there's history, hidden in flow/communication/library/knowledge/provenance/rag modes) */}
            {showTimeline && mode !== 'flow' && mode !== 'communication' && mode !== 'library' && mode !== 'knowledge' && mode !== 'provenance' && mode !== 'rag' && (
              <div className="flex-shrink-0 flex flex-row min-h-0" style={{ width: sidebarWidth }}>
              <div className="flex-1 flex flex-col min-h-0 min-w-0 pr-2">
                <div className="flex items-center gap-2 mb-3">
                  <button
                    onClick={() => useChatStore.getState().setOutlineTab('timeline')}
                    className={`text-xs font-semibold uppercase tracking-wider transition-colors ${
                      outlineTab === 'timeline' ? 'text-gray-300' : 'text-gray-600 hover:text-gray-400'
                    }`}
                  >
                    Timeline
                  </button>
                  <span className="text-gray-700">|</span>
                  <button
                    onClick={() => {
                      useChatStore.getState().setOutlineTab('topics');
                      if (sessionId) {
                        useChatStore.getState().fetchSessionOutline(sessionId, 'native');
                      }
                    }}
                    className={`text-xs font-semibold uppercase tracking-wider transition-colors ${
                      outlineTab === 'topics' ? 'text-gray-300' : 'text-gray-600 hover:text-gray-400'
                    }`}
                  >
                    Topics
                  </button>
                  <span className="text-gray-700">|</span>
                  <button
                    onClick={() => {
                      useChatStore.getState().setOutlineTab('knowledge');
                      if (sessionId) {
                        useChatStore.getState().fetchConversationKnowledge(sessionId, 'native');
                      }
                    }}
                    className={`text-xs font-semibold uppercase tracking-wider transition-colors ${
                      outlineTab === 'knowledge' ? 'text-gray-300' : 'text-gray-600 hover:text-gray-400'
                    }`}
                  >
                    Knowledge
                  </button>
                </div>
                {outlineTab === 'timeline' ? (
                  <Timeline />
                ) : outlineTab === 'topics' ? (
                  sessionId ? (
                    <SessionOutline
                      sessionId={sessionId}
                      sourceType="native"
                      onSectionClick={() => useChatStore.getState().setOutlineTab('timeline')}
                    />
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
                      Start a session to see topics
                    </div>
                  )
                ) : outlineTab === 'knowledge' ? (
                  sessionId ? (
                    <ConversationKnowledge
                      conversationId={sessionId}
                      sourceType="native"
                    />
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
                      Start a session to see knowledge
                    </div>
                  )
                ) : null}
              </div>
              {/* Horizontal drag handle */}
              <div
                onMouseDown={handleSidebarDragStart}
                className="group w-2 flex-shrink-0 flex items-center justify-center cursor-col-resize select-none"
                title="Drag to resize"
              >
                <div className="w-0.5 h-12 rounded-full bg-gray-700 group-hover:bg-indigo-500 transition-colors" />
              </div>
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
              {mode === 'knowledge' && <KnowledgeView />}
              {mode === 'provenance' && <ProvenanceView />}
              {mode === 'rag' && <RAGSearch />}
            </div>
          </>
        )}
      </div>

      {/* Notion context sources bar + prompt input */}
      {(mode === 'parallel' || mode === 'communication') && (
        <div className="flex flex-col gap-2">
          {/* Notion attached sources */}
          {sessionId && notionContextSources.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap px-1">
              {notionContextSources.map((src) => (
                <NotionSourceBadge key={src.id} sourceLabel={src.sourceLabel} />
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            {sessionId && (
              <button
                onClick={() => useChatStore.getState().setNotionPickerOpen(true)}
                className="px-2 py-1.5 text-xs rounded bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 border border-gray-700 transition-colors whitespace-nowrap"
                title="Attach Notion page as context"
              >
                📄 Notion
              </button>
            )}
            <button
              onClick={() => useChatStore.getState().setKnowledgeHintsEnabled(!knowledgeHintsEnabled)}
              className={`px-2 py-1.5 text-xs rounded border transition-colors whitespace-nowrap ${
                knowledgeHintsEnabled
                  ? 'bg-yellow-900/30 hover:bg-yellow-900/50 text-yellow-400 border-yellow-800'
                  : 'bg-gray-800 hover:bg-gray-700 text-gray-500 border-gray-700'
              }`}
              title={knowledgeHintsEnabled ? 'Knowledge Hints: ON — click to disable' : 'Knowledge Hints: OFF — click to enable'}
            >
              💡
            </button>
            <div className="flex-1">
              <PromptInput />
            </div>
          </div>
        </div>
      )}

      {/* Session management overlays */}
      <SessionDrawer />
      <SessionLinkPicker />

      {/* Notion page picker modal */}
      {notionPickerOpen && sessionId && (
        <NotionPagePicker
          sessionId={sessionId}
          onClose={() => useChatStore.getState().setNotionPickerOpen(false)}
          onSourcesChanged={() => {
            if (sessionId) {
              useChatStore.getState().fetchNotionContextSources(sessionId);
            }
          }}
        />
      )}
    </div>
  );
}
