# RFC 0016: Agent step streaming (SSE)

- **Status:** Proposed
- **Phase:** 3 (Step 16)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** the chat-message route (extending RFC 0012's endpoint), new frontend consumption logic
- **Depends on:** RFC 0013, RFC 0014, RFC 0015 (streams all three's intermediate progress)

## Summary

The chat-message endpoint will be changed from a single synchronous request/response (as built in RFC 0012) to a Server-Sent Events (SSE) stream, emitting intermediate progress events as the Planner classifies the question, the routed specialist calls tools, and the Critic verifies the draft — rather than the client receiving nothing until the entire, potentially many-seconds-long pipeline completes.

## Terminology

- **Server-Sent Events (SSE):** a standard, one-directional HTTP streaming mechanism allowing a server to push a sequence of discrete events to a client over a single, long-lived HTTP connection, simpler than WebSockets for cases (like this one) that don't need bidirectional communication.
- **Progress event:** a discrete, structured message emitted mid-pipeline describing what stage of processing is currently happening (e.g., "Planner: classifying question," "Explainer: retrieving callers of X," "Critic: verifying claims") — distinct from the final answer itself.

## Motivation

### The problem this RFC solves

By the point RFC 0013–0015 are all implemented, a single question can involve a Planner call, several specialist tool-calling round-trips, and up to multiple Critic revision rounds — a pipeline that can reasonably take many seconds, occasionally longer. RFC 0012's original synchronous request/response design (justified at the time, for a single simple LLM call) becomes a genuinely poor user experience at this accumulated latency: a user staring at a blank loading indicator for potentially 10-plus seconds with zero indication of what's happening or whether the system is working correctly versus stuck. This RFC exists to fix that specific experience once the pipeline has grown complex enough to need it — not before, which is why RFC 0009 explicitly deferred this exact capability rather than building it prematurely during Phase 1's simpler polling-based job-status updates.

### Why this wasn't built earlier

RFC 0009's dashboard polling (checking job status every 2–3 seconds) was explicitly judged adequate for indexing-job progress, which changes at a coarse, multi-second granularity. Per-agent-step progress is a genuinely finer-grained, faster-changing signal (a specialist might complete several tool calls within a couple of seconds), for which polling would either feel laggy (a long poll interval) or wasteful (a very short one). This is precisely the distinction RFC 0009 named explicitly when it deferred this capability to this RFC.

## Background / Prior art

Streaming intermediate "thinking" or tool-use progress, rather than only a final answer, is now a common UX pattern across LLM-based products with any multi-step or tool-calling behavior — giving the user visible evidence that a slower response is actively progressing, not stuck, meaningfully improves perceived responsiveness even when total completion time is unchanged.

## Detailed design

### Planned event shape

```ts
type AgentStreamEvent =
  | { type: "planning" }
  | { type: "planned"; questionType: QuestionType }
  | { type: "investigating"; specialist: string; toolCall: string }
  | { type: "tool_result"; toolCall: string; summary: string }
  | { type: "drafting" }
  | { type: "verifying" }
  | { type: "revising"; feedback: string }
  | { type: "answer"; content: string }
  | { type: "error"; message: string };
```

Each event is emitted as a standard SSE `data:` line (JSON-encoded) as the pipeline reaches that stage. The final `"answer"` event carries the same content RFC 0012's original synchronous response would have returned — this RFC changes *how* the answer and its surrounding progress are delivered, not what the final answer itself contains.

### Planned backend implementation approach

The chat-message route will set `Content-Type: text/event-stream` and keep the HTTP response open, writing each `AgentStreamEvent` as it occurs throughout the Planner → Specialist (with its tool-calling loop) → Critic (with its revision loop) sequence, rather than buffering everything and returning one JSON response at the end. The underlying agent logic (RFC 0013–0015) requires only a lightweight callback/emitter parameter threaded through each stage — the agents' actual reasoning logic does not need to change, only how their intermediate steps are surfaced outward.

### Planned frontend consumption

The frontend will use the standard `EventSource` API (or an equivalent `fetch`-based SSE reader if `EventSource`'s lack of custom-header support proves incompatible with the credentialed-request pattern established in RFC 0001) to consume this stream, rendering a live-updating "thinking" indicator (e.g., "Investigating callers of `formatDate`...") that resolves into the final answer once the `"answer"` event arrives.

## Implementation plan

1. Add an event-emitter parameter threaded through `planQuestion()` (RFC 0013), `runToolCallingAgent()` (RFC 0014), and `critiqueDraft()` (RFC 0015), each calling it at the appropriate points described in the planned event shape above.
2. Change the chat-message route to set SSE headers and write events as they're emitted, rather than awaiting a final result and returning one JSON body.
3. Persist the final answer to `ChatMessage` (RFC 0012's existing persistence contract) exactly as before — this RFC changes only the response *delivery* mechanism, not what gets stored.
4. Build frontend SSE consumption and a live progress-indicator UI component.
5. Manually verify: ask a real question requiring several tool calls and at least one Critic revision round, and confirm the visible progress events genuinely correspond to what's actually happening on the backend, in the correct order, with the final answer matching what a non-streamed call would have produced.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Server-Sent Events** *(proposed)* | Simple, standard, one-directional (matches this use case exactly — the client never needs to send anything mid-stream), lower implementation overhead than WebSockets | Slightly less broadly supported in some older client environments than plain HTTP (a non-issue for a modern browser-based frontend) | **Proposed** |
| **WebSockets** | Bidirectional, could support future features requiring client-to-server messages mid-stream | Meaningfully more implementation complexity (connection lifecycle management, reconnection logic) for a capability (bidirectional communication) this specific use case does not need | Rejected — SSE's simplicity is a better match for a one-directional progress-streaming need |
| **Keep polling, just poll more frequently for chat messages specifically** | Reuses RFC 0009's already-established pattern, no new streaming infrastructure | Either laggy (a longer interval) or wasteful (a very short one) for the genuinely finer-grained, faster-changing progress signal this stage produces — exactly the distinction RFC 0009 itself named when deferring this capability | Rejected |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A long-lived SSE connection is dropped mid-stream (network interruption, proxy timeout) before the final answer arrives | Medium | Medium (user sees an incomplete stream) | The final answer is still persisted to `ChatMessage` regardless of stream delivery success — a dropped connection can be recovered by the frontend re-fetching the message history (RFC 0012's existing `GET` endpoint) even if the live stream itself was lost |
| Threading an event emitter through three separate agent modules (RFC 0013–0015) introduces coupling that makes each harder to reason about or test in isolation | Low-medium | Low | The emitter parameter is designed as optional/no-op by default, so each agent module's core logic remains independently testable exactly as before, with streaming as a pure addition, not a required dependency for using the underlying functions |

## Security considerations

- No new security surface beyond what RFC 0012 already established — the same `requireAuth`/ownership-scoping requirements apply identically to this streamed endpoint as to the original synchronous one.

## Performance considerations

- Streaming does not reduce total pipeline completion time — it changes only the perceived experience of waiting for it, by surfacing genuine intermediate progress rather than silence. This distinction is worth stating explicitly so this RFC isn't mistaken for a performance optimization; it's a UX one.

## Testing strategy

- The manual, ordered-event-sequence verification described in Implementation Plan is this stage's checkpoint — confirming events arrive in the correct order and genuinely correspond to real backend activity, not merely that *some* events arrive.
- Automated testing of SSE streams is more involved than a simple request/response assertion; RFC 0023 should address a testing approach for this specifically (e.g., asserting on the full sequence of event types received for a scripted, mocked agent run) rather than leaving it untested indefinitely.

## Rollback plan

If SSE streaming introduces more operational complexity (proxy/load-balancer compatibility issues, for instance) than its UX benefit justifies, reverting to RFC 0012's original synchronous response is straightforward — the underlying agent logic's optional event-emitter parameter can simply go unused, with the route returning one final JSON response exactly as before.

## Migration / rollout

The chat-message endpoint's response format changes from JSON to an SSE stream — any existing frontend code built against RFC 0012's original contract must be updated in the same change that ships this RFC's backend work, per this project's cross-service-contract change-management rule.

## Consequences

**Positive:** the user experience for genuinely multi-step, multi-second questions is meaningfully improved, with visible evidence of real progress rather than an opaque wait.

**Negative:** adds streaming-specific complexity (connection lifecycle, partial-failure handling) that a simple request/response design does not have to contend with.

## Success criteria

- A real question requiring multiple tool calls and at least one Critic revision produces a visible, correctly-ordered stream of progress events that genuinely reflects the backend's actual processing, ending in the correct final answer.

## Open questions

- Should progress events be persisted anywhere (e.g., for RFC 0022's future agent-trace logging), or are they purely ephemeral, live-only signals with no lasting record? Leaning toward also logging them for RFC 0022's benefit, but not decided or designed here.

## Non-goals for this RFC

- Any change to the underlying agent reasoning logic itself — this RFC only changes how already-existing intermediate steps are surfaced, not what those steps do.
- Persistent agent-trace logging — RFC 0022 (Phase 5).

## References

- Report: "Step 16 — SSE streaming," CodeCortex-Complete-Report.md.
- MDN: Server-Sent Events / `EventSource`.
- RFC 0009 (where this capability was originally, explicitly deferred).
