# RFC 0012: Single-agent LLM integration + chat persistence

- **Status:** Proposed
- **Phase:** 2 (Step 11, and the backend half of Step 12)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** new `backend/src/lib/agent.ts`, new routes for chat sessions/messages
- **Depends on:** RFC 0011 (context bundle), RFC 0003 (`ChatSession`/`ChatMessage` tables, built in Phase 0 for exactly this moment)

## Summary

The first LLM call in the entire project: a single, non-specialized agent that takes a user's question, calls RFC 0011's `hybridRetrieve()` to get a context bundle, makes one LLM API call combining the question and that context, and returns an answer. No tools, no multi-step loop, no Planner, no Critic — deliberately the simplest possible version of "question in, grounded answer out," to prove that loop works before Phase 3 multiplies it into six agents. Alongside this, the backend endpoints for persisting chat sessions and messages (writing to tables that have existed, unused, since Phase 0) will be built.

## Terminology

- **Grounded answer:** an LLM response constructed using retrieved context specific to the actual codebase, rather than the model's own general training knowledge about "how codebases like this typically work" — the property this RFC's design exists to establish and later verify.
- **System prompt:** the fixed instructions given to the LLM alongside the user's question and retrieved context, framing how it should use that context and what kind of answer to produce.
- **Single-agent (in this context):** exactly one LLM call per question, with no branching, no tool-calling, and no verification step — the deliberately minimal baseline this RFC establishes before Phase 3 adds all of those.

## Motivation

### The problem this RFC solves

Phase 3's eventual six-agent system (Planner, four Specialists, Critic) is a lot of moving, interacting complexity. If it's built directly, without first proving the far simpler "one retrieval call, one LLM call, one answer" loop actually works end-to-end, any bug encountered while building the six-agent system could originate from the retrieval layer, the prompt design, the LLM integration itself, or the multi-agent orchestration logic — with no way to isolate which. This RFC exists specifically to prove the simplest possible version of the loop first, so that when Phase 3 introduces real complexity on top of it, any new bug can be attributed to *that* complexity, not to a foundational issue that should have been caught here.

### Why chat persistence is bundled into this same RFC

RFC 0003 built `ChatSession` and `ChatMessage` tables in Phase 0, specifically and explicitly to avoid a schema migration against an already-populated `ConnectedRepo` table later. This RFC is that "later" — the first point where anything actually writes to those tables. Bundling the persistence contract with the first real agent call, rather than treating them as separate RFCs, reflects that they're genuinely one feature from a user's perspective (asking a question and having the conversation remembered are the same interaction, not two).

## Background / Prior art

"Retrieve context, then make one LLM call with that context" is the textbook baseline RAG pattern, deliberately kept as simple as possible here — this RFC is not attempting anything novel at the LLM-integration layer; the novelty in this project is specifically reserved for Phase 3's Critic-verification step, which is why this RFC's own design is intentionally unambitious.

## Detailed design

### Planned agent function

```ts
async function askSingleAgent(params: {
  connectedRepoId: string;
  question: string;
  chatHistory?: { role: "user" | "assistant"; content: string }[];
}): Promise<{ answer: string }>
```

1. Call `hybridRetrieve({ connectedRepoId, question })` (RFC 0011).
2. Construct a prompt: a system message instructing the model to answer using only the provided context and to say plainly when the context doesn't contain enough information to answer confidently (an explicit instruction against confidently fabricating an answer — the closest this simple version gets to Phase 3's Critic, without actually verifying anything against the graph).
3. Make one LLM API call (provider/model to be finalized at implementation time — this RFC does not lock in a specific vendor, since that's a cost/quality tradeoff better evaluated with real usage than decided speculatively here) with the system prompt, retrieved context, chat history (if any), and the question.
4. Return the raw answer text.

### Planned persistence contract

```text
POST /api/chat/sessions { connectedRepoId } → { id, ... }
GET /api/chat/sessions → [ ...user's sessions, scoped to connectedRepoId if provided ]
POST /api/chat/messages { chatSessionId, role: "user", content } → saves, then
triggers askSingleAgent(), saves the assistant's reply too,
returns both messages
GET /api/chat/sessions/:id/messages → full message history for one session
```

All routes protected by `requireAuth` (RFC 0002), and every query scoped to the authenticated user's own `ChatSession`s — a user must never be able to read or post into another user's chat session, enforced the same way `ConnectedRepo` ownership is already enforced elsewhere in this project.

### Why the agent call happens inside the message-creation endpoint, not a separate step

Keeping "save the user's message" and "get and save the agent's reply" as one request (rather than requiring the frontend to poll or separately trigger the agent) keeps Phase 2's contract simple, at the cost of this endpoint's response time now including however long the LLM call takes. This is judged acceptable for Phase 2's single, simple call; Phase 3's Planner→Specialist→Critic chain, which will take meaningfully longer, is precisely why RFC 0016 plans to move to a streamed response instead — this RFC's synchronous design is deliberately not meant to be the final answer for that later, heavier case.

## Implementation plan

1. Choose and integrate an LLM provider SDK (deferred specifics — this RFC establishes the pattern, not the vendor).
2. Write `askSingleAgent()` in `backend/src/lib/agent.ts`, implementing the four steps above.
3. Implement the four chat routes described above, each validated with Zod and scoped to `req.user`.
4. Manually verify: create a session against a real, previously-indexed fixture repository, ask a real question whose answer is actually knowable from that repository's content, and judge by hand whether the returned answer is both accurate and genuinely grounded in the retrieved context (not just plausible-sounding).
5. Manually verify a deliberately out-of-scope question (something the repository's content genuinely cannot answer) and confirm the agent says so plainly rather than fabricating a confident-sounding but ungrounded answer.
6. Only after steps 4 and 5 both pass, this RFC's scope is complete — Phase 3's work (RFC 0013 onward) builds on top of this, not before it.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Single, non-specialized agent** *(proposed)* | Simplest possible version of the full loop; isolates bugs before Phase 3's real complexity is introduced | Deliberately limited — no tool-calling, no verification, noticeably weaker than the eventual Phase 3 system | **Proposed** — intentionally, as a stepping stone, not a final design |
| **Build the full Planner/Specialist/Critic system directly, skipping this intermediate step** | Arrives at the "real" product faster in calendar time | Confounds multiple new, interacting sources of complexity (retrieval, prompting, orchestration, verification) with no way to isolate which one is responsible for any given bug | Rejected — directly against this project's own stated Phase 2/3 gating rationale |
| **Save the user message and trigger the agent as two separate requests** | Frontend could show the user's message immediately, before the agent's reply arrives, without waiting on the full round-trip | More moving parts (a second request, likely a loading state) for a Phase 2 need that doesn't yet require it | Deferred — worth reconsidering once streaming (RFC 0016) exists anyway, at which point this becomes a more natural two-step flow |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The single agent produces plausible-sounding but ungrounded or incorrect answers, and this goes unnoticed because it "sounds right" | Medium-high (this is a known, general risk of any LLM-based system, not specific to this design) | High (directly undermines the entire premise this project is built to differentiate itself on) | The mandatory manual verification steps (4 and 5) specifically require checking groundedness, not just plausibility, before this RFC's scope is considered complete |
| The message-creation endpoint's response time (now including a full LLM call) feels slow to users | Medium | Low-medium (a UX concern, not a correctness one) | Explicitly named as the reason RFC 0016 plans a streamed alternative for Phase 3, not attempted to be solved here |
| Chat history grows unboundedly and is passed in full to every subsequent LLM call, growing prompt cost linearly with conversation length | Medium, rising with usage | Medium (cost) | Not solved in this initial version — flagged as a future refinement (e.g., truncating or summarizing older history) once real usage data shows it matters |

## Security considerations

- Every chat route must independently verify the requesting user owns both the `connectedRepoId` (if provided) and the specific `chatSessionId` being read from or written to — a user must never be able to access another user's conversation, even by guessing or enumerating IDs.
- The prompt sent to the LLM provider will include retrieved code content from the user's own repository — for a private repository (once RFC 0010/0021 makes that possible), this means repository content leaves this project's own infrastructure boundary for the first time, sent to whichever external LLM provider is chosen. This is a materially different security posture than RFC 0008's local-only embedding model, and must be clearly, explicitly acknowledged (in a future RFC finalizing the specific LLM provider) rather than treated as an incidental detail.

## Performance considerations

- One LLM API call's latency (commonly single-digit seconds, provider-dependent) is now directly in the critical path of the message-creation endpoint's response time — acceptable for this simple version, explicitly named as the motivation for RFC 0016's later streaming design.
- `hybridRetrieve()`'s own performance characteristics (RFC 0011) compound with this call's latency — worth measuring the combined, real end-to-end response time once both are implemented together, not just each in isolation.

## Testing strategy

- The two mandatory manual verification questions (a genuinely answerable one, a genuinely unanswerable one) are this stage's actual checkpoint, exactly mirroring the "don't trust that it compiles, verify the actual output" principle already established for Steps 6–8.
- Automated testing of LLM-call-dependent code is inherently harder than the fully deterministic pipeline stages — RFC 0023 should address this via either a mocked/recorded LLM response for deterministic route-level tests, or accept that some behavior here can only be spot-checked manually on an ongoing basis, not fully automated.

## Rollback plan

If the single-agent approach proves fundamentally inadequate even at this simple scope (unlikely, given how minimal it is, but namable), the rollback is straightforward: nothing in Phase 3's design depends on this RFC's specific prompt wording or provider choice surviving unchanged — only the *pattern* (retrieve, then call an LLM with that context) needs to hold, and that pattern itself is not in question here.

## Migration / rollout

None for the agent logic itself. The chat persistence routes activate the `ChatSession`/`ChatMessage` tables for the first time since their creation in RFC 0003 — no schema migration is required, only new application code writing to already-existing tables, exactly as RFC 0003 intended.

## Consequences

**Positive:** the full retrieval-to-answer loop is proven working, in isolation, before Phase 3's real complexity is introduced — directly serving this project's own stated risk-isolation goal for phase-gating.

**Negative:** the resulting single-agent product is noticeably weaker than the eventual Phase 3 system (no tool-calling, no verification) — this is expected and acceptable, not a shortcoming to be alarmed by, provided it's clearly understood as an intentional stepping stone rather than mistaken for a finished feature.

## Success criteria

- A genuinely answerable question about a real indexed repository produces an answer that is both accurate and clearly grounded in retrieved context, judged by manual inspection.
- A genuinely unanswerable question produces an honest "I don't have enough information" response rather than a fabricated, confident-sounding one.

## Open questions

- Which LLM provider/model — deliberately left unresolved by this RFC, to be decided based on real cost/quality tradeoffs at implementation time rather than speculatively here.
- Chat history growth/truncation strategy — deferred until real usage data shows it's a real cost concern.

## Non-goals for this RFC

- Any form of multi-step reasoning, tool-calling, question classification, or answer verification — all explicitly Phase 3 (RFC 0013–0015).
- Streaming responses — RFC 0016.

## References

- Report: "Step 11 — Single agent" and the backend portion of "Step 12 — Chat UI," CodeCortex-Complete-Report.md.
- RFC 0011, RFC 0003.
