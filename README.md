# CodeCortex

**CodeCortex** is a multi-agent AI system for understanding codebases through a living knowledge graph (Neo4j), structural AST parsing (`tree-sitter`), and semantic vector search (`pgvector`).

A team of specialized LLM agents reason over the code graph, with a dedicated **Critic agent** verifying every answer against the graph for guaranteed structural correctness.

---

## Repository Structure

```text
codecortex/
├── AGENTS.md                  # Operating principles & system architecture
├── RULES.md                   # Strictly enforceable rulebook (RFC 2119)
├── README.md                  # Setup & project quick reference
│
├── backend/                   # Express + TypeScript API & worker engine (Port 4000)
├── parser-service/            # FastAPI + tree-sitter + bge-small-en-v1.5 (Port 8001)
├── frontend/                  # Next.js 14 presentation layer (Port 3000)
└── docs/rfcs/                 # Architectural Decision Records (RFC 0001–0023)
```

---

## Quick Start (Backend Dev)

### 1. Requirements
- Node.js >= 20.x
- Python >= 3.10 (for parser-service)
- Postgres with `pgvector` extension
- Neo4j Graph DB
- Redis

### 2. Running Backend Tests
```bash
npm test --prefix backend
npm run lint --prefix backend
npm run build --prefix backend
```

### 3. Health Verification
```bash
curl http://localhost:4000/health
# Response: {"status":"ok"}
```

---

## Phase Status

- [x] **Phase 0**: Foundation (Auth, Prisma Postgres Schema, Repo-Connection API Routes)
- [x] **Phase 1**: Ingestion Pipeline (Shallow Clone $\rightarrow$ tree-sitter AST Parse $\rightarrow$ Neo4j Graph $\rightarrow$ pgvector Embeddings $\rightarrow$ BullMQ Orchestration)
- [x] **Phase 2**: Single Non-Specialized Agent (RFC 0011 Hybrid Retrieval + RFC 0012 Single-Agent RAG Engine & Chat Persistence REST API)
- [ ] **Phase 3**: Full 6-Agent System (Planner, Explainer, Bug-Tracer, Reviewer, Refactorer, Critic)
- [ ] **Phase 4**: Memory & Efficiency (Insight cache, incremental re-indexing, evidence display)
- [ ] **Phase 5**: Hardening, Testing & Production Polish
