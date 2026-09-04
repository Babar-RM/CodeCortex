# RULES.md

Strict, enforceable rules for CodeCortex. Every rule uses **MUST** / **MUST NOT** / **SHOULD** / **SHOULD NOT** (RFC 2119-style). MUST/MUST NOT are non-negotiable without an approved exception (see **Exception & Approval Rules**). SHOULD/SHOULD NOT are strong defaults that need a stated reason to deviate from.

This file is the enforceable companion to `AGENTS.md` (which explains context and workflow). When the two conflict, `RULES.md` wins.

---

## Rule Priority

1. **Security rules outrank everything else**, including shipping speed, feature completeness, and code elegance.
2. **Architecture rules outrank feature convenience.** A feature that requires violating a system boundary must be redesigned, not shipped with the boundary broken.
3. **Explicit rules in this file outrank implicit convention.** If existing code violates a rule here, the existing code is the bug — new code must not copy it.
4. **RFCs outrank undocumented judgment calls.** If an RFC exists for an area, follow it or supersede it; don't quietly diverge.
5. Where two rules in this file appear to conflict, the more specific rule (narrower section) wins over the more general one.
6. Ties are resolved by raising the question, not by picking silently (see **Exception & Approval Rules**).

## Architecture Rules

1. The system MUST remain split as: `frontend/` (Next.js, presentation only) → `backend/` API process → `backend/` worker process → `parser-service/` (Python, internal-only) — per RFC 0001.
2. `frontend/` MUST NOT hold any secret, database credential, or long-lived token. It MUST talk to the system only via `backend/`'s HTTP API.
3. `parser-service/` MUST NOT have public network ingress in any deployment. It MUST NOT hold database credentials of any kind.
4. `parser-service/` MUST NOT execute, `eval`, or otherwise run any code extracted from a parsed repository. It performs static parsing only (RFC 0006).
5. Only the **worker** process (`backend/src/jobs/worker.ts`) MUST write to Neo4j. The API request-handling process MUST NOT write to Neo4j directly from a route handler.
6. Long-running or multi-minute work (cloning, parsing, graph writes, embedding generation) MUST run in the worker process, never inline in an HTTP request handler.
7. No component MAY read or write another component's datastore directly. Cross-boundary interaction MUST be an explicit, typed HTTP call.
8. Introducing a new service, datastore, or process boundary MUST come with an RFC before implementation.

## Repository Rules

1. The repository MUST retain the top-level structure: `frontend/`, `backend/`, `parser-service/`, `docs/`, `AGENTS.md`, `RULES.md`, `README.md`, `docker-compose.yml`, `.github/`.
2. Each app (`frontend/`, `backend/`) MUST own its own `package.json`, `tsconfig.json`, `.env.example`, `Dockerfile`, and `.dockerignore`. These MUST NOT be merged or shared across apps.
3. `parser-service/` MUST manage dependencies only via `requirements.txt` (or a future `pyproject.toml` if migrated) — Python and JS/TS dependency management MUST NOT be mixed.
4. Generated artifacts (`node_modules/`, `dist/`, `.next/`, `__pycache__/`) MUST NOT be committed. `.gitignore` MUST cover all of them.
5. RFCs MUST live under `docs/rfcs/`, one file per decision, numbered sequentially, never renumbered or reused.
6. New pipeline stages MUST live under `backend/src/jobs/pipeline/`, one file per stage.

## Feature Independence Rules

1. A pipeline stage (`fetch-repo.ts`, `parse-files.ts`, `build-graph.ts`, `generate-embeddings.ts`, and any future stage) MUST be callable and testable independently of the others — explicit typed inputs, explicit typed outputs, no hidden shared mutable state between stages beyond what's passed as parameters.
2. A stage MUST NOT reach into a later stage's datastore (e.g., Step 6's parsing MUST NOT write to Neo4j; that is Step 7's exclusive responsibility).
3. Frontend components MUST NOT contain business logic that duplicates backend validation or state derivation — the backend is the source of truth; the frontend renders it.
4. A new feature MUST be addable without modifying unrelated features' files, except where the change is genuinely cross-cutting (e.g., a shared type contract) — in which case the cross-cutting nature MUST be explicit in the PR description.

## Dependency Rules

1. A new production dependency MUST be justified — prefer the standard library or an already-used dependency before adding a new one.
2. A new **datastore, queue, or core framework** dependency (replacing or sitting alongside Postgres/Neo4j/Redis/BullMQ/Express/Next.js) MUST NOT be added without an RFC.
3. Dependencies MUST be pinned to specific or caret-ranged versions in `package.json`/`requirements.txt` — no unpinned `latest`.
4. A dependency that requires sending private repository content to an external third-party API (e.g., a hosted embedding API instead of the local `bge-small-en-v1.5` model) MUST NOT be added without explicit review — this would break the current "private code never leaves infrastructure you control" guarantee (RFC 0008).
5. Dev-only tooling (linters, test runners) MUST be in `devDependencies` and MUST NOT be required at runtime in a production Docker image, except where a documented reason exists (e.g., `prisma` CLI is intentionally in `dependencies` because `prisma migrate deploy` runs in the production container).

## Coding Rules

1. All new backend/frontend code MUST be TypeScript, not JavaScript.
2. All new parser-service code MUST be Python 3.12+, type-hinted (`from __future__ import annotations` not required on 3.12, but function signatures MUST carry type hints).
3. Route handlers MUST stay thin: validate input, delegate to `lib/`/`jobs/pipeline/` logic, return a response. Business logic MUST NOT live inline in a route handler beyond simple orchestration.
4. Functions performing a pipeline stage MUST accept a single typed params object, not a long positional-argument list.
5. Code MUST NOT contain commented-out blocks of dead code left "just in case" — delete it; git history preserves it.
6. Magic numbers/strings with real significance (file size limits, batch sizes, retry counts) MUST be named constants with a comment explaining the value's origin (see `MAX_FILE_SIZE_BYTES`, `BATCH_SIZE` as the pattern).

## Type Safety Rules

1. `frontend/tsconfig.json` and `backend/tsconfig.json` MUST keep `"strict": true`. This MUST NOT be weakened.
2. `// @ts-ignore` or `// @ts-expect-error` MUST NOT be used to silence a type error without an adjacent comment explaining why the underlying type is wrong and why suppressing it (rather than fixing it) is correct.
3. `any` MUST NOT be used for values with a knowable shape. Use `unknown` plus a narrowing check, or a proper interface/type.
4. Every Prisma model change MUST be reflected in `npx prisma generate` before code depending on it is considered complete (i.e., don't hand-write types that duplicate what Prisma would generate, if Prisma is already the source of truth).
5. Cross-service contracts (backend `parser-client.ts` types ↔ parser-service `schemas.py` Pydantic models) MUST be updated together, in the same change, whenever either side's shape changes.

## Naming Rules

1. Backend/TS module filenames MUST be `kebab-case.ts` (e.g., `fetch-repo.ts`).
2. React component filenames MUST be `PascalCase.tsx`.
3. Python module filenames MUST be `snake_case.py`.
4. Prisma models MUST be `PascalCase` singular; their mapped table names MUST be `snake_case` plural via `@@map`.
5. Neo4j node labels MUST be `PascalCase` singular (`:File`, `:Function`). Relationship types MUST be `SCREAMING_SNAKE_CASE` verbs (`:CALLS`, `:IMPORTS`).
6. Environment variables MUST be `SCREAMING_SNAKE_CASE`. Client-exposed Next.js variables MUST be prefixed `NEXT_PUBLIC_` and MUST NOT contain secrets.
7. RFC filenames MUST follow `docs/rfcs/NNNN-kebab-case-title.md` with a zero-padded sequential number.

## API Rules

1. All `/api/*` backend routes MUST require authentication via the `requireAuth` middleware unless explicitly and intentionally public (and documented as such in the route file).
2. All request bodies MUST be validated server-side with Zod before touching Prisma or any other datastore — client-side validation is never sufficient on its own.
3. Auth.js's `/auth/*` routes MUST remain mounted before `express.json()` in `backend/src/index.ts` — this ordering MUST NOT be changed without verifying Auth.js's own body parsing still works.
4. Responses MUST return typed, predictable JSON shapes — no ad hoc shape changes based on internal state that the frontend has to guess at.
5. A new endpoint MUST have its corresponding typed client function added to `frontend/lib/api.ts` in the same change, if the frontend consumes it. Components MUST NOT call `fetch` directly against the backend.
6. CORS configuration (`backend/src/index.ts`) MUST specify an explicit `FRONTEND_ORIGIN` and MUST NOT use `"*"` while `credentials: true` is set.

## Database Rules

1. All Postgres schema changes MUST go through a Prisma migration (`npm run prisma:migrate`) — no manual, unmigrated schema edits against a live database.
2. Every foreign key MUST specify an explicit `onDelete` behavior. `Cascade` is the default per RFC 0003; deviating requires a stated reason.
3. Raw SQL (`$queryRaw`/`$executeRaw`, used for the `vector` column) MUST use Prisma's tagged-template parameterization. String concatenation into a raw SQL query MUST NOT be used under any circumstance.
4. All Neo4j writes MUST use `MERGE`, never `CREATE`, for any node/relationship that could plausibly be re-written on re-index (RFC 0007).
5. All Cypher queries MUST use `$parameters` — string concatenation into a Cypher query MUST NOT be used under any circumstance.
6. A migration that removes or changes the type of an existing column MUST be called out explicitly in the PR description as a breaking schema change (see **Breaking Change Rules**).
7. `pgvector` embedding rows MUST be scoped by `connectedRepoId` in every query — a query across `code_embeddings` without that scope MUST NOT be written.

## Authentication Rules

1. GitHub OAuth via `@auth/express` MUST remain the sole authentication method. No additional provider (password, other OAuth providers) MAY be added without an RFC.
2. The GitHub access token MUST live only in the Auth.js JWT session cookie. It MUST NOT be persisted to Postgres, Redis, Neo4j, logs, or any other durable store, under any circumstance, including to "solve" the private-repo worker limitation — that requires its own RFC, not a quiet workaround.
3. `AUTH_SECRET` MUST be generated with real entropy per environment and MUST NOT be reused across dev/staging/production.
4. All authenticated route access MUST go through the `requireAuth` middleware — a route MUST NOT implement its own parallel session-checking logic.
5. Session cookies MUST remain `httpOnly`. Client-side JavaScript MUST NOT be given direct read access to the session token.

## Authorization Rules

1. A user MUST only be able to read or modify their own `ConnectedRepo`, `IndexingJob`, `ChatSession`, `ChatMessage`, and `CodeEmbedding` rows. Every query filtering these tables MUST scope by the authenticated `req.user.id` (directly or via a relation).
2. There MUST be no role or admin bypass of the above scoping anywhere in application code today. If one is ever needed, it MUST be designed and documented via RFC before implementation, not added ad hoc.
3. Cross-user data sharing (teams, orgs, shared repos) MUST NOT be implemented without an RFC — the current model assumes strict per-user isolation, and other rules (e.g., cascade-delete behavior) depend on that assumption holding.
4. The parser service, having no concept of users, MUST NOT be given any data it could leak across tenants — it MUST only ever receive the specific file/text content of the single request being served.

## Security Rules

1. Untrusted content (any cloned repository's file contents) MUST only ever be parsed, never executed, evaluated, or shelled out to.
2. All external input — API request bodies, pasted URLs, file paths derived from a cloned repo — MUST be validated before use in any database query, filesystem operation, or subprocess call.
3. Secrets MUST NOT appear in: source code, commit messages, log output, error messages returned to the client, or committed files of any kind.
4. The GitHub access token used for cloning MUST NOT be written to a persisted git credentials file on disk; it MUST only exist transiently in the clone command's execution.
5. New third-party dependencies MUST be checked for known vulnerabilities (`npm audit`/equivalent) before being added, and existing dependencies SHOULD be kept patched.
6. Any code path that could allow a Cypher or SQL injection (string-built queries) MUST be treated as a blocking issue, not a style nitpick.
7. The parser service MUST remain unreachable from the public internet in every deployment configuration.

## Environment & Secrets Rules

1. Each app MUST source its configuration from its own `.env` file, itself derived from that app's `.env.example`.
2. `.env`, `.env.local`, and any file containing real secret values MUST be listed in `.gitignore` and MUST NOT be committed.
3. Every new environment variable a change introduces MUST be added to the relevant `.env.example` in the same change, with a comment explaining its purpose if not self-evident.
4. `NEXT_PUBLIC_*` variables MUST be treated as public from the moment they're defined — they MUST NOT hold secrets, API keys, or anything sensitive.
5. Docker images MUST NOT bake in secret values at build time, except the documented, deliberate `NEXT_PUBLIC_BACKEND_URL` case required by Next.js's build-time inlining behavior.
6. Production secrets MUST be supplied via the deploy platform's secret manager or environment configuration, never via a file checked into the image or repo.

## Error Handling Rules

1. A pipeline job's failure MUST update `IndexingJob.status` to `FAILED` with a human-readable `errorMessage` — a job MUST NOT fail silently or hang indefinitely in `RUNNING`.
2. A single bad file during parsing (Step 6) MUST NOT abort the entire indexing job — it MUST be logged and skipped, per the established pattern in `parse-files.ts`.
3. A job-level precondition failure (e.g., attempting to index a private repo with no stored credential) MUST fail the whole job explicitly and clearly — it MUST NOT be silently worked around by weakening a security rule (see Authentication Rule 2).
4. API error responses MUST NOT leak internal details (stack traces, raw database errors, file paths) to the client. They MUST return a generic message plus an appropriate HTTP status code; details belong in server-side logs only.
5. Every `try/finally` around a resource that needs cleanup (temp directories, open sessions/connections) MUST actually perform that cleanup in the `finally` block — see `cleanupRepo()` as the required pattern for any future resource-acquiring stage.
6. Uncaught exceptions in the worker MUST be allowed to propagate to BullMQ (after updating `IndexingJob` to `FAILED`) so its retry/backoff logic can act on them — they MUST NOT be swallowed.

## Logging & Observability Rules

1. Logs MUST NOT contain secrets, tokens, or full session cookies, under any circumstance.
2. Logs SHOULD include enough context (job ID, repo full name, step name) to trace a failure back to a specific indexing run without needing to reproduce it.
3. `console.log`/`print` debugging statements MUST be removed before a change is considered complete, unless they're a deliberate, permanent operational log line (in which case use the structured logger — `pino`/`pino-http` on the backend — not a raw `console.log`).
4. Worker job failures MUST be logged with enough detail (job ID, error message) to triage without database access, per the existing `worker.on("failed", ...)` pattern.

## AI/LLM Rules

*(Applies once Phase 2/3 introduce actual LLM calls — Phase 0/1 have none.)*

1. No LLM/AI call of any kind MAY be introduced into Phase 0/1 pipeline code (Steps 1–9). Structure extraction, graph construction, and embedding generation MUST remain fully deterministic.
2. When Phase 2/3 LLM calls are introduced, every user-facing answer MUST pass through the Critic agent's graph-verification step before being returned — this MUST NOT be treated as an optional or cuttable component of "an agent that answers questions."
3. LLM calls MUST NOT be given raw, unscoped access to a user's entire codebase without going through the retrieval layer (graph + embeddings) — this is what distinguishes CodeCortex from a plain RAG chatbot and MUST be preserved architecturally.
4. Prompts and any LLM-facing code MUST NOT embed secrets or full access tokens as part of context construction.
5. Any introduction of a third-party hosted LLM API MUST document, via RFC, what data leaves local infrastructure and under what terms — consistent with the existing embedding-model precedent (RFC 0008) of preferring local execution where feasible.

## Testing Rules

1. A change to `backend/` or `frontend/` MUST NOT break existing passing tests.
2. `npm run lint` and the relevant `build`/typecheck command MUST pass before a change is considered complete.
3. A new pipeline stage SHOULD ship with at least a fixture-based unit test callable without live network access (a real GitHub clone, live Neo4j, etc.), per the pattern established in RFCs 0005–0009's Testing Strategy sections.
4. A manual checkpoint explicitly called for by an RFC (e.g., Step 6/7/8's hand-verification) MUST actually be performed and its result stated before that step is claimed done — "the code compiles" is not sufficient evidence of correctness for these steps.
5. Tests MUST NOT depend on external network access to third-party services (GitHub, a hosted model API) in CI — use fixtures/mocks.

## Git Rules

1. Work MUST happen on a branch, not directly on `main`.
2. Branches SHOULD be named `phase-N/step-M-short-description`, matching the report's step numbering, per `AGENTS.md`'s Git Workflow.
3. `main` MUST always be in a state that passes `ci.yml` — a red `main` MUST be treated as an incident, not a background task.
4. History-rewriting commands (`push --force` to `main`, `rebase` of shared history) MUST NOT be used on `main` or any shared branch without explicit coordination.
5. Large, unrelated changes MUST NOT be bundled into a single commit or branch — one step/concern per branch, per `AGENTS.md`.

## Commit Rules

1. Commit messages MUST describe what changed and, where relevant, reference the step/RFC involved (e.g., `feat(backend): Step 7 graph writer (RFC 0007)`).
2. A commit MUST NOT mix an unrelated formatting-only diff with a functional change — keep them separate for reviewability.
3. Commit messages MUST NOT contain secret values, even accidentally (double-check diffs before committing `.env`-adjacent changes).
4. A commit that fixes a bug introduced earlier in the same branch SHOULD be squashed into the original commit before merge, rather than left as a visible "fix typo" trail, unless the branch's history is independently valuable to preserve.

## Pull Request Rules

1. A PR MUST describe: what changed, why (linking an RFC if one exists or is newly added), and how it was verified (tests run, manual checkpoint performed).
2. A PR that changes a cross-service contract MUST show both sides of the change (e.g., backend `parser-client.ts` diff and parser-service `schemas.py` diff).
3. A PR introducing a new datastore, queue, framework, or auth provider MUST link an approved RFC — it MUST NOT be merged without one (see Dependency Rules, Architecture Rules).
4. A PR MUST NOT be merged with failing CI.
5. A PR that represents a breaking change (schema, API contract, deploy config) MUST be labeled/flagged as such per **Breaking Change Rules**.
6. A PR touching security-relevant code (auth, CORS, query construction, secret handling) SHOULD get explicit reviewer attention called out in the PR description, not buried in a larger diff.

## CI/CD Rules

1. Every app with its own `package.json`/`requirements.txt` MUST have its own CI job (lint/build/test) in `.github/workflows/ci.yml`. A service without CI coverage (currently `parser-service/` — a known, tracked gap) MUST NOT be treated as "done" until this exists.
2. `docker-publish.yml` MUST only build/push images after `ci.yml` has passed on `main` — this ordering MUST NOT be bypassed.
3. The `deploy` job MUST remain gated (`if: false` or an equivalent explicit gate) until a real deploy target is chosen and configured — it MUST NOT silently start deploying to an undocumented destination.
4. Docker image builds MUST NOT embed secret values into image layers (see Environment & Secrets Rules).
5. A new service added to the project MUST get a corresponding Dockerfile, `.dockerignore`, CI job, and `docker-compose.yml` entry in the same change that introduces it.

## Documentation Rules

1. A decision involving real alternatives (library choice, schema shape, security tradeoff) MUST be recorded as an RFC under `docs/rfcs/` — either before implementation (preferred) or in the same change as implementation.
2. `AGENTS.md` MUST be kept current with actual repository structure and workflow — a structural change (new app, new major directory) MUST update it in the same change.
3. `README.md` MUST be kept current with actual setup steps — a new required env var or local service (e.g., Neo4j, Redis) MUST be reflected there.
4. Inline comments MUST explain *why*, not restate *what* the code already makes obvious — comments that only restate the next line MUST be avoided.
5. A known limitation or gap discovered during implementation (e.g., the private-repo credential gap) MUST be documented inline at the relevant code AND as an Open Question in the applicable RFC — it MUST NOT be left undocumented.

## Breaking Change Rules

1. A breaking change is any of: removing/renaming a Postgres column or table in use, removing/renaming a Neo4j label or relationship type in use, changing an API response shape in a way existing frontend code doesn't handle, or changing a job payload shape without backward compatibility.
2. A breaking change MUST be called out explicitly in its PR description — it MUST NOT be bundled silently inside an unrelated feature change.
3. A breaking schema change MUST include a migration plan (how existing data is handled — backfilled, dropped with justification, or transformed) in the PR description, not just the raw migration file.
4. A breaking change to a cross-service contract (backend ↔ parser-service, frontend ↔ backend) MUST update both sides in the same change — a breaking change landed on only one side MUST NOT be merged.
5. A breaking change that contradicts an existing RFC's documented decision MUST supersede that RFC (new RFC, old one marked `Superseded by NNNN`) as part of the same change.

## Performance Rules

1. A new database query added to a request-handling path MUST use an appropriate index — an unindexed scan on a table expected to grow MUST NOT be introduced without a stated reason.
2. Long-running work (clone, parse, graph write, embed) MUST NOT be added to a synchronous HTTP request handler — it belongs in the worker (see Architecture Rules).
3. Batch operations (e.g., embedding generation) SHOULD batch external calls (to the parser service) rather than making one call per item, where the API supports batching.
4. A change that measurably slows down `POST /api/repos`'s response time (which MUST stay near-instant, per RFC 0004's design) MUST NOT be merged — that endpoint enqueues work, it does not perform it.
5. New Neo4j query patterns expected to run frequently or at scale SHOULD have a supporting index (see RFC 0007's `ensureGraphIndexes`) added in the same change.

## Accessibility Rules

1. All new interactive frontend elements (buttons, form inputs, links) MUST be real semantic HTML elements (`<button>`, `<input>`, `<a>`) or carry correct ARIA roles — MUST NOT be built from bare `<div onClick>` patterns.
2. All images/icons conveying meaning MUST have appropriate `alt` text or `aria-label`; purely decorative elements MUST be marked `aria-hidden`.
3. Color MUST NOT be the only means of conveying status (e.g., job status like `FAILED`/`SUCCEEDED`) — text or icon MUST accompany color coding.
4. Interactive elements MUST be reachable and operable via keyboard alone (tab order, visible focus states) — MUST NOT rely on hover/mouse-only interaction.
5. Form inputs MUST have associated, programmatically-linked labels, not placeholder text used as the only label.

## Backward Compatibility Rules

1. A change to a Prisma model MUST NOT break existing rows' validity — new required fields MUST have a default or a backfill migration.
2. A change to the parser service's `/parse` or `/embed` response shape MUST NOT break the currently-deployed backend's expectations without a coordinated, versioned rollout (both sides updated together — see Breaking Change Rules).
3. A change to `IndexingJob.status`'s enum values MUST account for existing rows already carrying the old values.
4. Old BullMQ job payload shapes still sitting in the queue at deploy time MUST be handled gracefully (or the queue drained/versioned) if the payload shape changes — a deploy MUST NOT assume the queue is empty.
5. RFCs MUST NOT be deleted when superseded — mark `Status: Superseded by NNNN` and keep the file, preserving the historical record.

## Prohibited Practices

1. Hardcoding secrets, API keys, or credentials directly in source code — MUST NOT, ever.
2. Disabling TypeScript strict mode, ESLint rules, or test suites to "make CI pass" without fixing the underlying issue — MUST NOT.
3. Executing untrusted repository content in any form (`eval`, dynamic `require`/`import` of cloned code, shelling out to a script found in a cloned repo) — MUST NOT, ever.
4. String-concatenating user- or repo-derived data into a SQL or Cypher query — MUST NOT, ever.
5. Persisting the GitHub access token to any durable store — MUST NOT, ever, without a superseding RFC to RFC 0002.
6. Setting CORS `origin: "*"` alongside `credentials: true` — MUST NOT, ever.
7. Committing `.env` files or any file containing real secret values — MUST NOT, ever.
8. Adding a new datastore/queue/framework, auth provider, or cross-tenant data-sharing feature without an RFC — MUST NOT.
9. Silently skipping a phase's mandated manual checkpoint (Steps 6/7/8's hand-verification) and claiming the step complete — MUST NOT.
10. Introducing advertising, telemetry, or third-party analytics without an explicit, separate, approved task — MUST NOT.
11. Force-pushing to `main` — MUST NOT.
12. Beginning Phase 2/3 (agents, LLM calls) implementation while Phase 1's checkpoint is unconfirmed — MUST NOT.

## Completion Rules

A task/change MUST NOT be reported as complete unless all of the following hold:
1. Code compiles/typechecks with no errors in every app touched.
2. Lint passes with no new warnings introduced.
3. Existing tests pass; new logic required by **Testing Rules** has coverage.
4. Any cross-service contract touched is updated on both sides.
5. New environment variables are documented in the relevant `.env.example`.
6. Any decision requiring an RFC has one, drafted or updated.
7. The relevant phase/step's mandated manual checkpoint (if any) has actually been performed, with its result stated — not assumed.
8. No rule in this document has been silently violated; any necessary exception has been recorded per **Exception & Approval Rules**.
9. `docker-compose.yml` still brings up the affected service(s) cleanly if their configuration changed.
10. Known limitations introduced or discovered are documented (inline + RFC Open Questions where applicable), not hidden.

## Exception & Approval Rules

1. Any MUST/MUST NOT rule in this document MAY only be violated with an explicit, recorded exception — never silently.
2. An exception MUST be recorded as either: (a) a new or updated RFC explaining the tradeoff, or (b) an explicit note in the PR description that a human reviewer has approved, referencing the specific rule being excepted and why.
3. An agent (AI or automated tool) MUST NOT unilaterally decide to except a MUST/MUST NOT rule — it MUST surface the conflict and request explicit approval before proceeding.
4. Repeated, informal exceptions to the same rule are a signal the rule itself may be wrong — this MUST prompt a proposal to change the rule (via updating this file with reasoning), not continued quiet exceptions.
5. SHOULD/SHOULD NOT rules MAY be deviated from with a stated reason in the PR description alone — no separate approval process is required, but the reason MUST be stated, not omitted.
6. Security Rules and Prohibited Practices exceptions require the highest bar — a stated reason plus explicit human sign-off is mandatory in every case; an RFC alone is not sufficient for a Prohibited Practices exception without also being reviewed and approved as a deliberate, isolated decision.