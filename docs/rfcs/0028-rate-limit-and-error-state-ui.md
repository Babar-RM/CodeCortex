# RFC 0028: Rate-limit and error-state UI

- **Status:** Proposed
- **Phase:** Frontend (Phase 5 UI)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** `frontend/components/ChatThread.tsx`, `frontend/lib/api.ts` (error handling)
- **Depends on:** RFC 0020 (the `429` responses this surfaces)

## Summary

Every `429 Too Many Requests` response from RFC 0020's rate-limiting middleware will be caught and rendered as a clear, specific, actionable message (which limit was hit, when it resets) rather than a generic error or a silently-failed request — matching RFC 0020's own backend principle that limits should be surfaced explicitly, extended now to the frontend that actually shows it to the user.

## Motivation

RFC 0020 built clear, specific `429` responses on the backend precisely so the frontend could show a real user something actionable. An unhandled `429` today would likely surface as a generic "something went wrong" or an unhandled promise rejection — neither honors what RFC 0020 was designed to enable.

## Detailed design

### Planned error handling

`frontend/lib/api.ts`'s shared `apiFetch()` wrapper will specifically check for a `429` status and throw a typed `RateLimitError` (carrying the limit name and reset time from the response body) distinct from its generic error path — allowing calling components to catch this specific case and render a tailored message rather than a generic failure banner.

```tsx
try {
  await sendMessage(content);
} catch (err) {
  if (err instanceof RateLimitError) {
    showBanner(`You've reached your ${err.limitName} limit. Resets at ${err.resetsAt}.`);
  } else {
    showBanner("Something went wrong. Please try again.");
  }
}
```

## Implementation plan

1. Extend `apiFetch()` to detect and specially handle `429` responses.
2. Add a `RateLimitError` type and a corresponding banner/toast component.
3. Wire this into the chat send flow and the repo-connect flow (both of RFC 0020's limited actions).
4. Manually verify: deliberately trigger each limit (or temporarily lower it for testing) and confirm the specific, correct message renders.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A typed `RateLimitError` with tailored UI** *(proposed)* | Matches RFC 0020's own principle of explicit, actionable limit communication | Slightly more error-handling code than a generic catch-all | **Proposed** |
| **Treat a 429 like any other error (generic failure message)** | Simpler | Directly undermines RFC 0020's own design intent — the backend went out of its way to be specific, and a generic frontend message would throw that away | Rejected |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Reset-time formatting is confusing across timezones | Low-medium | Low | Use a relative format ("resets in 12 minutes") rather than an absolute timestamp, avoiding timezone confusion entirely |

## Security considerations

None beyond what RFC 0020 already established.

## Performance considerations

None of note.

## Testing strategy

Manual limit-triggering verification per Implementation Plan.

## Rollback plan

Trivial — reverting to generic error handling is a small, isolated change.

## Migration / rollout

None.

## Consequences

**Positive:** completes RFC 0020's intent end-to-end, from backend enforcement to user-visible, actionable messaging.

**Negative:** none of substance.

## Success criteria

Each of RFC 0020's limits, when hit, shows a specific, correct, actionable message.

## Open questions

None significant.

## Non-goals for this RFC

Any change to the actual rate-limiting logic — purely a frontend rendering concern.

## References

RFC 0020.
