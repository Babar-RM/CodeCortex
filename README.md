# CodeCortex 🧠⚡

**CodeCortex** is an enterprise-grade multi-agent AI system for deep codebase understanding powered by a living knowledge graph (Neo4j), structural AST parsing (`tree-sitter`), semantic vector search (`pgvector`), and high-speed LLM reasoning (via Groq / LLaMA 3 / OpenAI).

Connect a GitHub repository; CodeCortex shallow-clones it, deterministically parses code structure into Neo4j graph nodes and edges, generates vector embeddings locally, and deploys a team of specialized AI agents to answer complex natural-language questions with zero-hallucination graph verification.

---

## 🏗️ Architecture & System Design

```mermaid
flowchart TD
    subgraph Client ["Client Layer"]
        Browser["Next.js 14 Dashboard & Chat UI (Port 3000)"]
    end

    subgraph BackendApp ["Backend System (Port 4000)"]
        API["Express HTTP API (/api/*)"]
        Auth["Auth.js (GitHub OAuth)"]
        Queue["BullMQ Job Queue (Redis)"]
        Worker["BullMQ Pipeline Worker Process"]
        AgentEngine["Multi-Agent Engine\n(Planner, Explainer, Bug-Tracer,\nReviewer, Refactorer, Critic)"]
    end

    subgraph ParserApp ["Parser Microservice (Port 8001)"]
        FastAPI["Python FastAPI"]
        TreeSitter["Tree-sitter AST Parser\n(JS/TS/JSX/TSX/Python)"]
        Embedder["bge-small-en-v1.5 Embedder\n(sentence-transformers)"]
    end

    subgraph DataStores ["Data Persistence"]
        PG[("PostgreSQL\nUsers, Repos, Jobs,\nChat History + pgvector")]
        Neo4j[("Neo4j Graph DB\n:File, :Function, :Class\n:CALLS, :IMPORTS, :DEFINES")]
        Redis[("Redis\nBullMQ Queues & Caching")]
    end

    subgraph ExternalServices ["External Providers"]
        Groq["Groq LLM API\n(openai/gpt-oss-120b / LLaMA)"]
        GitHub["GitHub API & Shallow Clones"]
    end

    Browser <-->|REST / SSE Streaming| API
    Browser -->|Sign In| Auth
    API --> PG
    API --> Queue
    Worker <--> Queue
    Worker -->|git clone| GitHub
    Worker <-->|POST /parse & /embed| FastAPI
    Worker -->|Write Nodes & Edges| Neo4j
    Worker -->|Write Embeddings| PG
    API <--> AgentEngine
    AgentEngine <-->|Cypher Graph Queries| Neo4j
    AgentEngine <-->|pgvector Search| PG
    AgentEngine <-->|LLM Completions| Groq
    FastAPI --> TreeSitter
    FastAPI --> Embedder
```

---

## ✨ Key Capabilities

- 🌳 **Deterministic AST Graph Extraction**: Parses function declarations, class hierarchies, imports, exports, and call-graphs directly into Neo4j using Python FastAPI + `tree-sitter`.
- ⚡ **Local Semantic Vector Search**: Embeds code chunks locally using `bge-small-en-v1.5` via `sentence-transformers` stored in Postgres `pgvector` columns.
- 🤖 **6-Agent Specialized Architecture**:
  - **Planner Agent**: Analyzes user query intent and maps out execution steps.
  - **Explainer Agent**: Breaks down architecture, design patterns, and code workflows.
  - **Bug-Tracer Agent**: Identifies edge cases, null dereferences, and logic bugs.
  - **Reviewer Agent**: Audits security, performance, and best practices.
  - **Refactorer Agent**: Proposes clean code refactorings with concrete diffs.
  - **Critic Agent**: Validates claims and code citations against the Neo4j graph before outputting the final answer to prevent hallucinations.
- 🚀 **High-Speed Groq LLM Inference**: Fully integrated with Groq (`GROQ_API_KEY`) utilizing ultra-fast inference models like `openai/gpt-oss-120b` or LLaMA 3.3.
- 📡 **Real-Time SSE Event Streaming**: Streams intermediate agent thoughts, tool executions, graph verification progress, and final answers live to the frontend interface.
- 🔗 **Commit-Pinned Code Citations**: Generates direct Markdown links pointing to exact file paths and line ranges on GitHub (`/blob/{sha}/{filePath}#L12-L24`).
- ⚡ **Incremental Re-Indexing & Caching**: Tracks Git commit SHAs to skip redundant indexing runs and caches multi-agent insights for instantaneous responses.

---

## 📁 Repository Structure

```text
CodeCortex/
├── AGENTS.md                  # System architecture, build phases, and agent rules
├── RULES.md                   # Strictly enforceable design rules (RFC 2119)
├── README.md                  # Comprehensive setup & operational guide
├── docker-compose.yml         # Container configuration for Postgres, Neo4j, Redis
│
├── frontend/                  # Next.js 14 (App Router) + TypeScript + Tailwind CSS (Port 3000)
│   ├── app/                   # App Router pages (/dashboard, /chat, /api)
│   ├── components/            # UI components (RepoConnector, ChatBox, AgentLogViewer)
│   └── lib/                   # API client & SSE consumer utilities
│
├── backend/                   # Express + TypeScript API Server & Worker (Port 4000)
│   ├── src/
│   │   ├── index.ts           # Express HTTP server entrypoint
│   │   ├── lib/               # LLM client, Prisma, Neo4j driver, agent loop
│   │   ├── jobs/              # BullMQ indexing worker & pipeline stages
│   │   ├── middleware/        # Auth, session, and rate-limiting middleware
│   │   └── routes/            # REST API endpoints (/api/repos, /api/chat)
│   └── prisma/                # PostgreSQL schema definitions & migrations
│
├── parser-service/            # Python FastAPI microservice (Port 8001)
│   ├── app/
│   │   ├── main.py            # FastAPI endpoints (/parse, /embed, /health)
│   │   ├── parsers/           # Tree-sitter parsers (JavaScript, TypeScript, Python)
│   │   └── embeddings.py      # bge-small-en-v1.5 local sentence-transformer pipeline
│   └── tests/                 # Pytest test suite for structural parsers
│
└── docs/rfcs/                 # Architectural Decision Records (RFC 0001–0029)
```

---

## ⚙️ Environment Configuration

### 1. Backend (`backend/.env`)

```env
PORT=4000
FRONTEND_ORIGIN=http://localhost:3000

# Auth.js / GitHub OAuth
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
AUTH_SECRET=your_generated_auth_secret

# Database Connections
DATABASE_URL=postgresql://user:password@localhost:5432/codecortex?sslmode=require
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your_neo4j_password
REDIS_URL=redis://localhost:6379

# Parser Microservice Endpoint
PARSER_SERVICE_URL=http://localhost:8001

# LLM Inference Configuration (Groq / OpenAI)
GROQ_API_KEY=gsk_your_groq_api_key
GROQ_MODEL=openai/gpt-oss-120b
```

### 2. Frontend (`frontend/.env.local`)

```env
NEXT_PUBLIC_BACKEND_URL=http://localhost:4000
```

---

## 🚀 Quick Start & Installation

### Prerequisites
- **Node.js**: `>= 20.x`
- **Python**: `>= 3.11`
- **PostgreSQL**: Version 15+ with `pgvector` enabled
- **Neo4j**: Version 5+ (Community or Enterprise)
- **Redis**: Version 7+

---

### Step-by-Step Setup

#### 1. Start Parser Microservice (Port 8001)
```powershell
cd parser-service
python -m venv .venv

# Windows PowerShell:
.\.venv\Scripts\Activate.ps1
# Linux/macOS:
source .venv/bin/activate

pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
```

#### 2. Start Backend API Server (Port 4000)
```powershell
cd backend
npm install
npx prisma db push
npm run dev
```

#### 3. Start Backend Ingestion Worker
In a separate terminal tab:
```powershell
cd backend
npm run worker
```

#### 4. Start Frontend Web Interface (Port 3000)
In a separate terminal tab:
```powershell
cd frontend
npm install
npm run dev
```

Visit [`http://localhost:3000`](http://localhost:3000) to connect a GitHub repository and begin querying your codebase with multi-agent AI!

---

## 🧪 Running Tests

### Backend Unit & Integration Tests (Vitest)
```bash
npm test --prefix backend
```

### Parser Microservice Tests (Pytest)
```powershell
cd parser-service
.\.venv\Scripts\pytest
```

### Frontend Production Build Verification
```bash
npm run build --prefix frontend
```

---

## 📜 Architectural Decision Records (RFC Index)

All core decisions are prospectively documented in `docs/rfcs/`:

- **Phase 0 (0001–0004)**: Service topology, Auth.js & GitHub OAuth, Prisma data model, repo connection API endpoints.
- **Phase 1 (0005–0010)**: Shallow git cloning, FastAPI tree-sitter parser, Neo4j schema, local `bge-small-en-v1.5` embeddings, BullMQ pipeline, private repository credentials.
- **Phase 2 (0011–0012)**: Hybrid retrieval (pgvector + Cypher), single-agent RAG engine, chat persistence.
- **Phase 3 (0013–0016)**: Planner agent routing, specialist agent tools, Critic graph verification, SSE progress streaming.
- **Phase 4 (0017–0019)**: Insight cache, incremental commit-diff re-indexing, evidence citation contracts.
- **Phase 5 (0020–0023)**: Rate limiting & token budgets, RBAC security, structured Pino logging, automated CI integration tests.
- **Phase 6 (0024–0029)**: Real-time dashboard indexing visualizer, chat UI, SSE event consumer, evidence rendering, error state UI, GitHub App setup.
- **Performance & Ingestion Hardening (0030)**: Large repository ingestion strategy, direct GitHub tarball archive streaming, batch parsing API, and bulk Cypher graph unwinding.
- **Agent Response Quality & Formatting (0031)**: Mandatory final synthesis LLM pass, trace leakage elimination, structured fallback formatting, and broad query handling.



---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
