# RFC 0024: Dashboard live indexing progress

- **Status:** Proposed
- **Phase:** Frontend (closes a Phase 1 gap)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** `frontend/components/RepoConnector.tsx`, `frontend/lib/api.ts`
- **Depends on:** RFC 0009 (the status/progressMessage fields this displays), RFC 0004 (the existing dashboard this extends)

## Summary

`RepoConnector.tsx`'s connected-repos list, which since Phase 0 has only ever displayed a static `indexingJobs[0]?.status ?? "PENDING"`, will be extended to poll `GET /api/repos` every 2–3 seconds while any job is in a non-terminal state (`PENDING`/`RUNNING`), rendering the live `progressMessage` RFC 0009's worker now actually writes, and stopping the poll once every job reaches `SUCCEEDED` or `FAILED`.

## Terminology

- **Terminal state:** a job status (`SUCCEEDED` or `FAILED`) that will not change further without a new indexing job being created — the condition that stops this RFC's polling loop.
- **Poll loop:** a client-side interval that repeatedly re-fetches data from an endpoint until some stopping condition is met, as opposed to a push-based mechanism (SSE, WebSockets).

## Motivation

### The problem this RFC solves

RFC 0004's original dashboard was built and verified before RFC 0009's worker existed — at the time, `PENDING` was the only status any job could ever have, so a static, non-updating display was correct for what existed. RFC 0009 has since made `IndexingJob.status` and `progressMessage` genuinely live, changing multiple times over the course of a real indexing job — but nothing on the frontend has been updated to reflect that yet. This RFC closes that specific, named gap.

### Why polling, not SSE, for this specific case

RFC 0009 itself already reasoned through this choice when the backend was built: indexing job status changes at a coarse, multi-second granularity (cloning, then parsing N files, then building the graph, then embedding), which polling handles perfectly well. RFC 0016's SSE streaming is reserved for the finer-grained, faster-changing signal of live agent tool-calling progress — a genuinely different case. This RFC simply implements, on the frontend, the polling behavior RFC 0009 already assumed would exist.

## Detailed design

### Planned polling logic

```ts
useEffect(() => {
  if (!connectedRepos.some(r => ["PENDING", "RUNNING"].includes(r.indexingJobs[0]?.status))) return;
  const interval = setInterval(async () => {
    const repos = await api.listConnectedRepos();
    setConnectedRepos(repos);
  }, 2500);
  return () => clearInterval(interval);
}, [connectedRepos]);
```

The effect re-evaluates its own stopping condition on every fetch — once no repo has a non-terminal job, the interval is cleared naturally on the next render, rather than needing a separate manual stop signal.

### Planned rendering

Each connected repo row shows both `status` (a small badge — gray for `PENDING`, blue/animated for `RUNNING`, green for `SUCCEEDED`, red for `FAILED`) and, while `RUNNING`, the live `progressMessage` text beneath it (e.g., "Parsing 342/900 files...").

## Implementation plan

1. Add the polling `useEffect` to `RepoConnector.tsx`, replacing the current one-time fetch of connected repos.
2. Add a status-badge sub-component with the four-state color mapping above.
3. Render `progressMessage` conditionally, only while `status === "RUNNING"`.
4. Manually verify: connect a real repo, watch the dashboard update through each stage without a manual page refresh, and confirm polling stops once the job reaches `SUCCEEDED`.
5. Manually verify the `FAILED` case (e.g., attempt a private repo before RFC 0021 is live, or any other known failure path) displays the `errorMessage` clearly and also stops polling.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Poll only while a non-terminal job exists** *(proposed)* | Simple; no wasted requests once indexing completes | A user with a page open exactly at the moment a job transitions might see the terminal state up to 2.5s late | **Proposed** |
| **Poll unconditionally, forever, while the dashboard is open** | Simpler effect logic (no stopping condition) | Wastes requests indefinitely for repos that finished indexing long ago | Rejected |
| **Use RFC 0016-style SSE for this too** | One less inconsistency in the codebase's data-fetching patterns | Genuinely mismatched to this signal's coarse-grained nature, as RFC 0009 already reasoned through; adds complexity with no real benefit | Rejected — consistent with RFC 0009's original reasoning |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Polling continues needlessly if the stopping-condition check has a bug | Low-medium | Low (wasted requests, not a correctness issue) | Manual verification explicitly checks polling actually stops (Implementation Plan step 4) |
| Multiple dashboard tabs open by the same user multiply request volume | Medium | Low | Not addressed in this RFC — acceptable at current scale; worth revisiting only if it becomes a measured backend load concern |

## Security considerations

No new security surface — this RFC only changes polling frequency and rendering of data already returned by an existing, already-authorized endpoint.

## Performance considerations

- 2.5s polling while a job is active is a small, bounded backend load per active user — negligible at this project's scale, consistent with RFC 0009's own performance assessment of this pattern.

## Testing strategy

- Manual verification of both the success path (stages visibly progressing, then stopping) and the failure path (RFC 0009's own error scenarios surfacing correctly) is this stage's checkpoint.

## Rollback plan

Reverting to a static, one-time fetch (RFC 0004's original behavior) is a one-line change if this polling approach causes unexpected issues.

## Migration / rollout

None — a frontend-only change against an already-stable backend contract.

## Consequences

**Positive:** the dashboard finally reflects RFC 0009's actual capability, closing a gap that's existed since that RFC shipped on the backend.

**Negative:** none of substance — this is a small, low-risk, purely additive frontend change.

## Success criteria

- A real indexing job's progress is visibly, correctly reflected on the dashboard in near-real-time, with polling stopping cleanly once the job completes.

## Open questions

None significant — this is a straightforward, well-scoped fix.

## Non-goals for this RFC

- Any change to backend behavior — this RFC is frontend-only.
- SSE-based streaming for this specific signal — deliberately not chosen, per Motivation.

## References

- RFC 0004, RFC 0009.
