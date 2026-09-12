# CodeCortex

**CodeCortex** is a multi-agent AI system for understanding codebases through a living knowledge graph (Neo4j), structural AST parsing (`tree-sitter`), and semantic vector search (`pgvector`).

A team of specialized LLM agents (Planner, Explainer, Bug-Tracer, Reviewer, Refactorer) reason over both the code graph and embeddings, with a dedicated **Critic agent** verifying every answer against the graph database for zero hallucinations.

---

## Repository Structure

```text
codecortex/
├── AGENTS.md                  # Operating principles & system architecture
├── RULES.md                   # Strictly enforceable rulebook (RFC 2119)
├── README.md                  # Setup & project quick reference
│
├── frontend/                  # Next.js 14 App Router + TypeScript + Tailwind CSS (Port 3000)
├── backend/                   # Express + TypeScript API & worker processing engine (Port 4000)
├── parser-service/            # FastAPI + tree-sitter + bge-small-en-v1.5 microservice (Port 8001)
└── docs/rfcs/                 # Architectural Decision Records (RFC 0001–0029)
```

---

## Key Features

- 🔍 **Deterministic AST Graph Extraction**: Uses Python FastAPI + `tree-sitter` to parse call graphs, imports, and symbol definitions into Neo4j.
- ⚡ **Local Semantic Embeddings**: Runs `bge-small-en-v1.5` locally via `sentence-transformers` stored in `pgvector`.
- 🤖 **6-Agent Architecture**: Includes Planner, Explainer, Bug-Tracer, Reviewer, Refactorer, and Critic.
- 🛡️ **Critic Graph Verification**: Every generated response is checked by the Critic against the Neo4j graph before being returned.
- 📡 **Real-Time SSE Progress Streaming**: Server-Sent Events stream intermediate multi-agent steps ("Planning", "Tool Call", "Critic Verification", "Revising").
- 🔗 **Commit-Pinned Evidence Citations**: Clickable source cards linking directly to the exact file and line ranges on GitHub (`/blob/{sha}/{filePath}#L12-L24`).
- ⏱️ **Live Dashboard Indexing Polling**: Dynamic dashboard updating status (`PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`) and live progress messages.
- 🛡️ **Rate Limiting & Token Budgets**: User request rate limiting and daily token budget enforcement with actionable reset banners.
- 🔒 **GitHub App Integration**: Supports private repository indexing with granular GitHub App scoping.

---

## Project Status

- [x] **Phase 0**: Foundation (Auth, Prisma Postgres Schema, Repo-Connection API Routes)
- [x] **Phase 1**: Ingestion Pipeline (Shallow Clone $\rightarrow$ tree-sitter AST Parse $\rightarrow$ Neo4j Graph $\rightarrow$ pgvector Embeddings $\rightarrow$ BullMQ Orchestration)
- [x] **Phase 2**: Single Agent (Hybrid Retrieval + Single-Agent RAG Engine & Chat Persistence API)
- [x] **Phase 3**: Full 6-Agent System (Planner, Explainer, Bug-Tracer, Reviewer, Refactorer, Critic + SSE Step Streaming)
- [x] **Phase 4**: Memory & Efficiency (Insight cache, incremental re-indexing, evidence data model)
- [x] **Phase 5**: Hardening, Testing & Production Polish (Rate limiting, RBAC, structured logging & agent trace, automated CI tests)
- [x] **Phase 6**: Frontend UI & Real-Time Interaction (Next.js 14 App Router, live polling, streaming chat UI, evidence rendering, error state UI, GitHub App UI)

---

## Quick Start

### 1. Requirements
- Node.js >= 20.x
- Python >= 3.11
- PostgreSQL (with `pgvector` extension)
- Neo4j Graph Database
- Redis

### 2. Setup & Installation

#### Backend
```bash
cd backend
npm install
cp .env.example .env
npx prisma db push
npm run dev
```

#### Parser Microservice
```bash
cd parser-service
python -m venv .venv
# Windows: .venv\Scripts\activate | Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8001 --reload
```

#### Frontend
```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

---

## Running Tests

### Backend Unit & Integration Tests (Vitest)
```bash
npm test --prefix backend
```

### Parser Microservice Tests (Pytest)
```bash
cd parser-service
python -m pytest
```

### Frontend Build & Lint Check
```bash
npm run build --prefix frontend
npm run lint --prefix frontend
```

---

## Architectural Decision Records (RFCs)

All non-trivial architectural decisions are recorded under `docs/rfcs/`:

- **Phase 0 (0001–0004)**: Service topology, Auth.js & GitHub OAuth, Prisma data model, repo connection API.
- **Phase 1 (0005–0010)**: Shallow cloning, FastAPI tree-sitter parser microservice, Neo4j schema, local `bge-small-en-v1.5` embeddings, BullMQ job queue, private repo credentials decision.
- **Phase 2 (0011–0012)**: Hybrid retrieval (pgvector + Neo4j Cypher), single-agent RAG engine.
- **Phase 3 (0013–0016)**: Planner agent routing, specialist agent tool-calling, Critic graph verification, SSE event streaming.
- **Phase 4 (0017–0019)**: Insight cache, incremental commit-diff re-indexing, evidence data contracts.
- **Phase 5 (0020–0023)**: Rate limiting & cost controls, RBAC private repo permissions, Pino structured logging & trace logs, fixture-based CI automated tests.
- **Phase 6 (0024–0029)**: Dashboard live indexing progress, chat interface architecture, SSE streaming consumption, evidence citation rendering, rate-limit error UI, GitHub App install UI.
