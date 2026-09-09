# RFC 0021: RBAC and private repository access

- **Status:** Proposed
- **Phase:** 5 (Step 21)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** `backend/src/lib/auth.ts` (replaces RFC 0002's OAuth App flow), `backend/src/jobs/worker.ts` (removes RFC 0009/0010's private-repo block)
- **Depends on:** RFC 0002, RFC 0009, RFC 0010 (this RFC formally supersedes RFC 0010's deferred decision)
- **Supersedes:** RFC 0010

## Summary

CodeCortex will migrate from a GitHub OAuth App (RFC 0002's original design, tied to a live user session token that RFC 0010 correctly identified the background worker cannot access) to a **GitHub App**, whose installation-based access tokens are independently obtainable by the backend at job time — with no dependency on any specific user's session — short-lived, and scoped to the specific repositories the app has been installed against, rather than a blanket account-wide `repo` OAuth scope. This resolves RFC 0010's deferred private-repo limitation properly, exactly as that RFC's own Background section anticipated.

## Terminology

- **GitHub App (as distinct from an OAuth App):** a GitHub integration type installable against specific repositories or an entire organization, authenticating via short-lived installation access tokens rather than long-lived user-authorized OAuth tokens.
- **Installation access token:** a GitHub App's credential, obtained on demand by the backend (using the App's own private key, not any user's session), scoped only to the repositories the App is installed against, and expiring after a short period (commonly one hour), requiring periodic refresh.
- **RBAC (Role-Based Access Control):** in this RFC's scope, specifically about *what a user can access* (their own repositories, as already enforced) rather than introducing new internal roles — this RFC's naming reflects the report's own step title, but its actual design is narrower than a full multi-role permission system (see Non-goals).

## Motivation

### The problem this RFC solves

RFC 0010 explicitly, deliberately deferred solving private-repo indexing to this exact phase, having evaluated and rejected (for the interim) both staying public-repo-only indefinitely and persisting the existing OAuth token in encrypted storage. This RFC is where that deferred resolution actually happens — and it resolves in favor of the GitHub App migration RFC 0002 and RFC 0010 both already anticipated as the architecturally correct long-term answer, rather than the encrypted-token-storage alternative RFC 0010 left as a live but disfavored option.

### Why a GitHub App is the right answer, not merely an acceptable one

The core problem RFC 0010 identified was structural: RFC 0009's worker runs detached from any HTTP session, so it has no access to a token tied to that session, and RFC 0002's design deliberately never persists that token anywhere durable. A GitHub App sidesteps this problem entirely rather than working around it — its installation access tokens are obtainable by the backend independently, at any time, using the App's own long-lived private key (a single, backend-held secret, fundamentally different in kind from a per-user session token), with no dependency on a live user session existing at job time at all. This isn't a workaround for RFC 0010's structural problem; it removes the structural mismatch that caused the problem in the first place.

## Background / Prior art

GitHub Apps are GitHub's own recommended integration pattern specifically for automation and backend services that need durable, scoped access independent of any one user's browser session — exactly this project's use case. Migrating to a GitHub App is a well-trodden path for products that started with a simpler OAuth App and later needed exactly this capability.

## Detailed design

### Planned authentication flow changes

- **User-facing login** changes from "authorize an OAuth App" to "install the GitHub App" (optionally scoped to specific repositories at install time, or all repositories, at the user's choice) — GitHub's own installation flow handles this UI.
- **Identity** (RFC 0002's `githubId`/`githubLogin`/`email` capture) is still obtained via a standard OAuth-like user-authorization step that GitHub Apps support alongside installation — this RFC does not remove user identity capture, only replaces the *repository access* mechanism underneath it.
- **Repository access**, previously via the OAuth App's blanket `repo` scope, is now via the specific set of repositories the user has installed the App against — a meaningfully narrower, more explicit grant than RFC 0002's original design, and one GitHub's own installation UI makes clearly visible to the user at grant time.

### Planned worker-side token acquisition

At job start, RFC 0009's worker (rather than checking `repo.isPrivate` and failing immediately, as RFC 0009/0010 currently specify) will request a fresh installation access token directly from GitHub's API, authenticating with the GitHub App's own private key (a backend-held secret, set once per environment, never tied to any specific user) and the specific installation ID recorded for that repository at connect time. This token is scoped only to the repositories that installation covers and expires within roughly an hour — the worker requests a fresh one per job rather than attempting to cache and reuse a token across jobs, given the short expiry window.

### Planned schema change

`ConnectedRepo` gains an `installationId` field (recorded at connect time, from the GitHub App's installation webhook or the connect-flow's own response), replacing the current reliance on the user's session token for repository access entirely — this value is not a secret itself (a GitHub App installation ID is an identifier, not a credential), so no new persisted-secret concern is introduced by storing it.

### Removing RFC 0009's private-repo block

With a working private-repo access path now in place, the explicit `if (repo.isPrivate) { fail immediately }` check RFC 0009/0010 required is removed — private repositories are indexed through the exact same pipeline (RFC 0005–0009) as public ones, the only difference being which credential `fetchRepo()` (RFC 0005) uses for the clone.

## Implementation plan

1. Register a GitHub App (distinct from the existing OAuth App) with the specific permissions needed (repository contents: read-only is sufficient for this project's actual needs — cloning and reading, never writing).
2. Update `backend/src/lib/auth.ts`: retain identity capture, replace the repository-access mechanism with the GitHub App installation flow.
3. Add `installationId` to `ConnectedRepo` via a Prisma migration.
4. Implement installation-access-token acquisition in `backend/src/jobs/worker.ts` (or a shared `lib/github-app.ts` helper), called at the start of every indexing job, replacing the current session-token dependency.
5. Remove RFC 0009's private-repo early-exit block.
6. Manually verify: install the GitHub App against a private test repository, connect it through the updated flow, trigger an index, and confirm it clones and indexes successfully — the specific scenario RFC 0009/0010 explicitly could not support.
7. Manually verify the existing public-repo flow still works unchanged, confirming this migration didn't regress previously-working behavior.
8. Update `docs/rfcs/0010-private-repo-credential-storage.md`'s status to `Superseded by 0021`.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Migrate to a GitHub App** *(proposed)* | Removes the structural token-access problem entirely; scoped, short-lived, independently-refreshable tokens; matches GitHub's own recommended pattern for this exact use case | A genuinely significant migration of the existing auth flow (RFC 0002), requiring careful, tested transition | **Proposed** |
| **Adopt RFC 0010's previously-rejected encrypted-token-storage alternative instead** | Avoids an auth-flow migration; works with the existing OAuth App | Still carries a broadly-scoped, non-expiring token even encrypted at rest — a materially weaker security posture than a GitHub App's scoped, short-lived tokens; RFC 0010 already reasoned through and disfavored this option for exactly these reasons | Rejected — consistent with RFC 0010's own stated preference for the GitHub App path once it could be properly resourced |
| **Continue deferring, remain public-repo-only indefinitely** | Zero additional work | Private-repo indexing — plausibly a genuinely valuable, commonly requested capability — remains permanently unavailable, which is no longer justified once Phase 5's dedicated hardening work has arrived specifically to resolve deferred items like this one | Rejected — this is precisely the phase RFC 0010 named as the right time to resolve this properly |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The auth-flow migration introduces a regression in existing identity capture or public-repo access | Medium (any migration of working, load-bearing code carries this risk) | High | Explicit, mandatory manual verification of both the new private-repo path AND the previously-working public-repo path (Implementation Plan steps 6–7), not just the new capability alone |
| Installation access token refresh logic is implemented incorrectly, causing jobs to intermittently fail once tokens expire mid-job for a long-running index | Low-medium | Medium | Given tokens last roughly an hour and most indexing jobs are expected to complete well within that window, this is a lower-probability risk than it might first appear, but worth explicit testing against a deliberately large fixture repository if one is available |
| Users who previously authorized the old OAuth App need to re-authorize/reinstall under the new GitHub App, creating a one-time migration friction point for any existing users | Medium (any users onboarded before this RFC ships) | Low-medium (a one-time UX cost, not an ongoing one) | Should be clearly communicated if/when this ships to real existing users — a straightforward, bounded, one-time transition, not an ongoing burden |

## Security considerations

- This RFC represents a meaningful security *improvement* over RFC 0002's original design: installation tokens are scoped only to specifically-installed repositories (versus a blanket account-wide `repo` OAuth scope) and expire within roughly an hour (versus RFC 0002's non-expiring OAuth App tokens) — directly addressing both concerns RFC 0002's own Security Considerations section originally flagged as accepted tradeoffs.
- The GitHub App's private key is now the single most sensitive credential in the system — it must be stored with the same rigor as `AUTH_SECRET` (RFC 0002) or database credentials: never committed, unique per environment, accessed only by the backend process that needs it.
- `installationId` values, while not secrets themselves, must still be scoped correctly per `ConnectedRepo`/user exactly as every other repo-identifying field already is — no new authorization pattern is introduced, but this field must not be overlooked when reviewing access-scoping logic.

## Performance considerations

- Requesting a fresh installation access token per job adds one additional API call to GitHub at job start — negligible relative to the clone/parse/embed work that follows it in the same job.

## Testing strategy

- The private-repo and public-repo manual verifications in Implementation Plan (steps 6–7) are this stage's core checkpoint — both the new capability and the preserved old one must be confirmed working.
- Token-refresh behavior under a long-running job is worth a dedicated test against a deliberately large fixture repository, if the expiry-window risk above is judged worth proactively testing rather than only monitoring in production.

## Rollback plan

If the GitHub App migration introduces problems severe enough to need reverting, the rollback path is reverting to RFC 0002's original OAuth App flow and RFC 0009's private-repo block — a real rollback, not a trivial one, given real user installations would exist by the time this ships; this should be planned as a deliberate, communicated transition in either direction, not assumed to be a quick, invisible toggle.

## Migration / rollout

This is a genuinely significant migration requiring: existing users to install the new GitHub App (replacing their old OAuth App authorization), a `ConnectedRepo.installationId` backfill or re-connect flow for repositories connected before this RFC ships, and coordinated deployment (the old OAuth-based worker code path and the new GitHub-App-based one should not both be live simultaneously against the same data in a way that causes confusion about which credential mechanism is authoritative).

## Consequences

**Positive:** private-repo indexing finally works, with a meaningfully *more* secure token model than the original OAuth App design ever had — a rare case where resolving a limitation also improves security rather than trading one for the other.

**Negative:** a real, non-trivial migration effort touching foundational auth code (RFC 0002) that has been working and depended upon since Phase 0 — the single riskiest change in this project's history to this point, by virtue of touching the most foundational, most-relied-upon existing code.

## Success criteria

- A private repository can be connected and successfully indexed end-to-end, the exact scenario RFC 0009/0010 explicitly could not support.
- All previously-working public-repo functionality continues to work unchanged after this migration.
- RFC 0010 is formally marked `Superseded by 0021`.

## Open questions

- Should users who installed the App with "all repositories" access versus "selected repositories" access be treated any differently in the connect-flow UI? Not designed here — a product/UX question more than a backend architecture one.

## Non-goals for this RFC

- A general internal multi-role permission system (admin/member/viewer roles, team-based sharing) — despite this RFC's title echoing the report's "RBAC" step name, its actual scope is narrower: resolving repository *access* via GitHub's own permission model, not introducing new internal roles within CodeCortex itself. A genuine internal RBAC system, if ever needed, would warrant its own future RFC.

## References

- Report: "Step 21 — RBAC / private repo access," CodeCortex-Complete-Report.md.
- RFC 0002, RFC 0009, RFC 0010.
- GitHub documentation: GitHub Apps vs. OAuth Apps, installation access tokens.
