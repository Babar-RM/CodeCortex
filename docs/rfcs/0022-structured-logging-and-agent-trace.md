# RFC 0022: Structured logging and agent trace

- **Status:** Proposed
- **Phase:** 5 (Step 22)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** `backend/src/lib/logging.ts` (extends the existing `pino`/`pino-http` setup from RFC 0001), a new `AgentTrace` model or log sink
- **Depends on:** RFC 0013–0016 (the agent steps this RFC records), RFC 0020 (the cap-hit monitoring this RFC formalizes)

## Summary

Every agent-pipeline step (Planner classification, each specialist tool call, each Critic verification round) will be logged with a consistent, structured schema and a shared correlation ID per question, tying every log line for a single question together — both for operational debugging and, optionally, as the backing data for an in-app debug/trace view showing exactly what the system did to arrive at a given answer.

## Terminology

- **Structured logging:** log entries emitted as machine-parseable structured data (JSON, in this case, via the already-established `pino` logger) rather than unstructured free-text strings, enabling querying and aggregation.
- **Correlation ID:** a single identifier attached to every log line produced while processing one specific question, allowing all of that question's scattered log entries (across Planner, Specialist, Critic) to be reassembled into one coherent trace.
- **Agent trace:** the full, ordered sequence of steps (classification, tool calls, verification rounds) that produced a specific answer — the structured record this RFC's logging design makes reconstructable.

## Motivation

### The problem this RFC solves

By the time RFC 0013–0016 are all built, a single question's processing involves a genuinely complex sequence of steps across multiple agent calls, potentially multiple tool-calling iterations, and potentially multiple Critic revision rounds. Without structured, correlated logging, debugging why a specific answer was wrong, why a specific question took unusually long, or how often iteration caps (RFC 0014/0015/0020) are actually being hit in practice is entirely dependent on unstructured console output scattered across whichever code path happened to log something — genuinely difficult to reconstruct after the fact. This RFC exists to make the system's actual behavior legible after the fact, not just observable in the moment it's streamed to a user (RFC 0016).

### Why this is sequenced in Phase 5, specifically after RFC 0020

RFC 0020 already introduced the need to monitor how often iteration caps are hit, to inform whether they're tuned correctly — but didn't itself specify a general logging design, focusing narrowly on the rate-limiting mechanism itself. This RFC generalizes that specific need into the broader, systematic logging infrastructure the whole agent pipeline should have had a plan for since Phase 3, but which — consistent with this project's general practice of building the working capability first and its operational tooling once real behavior exists to observe — was deliberately deferred to this hardening phase.

## Background / Prior art

Correlated, structured tracing across a multi-step, multi-service pipeline is standard observability practice for any sufficiently complex distributed or multi-stage system — the specific pattern here (a correlation ID threaded through every log line for one logical unit of work) is a lightweight, self-hosted version of the same principle behind dedicated distributed-tracing tools, scaled appropriately to this project's current size rather than adopting a heavier dedicated tracing platform prematurely.

## Detailed design

### Planned log schema

```ts
type AgentTraceLog = {
  correlationId: string;      // one per question, generated at chat-message route entry
  connectedRepoId: string;
  userId: string;
  step: "planned" | "tool_call" | "tool_result" | "draft" | "critic_check" | "revise" | "approved" | "unverifiable";
  timestamp: string;
  durationMs?: number;
  detail: Record<string, unknown>;  // step-specific payload, e.g. { questionType } for "planned", { tool, args } for "tool_call"
};
```

### Planned correlation ID propagation

A `correlationId` (a simple UUID) is generated once, at the moment a chat-message request enters the system, and threaded through every function call in the Planner → Specialist → Critic chain — reusing the same event-emitter parameter RFC 0016 already introduced for SSE streaming, since both concerns (streaming live progress to the user, and logging that same progress for later reconstruction) touch the exact same set of call sites and naturally share this propagation mechanism rather than requiring two separate instrumentation passes.

### Planned storage / sink

Initially, structured JSON log lines via the already-established `pino` logger (RFC 0001), queryable via whatever log-aggregation tooling the eventual deploy environment provides (a log search interface, or simple `grep`/`jq` against log files in simpler deployments). A dedicated `AgentTrace` Postgres table is named as an option, not a requirement — RFC 0016's Open Question already flagged this same "should progress events also be persisted" question, and this RFC resolves it in favor of at least structured *logging*, leaving a full dedicated table as an optional enhancement if an in-app trace-viewing UI is ever built (see Open Questions).

### Planned iteration-cap-hit monitoring

Every time RFC 0014's tool-calling iteration cap or RFC 0015's Critic revision cap is actually reached (not merely available, but hit), a specific, easily-searchable log entry (`step: "cap_hit"`, with which cap and the question's correlation ID) is emitted — directly fulfilling RFC 0020's own flagged need to monitor whether these fixed caps are well-tuned, formalized here as part of this RFC's general logging design rather than as a one-off addition.

## Implementation plan

1. Generate a `correlationId` at the start of the chat-message route handler.
2. Thread it as part of the same event-emitter object RFC 0016 already introduced through `planQuestion()`, `runToolCallingAgent()`, and `critiqueDraft()`.
3. At each existing emission point (the same points RFC 0016 already emits SSE events from), additionally emit a structured `pino` log line per the schema above — reusing the call sites, not duplicating the instrumentation logic.
4. Add explicit `cap_hit` log emission at RFC 0014's iteration-cap and RFC 0015's revision-cap boundaries.
5. Manually verify: ask a real question, and confirm the resulting log output, filtered by that question's `correlationId`, reconstructs a complete, sensible, chronologically-ordered trace of exactly what happened — Planner classification, each tool call and result, the draft, the Critic's check, and the final verdict.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Structured `pino` logs with a shared correlation ID** *(proposed)* | Reuses existing logging infrastructure (RFC 0001) and the existing event-emitter propagation (RFC 0016); no new datastore required for the baseline capability | Querying/aggregating logs is only as good as whatever log tooling the deploy environment provides — no built-in UI without additional work | **Proposed** |
| **A dedicated distributed-tracing platform (e.g., an OpenTelemetry-based setup)** | Purpose-built for exactly this kind of multi-step trace reconstruction, with mature tooling | Meaningfully more operational overhead and a new category of infrastructure for a project at this stage's actual scale — premature relative to real observability needs so far | Rejected for now — worth reconsidering if this project's operational complexity grows substantially beyond its current scope |
| **A dedicated `AgentTrace` Postgres table from the start, not just logs** | Enables a proper in-app trace-viewing UI without depending on external log tooling | Additional schema and write-path complexity for a capability (an in-app trace viewer) not yet requested or designed | Deferred, not rejected — named explicitly as an option once/if that UI is actually wanted, not built speculatively now |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Log volume grows significant relative to whatever log-storage/retention the deploy environment provides, given every tool call and revision round now emits a structured entry | Medium, rising with usage | Low-medium (cost/storage, not correctness) | Worth setting a reasonable retention policy at the deploy-tooling level; not a design concern for this RFC's own logging logic itself |
| Sensitive data (e.g., actual code snippets passed as tool call arguments) ends up in logs, which typically have weaker access controls than the primary application database | Medium (a genuine, easy-to-overlook risk when logging "everything" for debuggability) | Medium-high (a private-repo content leak into a less-protected system) | The `detail` field's contents should be reviewed carefully at each emission point — log metadata about a tool call (which tool, which function name) rather than the full content it returned, wherever the metadata alone is sufficient for debugging purposes |

## Security considerations

- The risk named directly above (sensitive code content leaking into logs) is this RFC's most important consideration — logs should favor metadata over full content wherever the metadata is sufficient for the debugging/monitoring purpose this RFC exists to serve, consistent with this project's general "never let debug/observability tooling become a security bypass" principle (a variant of the same reasoning behind RFC 0022's own careful scoping — this document should not become the thing that leaks what RFC 0002/0006/0007 worked hard to protect).
- `correlationId`s and `userId`s in logs are not themselves secrets, but logs containing them should still be access-controlled at least as tightly as the application's own admin-level access, since correlating a user's identity with detailed behavioral logs is itself a privacy-relevant capability.

## Performance considerations

- Structured logging at each already-existing emission point adds negligible overhead relative to the LLM calls and database queries already happening at those same points — this RFC does not introduce a meaningful new performance cost.

## Testing strategy

- The manual trace-reconstruction verification in Implementation Plan is this stage's checkpoint — confirming a real question's full log trail, filtered by `correlationId`, tells a coherent, complete, and correctly-ordered story.
- `cap_hit` logging should be specifically tested by deliberately triggering a cap (e.g., temporarily lowering RFC 0014's iteration cap for a test) and confirming the expected log entry appears.

## Rollback plan

If this RFC's additional logging proves too costly (volume/storage) or risky (the sensitive-data-in-logs concern above proves harder to fully avoid than anticipated), individual log emission points can be selectively disabled or have their `detail` payloads trimmed without affecting the underlying agent logic at all — logging is a pure addition alongside existing call sites, not something the agent pipeline's correctness depends on.

## Migration / rollout

None required beyond the new logging code itself — no schema changes unless the optional `AgentTrace` table (see Alternatives) is separately pursued.

## Consequences

**Positive:** the agent pipeline's actual behavior becomes reconstructable and debuggable after the fact, closing a real operational gap that's existed silently since Phase 3's agents were first built without this instrumentation.

**Negative:** introduces a new, easy-to-overlook category of security risk (sensitive content leaking into logs) that requires ongoing care at every future emission point, not just the ones this RFC's initial implementation covers.

## Success criteria

- A real question's complete processing trace can be reconstructed, in correct chronological order, purely from structured logs filtered by its `correlationId`.
- `cap_hit` events are reliably logged whenever an iteration or revision cap is actually reached.

## Open questions

- Should a dedicated `AgentTrace` table and an in-app trace-viewing UI be built as a follow-up, once there's a concrete user (a developer debugging their own team's usage, for instance) who'd benefit from seeing this without needing raw log access? Named as an option, not decided here.

## Non-goals for this RFC

- A dedicated distributed-tracing platform — explicitly rejected as premature, per Alternatives.
- An in-app trace-viewing UI — named as a possible future enhancement, not built as part of this RFC.

## References

- Report: "Step 22 — Logging," CodeCortex-Complete-Report.md.
- RFC 0001 (existing `pino`/`pino-http` setup), RFC 0016 (the event-emitter propagation this RFC reuses), RFC 0020.
