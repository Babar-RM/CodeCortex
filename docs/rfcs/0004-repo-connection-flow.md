# RFC 0004: Repo-Connection Flow

| Metadata | Details |
|---|---|
| **Status** | Proposed |
| **Phase** | 0 (Step 4) |
| **Date** | 2026-08 |
| **Author** | CodeCortex team |
| **Affects** | `backend/src/routes/repos.ts`, `frontend/components/RepoConnector.tsx`, `frontend/lib/api.ts` |
| **Depends on** | [RFC 0001](file:///e:/Projects/CodeCortex/docs/rfcs/0001-service-topology.md), [RFC 0002](file:///e:/Projects/CodeCortex/docs/rfcs/0002-authentication.md), [RFC 0003](file:///e:/Projects/CodeCortex/docs/rfcs/0003-phase-0-data-model.md) |

---

## Summary

> [!IMPORTANT]
> The repo connection flow supports two entry points—selecting from the user's GitHub repositories via OAuth or pasting a public repository URL directly. Both converge on a validated `POST /api/repos` endpoint that persists the repository reference and creates a `PENDING` `IndexingJob` row.

---

## Shared Request Validation Schema

```typescript
import { z } from "zod";

export const connectRepoSchema = z.object({
  fullName: z
    .string()
    .min(1)
    .regex(/^[^/]+\/[^/]+$/, "Expected 'owner/repo'"),
  htmlUrl: z.string().url(),
  isPrivate: z.boolean().default(false),
  defaultBranch: z.string().default("main"),
});
```

---

## Endpoint Contracts

### 1. `GET /api/repos/github`
- Fetches the user's accessible repositories directly from GitHub's REST API using the session's access token (`req.githubAccessToken`).
- Maps results to the standard repository metadata contract.

### 2. `POST /api/repos`
- Validates request payload against `connectRepoSchema`.
- Upserts `ConnectedRepo` record based on `[userId, fullName]`.
- Creates a placeholder `IndexingJob` record with `status: "PENDING"`.

### 3. `GET /api/repos`
- Returns all connected repositories for the authenticated user (`req.user.id`) including their latest indexing job status.

---

## Scope Restraint & Security Boundaries

> [!CAUTION]
> - `POST /api/repos` **MUST NOT** trigger repository cloning, parsing, or background indexing in Phase 0.
> - The GitHub access token **MUST NEVER** be exposed to the client bundle.
> - Input fields (`fullName`, `htmlUrl`) are strictly validated server-side using Zod before reaching Prisma.

---

## Implementation Plan

1. Implement Zod validation schema and route handlers in `backend/src/routes/repos.ts`.
2. Protect all routes with `requireAuth` middleware.
3. Verify all endpoints via `curl` and `prisma studio`.
4. Build `frontend/components/RepoConnector.tsx` and integrate backend calls into `frontend/lib/api.ts`.
