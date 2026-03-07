# Prism — Multi-LLM Orchestrator with Context Handoff & Agent Execution

## Project Overview

Prism is an AI Operating System that lets users orchestrate multiple LLMs (OpenAI GPT, Anthropic Claude, Google Gemini) through a unified interface. Unlike simple chatbot aggregators that fan out the same prompt, Prism enables **intelligent context routing** — users can start a conversation with one LLM, then hand off the context to another LLM that's better suited for the next task, with full conversation continuity.

### Core Insight

LLM APIs are stateless. Every API call requires sending the full message history. This means Prism — not any individual LLM — owns the conversation. Prism controls what each model "sees" by dynamically assembling context from a unified memory store. This is the architectural foundation that makes cross-model handoff possible.

### Target Users

- Power users who work with multiple AI chatbots daily and are tired of copy-pasting between them
- Developers who want to leverage different LLMs' strengths for different tasks
- Teams that need to compare LLM outputs systematically

---

## Architecture (5 Layers)

```
┌─────────────────────────────────────┐
│  Frontend (React / Next.js)         │  ← Unified Timeline + Agent Dashboard
├─────────────────────────────────────┤
│  Orchestrator                       │  ← Task Planner + Scheduler + Router
├─────────────────────────────────────┤
│  LLM Layer        │  Agent Layer    │  ← Brains + Hands
├─────────────────────────────────────┤
│  Memory Layer (Context Engine)      │  ← The nervous system
├─────────────────────────────────────┤
│  External Tools                     │  ← File System, Git, Cloud, APIs
└─────────────────────────────────────┘
```

### Layer 1: Frontend

- **Unified Timeline**: A single chronological view showing all interactions across all LLMs. Each message is tagged with its source model (e.g., "GPT-4o", "Claude Opus"). When a handoff occurs, the timeline shows the transition visually.
- **Mode Selector**: Four modes — Parallel, Handoff, Compare, Synthesize
- **Handoff Controls**: User can select a conversation segment, choose a target model, and optionally add a task-specific instruction before handing off.
- **Agent Dashboard**: Shows active agent executions, progress, and outputs.
- **Model Selector**: Toggle which LLMs are active. Show cost estimates per model.

Tech: Next.js (App Router) + Tailwind CSS + WebSocket for streaming

### Layer 2: Orchestrator

The central decision-making layer. Replaces a simple router.

- **Task Planner**: Analyzes user intent and breaks it into subtasks. When user says "turn this architecture into an app", it decomposes into: analyze modules → scaffold code → run tests → deploy.
- **Execution Scheduler**: Determines task ordering and parallelism. Independent tasks run concurrently; dependent tasks run sequentially.
- **Task Router**: Routes each subtask to the appropriate destination:
  - Thinking/generating tasks → LLM Layer
  - Execution/action tasks → Agent Layer
  - Hybrid tasks → LLM first, then Agent

Key design: LLMs can trigger agents via function calling / tool use. This creates a feedback loop where LLMs decide what agents to invoke.

Tech: FastAPI (Python) or Express (Node.js) — choose one and be consistent

### Layer 3a: LLM Layer

Unified adapter layer that normalizes all LLM interactions.

```
Common Interface
├── OpenAI Adapter (GPT-4o, o3, o4-mini)
├── Anthropic Adapter (Claude Opus 4.6, Sonnet 4.5)
├── Google Adapter (Gemini 2.5 Pro, Flash)
└── (extensible for future providers)
```

Each adapter must:
- Normalize request format (prompt, system message, temperature, tools)
- Normalize response format (text, tool calls, token usage, latency)
- Handle streaming via SSE or WebSocket
- Handle file uploads (each provider has different formats/limits)
- Report token usage and estimated cost
- Handle rate limiting with exponential backoff

All LLM calls go through Common Interface. No direct provider API calls elsewhere.

### Layer 3b: Agent Layer

Specialized agents that take action on LLM outputs.

Built-in agents:
- **Code Gen Agent**: Takes architecture descriptions/diagrams → scaffolds project (calls Claude Code API or generates files directly)
- **Test Agent**: Runs test suites (npm test, pytest), reports coverage and failures
- **Deploy Agent**: Deploys to Vercel/AWS/etc., returns live URL
- **Doc Agent**: Generates README, API docs, changelogs from codebase
- **Research Agent**: Web search, data gathering, URL scraping

Agent contract (every agent must implement):
```
interface Agent {
  name: string
  description: string  // Used by LLM to decide when to invoke
  inputSchema: JSONSchema  // What the agent expects
  execute(input, context: MemoryContext): Promise<AgentResult>
}

interface AgentResult {
  success: boolean
  output: any  // The agent's deliverable
  artifacts: Artifact[]  // Files, images, URLs created
  log: string[]  // Execution steps for Execution Log
}
```

Custom agents: Users can register their own agents via a plugin system.

### Layer 4: Memory Layer (Context Engine)

The core of Prism. Four specialized stores + one builder.

#### 4a. Conversation Memory
- Stores ALL messages from ALL LLMs in a single chronological store
- Each message tagged with: `source_model`, `timestamp`, `session_id`, `handoff_id` (if part of a handoff chain)
- Schema:
  ```
  Message {
    id, session_id, role (user|assistant|system),
    content, source_model, handoff_from?,
    token_count, timestamp
  }
  ```
- Storage: PostgreSQL or SQLite

#### 4b. Artifact Memory
- Stores generated files, diagrams, code, images
- Version tracking (each artifact has a history)
- Schema:
  ```
  Artifact {
    id, session_id, type (code|image|diagram|document),
    content/file_path, created_by (model or agent),
    version, parent_version?, timestamp
  }
  ```

#### 4c. Decision Memory
- Tracks what was decided and why
- User preferences (e.g., "always use Claude for diagrams")
- Model performance observations (e.g., "GPT was faster for this type of task")

#### 4d. Execution Log
- Agent execution history: what was run, inputs, outputs, success/failure
- Enables the Orchestrator to learn from past executions

#### 4e. Context Builder (CRITICAL COMPONENT)
- Assembles the `messages` array for each LLM API call
- Reads from all four memory stores
- Applies **token budget management**: each model has different context window sizes
  - GPT-4o: 128K tokens
  - Claude Opus: 200K tokens
  - Gemini 2.5 Pro: 1M tokens
- Compression strategies:
  - Recent messages: include verbatim
  - Older messages: summarize
  - Cross-model outputs: include as system/user message with clear attribution
  - Artifacts: include description/summary, not full content (unless specifically needed)
- Handoff context packaging:
  ```
  "You are continuing a task handed off from {source_model}.
  Here is the relevant context from the previous conversation:
  {compressed_context}

  The user now wants you to: {user_instruction}"
  ```

### Layer 5: External Tools

File System, Git/GitHub, Cloud Platforms (Vercel, AWS), Third-party APIs.
Agents interact with these. LLMs never directly touch external tools.

---

## Four Modes of Operation

### Mode 1: Parallel (⚡)
Send the same prompt to all selected LLMs simultaneously. Display responses side-by-side.
- Simplest mode. No agent involvement.
- Good for: comparing writing quality, fact-checking, getting diverse perspectives.

### Mode 2: Handoff (🔄)
Transfer conversation context from one LLM to another.
- Flow: User chats with Model A → triggers handoff → Context Packager compresses relevant history → sends to Model B with handoff prompt → Model B continues with full context
- **Sync-back**: After Model B produces output, that output is written to Memory. When user returns to Model A, Context Builder automatically includes Model B's output in Model A's message history.
- Good for: leveraging different models' strengths (GPT for business analysis → Claude for diagrams → Gemini for data analysis).

### Mode 3: Compare (🔍)
Cross-model evaluation. Send Model A's output to Model B and C for critique.
- Flow: Model A responds → its response is sent to B and C with "evaluate this response" instruction → B and C provide critiques → all displayed together
- Good for: quality assurance, finding blind spots, getting second opinions.

### Mode 4: Synthesize (🧬)
Combine the best parts of multiple model responses.
- Flow: All models respond → a designated "synthesizer" model receives all responses → produces a merged best-of response
- Good for: getting the most comprehensive and accurate answer possible.

---

## Tech Stack

### Backend
- **Language**: TypeScript (Node.js) — consistent with frontend, good async support
- **Framework**: Fastify or Express
- **Database**: PostgreSQL (production) / SQLite (development)
- **Cache**: Redis (response cache, rate limiting)
- **WebSocket**: Socket.io or native ws for streaming
- **Queue**: BullMQ (for agent task execution)

### Frontend
- **Framework**: Next.js 15 (App Router)
- **Styling**: Tailwind CSS
- **State**: Zustand or Jotai
- **Streaming**: Server-Sent Events or WebSocket

### LLM SDKs
- OpenAI: `openai` npm package
- Anthropic: `@anthropic-ai/sdk` npm package
- Google: `@google/generative-ai` npm package

### Agent Orchestration
- Consider LangGraph.js for complex agent workflows
- Or build a lightweight custom orchestrator if LangGraph is too heavy

---

## Development Phases

### Phase 1: Foundation (MVP)
**Goal**: Single prompt → multiple LLMs → side-by-side display

1. Set up monorepo (Turborepo or Nx)
2. Build Common Interface + 3 LLM adapters (OpenAI, Anthropic, Google)
3. Build basic frontend with prompt input and parallel response display
4. Implement WebSocket streaming
5. Basic Conversation Memory (SQLite)
6. Parallel mode working end-to-end

**Deliverable**: User can type a prompt and see GPT, Claude, Gemini respond side by side in real time.

### Phase 2: Context Engine
**Goal**: Handoff mode with full context continuity

1. Build Unified Context Store (upgrade to PostgreSQL)
2. Build Context Packager (extraction, summarization, compression)
3. Build Context Builder (dynamic message history assembly with token budgeting)
4. Implement Handoff UI (select conversation segment, choose target model)
5. Implement sync-back (cross-model context updates)
6. Build Unified Timeline view

**Deliverable**: User can chat with GPT, handoff to Claude with full context, and when returning to GPT it knows what Claude produced.

### Phase 3: Compare & Synthesize
**Goal**: Cross-model evaluation and synthesis

1. Implement Compare mode (cross-evaluation flow)
2. Implement Synthesize mode (best-of merger)
3. Add Artifact Memory (track generated files/diagrams)
4. Add Decision Memory (track preferences)
5. Build Task Classifier (optional: auto-suggest best model for task type)

**Deliverable**: User can get multiple models to critique each other's work and produce a synthesized best answer.

### Phase 4: Agent Layer
**Goal**: LLM outputs trigger real-world actions

1. Define Agent interface/contract
2. Build Code Gen Agent
3. Build Test Agent
4. Build Deploy Agent
5. Implement Orchestrator (Task Planner + Scheduler)
6. Implement LLM → Agent feedback loop (LLM decides which agents to call)
7. Build Agent Dashboard in frontend
8. Add Execution Log to Memory

**Deliverable**: User can say "turn this architecture into an app" and watch agents scaffold, test, and deploy it.

### Phase 5: Polish & Extensibility
1. Custom agent plugin system
2. File upload handling across all providers
3. Cost tracking and optimization suggestions
4. Export conversation history
5. User preferences and model profiles
6. Authentication and multi-user support

### Phase 6: Communication Tools Integration
**Goal**: Connect external communication tools (Outlook, Teams, Line) so Prism can monitor messages, draft replies, and learn user reply habits.

Architecture:
- **Connector Layer** (`apps/api/src/connectors/`): BaseConnector abstract class with provider-specific implementations. All external messages normalized to `ExternalMessage` interface. Outlook connector uses Microsoft Graph API (covers both Outlook mail and Teams chat). Monitoring: Webhook (Graph Change Notifications) as primary, Polling (5-min interval) as fallback.
- **New Agents**: `ReplyDraftAgent` (drafts replies using LLM with thread context + learned tone), `MessageMonitorAgent` (syncs new messages and evaluates monitor rules).
- **Reply Learning** (`apps/api/src/services/reply-analyzer.ts`): When user approves/rejects a draft, analyze and store reply patterns (tone, length, style) per sender. Inject learned patterns into reply draft system prompt. Uses keyword-based heuristic, not LLM calls.
- **Monitor Rules Engine** (`apps/api/src/services/monitor-engine.ts`): User-defined rules with conditions (keywords, senders, subject, time range). Actions: notify (WebSocket push), draft_reply, draft_and_notify. Rules stored in `monitor_rules` table.
- **Session Integration**: Each external thread maps to one Prism session. External messages in `external_messages` table (separate from `messages`). AI drafts saved to both `draft_replies` and `messages` tables.
- **Frontend**: New `communication` mode in ModeSelector. Left-right layout: ThreadList + ThreadDetail. Components: CommunicationView, ThreadList, ThreadDetail, DraftEditor, MonitorRuleBuilder, ConnectorSetup, CommNotificationBadge, ReplyLearningPanel.
- **6 new DB tables**: connectors, external_threads, external_messages, reply_learning, monitor_rules, draft_replies.

See `PLAN-PHASE6.md` for full schema and API endpoint design.

---

## Key Design Decisions

1. **TypeScript full-stack**: Same language frontend and backend. Better DX, shared types.
2. **API-only, no web scraping**: All LLM interactions through official APIs. More reliable, supports streaming, enables full context control.
3. **Memory is the source of truth**: No LLM holds state. Prism's Memory Layer is the single source of truth for all conversations.
4. **Agents are stateless**: Agents receive context from Memory, execute, write results back to Memory. They don't maintain their own state.
5. **Context Builder is the gatekeeper**: Every LLM API call goes through Context Builder. It decides what each model sees, respecting token limits.
6. **Start simple, add complexity**: Phase 1 is a simple parallel fan-out. Each phase adds one major capability. Don't build everything at once.

---

## Project Structure

```
prism/
├── apps/
│   ├── web/                  # Next.js frontend
│   │   ├── app/              # App Router pages
│   │   ├── components/       # UI components
│   │   │   ├── Timeline/     # Unified Timeline
│   │   │   ├── AgentDash/    # Agent Dashboard
│   │   │   ├── ModelPicker/  # Model selector
│   │   │   └── ModeSelector/ # Mode toggle
│   │   └── lib/              # Client utilities
│   └── api/                  # Backend API server
│       ├── routes/           # API endpoints
│       ├── services/         # Business logic
│       ├── adapters/         # LLM adapters
│       │   ├── common.ts     # Common Interface
│       │   ├── openai.ts
│       │   ├── anthropic.ts
│       │   └── google.ts
│       ├── agents/           # Agent implementations
│       │   ├── base.ts       # Agent interface
│       │   ├── codegen.ts
│       │   ├── test.ts
│       │   ├── deploy.ts
│       │   ├── reply-draft.ts    # Phase 6: Reply drafting agent
│       │   └── message-monitor.ts # Phase 6: Message monitoring agent
│       ├── connectors/       # Phase 6: External tool connectors
│       │   ├── base-connector.ts  # Abstract connector interface
│       │   ├── outlook.ts         # Microsoft Graph (Outlook + Teams)
│       │   ├── line.ts            # LINE Messaging API
│       │   └── registry.ts        # Connector management
│       ├── memory/           # Memory Layer
│       │   ├── conversation.ts
│       │   ├── artifact.ts
│       │   ├── decision.ts
│       │   ├── execution-log.ts
│       │   └── context-builder.ts  # THE critical component
│       ├── services/         # Business logic
│       │   ├── connector-service.ts  # Phase 6: Connector lifecycle
│       │   ├── reply-analyzer.ts     # Phase 6: Tone/pattern analysis
│       │   └── monitor-engine.ts     # Phase 6: Rule evaluation
│       └── orchestrator/     # Orchestrator
│           ├── planner.ts
│           ├── scheduler.ts
│           └── router.ts
├── packages/
│   └── shared/               # Shared types and utilities
│       ├── types.ts          # Common TypeScript types
│       └── constants.ts
├── CLAUDE.md                 # This file
├── package.json
└── turbo.json                # Turborepo config
```

---

## API Keys Required

User must provide their own API keys:
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_AI_API_KEY`

Store in `.env.local`, never commit to git.

---

## Non-Goals (for now)

- No web scraping of ChatGPT/Claude/Gemini web interfaces
- No local/self-hosted model support (can add later)
- No mobile app (web-first)
- No multi-user collaboration (single-user first)
- No voice input/output
