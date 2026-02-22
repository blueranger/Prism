import { create } from 'zustand';
import type { OperationMode, TimelineEntry, AgentTask, FlowGraph, FlowNode, Session, SessionLink, ExternalThread, ExternalMessage, DraftReply, MonitorRule, ConnectorStatus, CommNotification, ImportedConversation, ImportedMessage, ImportPlatform, ImportProgress, SearchResult } from '@prism/shared';

export interface ModelResponse {
  model: string;
  content: string;
  done: boolean;
  error?: string;
}

/** Agent plan step for the dashboard */
export interface AgentPlanStep {
  id: string;
  target: string;
  description: string;
  dependsOn: string[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  output?: string;
  artifactCount?: number;
}

interface ChatState {
  mode: OperationMode;
  selectedModels: string[];
  responses: Record<string, ModelResponse>;
  isStreaming: boolean;
  sessionId: string | null;
  timeline: TimelineEntry[];

  // Handoff state
  handoffFromModel: string | null;
  handoffToModel: string | null;

  // Compare state
  compareOriginModel: string | null;
  compareOriginContent: string | null;

  // Synthesize state
  synthesizerModel: string | null;

  // Agent state
  agentTasks: AgentTask[];
  agentPlanSteps: AgentPlanStep[];
  agentPlanReasoning: string | null;
  agentIsExecuting: boolean;
  agentPlanMessage: string | null;
  agentFinalResult: { success: boolean; totalSteps: number; artifacts: { id: string; type: string; filePath?: string | null }[] } | null;

  // Flow state
  flowGraph: FlowGraph | null;
  flowSelectedNode: FlowNode | null;

  // Session management
  sessions: Session[];
  sessionDrawerOpen: boolean;
  linkedSessions: SessionLink[];
  linkPickerOpen: boolean;

  // Communication state
  commThreads: ExternalThread[];
  commSelectedThreadId: string | null;
  commThreadMessages: ExternalMessage[];
  commDrafts: DraftReply[];
  commRules: MonitorRule[];
  commConnectors: ConnectorStatus[];
  commNotifications: CommNotification[];
  commUnreadCount: number;
  commContentLoading: boolean;
  commQueueTask: string | null;   // label of the currently running queue task (null = idle)
  commQueuePending: number;       // number of tasks waiting in queue
  commConnectorSetupOpen: boolean;
  commRuleBuilderOpen: boolean;
  commEditingRule: MonitorRule | null;

  // Library state (Phase 7a)
  libraryConversations: ImportedConversation[];
  libraryTotal: number;
  librarySelectedId: string | null;
  libraryMessages: ImportedMessage[];
  libraryFilter: { platform?: string; search?: string };
  libraryLoading: boolean;
  libraryImporting: boolean;
  libraryStats: { total: number; byPlatform: Record<string, number> } | null;

  // Search state (Phase 7b)
  searchQuery: string;
  searchResults: SearchResult[];
  searchTotal: number;
  searchTimeMs: number;
  searchLoading: boolean;
  searchFilters: {
    source?: 'imported' | 'native';
    platform?: ImportPlatform;
    dateFrom?: string;
    dateTo?: string;
  };

  setMode: (mode: OperationMode) => void;
  toggleModel: (model: string) => void;
  setSelectedModels: (models: string[]) => void;
  startStreaming: () => void;
  startStreamingFor: (models: string[]) => void;
  appendChunk: (model: string, content: string) => void;
  markDone: (model: string, error?: string) => void;
  finishStreaming: () => void;
  setSessionId: (id: string) => void;
  clearResponses: () => void;
  setTimeline: (entries: TimelineEntry[]) => void;
  addTimelineEntry: (entry: TimelineEntry) => void;
  setHandoffFrom: (model: string | null) => void;
  setHandoffTo: (model: string | null) => void;
  startHandoffStreaming: (toModel: string) => void;

  // Compare
  setCompareOrigin: (model: string | null, content?: string | null) => void;

  // Synthesize
  setSynthesizerModel: (model: string | null) => void;

  // Agent
  setAgentTasks: (tasks: AgentTask[]) => void;
  setAgentPlanSteps: (steps: AgentPlanStep[]) => void;
  setAgentPlanReasoning: (reasoning: string | null) => void;
  updateAgentPlanStep: (stepId: string, update: Partial<AgentPlanStep>) => void;
  setAgentIsExecuting: (executing: boolean) => void;
  setAgentPlanMessage: (msg: string | null) => void;
  setAgentFinalResult: (result: ChatState['agentFinalResult']) => void;
  resetAgentState: () => void;

  // Flow
  setFlowGraph: (graph: FlowGraph | null) => void;
  setFlowSelectedNode: (node: FlowNode | null) => void;

  // Session management
  setSessions: (sessions: Session[]) => void;
  setSessionDrawerOpen: (open: boolean) => void;
  setLinkedSessions: (links: SessionLink[]) => void;
  setLinkPickerOpen: (open: boolean) => void;
  newSession: () => void;
  switchSession: (id: string) => void;

  // Communication
  setCommThreads: (threads: ExternalThread[]) => void;
  setCommSelectedThreadId: (id: string | null) => void;
  setCommThreadMessages: (messages: ExternalMessage[]) => void;
  setCommDrafts: (drafts: DraftReply[]) => void;
  setCommRules: (rules: MonitorRule[]) => void;
  setCommConnectors: (connectors: ConnectorStatus[]) => void;
  addCommNotification: (notification: CommNotification) => void;
  clearCommNotifications: () => void;
  setCommUnreadCount: (count: number) => void;
  setCommContentLoading: (loading: boolean) => void;
  setCommQueueStatus: (task: string | null, pending: number) => void;
  setCommConnectorSetupOpen: (open: boolean) => void;
  setCommRuleBuilderOpen: (open: boolean) => void;
  setCommEditingRule: (rule: MonitorRule | null) => void;

  // Library (Phase 7a)
  fetchLibrary: (opts?: { platform?: string; search?: string; offset?: number }) => Promise<void>;
  selectLibraryConversation: (id: string) => Promise<void>;
  importFile: (file: File, platform: ImportPlatform) => Promise<ImportProgress>;
  fetchLibraryStats: () => Promise<void>;
  setLibraryFilter: (filter: { platform?: string; search?: string }) => void;
  setLibraryImporting: (importing: boolean) => void;

  // Search (Phase 7b)
  setSearchQuery: (q: string) => void;
  setSearchFilters: (filters: ChatState['searchFilters']) => void;
  performSearch: () => Promise<void>;
  clearSearch: () => void;
  navigateToSearchResult: (result: SearchResult) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  mode: 'parallel',
  selectedModels: ['gpt-4o', 'claude-sonnet-4-20250514', 'gemini-2.5-flash'],
  responses: {},
  isStreaming: false,
  sessionId: null,
  timeline: [],
  handoffFromModel: null,
  handoffToModel: null,
  compareOriginModel: null,
  compareOriginContent: null,
  synthesizerModel: null,
  agentTasks: [],
  agentPlanSteps: [],
  agentPlanReasoning: null,
  agentIsExecuting: false,
  agentPlanMessage: null,
  agentFinalResult: null,
  flowGraph: null,
  flowSelectedNode: null,

  // Session management
  sessions: [],
  sessionDrawerOpen: false,
  linkedSessions: [],
  linkPickerOpen: false,

  // Communication
  commThreads: [],
  commSelectedThreadId: null,
  commThreadMessages: [],
  commDrafts: [],
  commRules: [],
  commConnectors: [],
  commNotifications: [],
  commUnreadCount: 0,
  commContentLoading: false,
  commQueueTask: null,
  commQueuePending: 0,
  commConnectorSetupOpen: false,
  commRuleBuilderOpen: false,
  commEditingRule: null,

  // Library
  libraryConversations: [],
  libraryTotal: 0,
  librarySelectedId: null,
  libraryMessages: [],
  libraryFilter: {},
  libraryLoading: false,
  libraryImporting: false,
  libraryStats: null,

  // Search
  searchQuery: '',
  searchResults: [],
  searchTotal: 0,
  searchTimeMs: 0,
  searchLoading: false,
  searchFilters: {},

  setMode: (mode) => set({ mode, responses: {} }),

  toggleModel: (model) =>
    set((state) => {
      const selected = state.selectedModels.includes(model)
        ? state.selectedModels.filter((m) => m !== model)
        : [...state.selectedModels, model];
      return { selectedModels: selected };
    }),

  setSelectedModels: (models) => set({ selectedModels: models }),

  startStreaming: () =>
    set((state) => {
      const responses: Record<string, ModelResponse> = {};
      for (const model of state.selectedModels) {
        responses[model] = { model, content: '', done: false };
      }
      return { isStreaming: true, responses };
    }),

  startStreamingFor: (models) =>
    set(() => {
      const responses: Record<string, ModelResponse> = {};
      for (const model of models) {
        responses[model] = { model, content: '', done: false };
      }
      return { isStreaming: true, responses };
    }),

  startHandoffStreaming: (toModel) =>
    set({
      isStreaming: true,
      responses: {
        [toModel]: { model: toModel, content: '', done: false },
      },
    }),

  appendChunk: (model, content) =>
    set((state) => {
      const existing = state.responses[model];
      if (!existing) return state;
      return {
        responses: {
          ...state.responses,
          [model]: { ...existing, content: existing.content + content },
        },
      };
    }),

  markDone: (model, error) =>
    set((state) => {
      const existing = state.responses[model];
      if (!existing) return state;
      return {
        responses: {
          ...state.responses,
          [model]: { ...existing, done: true, error },
        },
      };
    }),

  finishStreaming: () =>
    set((state) => {
      // Force all models to done: true so UI never shows stale "streaming..." badges
      const responses = { ...state.responses };
      for (const key of Object.keys(responses)) {
        if (!responses[key].done) {
          responses[key] = { ...responses[key], done: true };
        }
      }
      return { isStreaming: false, responses };
    }),

  setSessionId: (id) => {
    try { localStorage.setItem('prism_sessionId', id); } catch {}
    return set({ sessionId: id });
  },

  clearResponses: () => set({ responses: {} }),

  setTimeline: (entries) => set({ timeline: entries }),

  addTimelineEntry: (entry) =>
    set((state) => ({ timeline: [...state.timeline, entry] })),

  setHandoffFrom: (model) => set({ handoffFromModel: model }),

  setHandoffTo: (model) => set({ handoffToModel: model }),

  setCompareOrigin: (model, content) =>
    set({ compareOriginModel: model, compareOriginContent: content ?? null }),

  setSynthesizerModel: (model) => set({ synthesizerModel: model }),

  // Agent actions
  setAgentTasks: (tasks) => set({ agentTasks: tasks }),

  setAgentPlanSteps: (steps) => set({ agentPlanSteps: steps }),
  setAgentPlanReasoning: (reasoning) => set({ agentPlanReasoning: reasoning }),

  updateAgentPlanStep: (stepId, update) =>
    set((state) => ({
      agentPlanSteps: state.agentPlanSteps.map((s) =>
        s.id === stepId ? { ...s, ...update } : s
      ),
    })),

  setAgentIsExecuting: (executing) => set({ agentIsExecuting: executing }),

  setAgentPlanMessage: (msg) => set({ agentPlanMessage: msg }),

  setAgentFinalResult: (result) => set({ agentFinalResult: result }),

  resetAgentState: () =>
    set({
      agentTasks: [],
      agentPlanSteps: [],
      agentPlanReasoning: null,
      agentIsExecuting: false,
      agentPlanMessage: null,
      agentFinalResult: null,
    }),

  // Flow actions
  setFlowGraph: (graph) => set({ flowGraph: graph }),
  setFlowSelectedNode: (node) => set({ flowSelectedNode: node }),

  // Session management actions
  setSessions: (sessions) => set({ sessions }),
  setSessionDrawerOpen: (open) => set({ sessionDrawerOpen: open }),
  setLinkedSessions: (links) => set({ linkedSessions: links }),
  setLinkPickerOpen: (open) => set({ linkPickerOpen: open }),

  newSession: () => {
    try { localStorage.removeItem('prism_sessionId'); } catch {}
    set({
      sessionId: null,
      responses: {},
      timeline: [],
      handoffFromModel: null,
      handoffToModel: null,
      compareOriginModel: null,
      compareOriginContent: null,
      synthesizerModel: null,
      agentTasks: [],
      agentPlanSteps: [],
      agentPlanReasoning: null,
      agentIsExecuting: false,
      agentPlanMessage: null,
      agentFinalResult: null,
      flowGraph: null,
      flowSelectedNode: null,
      linkedSessions: [],
      sessionDrawerOpen: false,
      linkPickerOpen: false,
    });
  },

  switchSession: (id) => {
    try { localStorage.setItem('prism_sessionId', id); } catch {}
    set({
      sessionId: id,
      responses: {},
      timeline: [],
      handoffFromModel: null,
      handoffToModel: null,
      compareOriginModel: null,
      compareOriginContent: null,
      synthesizerModel: null,
      agentTasks: [],
      agentPlanSteps: [],
      agentPlanReasoning: null,
      agentIsExecuting: false,
      agentPlanMessage: null,
      agentFinalResult: null,
      flowGraph: null,
      flowSelectedNode: null,
      linkedSessions: [],
      sessionDrawerOpen: false,
    });
  },

  // Communication actions
  setCommThreads: (threads) => {
      const prev = get().commThreads;
      // Skip update if thread count and last-message timestamps haven't changed
      if (
        prev.length === threads.length &&
        prev.every((t, i) => t.id === threads[i].id && t.lastMessageAt === threads[i].lastMessageAt)
      ) {
        return;
      }
      set({ commThreads: threads });
    },
  setCommSelectedThreadId: (id) => set({ commSelectedThreadId: id, commThreadMessages: [] }),
  setCommThreadMessages: (messages) => set({ commThreadMessages: messages }),
  setCommDrafts: (drafts) => set({ commDrafts: drafts }),
  setCommRules: (rules) => set({ commRules: rules }),
  setCommConnectors: (connectors) => set({ commConnectors: connectors }),
  addCommNotification: (notification) =>
    set((state) => ({
      commNotifications: [notification, ...state.commNotifications],
      commUnreadCount: state.commUnreadCount + 1,
    })),
  clearCommNotifications: () => set({ commNotifications: [], commUnreadCount: 0 }),
  setCommUnreadCount: (count) => set({ commUnreadCount: count }),
  setCommContentLoading: (loading) => set({ commContentLoading: loading }),
  setCommQueueStatus: (task, pending) => set({ commQueueTask: task, commQueuePending: pending }),
  setCommConnectorSetupOpen: (open) => set({ commConnectorSetupOpen: open }),
  setCommRuleBuilderOpen: (open) => set({ commRuleBuilderOpen: open }),
  setCommEditingRule: (rule) => set({ commEditingRule: rule }),

  // Library actions
  fetchLibrary: async (opts) => {
    set({ libraryLoading: true });
    try {
      const { fetchImportedConversations } = await import('@/lib/api');
      const filter = opts ?? get().libraryFilter;
      const result = await fetchImportedConversations({
        platform: filter.platform,
        search: filter.search,
        offset: opts?.offset,
      });
      set({
        libraryConversations: result.conversations,
        libraryTotal: result.total,
        libraryFilter: { platform: filter.platform, search: filter.search },
      });
    } catch (err) {
      console.error('[library] fetch error:', err);
    } finally {
      set({ libraryLoading: false });
    }
  },

  selectLibraryConversation: async (id) => {
    set({ librarySelectedId: id, libraryMessages: [] });
    try {
      const { fetchImportedMessages } = await import('@/lib/api');
      const messages = await fetchImportedMessages(id);
      set({ libraryMessages: messages });
    } catch (err) {
      console.error('[library] fetch messages error:', err);
    }
  },

  importFile: async (file, platform) => {
    set({ libraryImporting: true });
    try {
      const { uploadImportFile } = await import('@/lib/api');
      const result = await uploadImportFile(file, platform);
      // Refresh library after import
      await get().fetchLibrary();
      await get().fetchLibraryStats();
      return result;
    } finally {
      set({ libraryImporting: false });
    }
  },

  fetchLibraryStats: async () => {
    try {
      const { fetchImportStats } = await import('@/lib/api');
      const stats = await fetchImportStats();
      set({ libraryStats: stats });
    } catch (err) {
      console.error('[library] fetch stats error:', err);
    }
  },

  setLibraryFilter: (filter) => set({ libraryFilter: filter }),
  setLibraryImporting: (importing) => set({ libraryImporting: importing }),

  // Search actions
  setSearchQuery: (q) => set({ searchQuery: q }),
  setSearchFilters: (filters) => set({ searchFilters: filters }),

  performSearch: async () => {
    const { searchQuery, searchFilters } = get();
    if (!searchQuery.trim()) return;
    set({ searchLoading: true });
    try {
      const { searchAll } = await import('@/lib/api');
      const result = await searchAll({
        query: searchQuery,
        source: searchFilters.source,
        platform: searchFilters.platform,
        dateFrom: searchFilters.dateFrom,
        dateTo: searchFilters.dateTo,
      });
      set({
        searchResults: result.results,
        searchTotal: result.total,
        searchTimeMs: result.queryTimeMs,
      });
    } catch (err) {
      console.error('[search] error:', err);
    } finally {
      set({ searchLoading: false });
    }
  },

  clearSearch: () => set({
    searchQuery: '',
    searchResults: [],
    searchTotal: 0,
    searchTimeMs: 0,
    searchFilters: {},
  }),

  navigateToSearchResult: (result) => {
    if (result.source === 'imported') {
      set({ mode: 'library' });
      get().selectLibraryConversation(result.conversationId);
    } else {
      set({ mode: 'parallel' });
      get().switchSession(result.conversationId);
    }
    get().clearSearch();
  },
}));
