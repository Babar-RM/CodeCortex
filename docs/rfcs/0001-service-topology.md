# RFC 0001: Service Topology — Separate Express Backend + Next.js Frontend

| Metadata | Details |
|---|---|
| **Status** | Proposed |
| **Phase** | 0 (Step 1) |
| **Date** | 2026-08 |
| **Author** | CodeCortex team |
| **Affects** | Overall repo structure, `backend/`, `frontend/`, every future phase's deploy topology |
| **Supersedes** | None (first RFC) |

---

## Summary

> [!IMPORTANT]
> CodeCortex will be built as two independently deployable services from the very first commit — an **Express + TypeScript backend** and a **Next.js frontend** — communicating strictly over HTTP, rather than as a single Next.js application using API routes. The backend will be built and manually verified first; the frontend does not start until the backend has something real to consume.

This single decision shapes nearly every RFC that follows, establishing clear boundaries for where state lives, where secrets live, and where long-running work is allowed to execute.

---

## Terminology

- **Monolith (in this context):** A single Next.js application serving both UI pages and API routes from one process/deployment.
- **Split topology:** Two separately built, separately deployed, and separately scaled applications communicating over a network boundary (HTTP).
- **Long-running work:** Any operation that cannot reasonably complete within a typical HTTP request/response cycle (repo cloning, multi-file AST parsing, multi-step LLM agent loops).
- **Deployable unit:** A single artifact (container image, serverless function, process) built once and deployed as a whole.

---

## Motivation

### The problem this RFC solves
At inception, CodeCortex has zero lines of code. It would be tempting to build it as one Next.js app with API routes for initial speed. However, this project's explicit roadmap makes a monolith a dead end within Phase 1:

- **Phase 1 (Steps 5–9):** Requires shallow cloning git repos, executing Python AST parser sub-processes, writing structured facts to Neo4j & pgvector, and orchestrating background jobs via BullMQ—which requires a long-lived Node process listening on Redis, not ephemeral request-scoped functions.
- **Phase 3 (Steps 13–16):** Requires multi-agent loops (Planner, Specialist, Critic) with streaming SSE responses, stateful across calls.

Neither fits bounded serverless function execution timeouts. An always-on, addressable server process is required by Phase 1 at the latest.

### Why this can't be deferred
Building a split topology from day one avoids an expensive mid-project migration: extracting API logic, replacing NextAuth with `@auth/express`, re-plumbing CORS, and adjusting cookie credentials. Pay the minimal setup cost upfront rather than refactoring under time pressure.

---

## Background / Prior Art

This pattern—a lightweight presentation layer talking to a dedicated API/worker backend—is standard in developer platforms and background-processing SaaS (CI/CD tools, repo analyzer platforms, multi-agent services). CodeCortex adopts this battle-tested pattern from commit one.

---

## Detailed Design

### Planned Repo Layout

```text
codecortex/
├── backend/                  # Express + TypeScript (Port 4000 in dev) — BUILD FIRST
│   ├── src/
│   │   ├── index.ts          # App entrypoint: CORS, Auth.js mount, health & route mounts
│   │   ├── lib/              # Prisma client, auth config, Neo4j, parser client
│   │   ├── middleware/       # requireAuth session validation
│   │   ├── routes/           # REST API endpoints (e.g. repos.ts)
│   │   └── jobs/             # BullMQ queue & worker process
│   ├── prisma/
│   │   └── schema.prisma     # Postgres schema
│   ├── tsconfig.json
│   ├── package.json
│   └── Dockerfile
│
└── frontend/                 # Next.js 14 App Router + Tailwind (Port 3000 in dev) — BUILD LAST
    ├── app/                  # React Server Components & pages
    ├── components/           # UI components (e.g. RepoConnector.tsx)
    ├── lib/
    │   └── api.ts            # Typed fetch wrapper around backend API
    ├── tsconfig.json
    ├── package.json
    └── Dockerfile
```

### Build Sequencing Enforced by this RFC

> [!NOTE]
> Work starts with the backend — the frontend has nothing to render until the backend returns real, verified data.

1. **Backend Scaffolding:** Express app, TypeScript setup, `/health` route.
2. **Backend Authentication:** Auth.js + GitHub OAuth ([RFC 0002](file:///e:/Projects/CodeCortex/docs/rfcs/0002-authentication.md)).
3. **Backend Data Model:** Postgres Prisma schema & migrations ([RFC 0003](file:///e:/Projects/CodeCortex/docs/rfcs/0003-phase-0-data-model.md)).
4. **Backend Repo-Connection API:** `/api/repos` endpoints, verified via `curl` and `prisma studio` ([RFC 0004](file:///e:/Projects/CodeCortex/docs/rfcs/0004-repo-connection-flow.md)).
5. **Frontend Scaffolding:** Built last, consuming the already-verified backend endpoints via `frontend/lib/api.ts`.

### Communication Contract

- All `frontend` $\rightarrow$ `backend` requests pass through `frontend/lib/api.ts` using `credentials: "include"` to pass HTTP-only session cookies.
- Backend CORS configuration explicitly locks `Access-Control-Allow-Origin` to `FRONTEND_ORIGIN` alongside `credentials: true`. Wildcards (`*`) are prohibited.

---

## Implementation Plan

1. Initialize `backend/` with `package.json`, TypeScript (`tsconfig.json` with `"strict": true`), Express, and dev dependencies (`tsx`).
2. Implement `src/index.ts` with CORS, JSON body parser, and `GET /health` returning `{ status: "ok" }`.
3. Create `backend/.env.example` defining `PORT` and `FRONTEND_ORIGIN`.
4. Setup `.gitignore` covering `node_modules/`, `dist/`, `.env`.
5. Verify locally: Run `npm run dev` and test via `curl http://localhost:4000/health`.

---

## Alternatives Considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Next.js API routes (Monolith)** | Single repository, zero CORS setup | Fails Phase 1 long-running worker & Phase 3 agent streaming requirements | **Rejected** |
| **Separate Express Backend** | Independent process scaling, worker process support, strict state boundaries | Requires two dev servers, env management, and CORS configuration | **Proposed** |
| **tRPC End-to-End** | Full compile-time type safety across boundary | Adds framework complexity premature for initial small endpoint surface | **Deferred** |
| **GraphQL** | Client-driven query fetching | Unnecessary overhead for CRUD/queue orchestration endpoints | **Rejected** |

---

## Security Considerations

> [!CAUTION]
> - `FRONTEND_ORIGIN` must be an explicit URL (e.g., `http://localhost:3000` in dev).
> - Never set `Access-Control-Allow-Origin: *` while `credentials: true` is enabled.
> - The backend process holds all secrets (`DATABASE_URL`, `GITHUB_CLIENT_SECRET`, `AUTH_SECRET`). The frontend holds zero server secrets.

---

## Success Criteria

- Backend dev server starts on port 4000 and responds to `GET /health` with `200 OK`.
- By Phase 1, BullMQ worker executes seamlessly within `backend/` as a separate entrypoint (`src/jobs/worker.ts`) without architectural refactoring.
