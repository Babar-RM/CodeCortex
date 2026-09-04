# RFC 0002: Authentication — Auth.js + GitHub OAuth

| Metadata | Details |
|---|---|
| **Status** | Proposed |
| **Phase** | 0 (Step 2) |
| **Date** | 2026-08 |
| **Author** | CodeCortex team |
| **Affects** | `backend/src/lib/auth.ts`, `backend/src/middleware/requireAuth.ts`, `backend/src/lib/auth-types.d.ts` |
| **Depends on** | [RFC 0001](file:///e:/Projects/CodeCortex/docs/rfcs/0001-service-topology.md) |

---

## Summary

> [!IMPORTANT]
> CodeCortex will use **GitHub OAuth** as its single login method, implemented via `@auth/express`. A single OAuth grant serves double duty: identifying the user and authorizing repository access. There are no separate passwords, alternative identity providers, or secondary "connect GitHub" flows.

---

## Terminology

- **OAuth Grant / Scope:** Specific permissions granted by the user (e.g., `read:user`, `user:email`, `repo`).
- **JWT Session:** Stateless session state signed via `AUTH_SECRET` and stored in an HTTP-only browser cookie.
- **`httpOnly` Cookie:** Cookie flag preventing client-side JavaScript execution access (`document.cookie`), mitigating XSS session hijacking.

---

## Motivation

Every CodeCortex user needs at least one connected GitHub repository to receive any value. Treating identity (who you are) and repository access (what code can be read) as separate flows adds unnecessary synchronization overhead. Collapsing identity and repo permissions into a single login grant eliminates state-drift bugs.

---

## Detailed Design

### OAuth Scopes

| Scope | Purpose |
|---|---|
| `read:user` | Retrieves user profile metadata (avatar URL, username). |
| `user:email` | Fetches private primary email address if not public. |
| `repo` | Grants read access to both public and private repositories for Phase 1 ingestion. |

### Session Architecture

1. **JWT Strategy:** Sessions are stored as signed JWT cookies using `AUTH_SECRET`. No `sessions` table is maintained in Postgres.
2. **Token Security:** The GitHub access token resides **only** in the HTTP-only JWT session cookie. It is **never persisted** to any database or durable storage.

### Middleware & User Auto-Provisioning (`requireAuth`)

```typescript
// Pseudocode pattern for backend/src/middleware/requireAuth.ts
async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const session = await getSession(req, authConfig);
  if (!session?.githubId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Upsert user profile on every authenticated request
  const user = await prisma.user.upsert({
    where: { githubId: session.githubId },
    update: {
      githubLogin: session.githubLogin,
      avatarUrl: session.avatarUrl,
      email: session.email,
    },
    create: {
      githubId: session.githubId,
      githubLogin: session.githubLogin,
      avatarUrl: session.avatarUrl,
      email: session.email,
    },
  });

  req.user = user;
  req.githubAccessToken = session.githubAccessToken;
  next();
}
```

> [!NOTE]
> All protected backend routes MUST use `requireAuth` as their single source of authentication truth.

---

## Implementation Plan

1. Install `@auth/express` in `backend/`.
2. Register a GitHub OAuth App with callback URL `http://localhost:4000/auth/callback/github`.
3. Add `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `AUTH_SECRET` to `.env.example` and `.env`.
4. Generate `AUTH_SECRET` via `npx auth secret`.
5. Implement `backend/src/lib/auth.ts` and `backend/src/lib/auth-types.d.ts`.
6. Mount `ExpressAuth(authConfig)` on `/auth/*` **before** `express.json()`.
7. Create `backend/src/middleware/requireAuth.ts`.
8. Verify end-to-end flow with a protected test route `GET /api/me`.

---

## Alternatives Considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Clerk / Auth0 + Separate OAuth** | Pre-built UI | Dual identity management, extra onboarding steps | **Rejected** |
| **GitHub OAuth + JWT Session** | Single grant, zero session table bloat | Tokens stored in client-side signed cookies | **Proposed** |
| **Hand-rolled OAuth Client** | No dependencies | Risk of CSRF state validation errors | **Rejected** |

---

## Security Considerations

> [!CAUTION]
> - `AUTH_SECRET` must be kept secret and unique per environment.
> - The GitHub access token MUST NOT be logged or written to Postgres, Redis, or disk.
