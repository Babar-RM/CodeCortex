# RFC 0015: Critic agent

- **Status:** Proposed
- **Phase:** 3 (Step 15)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** new `backend/src/lib/agents/critic.ts`
- **Depends on:** RFC 0014 (verifies its draft output), RFC 0007 (the graph it verifies against)

## Summary

Every draft answer produced by any of RFC 0014's four specialists will be passed through a dedicated Critic agent before ever being shown to a user. The Critic's job is to check each specific factual claim in the draft answer (e.g., "function X calls function Y") against the actual Neo4j graph, and either approve the answer, request a revision from the specialist with specific feedback about what's unverified or wrong, or — after a hard iteration cap — flag the answer as unverified rather than silently presenting it as trustworthy.

## Terminology

- **Verification (in this context):** confirming that a specific, checkable factual claim in an LLM-generated answer is actually true according to the graph, as opposed to merely plausible-sounding.
- **Factual claim extraction:** identifying the individual, independently-checkable assertions within a longer natural-language answer (e.g., pulling out "`formatDate` calls `Intl.DateTimeFormat`" as one discrete, verifiable claim from a longer explanatory paragraph).
- **Revision loop:** the cycle of the Critic rejecting a draft with specific feedback, the originating specialist producing a revised draft incorporating that feedback, and the Critic re-checking the revision.

## Motivation

### The problem this RFC solves

Every prior RFC in this project's design — RFC 0007's careful, idempotent graph construction, RFC 0008's locally-run embeddings, RFC 0011's hybrid retrieval, RFC 0014's tool-calling specialists — exists to produce grounded, accurate answers. None of it, on its own, actually *guarantees* the final natural-language answer an LLM writes correctly reflects the data it was given. An LLM can retrieve entirely correct context via a tool call and then still misstate, misremember, or subtly distort a detail while composing its final prose answer — a failure mode fundamentally different from (and not caught by) any of the retrieval-quality work in earlier RFCs. This RFC exists specifically to catch that last-mile failure mode, which is the single specific capability this project's own stated differentiation argument (verified answers, not plausible-sounding ones) actually rests on.

### Why this must not be cut, ever, even under schedule pressure

This project's own `AGENTS.md` states plainly that a Phase 2/3 system shipped without the Critic's graph-verification step is "a materially different product than what this project is building." This RFC exists to make that constraint concrete and implementable, not merely aspirational — skipping or watering down this RFC's actual verification logic (e.g., replacing real graph checks with the LLM simply "double-checking itself" in a second prompt, with no actual graph query involved) would defeat the entire purpose while superficially appearing to satisfy it.

## Background / Prior art

Self-verification and self-critique loops for LLM outputs are an active, established pattern (sometimes called "self-refine" or "reflection" in the broader literature) — but the specific design choice here, worth naming explicitly, is that this Critic verifies against an **external, independently-constructed source of truth** (the Neo4j graph, built deterministically in Phase 1 with no LLM involvement at all) rather than the model merely reflecting on its own output in isolation. This distinction is what makes this design meaningfully stronger than a generic "ask the model to double-check itself" pattern, which has no external ground truth to check against and can hallucinate a confident-sounding "yes, this is correct" just as easily as it hallucinated the original claim.

## Detailed design

### Planned function signature

```ts
async function critiqueDraft(params: {
  draftAnswer: string;
  connectedRepoId: string;
  question: string;
}): Promise<
  | { verdict: "approved"; answer: string }
  | { verdict: "revise"; feedback: string }
  | { verdict: "unverifiable"; answer: string; caveat: string }
>
```

### Planned verification process

1. **Extract factual claims** from the draft answer via one LLM call specifically prompted to identify discrete, checkable assertions (e.g., "X calls Y," "X is defined in file Y," "X inherits from Y") — deliberately separate from generating the original answer, so this extraction step isn't biased by having just written the claims itself in the same context.
2. **For each extracted claim**, run an actual, real Cypher query against the graph (RFC 0007) to check whether it holds — e.g., a "calls" claim is checked via a direct `MATCH` for the corresponding `CALLS` edge, not by asking an LLM whether it "sounds right."
3. **Aggregate results**: if all claims verify, `approved`. If any claim fails verification, `revise`, with feedback specifically naming which claim was wrong and what the graph actually shows — fed back to the originating specialist (RFC 0014) to produce a corrected draft.
4. **Iteration cap** (planned: 3 revision rounds): if claims still fail verification after the cap is reached, return `unverifiable` — the answer is still returned to the user, but explicitly flagged as containing claims that could not be confirmed against the graph, rather than either silently presenting an unverified answer as trustworthy or refusing to answer at all.

### Why claims that can't be graph-checked (e.g., subjective judgments like "this code looks well-organized") aren't rejected outright

Not every sentence in a helpful answer is a checkable factual claim — some are reasonable, appropriate subjective framing or explanation. This RFC's claim-extraction step is designed to identify only genuinely checkable structural assertions (calls, definitions, inheritance, imports) for verification, explicitly leaving non-structural commentary alone rather than forcing everything through a check it was never meant to satisfy.

## Implementation plan

1. Write the claim-extraction prompt and function, tested manually against several example draft answers to confirm it correctly identifies genuine structural claims and correctly leaves subjective/explanatory prose alone.
2. Write the per-claim graph-verification logic, mapping each claim type (calls, defines, inherits, imports) to the corresponding Cypher query pattern already established in RFC 0007.
3. Write the aggregation and revision-feedback logic, including the iteration cap.
4. Wire this into the specialist flow (RFC 0014): every specialist's draft answer passes through `critiqueDraft()` before being returned from the chat-message route.
5. Manually verify with at least one deliberately constructed test case: take a real specialist draft answer and manually inject a false claim into it (e.g., changing a real "calls" relationship to a function it does not actually call), confirming the Critic correctly catches this specific injected error and produces a `revise` verdict with accurate feedback.
6. Manually verify the `unverifiable` fallback path by constructing a scenario where a claim remains genuinely unresolvable (e.g., referencing a function that doesn't exist in the graph at all) even after revision attempts, confirming it correctly reaches the iteration cap and returns the expected flagged-caveat response rather than looping indefinitely or crashing.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Verify factual claims against the real Neo4j graph** *(proposed)* | Checks against an independently-constructed, deterministic source of truth; directly implements this project's core differentiation claim | Requires claim-extraction to work reliably, and requires mapping natural-language claims back to specific graph query patterns — genuinely hard engineering | **Proposed** |
| **Self-critique via a second LLM call with no external verification** ("ask the model to double check itself") | Much simpler to implement | No independent ground truth — the model can hallucinate a confident "yes, correct" just as easily as it hallucinated the original error; provides no real verification guarantee | Rejected — this is explicitly the weaker pattern this RFC's design deliberately avoids |
| **Skip verification for latency/cost reasons, treat every specialist draft as final** | Fastest, cheapest | Directly abandons this project's stated core differentiator; explicitly prohibited by this project's own `AGENTS.md`/`RULES.md` | Rejected — not a real option under this project's own constraints |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Claim extraction misses a genuine factual error because it wasn't phrased in an extractable way | Medium (natural language is varied; extraction is itself an LLM task, not infallible) | High (an unverified error reaches the user, undermining the entire feature's purpose) | Named explicitly as a residual risk, not claimed to be fully solved; worth ongoing monitoring once RFC 0022's logging exists, to observe real-world extraction miss patterns |
| The revision loop oscillates (the specialist's "corrected" draft introduces a new false claim while fixing the flagged one) without converging | Medium | Medium | The iteration cap bounds this — after 3 rounds, `unverifiable` is returned rather than looping indefinitely, and the user is told explicitly rather than left in an infinite wait |
| Verification adds enough latency that the overall question-answering experience feels slow | High (an unavoidable, direct consequence of doing real verification work) | Medium (UX cost, weighed against and accepted for the correctness benefit) | RFC 0016's streaming design will surface "verifying..." as visible intermediate progress, rather than leaving verification latency invisible and simply feeling like a longer wait |

## Security considerations

- Claim verification queries the graph using the same `connectedRepoId` scoping already required everywhere else in this project — no new security surface is introduced here beyond what RFC 0007/0011/0014 already established, since this RFC only reads from the graph, using the same access patterns.

## Performance considerations

- This RFC adds meaningfully to per-question latency: claim extraction (one LLM call) plus one graph query per extracted claim plus, in the worst case, up to two additional full revision rounds (each involving the originating specialist re-running, potentially with its own additional tool calls). This is the single largest additional cost RFC 0015 introduces to the overall system, and it is judged worth paying given it directly implements this project's core value proposition — but it should be measured and reported on explicitly (RFC 0022) rather than left unmeasured.

## Testing strategy

- The deliberately-injected-false-claim test (Implementation Plan step 5) is this stage's single most important verification — it directly tests whether the Critic actually catches an error, not merely whether the code runs without throwing.
- Claim-to-Cypher-query mapping logic (deterministic, no LLM involved in the actual verification query itself) should get direct unit tests against a known fixture graph, independent of any LLM behavior.

## Rollback plan

If the revision loop proves too costly or too unreliable in practice, a fallback mode could skip revision entirely and go straight from a single verification pass to either `approved` or `unverifiable` (removing the iterative refinement, keeping the core "check claims against the graph" capability) — a real degradation of quality, but one that preserves this RFC's essential, non-negotiable verification guarantee rather than abandoning it.

## Migration / rollout

None — new capability inserted into the existing specialist flow.

## Consequences

**Positive:** this is the single feature most directly responsible for this project's claimed differentiation from plain-RAG code chat tools — a verified, not merely plausible, answer.

**Negative:** meaningfully increases per-question latency and LLM cost, on top of everything RFC 0013/0014 already add.

## Success criteria

- A deliberately injected false factual claim is reliably caught and correctly triggers a `revise` verdict with accurate, specific feedback.
- A genuinely correct draft answer is not incorrectly flagged or endlessly revised — false positives (rejecting a correct claim) are as important to avoid as false negatives (missing a real error).

## Open questions

- Should the iteration cap (3) be configurable per question type, mirroring RFC 0014's own similar open question about `expansionHops`/tool budgets varying by specialist? Not decided — revisit with real usage data.

## Non-goals for this RFC

- Streaming the Critic's intermediate verification progress to the user — RFC 0016.
- Verifying subjective, non-structural claims — explicitly out of scope, per Detailed Design.

## References

- Report: "Step 15 — Critic agent," CodeCortex-Complete-Report.md.
- RFC 0007, RFC 0014.
