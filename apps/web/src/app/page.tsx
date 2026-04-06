'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { restoreSession, fetchSessionLinks, createSession, fetchSessionApi } from '@/lib/api';
import { MODELS, MAX_SELECTED_MODELS, DEFAULT_MODELS } from '@prism/shared';
import { useCommWebSocket } from '@/lib/useCommWebSocket';
import ModelSelector from '@/components/ModelSelector';
import ModeSelector from '@/components/ModeSelector';
import ObserverPanel from '@/components/ObserverPanel';
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
import TopicActionsPanel from '@/components/TopicActionsPanel';
import SessionLinkPicker from '@/components/SessionLinkPicker';
import LinkedSessionsBadge from '@/components/LinkedSessionsBadge';
import CommunicationView from '@/components/CommunicationView';
import CommNotificationBadge from '@/components/CommNotificationBadge';
import LibraryView from '@/components/LibraryView';
import KnowledgeView from '@/components/KnowledgeView';
import MemoryView from '@/components/MemoryView';
import TriggerView from '@/components/TriggerView';
import CostsView from '@/components/CostsView';
import ProvenanceView from '@/components/ProvenanceView';
import RAGSearch from '@/components/RAGSearch';
import SearchBar from '@/components/SearchBar';
import SearchResults from '@/components/SearchResults';
import NotionPagePicker from '@/components/NotionPagePicker';
import NotionSourceBadge from '@/components/NotionSourceBadge';
import SessionBootstrapBanner from '@/components/SessionBootstrapBanner';
import SessionCostBanner from '@/components/SessionCostBanner';

export default function Home() {
  const mode = useChatStore((s) => s.mode);
  const timeline = useChatStore((s) => s.timeline);
  const sessionId = useChatStore((s) => s.sessionId);
  const currentSession = useChatStore((s) => s.currentSession);
  const searchQuery = useChatStore((s) => s.searchQuery);
  const outlineTab = useChatStore((s) => s.outlineTab);
  const notionContextSources = useChatStore((s) => s.notionContextSources);
  const notionPickerOpen = useChatStore((s) => s.notionPickerOpen);
  const knowledgeHintsEnabled = useChatStore((s) => s.knowledgeHintsEnabled);
  const modelRecommendationsEnabled = useChatStore((s) => s.modelRecommendationsEnabled);
  const setSessionId = useChatStore((s) => s.setSessionId);
  const setCurrentSession = useChatStore((s) => s.setCurrentSession);
  const setNotionPickerOpen = useChatStore((s) => s.setNotionPickerOpen);
  const fetchNotionContextSources = useChatStore((s) => s.fetchNotionContextSources);
  const [leftPanelHidden, setLeftPanelHidden] = useState(false);
  const [rightPanelHidden, setRightPanelHidden] = useState(false);

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

  useEffect(() => {
    try {
      setLeftPanelHidden(localStorage.getItem('prism_leftPanelHidden') === 'true');
      setRightPanelHidden(localStorage.getItem('prism_rightPanelHidden') === 'true');
    } catch {}
  }, []);

  useEffect(() => {
    if ((mode !== 'parallel' && mode !== 'observer') || !sessionId) return;
    restoreSession(sessionId);
  }, [mode, sessionId]);

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

    try {
      const saved = localStorage.getItem('prism_modelRecommendationsEnabled');
      if (saved !== null) {
        useChatStore.getState().setModelRecommendationsEnabled(JSON.parse(saved) === true);
      }
    } catch {}
  }, []);

  const handleOpenNotionPicker = useCallback(async () => {
    let activeSessionId = sessionId;
    if (!activeSessionId) {
      activeSessionId = await createSession();
      if (!activeSessionId) return;
      setSessionId(activeSessionId);
      const session = await fetchSessionApi(activeSessionId);
      setCurrentSession(session);
    }

    await fetchNotionContextSources(activeSessionId);
    setNotionPickerOpen(true);
  }, [fetchNotionContextSources, sessionId, setCurrentSession, setNotionPickerOpen, setSessionId]);

  const showTimeline = timeline.length > 0;
  const canShowSidePanels = mode !== 'flow' && mode !== 'communication' && mode !== 'library' && mode !== 'knowledge' && mode !== 'memory' && mode !== 'triggers' && mode !== 'costs' && mode !== 'provenance' && mode !== 'rag';
  const canShowRightActions = canShowSidePanels && mode !== 'observer';

  const toggleLeftPanel = useCallback((hidden: boolean) => {
    setLeftPanelHidden(hidden);
    try { localStorage.setItem('prism_leftPanelHidden', String(hidden)); } catch {}
  }, []);

  const toggleRightPanel = useCallback((hidden: boolean) => {
    setRightPanelHidden(hidden);
    try { localStorage.setItem('prism_rightPanelHidden', String(hidden)); } catch {}
  }, []);

  return (
    <div className="h-screen overflow-hidden flex flex-col p-4 gap-4">
      {/* Header */}
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold tracking-tight text-gray-100">
            Prism
          </h1>
          <button
            onClick={() => {
              useChatStore.getState().newSession();
              useChatStore.getState().setMode('observer');
            }}
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
      <div className="relative flex-1 min-h-0">
        {showTimeline && canShowSidePanels && leftPanelHidden && (
          <div className="pointer-events-none absolute left-0 top-0 z-20">
            <button
              onClick={() => toggleLeftPanel(false)}
              className="pointer-events-auto rounded-lg border border-gray-800 bg-gray-900/90 px-3 py-2 text-xs text-gray-300 shadow-lg backdrop-blur transition-colors hover:bg-gray-800"
            >
              Show Timeline
            </button>
          </div>
        )}

        {sessionId && currentSession && canShowRightActions && rightPanelHidden && (
          <div className="pointer-events-none absolute right-0 top-0 z-20">
            <button
              onClick={() => toggleRightPanel(false)}
              className="pointer-events-auto rounded-lg border border-gray-800 bg-gray-900/90 px-3 py-2 text-xs text-gray-300 shadow-lg backdrop-blur transition-colors hover:bg-gray-800"
            >
              Show Actions
            </button>
          </div>
        )}

        <div className="flex h-full gap-4 min-h-0">
        {searchQuery ? (
          /* Search results overlay */
          <SearchResults />
        ) : (
          <>
            {/* Timeline sidebar (shows when there's history, hidden in flow/communication/library/knowledge/provenance/rag modes) */}
            {showTimeline && canShowSidePanels && !leftPanelHidden && (
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
                  <button
                    onClick={() => toggleLeftPanel(true)}
                    className="ml-auto rounded border border-gray-700 px-2 py-1 text-[10px] uppercase tracking-wide text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
                  >
                    Hide
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
            <div className="flex-1 flex flex-col gap-4 min-h-0 overflow-hidden">
              {(mode === 'parallel' || mode === 'observer') && sessionId && currentSession?.sessionType === 'topic' && (
                <SessionBootstrapBanner sessionId={sessionId} />
              )}
              {sessionId && canShowSidePanels && <SessionCostBanner sessionId={sessionId} />}
              {mode === 'observer' && <ObserverPanel />}
              {mode === 'parallel' && <ParallelView />}
              {mode === 'handoff' && <HandoffPanel />}
              {mode === 'compare' && <ComparePanel />}
              {mode === 'synthesize' && <SynthesizePanel />}
              {mode === 'agents' && <AgentDashboard />}
              {mode === 'flow' && <FlowVisualizer />}
              {mode === 'communication' && <CommunicationView />}
              {mode === 'library' && <LibraryView />}
              {mode === 'knowledge' && <KnowledgeView />}
              {mode === 'memory' && <MemoryView />}
              {mode === 'triggers' && <TriggerView />}
              {mode === 'costs' && <CostsView />}
              {mode === 'provenance' && <ProvenanceView />}
              {mode === 'rag' && <RAGSearch />}
            </div>

            {sessionId && currentSession && canShowRightActions && !rightPanelHidden && (
              <TopicActionsPanel onHide={() => toggleRightPanel(true)} />
            )}

          </>
        )}
        </div>
      </div>

      {/* Notion context sources bar + prompt input */}
      {(mode === 'observer' || mode === 'parallel' || mode === 'communication') && (
        <div className="flex flex-col gap-2">
          {/* Notion attached sources */}
          {sessionId && notionContextSources.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap px-1">
              {notionContextSources.map((src) => (
                <NotionSourceBadge key={src.id} sourceLabel={src.sourceLabel} />
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-2">
              <button
                onClick={() => { void handleOpenNotionPicker(); }}
                className="px-2 py-1.5 text-xs rounded bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 border border-gray-700 transition-colors whitespace-nowrap"
                title="Attach Notion page as context"
              >
                📄 Notion
              </button>
              <button
                onClick={() => useChatStore.getState().setModelRecommendationsEnabled(!modelRecommendationsEnabled)}
                aria-pressed={modelRecommendationsEnabled}
                className={`flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-xs transition-colors whitespace-nowrap ${
                  modelRecommendationsEnabled
                    ? 'bg-indigo-900/30 hover:bg-indigo-900/50 text-indigo-300 border-indigo-700'
                    : 'bg-gray-800 hover:bg-gray-700 text-gray-500 border-gray-700'
                }`}
                title={modelRecommendationsEnabled ? 'Model Recommendations: ON — click to disable' : 'Model Recommendations: OFF — click to enable'}
              >
                <span className="font-medium">AI Rec</span>
                <span className={`relative h-4 w-8 rounded-full transition-colors ${modelRecommendationsEnabled ? 'bg-indigo-500/70' : 'bg-gray-700'}`}>
                  <span
                    className={`absolute top-[2px] h-3 w-3 rounded-full bg-white transition-transform ${
                      modelRecommendationsEnabled ? 'translate-x-4' : 'translate-x-1'
                    }`}
                  />
                </span>
              </button>
            </div>
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
