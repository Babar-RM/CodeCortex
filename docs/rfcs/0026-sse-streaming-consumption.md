# RFC 0026: SSE streaming consumption

- **Status:** Proposed
- **Phase:** Frontend (Phase 3 UI)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** `frontend/components/ChatThread.tsx` (extends RFC 0025), new `frontend/lib/useAgentStream.ts`
- **Depends on:** RFC 0016 (the SSE contract this consumes), RFC 0025 (the chat UI this upgrades)

## Summary

RFC 0025's basic send-and-wait chat flow will be upgraded to consume RFC 0016's SSE event stream, rendering live intermediate progress ("classifying your question...", "investigating callers of formatDate...", "verifying claims...") as it happens, resolving into the final answer once the stream's `"answer"` event arrives — replacing the plain loading spinner RFC 0025 would otherwise show for the entire, potentially many-seconds-long pipeline duration.

## Terminology

- **Progress indicator:** a live-updating UI element reflecting the current backend processing stage, as opposed to a generic, uninformative loading spinner.

## Motivation

### The problem this RFC solves

By the time RFC 0025's basic chat UI is built, sending a question that routes through RFC 0013–0015's full pipeline can genuinely take many seconds. RFC 0025's simple "await the response" flow would leave the user staring at a spinner that entire time with zero indication of what's happening — exactly the poor experience RFC 0016 was designed on the backend to prevent, but which does nothing for the user until the frontend actually consumes that stream. This RFC is that consumption.

## Detailed design

### Planned `useAgentStream` hook

```ts
function useAgentStream(chatSessionId: string) {
  const [events, setEvents] = useState<AgentStreamEvent[]>([]);
  const [finalAnswer, setFinalAnswer] = useState<AnswerWithEvidence | null>(null);

  async function sendMessage(content: string) {
    setEvents([]);
    setFinalAnswer(null);
    const response = await fetch(`${BACKEND_URL}/api/chat/messages`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatSessionId, role: "user", content }),
    });
    const reader = response.body.getReader();
    // parse SSE frames, dispatch each AgentStreamEvent to setEvents,
    // and on the "answer" event, set finalAnswer and stop.
  }

  return { events, finalAnswer, sendMessage };
}
```

Given RFC 0001's cross-origin, credentialed-request pattern, the native `EventSource` API's lack of custom-header/credentialed-POST support means a `fetch`-based streaming reader (as sketched above) is used instead of `EventSource` directly — consistent with the option RFC 0016 itself flagged as the likely necessary choice given this project's architecture.

### Planned progress rendering

Each `AgentStreamEvent` maps to a short, human-readable line appended to a "thinking" panel above the eventual answer:

| Event type | Displayed as |
|---|---|
| `planning` | "Understanding your question..." |
| `planned` | "Question type: {questionType}" |
| `investigating` | "Looking at {toolCall}..." |
| `drafting` | "Drafting an answer..." |
| `verifying` | "Verifying against the codebase..." |
| `revising` | "Double-checking a detail..." |

Once the `"answer"` event arrives, the thinking panel collapses (or remains visible as a collapsed "show reasoning" toggle) and the final answer renders in the thread, exactly where RFC 0025's optimistic-update flow expects it.

## Implementation plan

1. Implement `useAgentStream()`, handling SSE frame parsing over a `fetch` response body reader.
2. Replace RFC 0025's simple `sendChatMessage()` call with this hook in `ChatThread.tsx`.
3. Build the live progress-panel UI.
4. Manually verify: ask a question requiring multiple tool calls and at least one Critic revision round, confirm the displayed progress genuinely, correctly reflects backend activity in order, and confirm the final answer matches what a non-streamed call would have produced.
5. Manually verify graceful handling of a dropped connection mid-stream (per RFC 0016's own named risk) — confirm the frontend can recover by re-fetching message history rather than getting stuck in a broken state.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **`fetch`-based SSE reader** *(proposed)* | Supports credentialed POST requests, matching this project's cross-origin cookie pattern | More manual frame-parsing code than the native `EventSource` API provides | **Proposed** |
| **Native `EventSource`** | Simpler built-in API | Doesn't support custom headers or POST bodies well, incompatible with sending the question content as part of establishing the stream | Rejected |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A dropped connection leaves the UI in an inconsistent state | Medium | Medium | Explicit recovery path (re-fetch message history) tested in Implementation Plan step 5, per RFC 0016's own named risk |
| Manual SSE frame parsing has a bug mis-splitting events | Medium | Medium | Manual verification specifically checks event ordering and completeness, not just that "something" renders |

## Security considerations

No new security surface beyond RFC 0025's existing credentialed-request pattern.

## Performance considerations

Streaming doesn't reduce total completion time — only improves perceived experience, exactly as RFC 0016 itself noted.

## Testing strategy

Manual, ordered-event verification per Implementation Plan is this stage's checkpoint.

## Rollback plan

Reverting to RFC 0025's simple await-based flow is straightforward if streaming proves unreliable — the backend supports both patterns' underlying data either way.

## Migration / rollout

Replaces RFC 0025's `sendChatMessage` call path — a frontend-only change against an already-existing backend contract.

## Consequences

**Positive:** the user finally sees genuine evidence of progress during CodeCortex's most powerful but slowest feature (multi-step, verified agent answers).

**Negative:** meaningfully more complex client-side code than a simple request/response.

## Success criteria

A real multi-step question shows correctly-ordered, accurate live progress and resolves to the correct final answer.

## Open questions

None beyond what RFC 0016 already flagged on the backend side.

## Non-goals for this RFC

Evidence rendering — RFC 0027.

## References

RFC 0016, RFC 0025.
