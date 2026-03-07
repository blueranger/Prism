# Prism — Remaining Claude Code Prompts

## Phase 3 Remaining

### 1. Decision Memory

Add a Decision Memory system to the Memory Layer.

Create `apps/api/src/memory/decision.ts` that stores user preferences and model performance observations. Schema:

```
decisions table:
  id TEXT PRIMARY KEY,
  session_id TEXT,
  type TEXT ('preference' | 'observation'),
  key TEXT (e.g., 'diagram_model', 'response_style'),
  value TEXT (e.g., 'anthropic/claude-sonnet', 'concise'),
  reason TEXT (why this decision was made),
  created_at INTEGER,
  updated_at INTEGER
```

Functions needed: `saveDecision()`, `getDecisions()`, `getDecisionsByType()`, `deleteDecision()`.

Then integrate into Context Builder (`context-builder.ts`). Add a new phase after Phase E that:
1. Loads all decisions for the current session
2. Formats them as a system message: "User preferences: ..."
3. Injects into the messages array

Add a REST endpoint `POST /api/sessions/:id/decisions` and `GET /api/sessions/:id/decisions` in a new route file or inside `sessions.ts`.

Add a simple UI component `DecisionPanel.tsx` — a small section in SessionDrawer or a standalone panel that shows current preferences and lets users add/edit/delete them manually. Keep the UI minimal.

---

### 2. Task Classifier

Add a Task Classifier that analyzes the user's prompt and recommends the best model.

Create `apps/api/src/services/task-classifier.ts`. It should:
1. Take a user prompt as input
2. Use pattern matching and keyword detection (not an LLM call — keep it fast and free) to classify the task type: coding, diagram, writing, analysis, math, translation, general
3. Map task types to recommended models based on known strengths:
   - coding → anthropic/claude-sonnet (strong at code)
   - diagram/visual → anthropic/claude-sonnet (Mermaid, SVG)
   - data analysis → google/gemini-flash (1M context for large data)
   - creative writing → openai/gpt-4o
   - general → no recommendation
4. Also check Decision Memory — if the user has a stored preference for this task type, that overrides the default mapping
5. Return: `{ taskType: string, recommendedModel: string | null, confidence: number, reason: string }`

Add endpoint `POST /api/classify` that accepts `{ prompt: string, sessionId?: string }`.

On the frontend, when the user types a prompt in Parallel mode, call the classifier. If it has a recommendation, show a subtle suggestion chip above the prompt input: "Suggested: Claude Sonnet (coding task)" — the user can click to switch to that model or ignore it. Do NOT auto-switch. This should be non-intrusive.

---

## Phase 4 Remaining

### 3. Deploy Agent

Add a Deploy Agent to the Agent Layer.

Create `apps/api/src/agents/deploy.ts` extending BaseAgent. It should:
1. Take generated code artifacts from a session (read from Artifact Memory)
2. Write them to a temp directory as actual files
3. Auto-detect project type (Node.js, Python, static HTML) from file contents
4. For static sites: use a simple local HTTP server (serve package) and return the local URL
5. For Node.js projects: run `npm install && npm start` in a child process and return the URL
6. Store the deployment info (URL, status, logs) as artifacts
7. Handle cleanup / stopping previous deployments

Register it in the agent registry with name "deploy" and description "Deploys generated code to a local server and returns a live URL".

Input schema: `{ sessionId: string, artifactIds?: string[], port?: number }`

This is a local-first deploy agent. Cloud deployment (Vercel/AWS) can be added later as a separate agent.

---

### 4. Doc Agent

Add a Documentation Agent to the Agent Layer.

Create `apps/api/src/agents/doc.ts` extending BaseAgent. It should:
1. Take code artifacts from a session
2. Send them to an LLM (use Claude Sonnet by default, same as CodeGen) with a prompt to generate documentation
3. Support multiple doc types via input: 'readme', 'api-docs', 'changelog'
4. For 'readme': generate a standard README.md with project overview, setup instructions, usage, and API reference
5. For 'api-docs': extract function signatures and generate API documentation
6. For 'changelog': compare artifact versions and generate a changelog
7. Store generated docs as new artifacts with type 'document'

Register with name "doc" and description "Generates documentation (README, API docs, changelog) from code artifacts".

Input schema: `{ sessionId: string, docType: 'readme' | 'api-docs' | 'changelog', artifactIds?: string[] }`

---

### 5. Research Agent

Add a Research Agent to the Agent Layer.

Create `apps/api/src/agents/research.ts` extending BaseAgent. It should:
1. Take a research query and optional constraints
2. Use an LLM (GPT-4o by default — good at synthesis) to break the query into search sub-questions
3. For each sub-question, generate a structured research note with: finding, source attribution, confidence level
4. Synthesize all findings into a research summary
5. Store the summary and individual findings as artifacts with type 'document'

Since we don't have web search API access, this agent works with the LLM's training knowledge only. The architecture should make it easy to plug in a web search API (SerpAPI, Tavily, etc.) later by adding a `searchProvider` option.

Register with name "research" and description "Researches a topic using LLM knowledge, produces structured findings and a synthesis report".

Input schema: `{ query: string, depth: 'quick' | 'thorough', constraints?: string }`

---

## Phase 5: Polish & Extensibility

### 6. Custom Agent Plugin System

Add a plugin system so users can register custom agents at runtime.

Create `apps/api/src/agents/plugin-loader.ts` that:
1. Watches a `plugins/` directory in the project root
2. Each plugin is a single `.js` or `.ts` file that exports: `{ name, description, inputSchema, execute }`
3. On startup, scan the directory and register each plugin with AgentRegistry
4. Add a REST endpoint `GET /api/agents/plugins` to list loaded plugins
5. Add a REST endpoint `POST /api/agents/plugins/reload` to rescan the directory

Also add a simple UI section to the Agent Dashboard that shows loaded plugins with a "Reload" button.

Provide one example plugin file `plugins/example-summarizer.js` that summarizes text input.

---

### 7. File Upload Handling

Add file upload support across all LLM providers.

1. Add a file upload endpoint `POST /api/upload` using multer. Store files in `uploads/` directory. Return file ID and metadata.
2. Update the prompt input UI to support drag-and-drop and a file attachment button.
3. Update each LLM adapter to handle file attachments:
   - OpenAI: use the files API or base64 image encoding for vision
   - Anthropic: use base64 image in message content blocks
   - Google: use inlineData for images, or fileData for larger files
4. Update `chat-store.ts` to track attached files per message
5. Store file references in the messages table (add `attachments` JSON column)

Support image files (png, jpg, gif, webp) first. PDF and document support can come later.

---

### 8. Cost Tracking

Add token usage and cost tracking.

1. Create `apps/api/src/memory/cost-tracker.ts` with schema:
   ```
   token_usage table:
     id TEXT PRIMARY KEY,
     session_id TEXT,
     message_id TEXT,
     model TEXT,
     input_tokens INTEGER,
     output_tokens INTEGER,
     estimated_cost REAL,
     timestamp INTEGER
   ```
2. Define cost rates per model in `packages/shared/src/constants.ts`:
   - GPT-4o: $2.50/1M input, $10/1M output
   - Claude Sonnet: $3/1M input, $15/1M output
   - Gemini Flash: $0.075/1M input, $0.30/1M output
3. After each LLM call in the route handlers, extract token usage from the adapter response and save to cost_tracker
4. Update each adapter to return `usage: { inputTokens, outputTokens }` in stream completion
5. Add endpoint `GET /api/sessions/:id/cost` returning per-model and total costs
6. Add a cost display in the frontend header showing session running cost, and a cost breakdown in SessionDrawer

---

### 9. Export Conversation History

Add conversation export functionality.

1. Add endpoint `GET /api/sessions/:id/export?format=json|markdown|html`
2. JSON format: full message array with metadata
3. Markdown format: formatted conversation with model attribution headers, code blocks preserved
4. HTML format: styled single-page HTML with model-colored message bubbles (embed CSS inline)
5. Add an "Export" button in SessionDrawer for each session, with a format dropdown
6. The export should include: all messages, artifact references, handoff events, and linked session info

---

### 10. User Preferences & Model Profiles

Add a settings panel for user preferences.

1. Create `apps/api/src/memory/preferences.ts` — global preferences (not per-session, unlike Decision Memory):
   - Default models to enable
   - Default mode (parallel/handoff/compare/synthesize)
   - Temperature per model
   - System prompt prefix (added to all LLM calls)
   - Theme (dark/light — for future use)
2. Store in SQLite `preferences` table (key-value pairs)
3. Add endpoint `GET /api/preferences` and `PUT /api/preferences`
4. Add a Settings icon in the header that opens a `SettingsPanel.tsx` modal
5. Context Builder should read global preferences and apply system prompt prefix

---

### 11. Authentication & Multi-User

Add basic authentication and multi-user support.

1. Add a `users` table: `id, email, password_hash, created_at`
2. Use bcrypt for password hashing, JWT for session tokens
3. Add endpoints: `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
4. Add auth middleware that validates JWT on all routes except auth endpoints
5. Add `user_id` column to sessions, messages, decisions, preferences tables
6. Scope all queries by user_id
7. Add a simple login/register page at `/login`
8. Store JWT in localStorage, include in API headers
9. Redirect to login if not authenticated

Keep it simple — no OAuth, no email verification, no password reset for now.
