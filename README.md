# Prism

Prism is a multi-LLM workspace for running, comparing, routing, and operationalizing AI conversations in one place.

Instead of treating each model as a separate chat silo, Prism keeps the conversation state itself. That lets you:

- send the same prompt to multiple models at once
- hand off context between models without copy-paste
- critique one model with another
- synthesize multiple responses into a single answer
- run agent workflows on top of model output
- monitor external communication channels and draft replies
- import past AI conversations into a searchable knowledge base

## What This Project Does

Prism combines three product ideas into one system:

1. A multi-model AI workspace
   Compare OpenAI, Anthropic, and Google models side by side, then continue the work with the model best suited for the next step.

2. A communication copilot
   Connect Outlook, Teams, LINE, or use a manual inbox. Prism can monitor threads, classify incoming messages, and draft replies using your learned style.

3. A conversation knowledge system
   Import ChatGPT, Claude, and Gemini exports, extract entities/tags, search them, and ask RAG-style questions across your own history.

## Core Modes

- `Parallel`: send the same prompt to multiple models
- `Handoff`: continue a task in a different model with preserved context
- `Compare`: ask other models to critique a response
- `Synthesize`: merge multiple model outputs into one answer
- `Agents`: execute structured agent tasks
- `Flow`: visualize cross-model conversation flow
- `Communication`: monitor and respond to external message threads
- `Library`: browse imported conversation archives
- `Knowledge`: explore extracted entities, tags, and graph links
- `Provenance`: trace where outputs came from
- `KB`: run knowledge-base / RAG search over indexed content

## Architecture

Prism is a monorepo with three main parts:

```text
prism/
├── apps/
│   ├── api/       # Express API, connectors, agents, memory, RAG, orchestration
│   └── web/       # Next.js frontend workspace
├── packages/
│   └── shared/    # Shared types and constants
└── scripts/       # Local helper scripts for connector exploration/testing
```

At a high level:

- `apps/web` is the UI
- `apps/api` is the orchestration and data layer
- SQLite stores sessions, messages, external threads, drafts, imports, knowledge records, and indexing metadata
- provider adapters normalize OpenAI / Anthropic / Google requests
- connectors normalize Outlook / Teams / LINE / Notion / manual communication sources

## Main Capabilities

### Multi-LLM orchestration

- parallel streaming across selected models
- per-model context building
- cross-model handoff
- compare and synthesize workflows
- model registry with provider-specific metadata

### Communication workflows

- Outlook connector
- local Outlook for macOS support
- Teams monitoring
- LINE monitoring
- Notion integration
- manual threads for copy/paste workflows
- AI reply drafting with learned sender style

### Knowledge and search

- import ChatGPT / Claude / Gemini archives
- full-text search across native and imported conversations
- knowledge extraction (entities, tags, graph relationships)
- hybrid RAG search over indexed chunks and embeddings
- citation-oriented question answering

### File handling

- upload and analyze PDFs, images, DOCX, XLSX, and PPTX
- async file analysis pipeline
- extract text and summaries into session context

## Tech Stack

- Frontend: Next.js 15, React 19, Zustand, Tailwind CSS
- Backend: Express, TypeScript, WebSocket + SSE streaming
- Storage: SQLite via `better-sqlite3`
- LLM providers: OpenAI, Anthropic, Google
- File and connector tooling: Puppeteer, AppleScript, document parsers
- Monorepo tooling: npm workspaces, Turbo

## Getting Started

### Prerequisites

- Node.js 22+ recommended
- npm 11+ recommended
- macOS if you want to use local Outlook / AppleScript flows
- Chrome-based environment if you want LINE / Teams Puppeteer-based connectors

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a root `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Minimum setup for core LLM usage:

```env
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GOOGLE_AI_API_KEY=...
```

Optional for Outlook OAuth:

```env
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_REDIRECT_URI=http://localhost:3001/api/connectors/outlook/callback
```

You may also need additional connector-specific variables, depending on which integrations you use.

### 3. Start the app

From the repo root:

```bash
npm run dev
```

This starts:

- web app at [http://localhost:3000](http://localhost:3000)
- API at [http://localhost:3001](http://localhost:3001)

## Typical Usage

### Multi-model workflow

1. Open Prism in the browser
2. Select one or more models
3. Start in `Parallel`
4. Switch to `Handoff`, `Compare`, or `Synthesize` as needed
5. Review timeline, topics, and knowledge extracted from the session

### Communication workflow

1. Open `Comms`
2. Connect a provider or create a manual thread
3. Sync/load messages
4. Generate a draft reply
5. Review, edit, approve, and send

### Knowledge workflow

1. Import a ChatGPT / Claude / Gemini archive
2. Let Prism index the conversations
3. Browse `Library`
4. Explore `Knowledge`
5. Use `KB` mode to ask questions across imported and native data

## Connectors and Integrations

Prism currently includes support for:

- OpenAI
- Anthropic
- Google Gemini
- Outlook OAuth
- Outlook for macOS
- Teams
- LINE
- Notion
- manual/local threads

Some connectors are production-shaped, while others are more local-first or workflow-specific. This repo should be treated as an actively evolving system rather than a polished SaaS product.

## Notes on Local State

Prism stores working data locally in SQLite during development. Sensitive local files are intentionally ignored from Git, including:

- `.env`
- nested `.env` files
- SQLite database files
- local build artifacts

If you deploy or share this project, review connector settings, local automation scripts, and environment variables before reuse.

## Development Commands

From the repo root:

```bash
npm run dev
npm run build
npm run lint
```

Per app:

```bash
npm run dev --workspace @prism/api
npm run dev --workspace @prism/web
```

## Project Status

Prism is functional, but still clearly in active development. The repository includes planning documents, prototype flows, and connector-specific experiments alongside the core app.

If you are evaluating the repo, the best way to understand it is:

1. start the app locally
2. try `Parallel`, `Handoff`, and `Comms`
3. import a conversation archive
4. explore `Knowledge` and `KB`

## License

No license file is currently included in this repository. Assume all rights reserved unless a license is added.
