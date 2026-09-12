# RFC 0029: Private repository / GitHub App install UI

- **Status:** Proposed
- **Phase:** Frontend (Phase 5 UI)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** `frontend/app/page.tsx`, `frontend/components/RepoConnector.tsx`
- **Depends on:** RFC 0021 (the GitHub App migration this surfaces)

## Summary

The landing page's "Sign in with GitHub" flow and the dashboard's repo picker will be updated to reflect RFC 0021's GitHub App migration — directing users to install the App (optionally scoped to specific repositories) rather than authorizing the old OAuth App, and visually distinguishing which listed repositories are actually accessible for indexing (i.e., covered by the App's installation) from ones that are not.

## Motivation

RFC 0021 changed the underlying access model on the backend specifically so private repos could work — but if the frontend still presents the old OAuth-App-authorization framing, users have no way to actually benefit from that change, and might be confused about why some of their repos work and others don't (depending on installation scope).

## Detailed design

### Planned landing page change

"Sign in with GitHub" becomes "Connect GitHub" or similar, linking to the GitHub App's installation URL rather than the old OAuth authorization URL — GitHub's own installation flow handles the actual repository-selection UI during that process.

### Planned dashboard indicator

Each repo in the picker (`GET /api/repos/github`) shows whether it's covered by the current installation (accessible) or not (would need the user to update their GitHub App installation settings to include it) — sourced from whatever RFC 0021's backend implementation exposes about installation scope.

## Implementation plan

1. Update the landing page's sign-in link/copy.
2. Extend `GET /api/repos/github`'s frontend consumption to show an "accessible" / "not covered by installation" indicator per repo, with a link to GitHub's installation settings for repos not currently covered.
3. Manually verify: install the App scoped to only some repos, confirm the picker correctly distinguishes covered vs. not-covered repos, and confirm attempting to connect a not-covered repo either is disabled or clearly explains what to do.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Explicit accessible/not-covered indicator per repo** *(proposed)* | Clear, prevents confusing failed-connect attempts | Requires the backend to expose installation-scope data per repo, a small addition to RFC 0021's existing response shape | **Proposed** |
| **Let a user attempt to connect any listed repo and fail later if not covered** | No extra UI needed | Confusing, delayed failure — the user finds out only after attempting to connect, worse than telling them upfront | Rejected |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Existing users who authorized the old OAuth App see a confusing transition when this ships | Medium (a real, one-time migration UX moment, already named in RFC 0021) | Low-medium | Clear, explicit copy explaining the one-time re-connect step, consistent with RFC 0021's own acknowledgment of this friction |

## Security considerations

None beyond what RFC 0021 already established — this is purely a rendering/UX layer over that decision.

## Performance considerations

None of note.

## Testing strategy

Manual verification per Implementation Plan, specifically covering both a fully-scoped and a partially-scoped installation.

## Rollback plan

If RFC 0021's backend migration is ever rolled back, this frontend change would need to revert in lockstep — the two are tightly coupled by design, since this RFC exists purely to surface that backend decision.

## Migration / rollout

Should ship in the same release as RFC 0021's backend migration, not separately — a frontend still presenting the old OAuth flow while the backend has already migrated would be actively broken, not just incomplete.

## Consequences

**Positive:** makes RFC 0021's real capability (private repo access) actually usable and clear to real users.

**Negative:** couples this frontend change tightly to RFC 0021's rollout timing — cannot ship independently.

## Success criteria

A user can clearly tell which of their repos are connectable and successfully connect a private one, end to end.

## Open questions

None significant.

## Non-goals for this RFC

Any change to the underlying GitHub App / access-token logic — purely a frontend surface over RFC 0021's decision.

## References

RFC 0021.
