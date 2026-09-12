# RFC 0025: Chat interface architecture

- **Status:** Proposed
- **Phase:** Frontend (Phase 2 UI)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** new `frontend/app/chat/page.tsx`, `frontend/components/ChatThread.tsx`, `frontend/components/ChatSessionList.tsx`, `frontend/lib/api.ts`
- **Depends on:** RFC 0012 (the chat persistence contract this consumes)

## Summary

A new `/chat` route will provide the first user-facing interface for CodeCortex's actual core feature — asking questions about a connected repository. This RFC covers the basic architecture: a session list (past conversations, scoped per connected repo), a message thread (the conversation itself), and an input box — built first against RFC 0012's simple synchronous-feeling contract, with RFC 0026 upgrading it to real-time streaming afterward.

## Terminology

- **Chat session:** one persistent conversation thread about one connected repository, per RFC 0003's `ChatSession` model.
- **Optimistic update:** rendering the user's own message immediately in the UI upon send, before the backend confirms it was saved, for responsiveness.

## Motivation

### The problem this RFC solves

Every backend capability built since Phase 2 — retrieval, the agent pipeline, the Critic, caching, evidence — has had zero user-facing surface until now. This RFC is the first point where a real person can actually interact with any of it. Getting this basic architecture right (how sessions, messages, and repos relate on screen) matters because RFC 0026 and RFC 0027 both build additively on top of whatever structure this RFC establishes, rather than restructuring it.

### Why basic architecture first, streaming second

Building against RFC 0012's simpler contract first, before layering in RFC 0016's SSE streaming, follows the same incremental-verification discipline used throughout the backend: get the basic request/response flow (send a message, see an answer appear) working and visually correct before adding the complexity of live intermediate progress on top of it. A bug in the basic message-rendering logic is easier to isolate before streaming is also in the mix.

## Detailed design

### Planned page structure

`/chat` — redirects to `/chat/[most recent session]` or shows an empty state
`/chat/[sessionId]` — the actual chat UI: session list (sidebar) + thread (main panel) + input

### Planned component breakdown

- **`ChatSessionList`** — lists the current `connectedRepoId`'s past sessions (`GET /api/chat/sessions`), each showing a short preview and timestamp, clicking navigates to that session.
- **`ChatThread`** — renders the ordered message history (`GET /api/chat/sessions/:id/messages`) as alternating user/assistant bubbles.
- **Input box** — a simple textarea + send button, calling `POST /api/chat/messages`, disabled while a request is in flight.

### Planned optimistic update behavior

On send, the user's own message is appended to the thread immediately (before the backend responds), with a pending/sending visual state, then replaced with the confirmed version once the backend's response arrives (or reverted with an error state if the request fails) — standard practice for a responsive chat UI, and a pattern RFC 0016 will extend rather than replace once streaming exists.

## Implementation plan

1. Add `listChatSessions()`, `createChatSession()`, `getChatMessages()`, `sendChatMessage()` to `frontend/lib/api.ts`, matching RFC 0012's actual verified backend contract exactly (not a guessed shape).
2. Build `ChatSessionList` and `ChatThread` as separate, focused components.
3. Build the `/chat/[sessionId]` page composing both, plus the input box.
4. Implement the optimistic-update send flow described above.
5. Manually verify: create a new session, ask a real question against a real indexed repo, confirm the answer renders correctly, navigate away and back, confirm history persists correctly via `GET`.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Session list + thread + input, built against RFC 0012's simple contract first** *(proposed)* | Isolates basic-flow bugs from streaming-specific bugs, consistent with this project's incremental verification discipline | Requires a follow-up RFC (0026) to add streaming, rather than building the final version in one pass | **Proposed** |
| **Build directly against RFC 0016's SSE contract from the start, skip the intermediate step** | One less migration/refactor step later | Conflates basic UI correctness with streaming-specific complexity, harder to debug either in isolation | Rejected — matches the same reasoning RFC 0012 itself used to justify existing before RFC 0013-0016 |
| **A single global chat UI not scoped per repo** | Simpler navigation model | Doesn't match the actual data model (RFC 0003's `ChatSession` is explicitly scoped to one `connectedRepoId`) or the product's actual usage pattern (asking questions about one specific repo at a time) | Rejected |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Optimistic updates get out of sync with actual backend state if a request fails silently | Medium | Medium (confusing UI state) | Explicit error-state handling required in the send flow — a failed request must visibly revert or mark the optimistic message as failed, never leave it in a permanent "sending" limbo |
| Building this before RFC 0026 means a near-term rebuild of the send/receive flow | High (an accepted, deliberate cost of the phased approach) | Low (the cost is known and small — swapping fetch for EventSource, not a UI redesign) | Accepted per Motivation's reasoning |

## Security considerations

- Every chat API call must include credentials (`credentials: "include"`, per RFC 0001's established pattern) so RFC 0012's backend-side ownership checks actually receive the session cookie needed to enforce them.

## Performance considerations

- No new performance concerns beyond what RFC 0012's backend already accounts for — this RFC is a straightforward rendering layer over an already-designed contract.

## Testing strategy

- The manual send/receive/persist verification in Implementation Plan is this stage's checkpoint.

## Rollback plan

Straightforward — this is new, additive frontend surface with no dependency from any other part of the app.

## Migration / rollout

None — new route and components.

## Consequences

**Positive:** the first user-facing surface for CodeCortex's actual core value proposition.

**Negative:** a near-term follow-up refactor (RFC 0026) is already known to be needed — an accepted, deliberate cost.

## Success criteria

- A real question, asked through this UI against a real indexed repo, produces a correctly-rendered answer, with session history correctly persisting and reloading.

## Open questions

None significant at this architectural level — specifics are left to RFC 0026/0027's additions.

## Non-goals for this RFC

- Streaming — RFC 0026.
- Evidence rendering — RFC 0027.

## References

- RFC 0012, RFC 0003.
