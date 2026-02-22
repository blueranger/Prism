export type LLMProvider = 'openai' | 'anthropic' | 'google';

export type MessageRole = 'user' | 'assistant' | 'system';

export type OperationMode = 'parallel' | 'handoff' | 'compare' | 'synthesize' | 'agents' | 'flow' | 'communication' | 'library';

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
}

export interface LLMRequest {
  messages: { role: MessageRole; content: string }[];
  model: string;
  provider: LLMProvider;
  temperature?: number;
  maxTokens?: number;
}

export interface StreamChunk {
  provider: LLMProvider;
  model: string;
  content: string;
  done: boolean;
  error?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

export interface PromptRequest {
  prompt: string;
  models: string[];
  sessionId?: string;
  mode?: OperationMode;
}

export interface ModelConfig {
  provider: LLMProvider;
  model: string;
  displayName: string;
  maxTokens: number;
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
  handoffFrom?: string | null;
  handoffTo?: string | null;
}

/** Connection type between flow nodes */
export type FlowConnectionType = 'parallel' | 'handoff' | 'compare' | 'synthesize' | 'agent';

/** A node in the flow graph */
export interface FlowNode {
  id: string;
  type: 'user' | 'assistant' | 'handoff' | 'agent';
  role?: MessageRole;
  content: string;
  sourceModel: string;
  timestamp: number;
  /** Which mode produced this node */
  mode: FlowConnectionType;
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
}

export interface SessionLink {
  id: string;
  sessionId: string;         // the session importing context
  linkedSessionId: string;   // the session whose context is imported
  createdAt: number;
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

export type CommProvider = 'outlook' | 'teams' | 'line';

export type ConnectorType = 'outlook-oauth' | 'outlook-local' | 'teams' | 'line';

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

export interface ImportedConversation {
  id: string;
  sourcePlatform: ImportPlatform;
  originalId?: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  messageCount: number;
  sessionId?: string;
  importBatchId: string;
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
  totalMessages: number;
  error?: string;
}
