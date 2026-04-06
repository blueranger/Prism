export type LLMProvider = 'openai' | 'anthropic' | 'google';

export type MessageRole = 'user' | 'assistant' | 'system';

// --- Thinking / Reasoning Mode ---

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ThinkingConfig {
  enabled: boolean;
  /** OpenAI reasoning_effort (o-series, GPT-5.x) */
  effort?: ReasoningEffort;
  /** Google thinkingBudget (0-24576 tokens) / Anthropic budget_tokens */
  budgetTokens?: number;
}

export type OperationMode = 'observer' | 'parallel' | 'handoff' | 'compare' | 'synthesize' | 'agents' | 'flow' | 'communication' | 'library' | 'knowledge' | 'memory' | 'triggers' | 'provenance' | 'rag' | 'costs';

export type CostEstimationSource = 'static_registry_estimate' | 'provider_usage_estimate' | 'provider_reconciled';
export type CostDisplayStatus = 'estimated' | 'usage_based' | 'reconciled';

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  sourceModel: string;
  timestamp: number;
  tokenCount?: number;
  handoffId?: string | null;
  handoffFrom?: string | null;
  /** Which mode produced this message */
  mode?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  estimatedCostUsd?: number | null;
  pricingSource?: CostEstimationSource | null;
}

export type RichPreviewKind = 'html' | 'svg';
export type RichPreviewSource = 'auto' | 'manual';
export type RichPreviewExtractionSource = 'fenced' | 'raw-html' | 'raw-svg' | 'manual';

export interface RichPreviewArtifact {
  id: string;
  sessionId: string;
  messageId: string;
  previewKind: RichPreviewKind;
  selectedText: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  source: RichPreviewSource;
  extractionSource?: RichPreviewExtractionSource | null;
  hasLeadingText?: boolean;
  hasTrailingText?: boolean;
  startsWithTag?: string | null;
  createdAt: number;
}

export interface ManualPreviewRequest {
  previewKind: RichPreviewKind;
  selectedText: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
}

export interface HandoffRequest {
  sessionId: string;
  fromModel: string;
  toModel: string;
  instruction?: string;
}

export interface HandoffEvent {
  id: string;
  sessionId: string;
  fromModel: string;
  toModel: string;
  instruction: string | null;
  timestamp: number;
}

export interface ContextBudget {
  maxTokens: number;
  reserveForResponse: number;
  reserveForSystem: number;
  available: number;
}

export interface BuiltContext {
  messages: { role: MessageRole; content: string }[];
  tokenEstimate: number;
  summarizedCount: number;
  totalMessages: number;
  breakdown: ContextBreakdownItem[];
  documents: ContextDocumentDebugItem[];
  memoryInjection?: MemoryInjectionPreview | null;
}

export interface ContextBreakdownItem {
  key: string;
  label: string;
  tokens: number;
  count?: number;
}

export interface ContextDebugInfo {
  model: string;
  budget: ContextBudget;
  contextTokens: number;
  promptTokens: number;
  totalTokens: number;
  breakdown: ContextBreakdownItem[];
  documents: ContextDocumentDebugItem[];
  memoryInjection?: MemoryInjectionPreview | null;
}

export type ContextDocumentSourceType = 'notion_page' | 'web_page' | 'uploaded_file';
export type ContextDocumentStatus = 'full' | 'summary' | 'omitted';
export type ContextDocumentReason =
  | 'included'
  | 'truncated_to_budget'
  | 'budget_exhausted'
  | 'lower_priority_than_newer_sources'
  | 'not_ready';

export interface ContextDocumentDebugItem {
  id: string;
  sourceType: ContextDocumentSourceType;
  label: string;
  displayType?: string;
  status: ContextDocumentStatus;
  tokens: number;
  reason: ContextDocumentReason;
  priorityOrder?: number;
}

export interface LLMRequest {
  messages: { role: MessageRole; content: string }[];
  model: string;
  provider: LLMProvider;
  temperature?: number;
  maxTokens?: number;
  /** Thinking / reasoning mode configuration */
  thinking?: ThinkingConfig;
}

export interface StreamChunk {
  provider: LLMProvider;
  model: string;
  content: string;
  done: boolean;
  error?: string;
  stopReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
    cachedTokens?: number;
    totalTokens?: number;
  };
  estimatedCostUsd?: number;
  pricingSource?: CostEstimationSource;
  /** Thinking / chain-of-thought content (streamed separately from main response) */
  thinkingContent?: string;
}

export interface LLMUsageEvent {
  id: string;
  sessionId: string;
  messageId?: string | null;
  provider: LLMProvider;
  model: string;
  mode: string;
  requestId?: string | null;
  startedAt: number;
  completedAt: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  totalTokens: number;
  estimatedCostUsd: number;
  pricingVersion: string;
  pricingSource: CostEstimationSource;
  workspaceScope?: string | null;
  status?: 'completed' | 'failed';
  metadata?: Record<string, unknown> | null;
}

export interface LLMCostSummary {
  currency: 'USD';
  month: string;
  totalEstimatedUsd: number;
  totalReconciledUsd: number;
  providerBreakdown: Array<{
    provider: LLMProvider;
    estimatedUsd: number;
    reconciledUsd: number;
    displayStatus: CostDisplayStatus;
  }>;
  modelBreakdown: Array<{
    model: string;
    provider: LLMProvider;
    estimatedUsd: number;
    totalTokens: number;
  }>;
  modeBreakdown: Array<{
    mode: string;
    estimatedUsd: number;
    totalTokens: number;
  }>;
}

export interface ProviderCostSyncRun {
  id: string;
  provider: LLMProvider;
  month: string;
  status: 'completed' | 'failed';
  startedAt: number;
  completedAt?: number | null;
  message?: string | null;
}

export interface ProviderCostRecord {
  id: string;
  provider: LLMProvider;
  month: string;
  lineItem: string;
  amountUsd: number;
  currency: 'USD';
  displayStatus: CostDisplayStatus;
  syncedAt: number;
  metadata?: Record<string, unknown> | null;
}

export interface PromptRequest {
  prompt: string;
  models: string[];
  sessionId?: string;
  mode?: OperationMode;
  /** Per-model thinking configuration, keyed by model id */
  thinking?: Record<string, ThinkingConfig>;
}

export interface ModelConfig {
  provider: LLMProvider;
  model: string;
  displayName: string;
  maxTokens: number;
  /** USD per 1M input tokens */
  inputCostPer1M: number;
  /** USD per 1M output tokens */
  outputCostPer1M: number;
  /** Short description / notes about this model */
  description?: string;
  /** If true, model uses reasoning tokens (billed as output but invisible in response) */
  isReasoning?: boolean;
  /** If true, model supports thinking / extended reasoning mode */
  supportsThinking?: boolean;
}

/** Model discovered at runtime via provider API */
export interface DiscoveredModel {
  model: string;
  provider: LLMProvider;
  displayName: string;
  maxTokens: number;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  description?: string;
  isReasoning?: boolean;
  discoveredAt: number;
}

/** Metadata about the model registry state */
export interface ModelRegistryInfo {
  staticCount: number;
  discoveredCount: number;
  lastRefreshedAt: number | null;
  autoRefreshEnabled: boolean;
  refreshIntervalMs: number;
}

// --- Prism Topic / Action Sessions ---

export type SessionType = 'topic' | 'action';
export type ActionType = 'email' | 'message' | 'summary' | 'follow_up' | 'custom';
export type ActionStatus = 'draft' | 'in_progress' | 'completed' | 'cancelled';
export type ActionChannelHint = 'email' | 'teams' | 'line' | 'manual' | 'other';
export type ActionScenario = 'new' | 'reply';

export interface ActionContextSnapshot {
  sourceSessionId: string;
  sourceSessionTitle?: string | null;
  sourceSummary: string;
  sourceTemplate?: string | null;
  selectedMessageIds: string[];
  selectedFileIds?: string[];
  selectedArtifacts?: string[];
  actionScenario?: ActionScenario;
  userInstruction?: string | null;
  targetLabel?: string | null;
  channelHint?: ActionChannelHint;
  outputExpectation?: string | null;
  createdAt: number;
}

// --- Compare & Synthesize (Phase 3) ---

export interface CompareRequest {
  sessionId: string;
  /** The model whose response will be evaluated */
  originModel: string;
  /** Models that will critique the origin response */
  criticModels: string[];
  /** Optional custom evaluation instruction */
  instruction?: string;
}

export interface SynthesizeRequest {
  sessionId: string;
  /** Models whose latest responses will be synthesized */
  sourceModels: string[];
  /** The model that performs the synthesis */
  synthesizerModel: string;
  /** Optional custom synthesis instruction */
  instruction?: string;
}

export type ArtifactType = 'code' | 'image' | 'diagram' | 'document';

export interface Artifact {
  id: string;
  sessionId: string;
  type: ArtifactType;
  content: string;
  filePath?: string | null;
  createdBy: string;
  version: number;
  parentVersion?: number | null;
  timestamp: number;
}

// --- Artifact Provenance (Phase 7d) ---

export interface ProvenanceRecord {
  id: string;
  shortCode: string;
  sourceType: 'native' | 'imported';
  sessionId: string | null;
  conversationId: string | null;
  messageId: string;
  artifactId: string | null;
  contentPreview: string;
  contentHash: string;
  sourceModel: string;
  entities: string[] | null;
  tags: string[] | null;
  copiedAt: number;
  note: string | null;
}

// --- Agent Layer (Phase 4) ---

export type AgentStatus = 'pending' | 'running' | 'completed' | 'failed';

/** JSON Schema subset for describing agent inputs */
export interface AgentInputSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

/** The contract every agent must implement */
export interface AgentDefinition {
  name: string;
  description: string;
  inputSchema: AgentInputSchema;
}

/** Result returned by an agent after execution */
export interface AgentResult {
  success: boolean;
  output: string;
  artifacts: Artifact[];
  log: string[];
}

/** A task submitted to the orchestrator */
export interface AgentTask {
  id: string;
  sessionId: string;
  agentName: string;
  input: Record<string, unknown>;
  status: AgentStatus;
  result?: AgentResult | null;
  createdAt: number;
  updatedAt: number;
}

/** Execution log entry persisted to DB */
export interface ExecutionLogEntry {
  id: string;
  sessionId: string;
  taskId: string;
  agentName: string;
  input: string;
  output: string | null;
  success: boolean | null;
  startedAt: number;
  completedAt: number | null;
}

/** Request to execute an agent */
export interface AgentExecRequest {
  sessionId: string;
  agentName: string;
  input: Record<string, unknown>;
}

/** Tool definition exposed to LLMs for function-calling */
export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: AgentInputSchema;
}

/** Timeline entry for the frontend — a superset of Message with handoff markers */
export interface TimelineEntry {
  id: string;
  type: 'message' | 'handoff';
  role?: MessageRole;
  content: string;
  sourceModel: string;
  timestamp: number;
  mode?: string | null;
  handoffFrom?: string | null;
  handoffTo?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  estimatedCostUsd?: number | null;
  pricingSource?: CostEstimationSource | null;
}

/** Connection type between flow nodes */
export type FlowConnectionType =
  | 'parallel'
  | 'handoff'
  | 'compare'
  | 'synthesize'
  | 'observer'
  | 'observer_review'
  | 'observer_alternative'
  | 'observer_synthesize'
  | 'agent'
  | 'action_spawn'
  | 'action_writeback';

/** A node in the flow graph */
export interface FlowNode {
  id: string;
  type: 'user' | 'assistant' | 'handoff' | 'agent' | 'action';
  role?: MessageRole;
  content: string;
  sourceModel: string;
  timestamp: number;
  /** Which mode produced this node */
  mode: FlowConnectionType;
  sessionType?: SessionType;
  actionType?: ActionType | null;
  actionStatus?: ActionStatus | null;
  parentSessionId?: string | null;
  sessionId?: string | null;
  targetLabel?: string | null;
  resultSummary?: string | null;
}

/** A directed edge between flow nodes */
export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  type: FlowConnectionType;
  label?: string;
}

/** Full flow graph for the visualizer */
export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

// --- Session Management ---

export interface Session {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string | null;   // first user message, truncated to 100 chars
  models: string[];          // distinct assistant models used
  sessionType: SessionType;
  parentSessionId?: string | null;
  actionType?: ActionType | null;
  actionStatus?: ActionStatus | null;
  actionTitle?: string | null;
  actionTarget?: string | null;
  contextSnapshot?: ActionContextSnapshot | null;
  resultSummary?: string | null;
  interactionMode?: OperationMode | null;
  activeModel?: string | null;
  observerModels?: string[];
}

export type ObserverStatus = 'idle' | 'syncing' | 'ready' | 'stale' | 'error';

export interface ObserverConfig {
  sessionId: string;
  interactionMode: 'observer';
  activeModel: string | null;
  observerModels: string[];
  updatedAt: number;
}

export interface ObserverSnapshot {
  id: string;
  sessionId: string;
  model: string;
  activeModel: string;
  userMessageId: string;
  activeMessageId: string;
  summary: string;
  risks: string[];
  disagreements: string[];
  suggestedFollowUp: string | null;
  status: ObserverStatus;
  error: string | null;
  capturedAt: number;
}

export interface ObserverTurnRequest {
  prompt: string;
  sessionId?: string;
  activeModel: string;
  observerModels: string[];
  thinking?: Record<string, ThinkingConfig>;
}

export type ObserverActionType = 'review' | 'alternative' | 'synthesize';

export interface ObserverActionRequest {
  sessionId: string;
  model: string;
  action: ObserverActionType;
  instruction?: string;
}

export interface ObserverActionResponse {
  sessionId: string;
  model: string;
  action: ObserverActionType;
  messageId?: string;
}

export interface SessionLink {
  id: string;
  sessionId: string;         // the session importing context
  linkedSessionId: string;   // the session whose context is imported
  createdAt: number;
}

export interface CreateActionRequest {
  actionType: ActionType;
  title: string;
  target?: string;
  selectedMessageIds?: string[];
  selectedFileIds?: string[];
  selectedArtifacts?: string[];
  actionScenario?: ActionScenario;
  sourceTemplate?: string;
  instruction?: string;
  channelHint?: ActionChannelHint;
  outputExpectation?: string;
}

// --- Decision Memory ---

export type DecisionType = 'preference' | 'observation';

export interface Decision {
  id: string;
  type: DecisionType;
  /** e.g. "always use Claude for diagrams", "GPT-4o is faster for code" */
  content: string;
  /** Optional: which model this decision is about */
  model: string | null;
  /** Whether this decision is currently active (soft delete) */
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

// --- Structured Memory ---

export type MemoryScopeType = 'user' | 'workspace' | 'session';
export type MemoryType = 'profile' | 'relationship' | 'situation' | 'event' | 'claim';
export type MemoryStatus = 'active' | 'stale' | 'superseded' | 'archived';
export type MemorySourceKind = 'manual' | 'assistant_extracted' | 'promoted_from_session';
export type MemoryLinkRole =
  | 'subject'
  | 'manager'
  | 'report'
  | 'customer'
  | 'company'
  | 'project'
  | 'mentioned_person'
  | 'mentioned_entity';

export interface MemoryAttribute {
  id: string;
  memoryItemId: string;
  key: string;
  value: string;
  createdAt: number;
}

export interface MemoryEntityLink {
  id: string;
  memoryItemId: string;
  entityId: string | null;
  entityName: string;
  linkRole: MemoryLinkRole;
  createdAt: number;
}

export interface MemorySource {
  id: string;
  memoryItemId: string;
  sessionId?: string | null;
  messageId?: string | null;
  conversationId?: string | null;
  provenanceId?: string | null;
  excerpt: string;
  createdAt: number;
}

export interface MemoryEvent {
  id: string;
  memoryItemId: string;
  eventType: string;
  startedAt: number;
  endedAt?: number | null;
  timelineOrder: number;
}

export interface MemoryItem {
  id: string;
  scopeType: MemoryScopeType;
  memoryType: MemoryType;
  title: string;
  summary: string;
  status: MemoryStatus;
  confidence: number;
  validAt: number;
  observedAt: number;
  lastConfirmedAt?: number | null;
  expiresAt?: number | null;
  sourceKind: MemorySourceKind;
  createdAt: number;
  updatedAt: number;
  attributes: MemoryAttribute[];
  entityLinks: MemoryEntityLink[];
  sources: MemorySource[];
  events: MemoryEvent[];
}

export interface MemoryCandidate {
  id: string;
  sessionId?: string | null;
  messageId?: string | null;
  scopeType: MemoryScopeType;
  memoryType: MemoryType;
  title: string;
  summary: string;
  confidence: number;
  sourceKind: MemorySourceKind;
  status: 'pending' | 'accepted' | 'rejected';
  payload?: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryGraphNode {
  id: string;
  label: string;
  type: 'memory' | 'entity';
  memoryType?: MemoryType;
  color: string;
  size: number;
}

export interface MemoryGraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  weight: number;
}

export interface MemoryTimelineEvent {
  id: string;
  memoryItemId: string;
  title: string;
  summary: string;
  memoryType: MemoryType;
  startedAt: number;
  endedAt?: number | null;
}

export interface WorkingMemoryItem {
  id: string;
  sessionId?: string | null;
  title: string;
  summary: string;
  memoryType: MemoryType | 'working';
  status: 'active' | 'stale' | 'archived';
  confidence: number;
  sourceMessageId?: string | null;
  observedAt: number;
  expiresAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export type MemoryExtractionTrigger =
  | 'manual_promote'
  | 'manual_extract_session'
  | 'auto_post_response'
  | 'pre_compaction_flush'
  | 'session_close_snapshot';

export interface MemoryExtractionRun {
  id: string;
  sessionId?: string | null;
  trigger: MemoryExtractionTrigger;
  sourceMessageIds: string[];
  addedCount: number;
  duplicateCount: number;
  acceptedCount: number;
  rejectedCount: number;
  notes?: string | null;
  createdAt: number;
}

export interface MemoryExtractionRunItem {
  id: string;
  runId: string;
  candidateId?: string | null;
  memoryItemId?: string | null;
  title: string;
  memoryType: MemoryType;
  outcome: 'added' | 'duplicate_candidate' | 'duplicate_memory' | 'accepted' | 'rejected' | 'graph_only' | 'trigger_candidate';
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
}

export interface MemoryUsageRun {
  id: string;
  sessionId?: string | null;
  model: string;
  mode?: OperationMode | null;
  promptPreview: string;
  totalRetrieved: number;
  totalInjected: number;
  totalOmitted: number;
  createdAt: number;
}

export interface MemoryUsageRunItem {
  id: string;
  runId: string;
  memoryItemId?: string | null;
  title: string;
  memoryType: MemoryType | 'working';
  action: 'retrieved' | 'injected' | 'omitted';
  reason?: string | null;
  summary?: string | null;
  confidence?: number | null;
  createdAt: number;
}

export interface MemoryInjectionItem {
  memoryItemId?: string | null;
  title: string;
  summary: string;
  memoryType: MemoryType | 'working';
  confidence: number;
  reason?: string | null;
  sourceSessionId?: string | null;
  sourceMessageId?: string | null;
}

export interface MemoryInjectionPreview {
  runId?: string | null;
  retrievedItems: MemoryInjectionItem[];
  injectedItems: MemoryInjectionItem[];
  omittedItems: MemoryInjectionItem[];
}

export type RelationshipRoutingDecision = 'graph_only' | 'memory_candidate' | 'trigger_candidate';
export type RelationshipPromotionReason =
  | 'boss_report'
  | 'customer'
  | 'explicit_work_relevance'
  | 'mention_threshold'
  | 'followup_intent'
  | 'monitor_intent'
  | 'single_article_context';

export interface RelationshipEvidence {
  id: string;
  workspaceKey: string;
  sourceEntityName: string;
  targetEntityName: string;
  relationType: string;
  routingDecision: RelationshipRoutingDecision;
  promotionReason?: RelationshipPromotionReason | null;
  mentionCount: number;
  lastSeenAt: number;
  sourceSessionId?: string | null;
  sourceMessageId?: string | null;
  summary?: string | null;
}

export type TriggerType = 'follow_up' | 'deadline' | 'monitor' | 'staleness_review';
export type TriggerCandidateStatus = 'pending' | 'accepted' | 'rejected' | 'snoozed';
export type TriggerRuleStatus = 'active' | 'paused' | 'completed' | 'archived';
export type TriggerRunStatus = 'detected' | 'notified' | 'accepted' | 'rejected' | 'snoozed' | 'executed' | 'failed';
export type TriggerDeliveryChannel = 'web' | 'line' | 'teams' | 'telegram' | 'manual';
export type TriggerActionType = 'reminder' | 'ask_for_review' | 'execute_agent' | 'start_monitoring';

export interface TriggerAction {
  type: TriggerActionType;
  label: string;
  agentName?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface TriggerCandidate {
  id: string;
  sessionId?: string | null;
  sourceMemoryItemId?: string | null;
  sourceCandidateId?: string | null;
  triggerType: TriggerType;
  title: string;
  summary: string;
  status: TriggerCandidateStatus;
  confidence: number;
  triggerAt?: number | null;
  deliveryChannel: TriggerDeliveryChannel;
  action: TriggerAction;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface TriggerRule {
  id: string;
  triggerCandidateId?: string | null;
  triggerType: TriggerType;
  title: string;
  summary: string;
  status: TriggerRuleStatus;
  triggerAt?: number | null;
  deliveryChannel: TriggerDeliveryChannel;
  action: TriggerAction;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface TriggerRun {
  id: string;
  triggerCandidateId?: string | null;
  triggerRuleId?: string | null;
  status: TriggerRunStatus;
  note?: string | null;
  createdAt: number;
}

export interface TriggerNotification {
  id: string;
  triggerRunId?: string | null;
  channel: TriggerDeliveryChannel;
  title: string;
  body: string;
  deepLink?: string | null;
  status: 'pending' | 'sent' | 'failed';
  createdAt: number;
}

export type CompiledSourceType =
  | 'imported_chatgpt'
  | 'imported_claude'
  | 'imported_gemini'
  | 'native_prism_session'
  | 'web_article'
  | 'meeting_transcript'
  | 'external_transcript';

export interface CompiledSourceMessage {
  id?: string | null;
  role: MessageRole;
  content: string;
  sourceModel?: string | null;
  timestamp?: number | string | null;
}

export interface CompiledSourceDocument {
  sourceId: string;
  sourceType: CompiledSourceType;
  title: string;
  sourceUrl?: string | null;
  projectName?: string | null;
  workspaceName?: string | null;
  timestamps: {
    createdAt?: number | string | null;
    updatedAt?: number | string | null;
    syncedAt?: number | string | null;
  };
  messages: CompiledSourceMessage[];
  normalizedTranscript: string;
  metadata?: Record<string, unknown> | null;
}

export type ConceptCandidateType = 'mention' | 'candidate_topic' | 'core_concept';

export interface ConceptCandidate {
  name: string;
  definition: string;
  confidence: number;
  whereSeen?: string[];
  sourceLinks?: string[];
  conceptType: ConceptCandidateType;
}

export interface BacklinkSuggestion {
  title: string;
  targetPath?: string | null;
  reason: string;
  confidence: number;
}

export type RelatedNoteType = 'source' | 'context' | 'observation' | 'evergreen' | 'concept' | 'project' | 'topic';

export interface RelatedNoteSuggestion {
  title: string;
  noteType: RelatedNoteType;
  reason: string;
  confidence: number;
}

export type ArticleCandidateType = 'topic' | 'concept' | 'project' | 'partner' | 'entity' | 'client';

export interface ArticleCandidate {
  title: string;
  articleType: ArticleCandidateType;
  reason: string;
  confidence: number;
}

export interface CompilerArtifact {
  concepts: ConceptCandidate[];
  backlinkSuggestions: BacklinkSuggestion[];
  relatedNoteSuggestions: RelatedNoteSuggestion[];
  articleCandidates: ArticleCandidate[];
}

export interface CompilerRunSummary {
  id: string;
  sourceId: string;
  sourceType: CompiledSourceType;
  sourceTitle: string;
  status: 'pending' | 'completed' | 'partial' | 'failed';
  destinationType?: ObsidianDestinationType | null;
  model?: string | null;
  createdAt: number;
  completedAt?: number | null;
  graphUpdatesCount: number;
  memoryCandidatesCount: number;
  triggerCandidatesCount: number;
  conceptCount: number;
  relatedNoteCount: number;
  backlinkSuggestionCount: number;
  articleCandidateCount: number;
  errors?: string[];
  artifacts?: CompilerArtifact | null;
}

// --- Task Classification ---

export type TaskType =
  | 'coding'
  | 'diagram'
  | 'analysis'
  | 'writing'
  | 'math'
  | 'translation'
  | 'creative'
  | 'research'
  | 'general';

export interface ClassificationResult {
  taskType: TaskType;
  confidence: number;
  recommendedModel: string;
  displayName: string;
  reason: string;
  overriddenByDecision: boolean;
}

// --- Communication Tools Integration (Phase 6) ---

export type CommProvider = 'outlook' | 'teams' | 'line' | 'notion' | 'manual';

export type ConnectorType = 'outlook-oauth' | 'outlook-local' | 'teams' | 'line' | 'notion-oauth' | 'notion-internal' | 'manual';

export type DraftStatus = 'pending' | 'approved' | 'sent' | 'rejected';

export type MonitorAction = 'notify' | 'draft_reply' | 'draft_and_notify';

export interface ExternalThread {
  id: string;
  provider: CommProvider;
  accountId: string;
  externalId: string;
  sessionId: string | null;
  displayName: string;
  subject: string | null;
  senderName: string | null;
  senderEmail: string | null;
  isGroup: boolean;
  messageCount: number;
  lastMessageAt: number | null;
  lastSyncedAt: number | null;
  createdAt: number;
}

export interface ExternalMessage {
  id: string;
  threadId: string;
  provider: CommProvider;
  accountId: string;
  externalId: string;
  senderId: string;
  senderName: string;
  senderEmail: string | null;
  subject: string | null;
  content: string;
  timestamp: number;
  isInbound: boolean;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface ReplyLearning {
  id: string;
  provider: CommProvider;
  senderId: string;
  senderName: string;
  contextMessage: string;
  userReply: string;
  tone: string | null;
  replyLengthChars: number | null;
  containsQuestion: boolean;
  containsActionItem: boolean;
  wasEditedFromDraft: boolean;
  createdAt: number;
}

export interface MonitorRuleConditions {
  keywords?: string[];
  senders?: string[];
  subjectContains?: string[];
  isGroup?: boolean;
  timeRange?: {
    startHour: number;
    endHour: number;
  };
}

export interface MonitorRuleActionConfig {
  model?: string;
  tone?: string;
  instruction?: string;
}

export interface MonitorRule {
  id: string;
  provider: CommProvider | 'all';
  ruleName: string;
  enabled: boolean;
  conditions: MonitorRuleConditions;
  action: MonitorAction;
  actionConfig: MonitorRuleActionConfig | null;
  createdAt: number;
  updatedAt: number;
}

export interface DraftReply {
  id: string;
  threadId: string;
  messageId: string;
  provider: CommProvider;
  accountId: string;
  draftContent: string;
  modelUsed: string;
  tone: string | null;
  language: string | null;
  instruction: string | null;
  status: DraftStatus;
  triggeredBy: string | null;
  sentAt: number | null;
  userEdit: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ConnectorConfig {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  /** Per-account Outlook type (exchange, imap, pop) — local connector only */
  accountType?: string;
  /** 1-based index within the account type list — local connector only */
  accountIndex?: number;
}

export interface ConnectorRecord {
  id: string;
  provider: CommProvider;
  config: ConnectorConfig;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ConnectorStatus {
  accountId: string;
  provider: CommProvider;
  connectorType: ConnectorType;
  connected: boolean;
  active: boolean;
  lastSyncedAt: number | null;
  /** True when using local macOS Outlook connector (AppleScript, no OAuth) */
  isLocal?: boolean;
  /** Display label override (e.g. "Local Outlook (macOS)") */
  displayLabel?: string;
  /** Display name from the account profile (e.g. "John Doe") */
  displayName?: string | null;
  /** Email address from the account profile */
  email?: string | null;
  /** Number of threads currently stored for this account */
  threadCount?: number;
  /** Error message from the last sync attempt, null if last sync succeeded */
  lastSyncError?: string | null;
  /** Per-account persona description injected into draft system prompts */
  persona?: string | null;
  /** Whether auto-triage is enabled for this account */
  triageEnabled?: boolean;
}

export interface SenderLearningStats {
  senderId: string;
  senderName: string;
  provider: CommProvider;
  replyCount: number;
  avgLength: number;
  dominantTone: string | null;
  toneBreakdown: Record<string, number>;
  questionRate: number;
  actionItemRate: number;
  editRate: number;
  lastReplyAt: number;
}

export type CommNotificationType = 'rule_matched' | 'triage_complete';

export interface CommNotificationRuleMatched {
  type: 'rule_matched';
  ruleId: string;
  ruleName: string;
  threadId: string | null;
  message: {
    sender: string;
    subject: string | null;
    preview: string;
  };
  action: MonitorAction;
  draftId: string | null;
  timestamp: number;
}

export interface CommNotificationTriageComplete {
  type: 'triage_complete';
  accountId: string;
  totalTriaged: number;
  draftsGenerated: number;
  timestamp: number;
}

export type CommNotification = CommNotificationRuleMatched | CommNotificationTriageComplete;

// --- Email Triage Agent (Phase 6+) ---

export type TriageSenderRole = 'ceo' | 'manager' | 'colleague' | 'client' | 'vendor' | 'external' | 'unknown';
export type TriageImportance = 'urgent' | 'important' | 'normal' | 'low';
export type TriageSuggestedAction = 'auto_draft' | 'manual_reply' | 'skip';

export interface TriageResult {
  id: string;
  accountId: string;
  messageId: string;
  threadId: string;
  senderId: string | null;
  senderName: string | null;
  senderRole: TriageSenderRole;
  importance: TriageImportance;
  isCommercial: boolean;
  suggestedAction: TriageSuggestedAction;
  reasoning: string | null;
  draftId: string | null;
  createdAt: number;
}

export interface TriageSettings {
  triageEnabled: boolean;
  filterCommercial: boolean;
  autoInstruction: string | null;
}

/* ===== Phase 7a: Import Engine ===== */

export type ImportPlatform = 'chatgpt' | 'claude' | 'gemini';

export type ImportSourceKind = 'archive_upload' | 'chatgpt_browser_sync' | 'claude_browser_sync' | 'gemini_browser_sync';
export type ImportedTitleSource = 'source' | 'ai' | 'manual';

export interface ImportSyncState {
  conversationId: string;
  sourcePlatform: ImportPlatform;
  originalId: string;
  sourceKind: ImportSourceKind;
  lastSyncedAt: string;
  sourceUpdatedAt?: string;
  projectName?: string;
  workspaceId?: string;
  workspaceName?: string;
  accountId?: string;
  metadata?: Record<string, any>;
}

export interface ImportedConversation {
  id: string;
  sourcePlatform: ImportPlatform;
  originalId?: string;
  title: string;
  sourceTitle?: string;
  titleSource?: ImportedTitleSource;
  titleLocked?: boolean;
  titleGeneratedAt?: string;
  titleLastMessageCount?: number;
  createdAt: string;
  updatedAt?: string;
  lastActivityAt?: string;
  messageCount: number;
  sessionId?: string;
  importBatchId: string;
  projectName?: string;
  sourceKind?: ImportSourceKind;
  lastSyncedAt?: string;
  sourceUpdatedAt?: string;
  workspaceId?: string;
  workspaceName?: string;
  accountId?: string;
  defaultModelSlug?: string;
  isArchived?: boolean;
  metadata?: Record<string, any>;
}

export interface ImportedMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  sourceModel?: string;
  timestamp: string;
  tokenCount?: number;
  parentMessageId?: string;
  metadata?: Record<string, any>;
}

export interface ImportedSourceExportRequest {
  conversationId: string;
  vaultPath?: string;
}

export type ObsidianDestinationType =
  | 'obsidian_source'
  | 'obsidian_context'
  | 'obsidian_observation'
  | 'obsidian_evergreen'
  | 'notion_action';

export type KnowledgeMaturity = 'raw' | 'context' | 'incubating' | 'evergreen';

export interface KnowledgeNoteExportRequest {
  conversationId: string;
  content: string;
  vaultPath?: string;
  title?: string;
  destinationType?: ObsidianDestinationType;
  knowledgeMaturity?: KnowledgeMaturity;
  compilerRunId?: string | null;
}

export interface ActionItemsExportRequest {
  conversationId: string;
  model?: string;
}

export interface ObsidianExportResult {
  ok: boolean;
  filePath: string;
  relativePath: string;
  title: string;
  destinationType?: ObsidianDestinationType;
  knowledgeMaturity?: KnowledgeMaturity;
  wikiUpdate?: WikiUpdateResult;
}

export type WikiArtifactType = 'analysis' | 'comparison' | 'synthesis';

export type WikiPageKind =
  | 'source'
  | 'context'
  | 'observation'
  | 'evergreen'
  | 'concept'
  | 'topic'
  | 'project'
  | 'partner'
  | 'entity'
  | 'analysis'
  | 'comparison'
  | 'synthesis'
  | 'compile_plan'
  | 'compiler_summary'
  | 'index'
  | 'log'
  | 'schema';

export interface WikiIndexEntry {
  title: string;
  relativePath: string;
  summary: string;
  pageKind: WikiPageKind;
  updatedAt?: number | null;
}

export interface WikiLogEntry {
  id: string;
  timestamp: number;
  operation: 'ingest' | 'export' | 'query' | 'lint';
  title: string;
  pageKind?: WikiPageKind | null;
  relativePath?: string | null;
  sourceId?: string | null;
  sourceType?: CompiledSourceType | null;
  note?: string | null;
}

export interface WikiUpdateResult {
  ensuredFiles: string[];
  writtenFiles: string[];
  updatedFiles: string[];
  createdDrafts: string[];
  indexUpdated: boolean;
  logAppended: boolean;
  logEntry?: WikiLogEntry | null;
}

export interface WikiLintFinding {
  id: string;
  severity: 'info' | 'warning' | 'error';
  findingType:
    | 'orphan_page'
    | 'duplicate_page'
    | 'missing_concept_page'
    | 'stale_claim'
    | 'missing_source_link'
    | 'missing_backlink'
    | 'missing_provenance';
  title: string;
  description: string;
  relativePath?: string | null;
  relatedPaths?: string[];
  evidence?: string[];
  suggestedFix?: string | null;
}

export interface WikiLintRun {
  id: string;
  status: 'pending' | 'completed' | 'partial' | 'failed';
  createdAt: number;
  completedAt?: number | null;
  model?: string | null;
  findingCount: number;
  findings: WikiLintFinding[];
  articleCandidates?: ArticleCandidate[];
  errors?: string[];
}

export interface SaveQueryArtifactRequest {
  sessionId: string;
  messageId?: string;
  sourceModel?: string | null;
  title?: string;
  content: string;
  artifactType: WikiArtifactType;
  streamTarget?: 'prompt' | 'observer' | 'parallel' | 'compare' | 'synthesize';
  promoteTo?: 'obsidian_observation' | 'obsidian_evergreen' | null;
}

export type WikiWriteOperation = 'create' | 'update' | 'append' | 'no_op';

export interface CompiledArtifactCandidate {
  id: string;
  artifactType:
    | 'raw_source'
    | 'context'
    | 'observation'
    | 'evergreen'
    | 'concept'
    | 'topic'
    | 'project'
    | 'partner'
    | 'entity'
    | 'analysis'
    | 'comparison'
    | 'synthesis'
    | 'index_update'
    | 'log_update';
  pageKind: WikiPageKind;
  title: string;
  summary: string;
  rationale: string;
  confidence: number;
  relativePath?: string | null;
  contentPreview?: string | null;
  rubricRationale?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CompilePlanItem {
  id: string;
  artifactType: CompiledArtifactCandidate['artifactType'];
  pageKind: WikiPageKind;
  operation: WikiWriteOperation;
  title: string;
  relativePath: string;
  rationale: string;
  rubricRationale?: string | null;
  confidence: number;
  contentPreview?: string | null;
  diffSummary?: string | null;
  selectedByDefault?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface CompilePlan {
  id: string;
  sourceId: string;
  sourceType: CompiledSourceType;
  sourceTitle: string;
  status: 'planned' | 'partially_applied' | 'fully_applied' | 'rejected' | 'failed';
  model?: string | null;
  createdAt: number;
  updatedAt: number;
  appliedAt?: number | null;
  sourceSummary: string;
  detectedArtifacts: CompiledArtifactCandidate[];
  items: CompilePlanItem[];
  warnings?: string[];
  skippedItems?: string[];
  errors?: string[];
}

export interface ApplyCompilePlanRequest {
  itemIds?: string[];
}

export interface ApplyCompilePlanResult {
  plan: CompilePlan;
  appliedItemIds: string[];
  wikiUpdate: WikiUpdateResult;
}

export type WikiBackfillAction = 'compile_now' | 'archive_only' | 'skip';
export type WikiBackfillAgeBucket = 'recent' | 'mid_term' | 'legacy';

export interface WikiBackfillRecommendation {
  conversationId: string;
  title: string;
  platform: ImportPlatform;
  projectName?: string;
  createdAt: string;
  updatedAt?: string;
  lastActivityAt?: string;
  messageCount: number;
  ageBucket: WikiBackfillAgeBucket;
  recommendedAction: WikiBackfillAction;
  reasons: string[];
  score: number;
}

export interface WikiBackfillPlan {
  createdAt: number;
  totalConversations: number;
  compileNowCount: number;
  archiveOnlyCount: number;
  skipCount: number;
  recommendations: WikiBackfillRecommendation[];
}

export interface WikiBackfillApplyItem {
  conversationId: string;
  action: WikiBackfillAction;
}

export interface WikiBackfillApplyResultItem {
  conversationId: string;
  title: string;
  action: WikiBackfillAction;
  status: 'applied' | 'skipped' | 'failed';
  filePath?: string;
  compilePlanId?: string;
  appliedItemCount?: number;
  error?: string;
}

export interface WikiBackfillApplyResult {
  totalProcessed: number;
  compiledCount: number;
  archivedCount: number;
  skippedCount: number;
  failedCount: number;
  results: WikiBackfillApplyResultItem[];
}

export type WikiBackfillJobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type WikiBackfillJobItemStatus = 'pending' | 'running' | 'applied' | 'skipped' | 'failed';

export interface WikiBackfillJobItem {
  id: string;
  jobId: string;
  conversationId: string;
  title: string;
  platform: ImportPlatform;
  projectName?: string;
  ageBucket: WikiBackfillAgeBucket;
  score: number;
  recommendedAction: WikiBackfillAction;
  selectedAction: WikiBackfillAction;
  reasons: string[];
  status: WikiBackfillJobItemStatus;
  batchNumber?: number | null;
  startedAt?: number | null;
  completedAt?: number | null;
  filePath?: string;
  compilePlanId?: string;
  appliedItemCount?: number;
  error?: string;
}

export interface WikiBackfillJob {
  id: string;
  status: WikiBackfillJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  vaultPath: string;
  model?: string | null;
  batchSize: number;
  currentBatchSize: number;
  totalItems: number;
  processedItems: number;
  compiledCount: number;
  archivedCount: number;
  skippedCount: number;
  failedCount: number;
  nextBatchNumber: number;
  lastLintRunId?: string | null;
  lastLintFindingCount?: number | null;
  tuningNotes: string[];
  currentConversationTitle?: string | null;
  error?: string;
}

export interface ImportBatch {
  id: string;
  platform: ImportPlatform;
  filename: string;
  totalConversations: number;
  totalMessages: number;
  importedAt: string;
  status: 'processing' | 'completed' | 'failed';
  error?: string;
}

export interface ImportProgress {
  batchId: string;
  platform: ImportPlatform;
  status: 'processing' | 'completed' | 'failed';
  totalConversations: number;
  processedConversations: number;
  importedConversations?: number;
  overwrittenConversations?: number;
  skippedConversations?: number;
  totalMessages: number;
  error?: string;
}

export interface ChatGPTSyncConversation {
  id: string;
  title?: string;
  create_time?: number | null;
  update_time?: number | null;
  mapping: Record<string, any>;
  current_node?: string | null;
  conversation_template_id?: string | null;
  default_model_slug?: string | null;
  is_archived?: boolean;
  workspace_id?: string | null;
  workspace_name?: string | null;
  account_id?: string | null;
  metadata?: Record<string, any>;
}

export interface ChatGPTSyncRequest {
  projectName?: string;
  syncRunId?: string;
  syncBatchIndex?: number;
  syncBatchCount?: number;
  conversations: ChatGPTSyncConversation[];
}

export interface ClaudeSyncConversation {
  uuid: string;
  name?: string;
  created_at?: string | null;
  updated_at?: string | null;
  model?: string | null;
  current_leaf_message_uuid?: string | null;
  project_uuid?: string | null;
  project_name?: string | null;
  account_uuid?: string | null;
  account_email_address?: string | null;
  chat_messages: Array<{
    uuid?: string;
    sender?: string;
    text?: string;
    content?: Array<{ type?: string; text?: string }>;
    created_at?: string | null;
    updated_at?: string | null;
    parent_message_uuid?: string | null;
    model?: string | null;
  }>;
  metadata?: Record<string, any>;
}

export interface ClaudeSyncRequest {
  projectName?: string;
  syncRunId?: string;
  syncBatchIndex?: number;
  syncBatchCount?: number;
  conversations: ClaudeSyncConversation[];
}

export interface GeminiSyncConversation {
  id: string;
  title?: string;
  createTime?: string | null;
  updatedAt?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  chunks: Array<{
    type: 'USER' | 'MODEL';
    content: string;
    timestamp?: string | null;
  }>;
  metadata?: Record<string, any>;
}

export interface GeminiSyncRequest {
  projectName?: string;
  syncRunId?: string;
  syncBatchIndex?: number;
  syncBatchCount?: number;
  conversations: GeminiSyncConversation[];
}

export interface ImportSyncRun {
  id: string;
  sourcePlatform: ImportPlatform;
  sourceKind: ImportSourceKind;
  projectName?: string;
  status: 'running' | 'completed' | 'failed';
  requestedConversations: number;
  processedConversations: number;
  importedConversations: number;
  overwrittenConversations: number;
  skippedConversations: number;
  failedConversations: number;
  totalMessages: number;
  batchCount: number;
  completedBatchCount: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  metadata?: Record<string, any>;
}

export interface KBSessionBootstrapSource {
  sourceType: RAGSourceType;
  sourceId: string;
  sessionId?: string | null;
  conversationId?: string | null;
  sourceLabel: string;
  sourcePlatform?: string | null;
  excerpt?: string | null;
  sourceCreatedAt?: string | number | null;
  sourceLastActivityAt?: string | number | null;
  citedAt?: string | number | null;
}

export interface KBSessionBootstrapRequest {
  origin: 'kb' | 'library';
  query?: string;
  answer?: string;
  selectedSources?: KBSessionBootstrapSource[];
  citations?: Record<string, string>;
  suggestedTitle?: string;
  libraryConversationIds?: string[];
  activeModel?: string | null;
  observerModels?: string[];
}

export interface KBSessionBootstrapResponse {
  sessionId: string;
  sessionTitle: string;
}

export interface SessionBootstrapRecord {
  sessionId: string;
  bootstrapType: 'kb' | 'library';
  sourceCount: number;
  payload: KBSessionBootstrapRequest;
  createdAt: string;
}

export interface ImportProjectTarget {
  id: string;
  title: string;
  sessionType: SessionType;
  updatedAt: number;
}

/* ===== Phase 7b: Unified Search ===== */

export type SearchResultSource = 'imported' | 'native';

export interface SearchResult {
  id: string;
  conversationId: string;
  conversationTitle: string;
  source: SearchResultSource;
  sourcePlatform?: ImportPlatform;
  role: MessageRole;
  content: string;
  snippet: string;
  sourceModel?: string;
  timestamp: string;
  rank: number;
}

export interface SearchQuery {
  query: string;
  filters?: {
    source?: SearchResultSource;
    platform?: ImportPlatform;
    dateFrom?: string;
    dateTo?: string;
    role?: MessageRole;
    model?: string;
  };
  limit?: number;
  offset?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  queryTimeMs: number;
}

/* ===== Phase 7c: Knowledge Graph ===== */

export type EntityType = 'technology' | 'concept' | 'person' | 'project' | 'organization' | 'topic';
export type RelationType =
  | 'related_to'
  | 'part_of'
  | 'depends_on'
  | 'alternative_to'
  | 'used_with'
  | 'competitor_of'
  | 'partner_of'
  | 'customer_of'
  | 'reports_to'
  | 'manages';

export interface Tag {
  id: string;
  name: string;
  color?: string;
  createdAt: string;
  source: 'auto' | 'manual';
  conversationCount?: number;
}

export interface KnowledgeEntity {
  id: string;
  name: string;
  entityType: EntityType;
  description?: string;
  aliases?: string[];
  firstSeenAt?: string;
  mentionCount: number;
  createdAt: string;
  updatedAt?: string;
}

export interface EntityRelation {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: RelationType;
  weight: number;
  createdAt: string;
  routingDecision?: RelationshipRoutingDecision | null;
  promotionReason?: RelationshipPromotionReason | null;
  mentionCount?: number;
  summary?: string | null;
}

export interface EntityMention {
  entityId: string;
  conversationId?: string;
  sessionId?: string;
  conversationTitle?: string;
  mentionCount: number;
  contextSnippet?: string;
}

/** Scenario 1: Knowledge hint match for contextual suggestions while typing */
export interface KnowledgeHintMatch {
  entity: KnowledgeEntity;
  mentions: EntityMention[];
  totalConversations: number;
  /** The keyword from the user's prompt that triggered this entity match */
  matchedKeyword?: string;
}

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  type: EntityType;
  size: number;
  color: string;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  label: RelationType;
  weight: number;
}

export interface KnowledgeGraphData {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

export interface ExtractionProgress {
  status: 'idle' | 'running' | 'completed' | 'failed';
  totalConversations: number;
  processedConversations: number;
  entitiesFound: number;
  relationsFound: number;
  error?: string;
}

/* ===== Session Outline / Topic Navigation ===== */

export interface OutlineSection {
  id: string;
  title: string;
  description?: string;
  startMessageIndex: number;
  endMessageIndex: number;
  messageCount: number;
  keyEntities?: string[];
}

export interface SessionOutline {
  id: string;
  sessionId: string;
  sourceType: 'native' | 'imported';
  sections: OutlineSection[];
  generatedAt: string;
  modelUsed: string;
  version: number;
}

// --- Notion Integration (Scenario 4) ---

export interface NotionPageRef {
  id: string;
  notionPageId: string;
  title: string;
  url: string;
  lastEditedAt: number;
  parentType: 'workspace' | 'database' | 'page';
  parentId: string | null;
  iconEmoji: string | null;
  contentMd: string | null;
  contentHash: string | null;
  syncedAt: number;
}

export interface ContextSource {
  id: string;
  sessionId: string;
  sourceType: 'notion_page' | 'uploaded_file' | 'web_page';
  sourceId: string;
  sourceLabel: string;
  attachedAt: number;
  attachedBy: 'user' | 'auto';
}

// --- File Upload + Document Analysis ---

export type FileAnalysisStatus = 'pending' | 'processing' | 'done' | 'error';

export interface UploadedFile {
  id: string;
  sessionId: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  filePath: string;
  status: FileAnalysisStatus;
  extractedText?: string;
  summary?: string;
  analyzedBy?: string;
  errorMessage?: string;
  /** Analysis metadata (e.g. pageCount, method) */
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface UrlPreview {
  url: string;
  title: string | null;
  content: string;
}

export interface LinkedPageCandidate {
  url: string;
  normalizedUrl: string;
  title: string | null;
  anchorText?: string | null;
  host: string;
  snippet?: string | null;
  depth: number;
}

export interface WebPagePreviewResponse {
  page: UrlPreview;
  links: LinkedPageCandidate[];
}

export interface WebPageRef {
  id: string;
  sessionId: string;
  rootUrl: string;
  url: string;
  normalizedUrl: string;
  title: string | null;
  host: string;
  depth: number;
  parentWebPageId?: string | null;
  anchorText?: string | null;
  contentText: string;
  contentHash?: string | null;
  attachedAt: number;
  discoveredAt: number;
  metadata?: {
    outboundLinkCount?: number;
    sameDomainOnly?: boolean;
    snippet?: string;
  } | null;
}

export interface NotionWriteRecord {
  id: string;
  sessionId: string;
  messageId: string;
  accountId: string;
  notionPageId: string;
  pageTitle: string;
  contentPreview: string;
  writtenAt: number;
  status: 'success' | 'failed';
}

/* ===== RAG: Retrieval-Augmented Generation ===== */

export type RAGSourceType = 'uploaded_file' | 'message' | 'imported_conversation';

export interface TextChunk {
  id: string;
  sourceType: RAGSourceType;
  sourceId: string;
  sessionId?: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  createdAt: number;
}

export interface RAGSearchQuery {
  query: string;
  filters?: {
    sourceType?: RAGSourceType;
    sessionId?: string;
    dateFrom?: number;
    dateTo?: number;
  };
  limit?: number;
  hybridWeight?: number; // 0 = pure keyword, 1 = pure semantic, 0.5 = balanced (default)
}

export interface RAGSourceMetadata {
  sourceType: RAGSourceType;
  sourceId: string;
  sessionId?: string | null;
  conversationId?: string | null;
  sourcePlatform?: string | null;
  projectName?: string | null;
  workspaceName?: string | null;
  model?: string | null;
  sourceCreatedAt?: string | number | null;
  sourceUpdatedAt?: string | number | null;
  sourceLastActivityAt?: string | number | null;
  sourceSyncedAt?: string | number | null;
  citedAt?: string | number | null;
}

export interface RAGSearchResult {
  chunk: TextChunk;
  score: number;
  sourceLabel: string;   // e.g. filename, session title
  snippet: string;       // highlighted/trimmed content
  matchType: 'keyword' | 'semantic' | 'hybrid';
  sourceMeta?: RAGSourceMetadata;
}

export interface RAGSearchResponse {
  results: RAGSearchResult[];
  total: number;
  queryTimeMs: number;
}

export interface RAGAskQuery {
  query: string;
  model?: string;         // which LLM to use for answering
  filters?: RAGSearchQuery['filters'];
  maxChunks?: number;     // default 10
  sessionId?: string;     // current session for context
}

export interface RAGAskResponse {
  answer: string;
  /** Maps citation number (e.g. "1", "2") to the exact excerpt from that source used in the answer */
  citations?: Record<string, string>;
  model: string;
  sources: RAGSearchResult[];
  tokenCount?: number;
  queryTimeMs: number;
}

export interface RAGIndexStats {
  totalChunks: number;
  totalEmbeddings: number;
  indexedFiles: number;
  indexedSessions: number;
  indexedLibrary: number;
  embeddingModel: string;
}
