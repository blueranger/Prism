import { create } from 'zustand';
import { MAX_SELECTED_MODELS, MODELS, DEFAULT_MODELS } from '@prism/shared';
import type { OperationMode, TimelineEntry, AgentTask, FlowGraph, FlowNode, ObserverSnapshot, ObserverStatus, Session, SessionLink, ExternalThread, ExternalMessage, DraftReply, MonitorRule, ConnectorStatus, CommNotification, ImportedConversation, ImportedMessage, ImportPlatform, ImportProgress, SearchResult, KnowledgeGraphData, KnowledgeEntity, Tag, ExtractionProgress, SessionOutline, ContextSource, KnowledgeHintMatch, ThinkingConfig, WebPageRef, ContextDebugInfo } from '@prism/shared';

export interface ModelResponse {
  model: string;
  content: string;
  done: boolean;
  error?: string;
  stopReason?: string;
  mode?: string | null;
  messageId?: string;
  streamStatus?: 'streaming' | 'stalled' | 'completed' | 'error' | 'retrying';
  lastChunkAt?: number;
  partialRetained?: boolean;
  retryable?: boolean;
  attempt?: number;
  /** Accumulated thinking / chain-of-thought content */
  thinkingContent?: string;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  estimatedCostUsd?: number;
  pricingSource?: 'static_registry_estimate' | 'provider_usage_estimate' | 'provider_reconciled';
  debug?: {
    chunkCount: number;
    contentChars: number;
    thinkingChars: number;
    stopReason?: string;
    providerError?: string;
    lastEvent?: string;
    note?: string;
  };
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
  observerResponses: Record<string, ModelResponse>;
  parallelResponses: Record<string, ModelResponse>;
  compareResponses: Record<string, ModelResponse>;
  synthesizeResponses: Record<string, ModelResponse>;
  handoffResponses: Record<string, ModelResponse>;
  activeStreamTarget: 'observer' | 'parallel' | 'compare' | 'synthesize' | 'handoff' | null;
  isStreaming: boolean;
  sessionId: string | null;
  timeline: TimelineEntry[];
  lastContextDebug: Record<string, ContextDebugInfo> | null;

  // Handoff state
  handoffFromModel: string | null;
  handoffToModel: string | null;

  // Compare state
  compareOriginModel: string | null;
  compareOriginContent: string | null;

  // Synthesize state
  synthesizerModel: string | null;

  // Observer state
  observerActiveModel: string | null;
  observerModels: string[];
  observerSnapshots: Record<string, ObserverSnapshot>;
  observerStatuses: Record<string, ObserverStatus>;
  observerActionLoading: string | null;
  lastParallelPrompt: string | null;
  lastObserverPrompt: string | null;
  lastHandoffInstruction: string | null;
  lastCompareRequest: { originModel: string; criticModels: string[]; instruction?: string } | null;
  lastSynthesizeRequest: { sourceModels: string[]; synthesizerModel: string; instruction?: string } | null;

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
  currentSession: Session | null;
  topicActions: Session[];
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

  // Knowledge Graph state (Phase 7c)
  knowledgeGraphData: KnowledgeGraphData | null;
  knowledgeEntities: KnowledgeEntity[];
  knowledgeTags: Tag[];
  knowledgeStats: any;
  knowledgeSelectedEntity: string | null;
  knowledgeEntityDetail: any;
  knowledgeExtractionProgress: ExtractionProgress | null;
  knowledgeLoading: boolean;

  // Session Outline / Topic Navigation
  sessionOutline: SessionOutline | null;
  sessionOutlineLoading: boolean;
  outlineTab: 'timeline' | 'topics' | 'knowledge';
  outlineScrollTarget: number | null;
  outlineHighlightRange: { start: number; end: number } | null;

  // Per-conversation Knowledge
  conversationKnowledge: {
    entities: KnowledgeEntity[];
    tags: Tag[];
    graphData: KnowledgeGraphData | null;
    loading: boolean;
  } | null;

  // Notion context sources
  notionContextSources: ContextSource[];
  attachedWebPages: WebPageRef[];
  notionPickerOpen: boolean;
  notionSourcesLoading: boolean;

  // Provenance lookup (cross-component navigation)
  provenanceLookupCode: string | null;

  // Scenario 1 — Knowledge Hints while typing
  knowledgeHintsEnabled: boolean;
  knowledgeHintMatches: KnowledgeHintMatch[];
  knowledgeHintLoading: boolean;
  knowledgeHintDismissed: boolean;
  modelRecommendationsEnabled: boolean;

  // Thinking / Reasoning mode (per-model)
  thinkingConfig: Record<string, ThinkingConfig>;

  setMode: (mode: OperationMode) => void;
  toggleModel: (model: string) => void;
  setSelectedModels: (models: string[]) => void;
  startStreaming: () => void;
  startStreamingFor: (models: string[], target?: 'observer' | 'parallel' | 'compare' | 'synthesize' | 'handoff') => void;
  appendChunk: (model: string, content: string) => void;
  markDone: (
    model: string,
    error?: string,
    meta?: {
      stopReason?: string;
      promptTokens?: number;
      completionTokens?: number;
      reasoningTokens?: number;
      cachedTokens?: number;
      estimatedCostUsd?: number;
      pricingSource?: 'static_registry_estimate' | 'provider_usage_estimate' | 'provider_reconciled';
    }
  ) => void;
  markStalled: (
    model: string,
    opts?: {
      target?: 'observer' | 'parallel' | 'compare' | 'synthesize' | 'handoff';
      retryable?: boolean;
      error?: string;
      partialRetained?: boolean;
    }
  ) => void;
  keepPartial: (
    model: string,
    target?: 'observer' | 'parallel' | 'compare' | 'synthesize' | 'handoff'
  ) => void;
  reconcileCompletedResponse: (
    model: string,
    target?: 'observer' | 'parallel' | 'compare' | 'synthesize' | 'handoff'
  ) => void;
  finishStreaming: () => void;
  setLastParallelPrompt: (prompt: string | null) => void;
  setLastObserverPrompt: (prompt: string | null) => void;
  setLastHandoffInstruction: (instruction: string | null) => void;
  setLastCompareRequest: (value: ChatState['lastCompareRequest']) => void;
  setLastSynthesizeRequest: (value: ChatState['lastSynthesizeRequest']) => void;
  setSessionId: (id: string) => void;
  clearResponses: () => void;
  setLastContextDebug: (debug: Record<string, ContextDebugInfo> | null) => void;
  setTimeline: (entries: TimelineEntry[]) => void;
  addTimelineEntry: (entry: TimelineEntry) => void;
  setHandoffFrom: (model: string | null) => void;
  setHandoffTo: (model: string | null) => void;
  startHandoffStreaming: (toModel: string) => void;

  // Compare
  setCompareOrigin: (model: string | null, content?: string | null) => void;

  // Synthesize
  setSynthesizerModel: (model: string | null) => void;

  // Observer
  setObserverConfig: (activeModel: string | null, observerModels: string[]) => void;
  setObserverSnapshots: (snapshots: ObserverSnapshot[]) => void;
  upsertObserverSnapshot: (snapshot: ObserverSnapshot) => void;
  setObserverStatus: (model: string, status: ObserverStatus) => void;
  setObserverActionLoading: (value: string | null) => void;

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
  setCurrentSession: (session: Session | null) => void;
  setTopicActions: (actions: Session[]) => void;
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
  importFile: (file: File, platform: ImportPlatform, projectName?: string) => Promise<ImportProgress>;
  fetchLibraryStats: () => Promise<void>;
  setLibraryFilter: (filter: { platform?: string; search?: string }) => void;
  setLibraryImporting: (importing: boolean) => void;

  // Search (Phase 7b)
  setSearchQuery: (q: string) => void;
  setSearchFilters: (filters: ChatState['searchFilters']) => void;
  performSearch: () => Promise<void>;
  clearSearch: () => void;
  navigateToSearchResult: (result: SearchResult) => void;

  // Knowledge Graph (Phase 7c)
  fetchKnowledgeGraph: (opts?: any) => Promise<void>;
  fetchKnowledgeEntities: (opts?: any) => Promise<void>;
  fetchKnowledgeTags: (search?: string) => Promise<void>;
  selectKnowledgeEntity: (id: string) => Promise<void>;
  triggerKnowledgeExtraction: (provider?: string, model?: string) => Promise<void>;
  pollExtractionProgress: () => Promise<void>;
  fetchKnowledgeStatsAction: () => Promise<void>;

  // Outline actions
  fetchSessionOutline: (sessionId: string, sourceType: 'native' | 'imported') => Promise<void>;
  generateSessionOutline: (sessionId: string, sourceType: 'native' | 'imported', provider?: string, model?: string) => Promise<void>;
  setOutlineTab: (tab: 'timeline' | 'topics' | 'knowledge') => void;
  setOutlineScrollTarget: (index: number | null) => void;
  setOutlineHighlightRange: (range: { start: number; end: number } | null) => void;
  clearOutline: () => void;

  // Per-conversation Knowledge
  fetchConversationKnowledge: (id: string, sourceType: 'native' | 'imported') => Promise<void>;
  clearConversationKnowledge: () => void;

  // Notion context sources
  setNotionPickerOpen: (open: boolean) => void;
  setAttachedWebPages: (pages: WebPageRef[]) => void;
  fetchNotionContextSources: (sessionId: string) => Promise<void>;
  attachNotionSource: (sessionId: string, sourceId: string, sourceLabel: string) => Promise<void>;
  detachNotionSource: (id: string) => Promise<void>;

  // Provenance lookup
  lookupProvenance: (shortCode: string) => void;
  clearProvenanceLookup: () => void;

  // Knowledge Hints actions
  setKnowledgeHintsEnabled: (enabled: boolean) => void;
  setKnowledgeHintMatches: (matches: KnowledgeHintMatch[]) => void;
  setKnowledgeHintLoading: (loading: boolean) => void;
  dismissKnowledgeHints: () => void;
  clearKnowledgeHints: () => void;
  setModelRecommendationsEnabled: (enabled: boolean) => void;

  // Thinking actions
  setThinkingConfig: (model: string, config: ThinkingConfig) => void;
  clearThinkingConfig: (model: string) => void;
  appendThinkingChunk: (model: string, content: string) => void;
  setResponseDebug: (
    model: string,
    debug: Partial<NonNullable<ModelResponse['debug']>>,
    target?: 'observer' | 'parallel' | 'compare' | 'synthesize' | 'handoff'
  ) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  mode: 'observer',
  selectedModels: DEFAULT_MODELS,
  observerResponses: {},
  parallelResponses: {},
  compareResponses: {},
  synthesizeResponses: {},
  handoffResponses: {},
  activeStreamTarget: null,
  isStreaming: false,
  sessionId: null,
  timeline: [],
  lastContextDebug: null,
  handoffFromModel: null,
  handoffToModel: null,
  compareOriginModel: null,
  compareOriginContent: null,
  synthesizerModel: null,
  observerActiveModel: null,
  observerModels: [],
  observerSnapshots: {},
  observerStatuses: {},
  observerActionLoading: null,
  lastParallelPrompt: null,
  lastObserverPrompt: null,
  lastHandoffInstruction: null,
  lastCompareRequest: null,
  lastSynthesizeRequest: null,
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
  currentSession: null,
  topicActions: [],
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

  // Knowledge Graph
  knowledgeGraphData: null,
  knowledgeEntities: [],
  knowledgeTags: [],
  knowledgeStats: null,
  knowledgeSelectedEntity: null,
  knowledgeEntityDetail: null,
  knowledgeExtractionProgress: null,
  knowledgeLoading: false,

  // Outline
  sessionOutline: null,
  sessionOutlineLoading: false,
  outlineTab: 'timeline',
  outlineScrollTarget: null,
  outlineHighlightRange: null,

  // Per-conversation Knowledge
  conversationKnowledge: null,

  // Notion context sources
  notionContextSources: [],
  attachedWebPages: [],
  notionPickerOpen: false,
  notionSourcesLoading: false,

  // Provenance lookup
  provenanceLookupCode: null,

  // Knowledge Hints
  knowledgeHintsEnabled: true,
  knowledgeHintMatches: [],
  knowledgeHintLoading: false,
  knowledgeHintDismissed: false,
  modelRecommendationsEnabled: true,

  // Thinking — default ON for all models that support it, middle preset
  thinkingConfig: Object.fromEntries(
    Object.entries(MODELS)
      .filter(([, cfg]) => cfg.supportsThinking)
      .map(([id, cfg]) => [
        id,
        cfg.provider === 'openai'
          ? { enabled: true, effort: 'medium' as const }
          : { enabled: true, budgetTokens: 8192 },
      ]),
  ),

  setMode: (mode) => set({ mode }),

  toggleModel: (model) =>
    set((state) => {
      let selected: string[];
      if (state.selectedModels.includes(model)) {
        selected = state.selectedModels.filter((m) => m !== model);
      } else {
        // Enforce max selection limit
        if (state.selectedModels.length >= MAX_SELECTED_MODELS) return {};
        selected = [...state.selectedModels, model];
      }
      try { localStorage.setItem('prism_selectedModels', JSON.stringify(selected)); } catch {}
      return { selectedModels: selected };
    }),

  setSelectedModels: (models) => {
    const capped = models.slice(0, MAX_SELECTED_MODELS);
    try { localStorage.setItem('prism_selectedModels', JSON.stringify(capped)); } catch {}
    return set({ selectedModels: capped });
  },

  setObserverConfig: (activeModel, observerModels) =>
    set({
      observerActiveModel: activeModel,
      observerModels,
    }),

  setObserverSnapshots: (snapshots) =>
    set({
      observerSnapshots: Object.fromEntries(snapshots.map((snapshot) => [snapshot.model, snapshot])),
      observerStatuses: Object.fromEntries(snapshots.map((snapshot) => [snapshot.model, snapshot.status])),
    }),

  upsertObserverSnapshot: (snapshot) =>
    set((state) => ({
      observerSnapshots: {
        ...state.observerSnapshots,
        [snapshot.model]: snapshot,
      },
      observerStatuses: {
        ...state.observerStatuses,
        [snapshot.model]: snapshot.status,
      },
    })),

  setObserverStatus: (model, status) =>
    set((state) => ({
      observerStatuses: {
        ...state.observerStatuses,
        [model]: status,
      },
    })),

  setObserverActionLoading: (value) => set({ observerActionLoading: value }),

  setLastParallelPrompt: (prompt) => set({ lastParallelPrompt: prompt }),
  setLastObserverPrompt: (prompt) => set({ lastObserverPrompt: prompt }),
  setLastHandoffInstruction: (instruction) => set({ lastHandoffInstruction: instruction }),
  setLastCompareRequest: (value) => set({ lastCompareRequest: value }),
  setLastSynthesizeRequest: (value) => set({ lastSynthesizeRequest: value }),

  startStreaming: () =>
    set((state) => {
      const responses: Record<string, ModelResponse> = {};
      const now = Date.now();
      for (const model of state.selectedModels) {
        responses[model] = {
          model,
          content: '',
          done: false,
          mode: 'parallel',
          streamStatus: 'streaming',
          lastChunkAt: now,
          partialRetained: false,
          retryable: false,
          attempt: (state.parallelResponses[model]?.attempt ?? 0) + 1,
          debug: {
            chunkCount: 0,
            contentChars: 0,
            thinkingChars: 0,
            lastEvent: 'streaming',
          },
        };
      }
      return { isStreaming: true, activeStreamTarget: 'parallel', parallelResponses: responses, lastContextDebug: null };
    }),

  startStreamingFor: (models, target = 'parallel') =>
    set((state) => {
      const responses: Record<string, ModelResponse> = {};
      const now = Date.now();
      const previousMap =
        target === 'observer'
          ? state.observerResponses
          : target === 'compare'
          ? state.compareResponses
          : target === 'synthesize'
            ? state.synthesizeResponses
            : target === 'handoff'
              ? state.handoffResponses
              : state.parallelResponses;
      for (const model of models) {
        responses[model] = {
          model,
          content: '',
          done: false,
          mode: target,
          streamStatus: previousMap[model]?.content ? 'retrying' : 'streaming',
          lastChunkAt: now,
          partialRetained: false,
          retryable: false,
          attempt: (previousMap[model]?.attempt ?? 0) + 1,
          debug: {
            chunkCount: 0,
            contentChars: 0,
            thinkingChars: 0,
            lastEvent: previousMap[model]?.content ? 'retrying' : 'streaming',
          },
        };
      }
      return {
        isStreaming: true,
        activeStreamTarget: target,
        observerResponses: target === 'observer' ? responses : get().observerResponses,
        parallelResponses: target === 'parallel' ? responses : get().parallelResponses,
        compareResponses: target === 'compare' ? responses : get().compareResponses,
        synthesizeResponses: target === 'synthesize' ? responses : get().synthesizeResponses,
        handoffResponses: target === 'handoff' ? responses : get().handoffResponses,
        lastContextDebug: null,
      };
    }),

  startHandoffStreaming: (toModel) =>
    set((state) => ({
      isStreaming: true,
      activeStreamTarget: 'handoff',
      lastContextDebug: null,
      handoffResponses: {
        [toModel]: {
          model: toModel,
          content: '',
          done: false,
          mode: 'handoff',
          streamStatus: state.handoffResponses[toModel]?.content ? 'retrying' : 'streaming',
          lastChunkAt: Date.now(),
          partialRetained: false,
          retryable: false,
          attempt: (state.handoffResponses[toModel]?.attempt ?? 0) + 1,
          debug: {
            chunkCount: 0,
            contentChars: 0,
            thinkingChars: 0,
            lastEvent: state.handoffResponses[toModel]?.content ? 'retrying' : 'streaming',
          },
        },
      },
    })),

  appendChunk: (model, content) =>
    set((state) => {
      const target = state.activeStreamTarget ?? 'parallel';
      const mapKey =
        target === 'observer'
          ? 'observerResponses'
          : target === 'compare'
          ? 'compareResponses'
          : target === 'synthesize'
            ? 'synthesizeResponses'
            : target === 'handoff'
              ? 'handoffResponses'
              : 'parallelResponses';
      const responseMap = state[mapKey];
      const existing = responseMap[model];
      if (!existing) {
        return {
          [mapKey]: {
            ...responseMap,
            [model]: {
              model,
              content,
              done: false,
              mode: target,
              streamStatus: 'streaming',
              lastChunkAt: Date.now(),
              partialRetained: false,
              retryable: false,
              debug: {
                chunkCount: 1,
                contentChars: content.length,
                thinkingChars: 0,
                lastEvent: 'content_chunk',
              },
            },
          },
        };
      }
      return {
        [mapKey]: {
          ...responseMap,
          [model]: {
            ...existing,
            content: existing.content + content,
            lastChunkAt: Date.now(),
            streamStatus: 'streaming',
            retryable: false,
            partialRetained: false,
            error: undefined,
            debug: {
              chunkCount: (existing.debug?.chunkCount ?? 0) + 1,
              contentChars: (existing.debug?.contentChars ?? 0) + content.length,
              thinkingChars: existing.debug?.thinkingChars ?? 0,
              stopReason: existing.debug?.stopReason,
              providerError: undefined,
              lastEvent: 'content_chunk',
              note: existing.debug?.note,
            },
          },
        },
      };
    }),

  markDone: (model, error, meta) =>
    set((state) => {
      const target = state.activeStreamTarget ?? 'parallel';
      const mapKey =
        target === 'observer'
          ? 'observerResponses'
          : target === 'compare'
          ? 'compareResponses'
          : target === 'synthesize'
            ? 'synthesizeResponses'
            : target === 'handoff'
              ? 'handoffResponses'
              : 'parallelResponses';
      const responseMap = state[mapKey];
      const existing = responseMap[model];
      if (!existing) {
        return {
          [mapKey]: {
            ...responseMap,
            [model]: {
              model,
              content: '',
              done: true,
              error,
              stopReason: meta?.stopReason,
              promptTokens: meta?.promptTokens,
              completionTokens: meta?.completionTokens,
              reasoningTokens: meta?.reasoningTokens,
              cachedTokens: meta?.cachedTokens,
              estimatedCostUsd: meta?.estimatedCostUsd,
              pricingSource: meta?.pricingSource,
              mode: target,
              streamStatus: error ? 'error' : 'completed',
              retryable: Boolean(error && /timed out|timeout|stalled/i.test(error)),
              partialRetained: Boolean(error),
              debug: {
                chunkCount: 0,
                contentChars: 0,
                thinkingChars: 0,
                stopReason: meta?.stopReason,
                providerError: error,
                lastEvent: error ? 'error' : 'done',
              },
            },
          },
        };
      }
      return {
        [mapKey]: {
          ...responseMap,
          [model]: {
            ...existing,
            done: true,
            error,
            stopReason: meta?.stopReason ?? existing.stopReason,
            promptTokens: meta?.promptTokens ?? existing.promptTokens,
            completionTokens: meta?.completionTokens ?? existing.completionTokens,
            reasoningTokens: meta?.reasoningTokens ?? existing.reasoningTokens,
            cachedTokens: meta?.cachedTokens ?? existing.cachedTokens,
            estimatedCostUsd: meta?.estimatedCostUsd ?? existing.estimatedCostUsd,
            pricingSource: meta?.pricingSource ?? existing.pricingSource,
            streamStatus: error ? 'error' : 'completed',
            retryable: error ? (existing.retryable || Boolean(error && /timed out|timeout|stalled/i.test(error))) : false,
            partialRetained: error ? (existing.partialRetained || Boolean(error)) : false,
            debug: {
              chunkCount: existing.debug?.chunkCount ?? 0,
              contentChars: existing.debug?.contentChars ?? 0,
              thinkingChars: existing.debug?.thinkingChars ?? 0,
              stopReason: meta?.stopReason ?? existing.debug?.stopReason,
              providerError: error ?? existing.debug?.providerError,
              lastEvent: error ? 'error' : 'done',
              note: existing.debug?.note,
            },
          },
        },
      };
    }),

  markStalled: (model, opts) =>
    set((state) => {
      const target = opts?.target ?? state.activeStreamTarget ?? 'parallel';
      const mapKey =
        target === 'observer'
          ? 'observerResponses'
          : target === 'compare'
          ? 'compareResponses'
          : target === 'synthesize'
            ? 'synthesizeResponses'
            : target === 'handoff'
              ? 'handoffResponses'
              : 'parallelResponses';
      const responseMap = state[mapKey];
      const existing = responseMap[model];
      if (!existing) {
        return {
          [mapKey]: {
            ...responseMap,
            [model]: {
              model,
              content: '',
              done: opts?.retryable ?? false,
              error: opts?.error,
              mode: target,
              streamStatus: 'stalled',
              retryable: opts?.retryable ?? false,
              partialRetained: opts?.partialRetained ?? false,
              debug: {
                chunkCount: 0,
                contentChars: 0,
                thinkingChars: 0,
                providerError: opts?.error,
                lastEvent: 'stalled',
              },
            },
          },
        };
      }
      return {
        [mapKey]: {
          ...responseMap,
          [model]: {
            ...existing,
            done: opts?.retryable ? true : existing.done,
            error: opts?.error ?? existing.error,
            streamStatus: 'stalled',
            retryable: opts?.retryable ?? existing.retryable ?? false,
            partialRetained: opts?.partialRetained ?? existing.partialRetained ?? false,
            debug: {
              chunkCount: existing.debug?.chunkCount ?? 0,
              contentChars: existing.debug?.contentChars ?? 0,
              thinkingChars: existing.debug?.thinkingChars ?? 0,
              stopReason: existing.debug?.stopReason,
              providerError: opts?.error ?? existing.debug?.providerError,
              lastEvent: 'stalled',
              note: existing.debug?.note,
            },
          },
        },
      };
    }),

  keepPartial: (model, target) =>
    set((state) => {
      const resolvedTarget = target ?? state.activeStreamTarget ?? 'parallel';
      const mapKey =
        resolvedTarget === 'observer'
          ? 'observerResponses'
          : resolvedTarget === 'compare'
          ? 'compareResponses'
          : resolvedTarget === 'synthesize'
            ? 'synthesizeResponses'
            : resolvedTarget === 'handoff'
              ? 'handoffResponses'
              : 'parallelResponses';
      const responseMap = state[mapKey];
      const existing = responseMap[model];
      if (!existing) return state;
      return {
        [mapKey]: {
          ...responseMap,
          [model]: {
            ...existing,
            done: true,
            streamStatus: 'completed',
            retryable: false,
            partialRetained: true,
            error: undefined,
            debug: {
              chunkCount: existing.debug?.chunkCount ?? 0,
              contentChars: existing.debug?.contentChars ?? 0,
              thinkingChars: existing.debug?.thinkingChars ?? 0,
              stopReason: existing.debug?.stopReason,
              providerError: undefined,
              lastEvent: 'kept_partial',
              note: existing.debug?.note,
            },
          },
        },
      };
    }),

  reconcileCompletedResponse: (model, target) =>
    set((state) => {
      const resolvedTarget = target ?? state.activeStreamTarget ?? 'parallel';
      const mapKey =
        resolvedTarget === 'observer'
          ? 'observerResponses'
          : resolvedTarget === 'compare'
          ? 'compareResponses'
          : resolvedTarget === 'synthesize'
            ? 'synthesizeResponses'
            : resolvedTarget === 'handoff'
              ? 'handoffResponses'
              : 'parallelResponses';
      const responseMap = state[mapKey];
      const existing = responseMap[model];
      if (!existing || !existing.content.trim()) return state;
      return {
        [mapKey]: {
          ...responseMap,
          [model]: {
            ...existing,
            done: true,
            error: undefined,
            streamStatus: 'completed',
            retryable: false,
            partialRetained: false,
            debug: {
              chunkCount: existing.debug?.chunkCount ?? 0,
              contentChars: existing.debug?.contentChars ?? 0,
              thinkingChars: existing.debug?.thinkingChars ?? 0,
              stopReason: existing.stopReason ?? existing.debug?.stopReason,
              providerError: undefined,
              lastEvent: 'done',
              note: existing.debug?.note,
            },
          },
        },
      };
    }),

  finishStreaming: () =>
    set((state) => {
      const target = state.activeStreamTarget ?? 'parallel';
      const mapKey =
        target === 'observer'
          ? 'observerResponses'
          : target === 'compare'
          ? 'compareResponses'
          : target === 'synthesize'
            ? 'synthesizeResponses'
            : target === 'handoff'
              ? 'handoffResponses'
              : 'parallelResponses';
      const responses = { ...state[mapKey] };
      for (const key of Object.keys(responses)) {
        if (!responses[key].done) {
          responses[key] = {
            ...responses[key],
            done: true,
            streamStatus:
              responses[key].streamStatus === 'stalled'
                ? 'stalled'
                : responses[key].error
                ? 'error'
                : 'completed',
            debug: {
              chunkCount: responses[key].debug?.chunkCount ?? 0,
              contentChars: responses[key].debug?.contentChars ?? 0,
              thinkingChars: responses[key].debug?.thinkingChars ?? 0,
              stopReason: responses[key].debug?.stopReason,
              providerError: responses[key].debug?.providerError,
              lastEvent:
                responses[key].streamStatus === 'stalled'
                  ? 'stalled'
                  : responses[key].error
                  ? 'error'
                  : 'done',
              note: responses[key].debug?.note,
            },
          };
        }
      }
      return { isStreaming: false, activeStreamTarget: null, [mapKey]: responses };
    }),

  setSessionId: (id) => {
    try { localStorage.setItem('prism_sessionId', id); } catch {}
    return set({ sessionId: id });
  },

  clearResponses: () => set({
    observerResponses: {},
    parallelResponses: {},
    compareResponses: {},
    synthesizeResponses: {},
    handoffResponses: {},
    activeStreamTarget: null,
    lastContextDebug: null,
  }),
  setLastContextDebug: (debug) => set({ lastContextDebug: debug }),

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
  setCurrentSession: (session) => set({ currentSession: session }),
  setTopicActions: (actions) => set({ topicActions: actions }),
  setSessionDrawerOpen: (open) => set({ sessionDrawerOpen: open }),
  setLinkedSessions: (links) => set({ linkedSessions: links }),
  setLinkPickerOpen: (open) => set({ linkPickerOpen: open }),

  newSession: () => {
    try { localStorage.removeItem('prism_sessionId'); } catch {}
    set({
      sessionId: null,
      observerResponses: {},
      parallelResponses: {},
      compareResponses: {},
      synthesizeResponses: {},
      handoffResponses: {},
      activeStreamTarget: null,
      timeline: [],
      lastContextDebug: null,
      handoffFromModel: null,
      handoffToModel: null,
      compareOriginModel: null,
      compareOriginContent: null,
      synthesizerModel: null,
      observerActiveModel: null,
      observerModels: [],
      observerSnapshots: {},
      observerStatuses: {},
      observerActionLoading: null,
      lastParallelPrompt: null,
      lastObserverPrompt: null,
      lastHandoffInstruction: null,
      lastCompareRequest: null,
      lastSynthesizeRequest: null,
      agentTasks: [],
      agentPlanSteps: [],
      agentPlanReasoning: null,
      agentIsExecuting: false,
      agentPlanMessage: null,
      agentFinalResult: null,
      flowGraph: null,
      flowSelectedNode: null,
      linkedSessions: [],
      currentSession: null,
      topicActions: [],
      sessionDrawerOpen: false,
      linkPickerOpen: false,
      notionContextSources: [],
      attachedWebPages: [],
      notionPickerOpen: false,
      knowledgeHintMatches: [],
      knowledgeHintLoading: false,
      knowledgeHintDismissed: false,
    });
  },

  switchSession: (id) => {
    try { localStorage.setItem('prism_sessionId', id); } catch {}
    set({
      sessionId: id,
      observerResponses: {},
      parallelResponses: {},
      compareResponses: {},
      synthesizeResponses: {},
      handoffResponses: {},
      activeStreamTarget: null,
      timeline: [],
      lastContextDebug: null,
      handoffFromModel: null,
      handoffToModel: null,
      compareOriginModel: null,
      compareOriginContent: null,
      synthesizerModel: null,
      observerActiveModel: null,
      observerModels: [],
      observerSnapshots: {},
      observerStatuses: {},
      observerActionLoading: null,
      lastParallelPrompt: null,
      lastObserverPrompt: null,
      lastHandoffInstruction: null,
      lastCompareRequest: null,
      lastSynthesizeRequest: null,
      agentTasks: [],
      agentPlanSteps: [],
      agentPlanReasoning: null,
      agentIsExecuting: false,
      agentPlanMessage: null,
      agentFinalResult: null,
      flowGraph: null,
      flowSelectedNode: null,
      linkedSessions: [],
      currentSession: null,
      topicActions: [],
      sessionDrawerOpen: false,
      notionContextSources: [],
      attachedWebPages: [],
      notionPickerOpen: false,
      knowledgeHintMatches: [],
      knowledgeHintLoading: false,
      knowledgeHintDismissed: false,
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

  importFile: async (file, platform, projectName) => {
    set({ libraryImporting: true });
    try {
      const { uploadImportFile } = await import('@/lib/api');
      const result = await uploadImportFile(file, platform, projectName);
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
      set({ mode: 'observer' });
      get().switchSession(result.conversationId);
    }
    get().clearSearch();
  },

  // Knowledge Graph actions
  fetchKnowledgeGraph: async (opts) => {
    set({ knowledgeLoading: true });
    try {
      const { fetchGraphData } = await import('@/lib/api');
      const data = await fetchGraphData(opts);
      set({ knowledgeGraphData: data });
    } catch (err) {
      console.error('[knowledge] graph fetch error:', err);
    } finally {
      set({ knowledgeLoading: false });
    }
  },

  fetchKnowledgeEntities: async (opts) => {
    try {
      const { fetchEntities } = await import('@/lib/api');
      const result = await fetchEntities(opts);
      set({ knowledgeEntities: result.entities });
    } catch (err) {
      console.error('[knowledge] entities fetch error:', err);
    }
  },

  fetchKnowledgeTags: async (search) => {
    try {
      const { fetchTags } = await import('@/lib/api');
      const tags = await fetchTags(search);
      set({ knowledgeTags: tags });
    } catch (err) {
      console.error('[knowledge] tags fetch error:', err);
    }
  },

  selectKnowledgeEntity: async (id) => {
    set({ knowledgeSelectedEntity: id });
    try {
      const { fetchEntityDetail } = await import('@/lib/api');
      const detail = await fetchEntityDetail(id);
      set({ knowledgeEntityDetail: detail });
    } catch (err) {
      console.error('[knowledge] entity detail error:', err);
    }
  },

  triggerKnowledgeExtraction: async (provider, model) => {
    try {
      const { triggerExtraction } = await import('@/lib/api');
      await triggerExtraction(provider, model);
      set({ knowledgeExtractionProgress: { status: 'running', totalConversations: 0, processedConversations: 0, entitiesFound: 0, relationsFound: 0 } });
    } catch (err) {
      console.error('[knowledge] extraction trigger error:', err);
    }
  },

  pollExtractionProgress: async () => {
    try {
      const { fetchExtractionProgress } = await import('@/lib/api');
      const progress = await fetchExtractionProgress();
      set({ knowledgeExtractionProgress: progress });
    } catch (err) {
      console.error('[knowledge] progress poll error:', err);
    }
  },

  fetchKnowledgeStatsAction: async () => {
    try {
      const { fetchKnowledgeStats } = await import('@/lib/api');
      const stats = await fetchKnowledgeStats();
      set({ knowledgeStats: stats });
    } catch (err) {
      console.error('[knowledge] stats fetch error:', err);
    }
  },

  // Outline actions
  fetchSessionOutline: async (sessionId, sourceType) => {
    set({ sessionOutlineLoading: true });
    try {
      const { fetchOutline } = await import('@/lib/api');
      const result = await fetchOutline(sessionId, sourceType);
      set({ sessionOutline: result?.outline || null });
    } catch (err) {
      console.error('[outline] fetch error:', err);
      set({ sessionOutline: null });
    } finally {
      set({ sessionOutlineLoading: false });
    }
  },

  generateSessionOutline: async (sessionId, sourceType, provider, model) => {
    set({ sessionOutlineLoading: true });
    try {
      const { generateOutline } = await import('@/lib/api');
      const result = await generateOutline(sessionId, sourceType, provider, model);
      set({ sessionOutline: result?.outline || null });
    } catch (err) {
      console.error('[outline] generate error:', err);
    } finally {
      set({ sessionOutlineLoading: false });
    }
  },

  setOutlineTab: (tab) => set({ outlineTab: tab }),
  setOutlineScrollTarget: (index) => set({ outlineScrollTarget: index }),
  setOutlineHighlightRange: (range) => set({ outlineHighlightRange: range }),
  clearOutline: () => set({ sessionOutline: null, outlineScrollTarget: null, outlineHighlightRange: null }),

  fetchConversationKnowledge: async (id, sourceType) => {
    set({ conversationKnowledge: { entities: [], tags: [], graphData: null, loading: true } });
    try {
      if (sourceType === 'imported') {
        const { fetchConversationKnowledge } = await import('@/lib/api');
        const data = await fetchConversationKnowledge(id);
        set({ conversationKnowledge: { entities: data.entities || [], tags: data.tags || [], graphData: data.graphData || null, loading: false } });
      } else {
        const { fetchSessionKnowledge } = await import('@/lib/api');
        const data = await fetchSessionKnowledge(id);
        set({ conversationKnowledge: { entities: data.entities || [], tags: data.tags || [], graphData: data.graphData || null, loading: false } });
      }
    } catch (err) {
      console.error('[conversation-knowledge] fetch error:', err);
      set({ conversationKnowledge: null });
    }
  },

  clearConversationKnowledge: () => set({ conversationKnowledge: null }),

  // Notion context source actions
  setNotionPickerOpen: (open) => set({ notionPickerOpen: open }),
  setAttachedWebPages: (pages) => set({ attachedWebPages: pages }),

  fetchNotionContextSources: async (sessionId) => {
    set({ notionSourcesLoading: true });
    try {
      const { fetchContextSources } = await import('@/lib/api');
      const sources = await fetchContextSources(sessionId);
      set({ notionContextSources: sources.filter((source: ContextSource) => source.sourceType === 'notion_page') });
    } catch (err) {
      console.error('[notion] fetch context sources error:', err);
    } finally {
      set({ notionSourcesLoading: false });
    }
  },

  attachNotionSource: async (sessionId, sourceId, sourceLabel) => {
    try {
      const { attachContextSource } = await import('@/lib/api');
      await attachContextSource(sessionId, sourceId, sourceLabel);
      await get().fetchNotionContextSources(sessionId);
    } catch (err) {
      console.error('[notion] attach source error:', err);
    }
  },

  detachNotionSource: async (id) => {
    try {
      const { detachContextSource } = await import('@/lib/api');
      await detachContextSource(id);
      const sessionId = get().sessionId;
      if (sessionId) {
        await get().fetchNotionContextSources(sessionId);
      }
    } catch (err) {
      console.error('[notion] detach source error:', err);
    }
  },

  // Provenance lookup — switches to provenance mode and sets the code for auto-search
  lookupProvenance: (shortCode) => {
    set({ provenanceLookupCode: shortCode, mode: 'provenance' as OperationMode });
  },
  clearProvenanceLookup: () => set({ provenanceLookupCode: null }),

  // Knowledge Hints actions
  setKnowledgeHintsEnabled: (enabled) => set({ knowledgeHintsEnabled: enabled }),
  setKnowledgeHintMatches: (matches) => set({ knowledgeHintMatches: matches, knowledgeHintDismissed: false }),
  setKnowledgeHintLoading: (loading) => set({ knowledgeHintLoading: loading }),
  dismissKnowledgeHints: () => set({ knowledgeHintDismissed: true }),
  clearKnowledgeHints: () => set({ knowledgeHintMatches: [], knowledgeHintLoading: false, knowledgeHintDismissed: false }),
  setModelRecommendationsEnabled: (enabled) => {
    try { localStorage.setItem('prism_modelRecommendationsEnabled', JSON.stringify(enabled)); } catch {}
    set({ modelRecommendationsEnabled: enabled });
  },

  // Thinking actions
  setThinkingConfig: (model, config) =>
    set((state) => ({
      thinkingConfig: { ...state.thinkingConfig, [model]: config },
    })),

  clearThinkingConfig: (model) =>
    set((state) => {
      const next = { ...state.thinkingConfig };
      delete next[model];
      return { thinkingConfig: next };
    }),

  appendThinkingChunk: (model, content) =>
    set((state) => {
      const target = state.activeStreamTarget ?? 'parallel';
      const mapKey =
        target === 'observer'
          ? 'observerResponses'
          : target === 'compare'
          ? 'compareResponses'
          : target === 'synthesize'
            ? 'synthesizeResponses'
            : target === 'handoff'
              ? 'handoffResponses'
              : 'parallelResponses';
      const responseMap = state[mapKey];
      const existing = responseMap[model];
      if (!existing) {
        return {
          [mapKey]: {
            ...responseMap,
            [model]: {
              model,
              content: '',
              done: false,
              mode: target,
              streamStatus: 'streaming',
              lastChunkAt: Date.now(),
              partialRetained: false,
              retryable: false,
              thinkingContent: content,
              debug: {
                chunkCount: 1,
                contentChars: 0,
                thinkingChars: content.length,
                lastEvent: 'thinking_chunk',
              },
            },
          },
        };
      }
      const update: Partial<ChatState> = {
        [mapKey]: {
          ...responseMap,
          [model]: {
            ...existing,
            thinkingContent: (existing.thinkingContent ?? '') + content,
            lastChunkAt: Date.now(),
            streamStatus: 'streaming',
            debug: {
              chunkCount: (existing.debug?.chunkCount ?? 0) + 1,
              contentChars: existing.debug?.contentChars ?? 0,
              thinkingChars: (existing.debug?.thinkingChars ?? 0) + content.length,
              stopReason: existing.debug?.stopReason,
              providerError: existing.debug?.providerError,
              lastEvent: 'thinking_chunk',
              note: existing.debug?.note,
            },
          },
        },
      };
      return update;
    }),

  setResponseDebug: (model, debug, target) =>
    set((state) => {
      const resolvedTarget = target ?? state.activeStreamTarget ?? 'parallel';
      const mapKey =
        resolvedTarget === 'observer'
          ? 'observerResponses'
          : resolvedTarget === 'compare'
          ? 'compareResponses'
          : resolvedTarget === 'synthesize'
            ? 'synthesizeResponses'
            : resolvedTarget === 'handoff'
              ? 'handoffResponses'
              : 'parallelResponses';
      const responseMap = state[mapKey];
      const existing = responseMap[model];
      const nextDebug = {
        chunkCount: debug.chunkCount ?? existing?.debug?.chunkCount ?? 0,
        contentChars: debug.contentChars ?? existing?.debug?.contentChars ?? 0,
        thinkingChars: debug.thinkingChars ?? existing?.debug?.thinkingChars ?? 0,
        stopReason: debug.stopReason ?? existing?.debug?.stopReason,
        providerError: debug.providerError ?? existing?.debug?.providerError,
        lastEvent: debug.lastEvent ?? existing?.debug?.lastEvent,
        note: debug.note ?? existing?.debug?.note,
      };

      return {
        [mapKey]: {
          ...responseMap,
          [model]: existing
            ? {
                ...existing,
                debug: nextDebug,
              }
            : {
                model,
                content: '',
                done: false,
                mode: resolvedTarget,
                streamStatus: 'streaming',
                lastChunkAt: Date.now(),
                partialRetained: false,
                retryable: false,
                debug: nextDebug,
              },
        },
      };
    }),
}));
