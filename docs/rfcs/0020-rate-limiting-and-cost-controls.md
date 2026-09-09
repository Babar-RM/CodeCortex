# RFC 0020: Rate limiting and cost controls

- **Status:** Proposed
- **Phase:** 5 (Step 20)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** `backend/src/middleware/rateLimit.ts` (new), RFC 0009's worker, RFC 0014's tool-calling loop
- **Depends on:** RFC 0009 (indexing jobs to cap), RFC 0014 (tool-calling iterations to cap), RFC 0002 (per-user identity to key limits on)

## Summary

Explicit, enforced limits will be added at three separate points in the system — indexing job frequency per user, LLM calls per user per time window, and the tool-calling iteration cap already present in RFC 0014's design but not yet backed by any cross-request accounting — closing the gap between "the system has some informal per-request caps" and "the system cannot be driven into runaway cost by a single user, whether through malice, a bug, or simple heavy use."

## Terminology

- **Rate limit:** a cap on how many times an action can occur within a rolling or fixed time window, per some key (here, per user).
- **Cost control (in this context):** any mechanism specifically bounding real monetary/compute cost, as distinct from a rate limit that might exist purely for fairness or abuse-prevention reasons unrelated to cost.
- **Token budget:** a cap expressed in LLM token usage (input + output tokens across a session or window) rather than raw request count, which correlates more directly with actual cost than request count alone.

## Motivation

### The problem this RFC solves

Every prior RFC in Phase 2/3/4 introduced a new point where a single user action can trigger real, metered cost: RFC 0012's single LLM call, RFC 0014's multi-call tool-calling loop (bounded per-question by an iteration cap, but with no limit on how many *questions* a user can ask in a given window), RFC 0009's indexing jobs (each involving both compute and, indirectly, LLM-adjacent embedding cost). None of these RFCs, individually, was the right place to design cross-request accounting — each was scoped to getting its own specific capability working correctly first. This RFC exists to add the missing layer that treats cost as a first-class, actively-managed concern across the whole system, not just within any single request.

### Why this belongs in Phase 5, not earlier

Rate limiting and cost controls are meaningless to design against a system that doesn't yet reliably work — capping something that isn't built yet, or capping it based on assumptions about its cost profile that haven't been measured with real usage, risks either being too restrictive (blocking legitimate use) or too permissive (not actually protecting against the risk it's meant to address). This RFC is explicitly sequenced last, once Phases 2–4 have produced real, measurable data about actual LLM call volume, token usage, and indexing job cost per repository — this RFC's specific limit values are meant to be informed by that real data, not guessed at in advance.

## Background / Prior art

Per-user rate limiting and token-budget enforcement is standard practice for any product built on metered, per-call-cost external APIs (which is exactly what every LLM provider is) — without it, a single user (through a bug in their own usage, a scripted abuse attempt, or simply very heavy legitimate use) can drive unbounded real cost with no natural backpressure, a well-known failure mode for LLM-based products specifically.

## Detailed design

### Planned limit points

| Limit | Scope | Enforcement point |
|---|---|---|
| Indexing jobs per user per hour | Per-user | `POST /api/repos`, before enqueueing (RFC 0009) |
| Questions (chat messages triggering the full pipeline) per user per hour | Per-user | Chat-message route, before invoking the Planner (RFC 0012/0013) |
| Tool-calling iterations per question | Per-question | Already present in RFC 0014's design as a fixed cap (planned: 6); this RFC adds monitoring/logging of how often the cap is actually hit, informing whether it's tuned correctly |
| Critic revision rounds per question | Per-question | Already present in RFC 0015's design (planned: 3); same monitoring treatment as above |
| Token budget per user per day | Per-user | A running total tracked across all LLM calls (Planner + Specialist + Critic combined), checked before each new question is allowed to proceed |

### Planned enforcement mechanism

A lightweight Express middleware, `rateLimit(action, limit, windowSeconds)`, backed by Redis (already provisioned per RFC 0009, now given a second, distinct use beyond BullMQ) using a simple fixed-window or sliding-window counter keyed on `userId:action`. This reuses existing infrastructure rather than introducing a new datastore purely for rate-limiting — a deliberate choice given this project's general preference to avoid unnecessary new infrastructure.

### Planned user-facing behavior when a limit is hit

A limit being reached returns a clear, specific error (`429 Too Many Requests` with a message stating which limit was hit and when it resets) — never a silent failure, a generic 500, or a request that appears to hang. This mirrors this project's established pattern (RFC 0009's private-repo failure, RFC 0015's `unverifiable` verdict) of surfacing limitations explicitly rather than degrading silently.

### Why token budget, not just request-count limits

A request-count limit alone doesn't capture cost variance well — one question might trigger a single Planner call and a simple Explainer response, while another triggers multiple Bug-Tracer tool calls and several Critic revision rounds, at meaningfully different token cost. A token-budget-based limit, tracked as a running total, more directly reflects actual cost exposure than counting requests alone.

## Implementation plan

1. Add a Redis-backed `rateLimit()` middleware, applied to `POST /api/repos` (indexing) and the chat-message route (questions).
2. Instrument every LLM call (Planner, Specialist, Critic) to report its actual token usage (most provider SDKs return this in the response) to a running per-user daily total in Redis.
3. Before invoking the Planner for a new question, check the user's current token-budget total against the configured daily cap; return a clear `429` if exceeded.
4. Add logging (tying into RFC 0022) for every time an iteration cap (tool-calling or Critic revision) is actually hit, to inform whether the fixed caps chosen in RFC 0014/0015 need tuning based on real usage.
5. Manually verify: deliberately exceed each limit (repeatedly connect repos rapidly, ask many questions rapidly, or temporarily lower a limit for testing purposes) and confirm each produces the expected, clear `429` response rather than a silent failure or an unbounded continuation.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Redis-backed per-user rate limits plus a token budget** *(proposed)* | Reuses existing infrastructure; token budget reflects real cost variance better than request counts alone | Requires instrumenting every LLM call site to report usage consistently | **Proposed** |
| **Request-count limits only, no token budget** | Simpler to implement | Doesn't capture cost variance between a simple and a complex question — a user could stay under a request-count limit while still generating disproportionate token cost via repeatedly asking complex, tool-heavy questions | Rejected — token budget is a more direct proxy for the actual thing being protected against (cost) |
| **A third-party API gateway/rate-limiting service** | Offloads the implementation entirely | Adds a new external dependency and cost for a capability this project's existing Redis infrastructure can already support directly | Rejected — no justification for the added dependency given Redis is already available |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Limits are set too restrictively (based on incomplete early usage data), frustrating legitimate heavy users | Medium (an inherent risk of setting any limit before extensive real-world data exists) | Medium | Limits should be treated as tunable configuration, not hardcoded constants, and revisited once real usage patterns across Phases 2–4 are observed |
| Token-usage reporting from the LLM provider SDK is inconsistent or missing for some call types, undercounting real cost | Low-medium | Medium | Worth an explicit fallback (e.g., estimate token count from character count when the provider doesn't report it) rather than silently treating unreported usage as zero |
| A rate-limit check itself becomes a performance bottleneck if implemented inefficiently (e.g., a slow Redis round-trip on every request) | Low | Low | Redis operations for simple counters are inherently fast; this is not expected to be a real concern at this project's scale |

## Security considerations

- Rate limits are keyed on the authenticated `userId` (RFC 0002), not on IP address or any other spoofable signal — consistent with this project's existing pattern of scoping everything to the authenticated user identity.
- This RFC also serves a security purpose beyond pure cost control: it bounds the practical impact of a compromised account or a scripted abuse attempt, not just accidental heavy legitimate use.

## Performance considerations

- Each rate-limit check adds one (or a small, fixed number of) fast Redis round-trip(s) to the request path — negligible relative to the LLM call latencies already present in every request this RFC guards.

## Testing strategy

- The deliberate limit-exceeding manual verification in Implementation Plan is this stage's checkpoint.
- Once stable, automated tests can directly exercise the rate-limiting middleware in isolation (mocking the Redis counter) without needing to trigger real, costly LLM calls to test the limiting logic itself.

## Rollback plan

If a specific limit proves miscalibrated badly enough to need immediate correction, adjusting a configuration value (the limit threshold or window) requires no code deployment if these are implemented as runtime-configurable values (e.g., environment variables or a simple config table) rather than hardcoded constants — worth designing for this flexibility from the start given the inherent uncertainty in initial limit-setting.

## Migration / rollout

None required beyond the new middleware and instrumentation — no schema changes, since Redis-based counters don't require a Postgres migration.

## Consequences

**Positive:** the system gains a genuine, enforced backstop against runaway cost from any single user, closing a gap every prior RFC left open by design (each scoped to its own capability, not cross-request accounting).

**Negative:** initial limit values, set without extensive real usage data, carry real risk of being miscalibrated in either direction — this is named explicitly as an accepted, temporary cost of shipping any limit at all, to be corrected with real data rather than delayed indefinitely awaiting perfect information.

## Success criteria

- Every configured limit, when deliberately exceeded during testing, produces a clear `429` response with an informative message — not a silent failure, hang, or unbounded continuation.
- Token usage is measurably tracked and enforced against a real per-user daily budget.

## Open questions

- Should limits differ by some notion of user tier (if this product ever introduces paid tiers) rather than one uniform limit for everyone? Not designed here — this RFC assumes a single-tier system, consistent with everything built so far.
- Exact initial limit values — deliberately left to be set based on real observed usage data from Phases 2–4, not fixed speculatively in this RFC.

## Non-goals for this RFC

- Billing or payment integration — entirely out of scope; this RFC only enforces limits, it does not introduce any monetization mechanism.
- Per-repository (as opposed to per-user) limits — not designed here, though a natural future extension if repository size/complexity turns out to correlate strongly with cost independent of user behavior.

## References

- Report: "Step 20 — Rate limiting," CodeCortex-Complete-Report.md.
- RFC 0009, RFC 0014, RFC 0015.
