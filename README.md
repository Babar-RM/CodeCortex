# CodeCortex

**CodeCortex** is a multi-agent AI system for understanding codebases through a living knowledge graph ([Neo4j](file:///e:/Projects/CodeCortex/AGENTS.md#L316)), structural AST parsing (`tree-sitter`), and semantic vector search (`pgvector`).

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
├── frontend/                  # Next.js 14 presentation layer (Port 3000) — Built last
└── docs/rfcs/                 # Architectural Decision Records (RFC 0001–0023)
```

---

## Quick Start (Backend Dev)

### 1. Requirements
- Node.js >= 20.x
- npm >= 10.x

### 2. Setup & Running Backend
```bash
cd backend
npm install
npm run dev
```

### 3. Verification
```bash
curl http://localhost:4000/health
# Response: {"status":"ok"}
```

---

## Phase Status

- [x] **Phase 0 Step 1**: Backend Scaffolding & RFC 0001 Service Topology
- [ ] **Phase 0 Step 2**: GitHub OAuth Authentication (RFC 0002)
- [ ] **Phase 0 Step 3**: Prisma Postgres Schema (RFC 0003)
- [ ] **Phase 0 Step 4**: Repo-Connection API Routes & Frontend Dashboard (RFC 0004)
- [ ] **Phase 1**: Ingestion Pipeline (Clone $\rightarrow$ AST Parse $\rightarrow$ Graph $\rightarrow$ Embeddings)
