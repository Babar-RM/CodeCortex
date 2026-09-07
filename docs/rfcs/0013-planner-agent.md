# RFC 0013: Planner agent

- **Status:** Proposed
- **Phase:** 3 (Step 13)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** new `backend/src/lib/agents/planner.ts`
- **Depends on:** RFC 0012 (the single-agent pattern this replaces the "single" part of), RFC 0011 (retrieval the Planner may also lean on for classification context)

## Summary

A dedicated Planner agent will be introduced as the first step in every question-answering request, replacing RFC 0012's single undifferentiated agent as the sole responder. The Planner's only job is to classify an incoming question into one of a small, fixed set of types (explain, trace-a-bug, review-a-change, suggest-a-refactor) and route it to the corresponding specialist (RFC 0014) — it does not itself investigate the codebase or produce a final answer.

## Terminology

- **Classification (in this context):** determining which of a fixed, small set of question categories a user's natural-language question belongs to, via one LLM call.
- **Routing:** the Planner's decision output — which specialist agent should handle this specific question.
- **Question type:** one of the four categories this RFC defines: Explain, Bug-Trace, Review, Refactor.

## Motivation

### The problem this RFC solves

RFC 0012's single agent treats every question identically, regardless of whether the user is asking "how does this work" (an explanatory question, best served by broad context and clear prose) versus "what breaks if I change this" (a structural, caller-tracing question, best served by deep graph traversal) versus "review this change" (needing a diff-aware comparison the other two don't). A single undifferentiated agent can attempt all of these with one generic prompt, but does none of them as well as a prompt and retrieval strategy specifically tuned to that question type would. This RFC introduces the first, smallest piece of Phase 3's specialization: deciding *which* kind of question this is, before deciding *how* to answer it.

### Why classification must be separate from investigation

Combining "figure out what kind of question this is" and "actually answer it" into one LLM call (which RFC 0012's single agent effectively does implicitly) means the model is doing two different cognitive tasks in one pass, with no opportunity to route to a specialized strategy based on the first task's outcome. Splitting them into two distinct steps — a fast, cheap classification call, then a routed, specialized investigation — is what makes the rest of Phase 3's specialization (RFC 0014) possible at all.

## Background / Prior art

Intent classification as a first step before routing to specialized handling is a long-established pattern in customer-support and task-automation systems generally (classify the request type, then dispatch to the right handler) — this RFC applies that same, well-understood pattern to code-question answering specifically.

## Detailed design

### Planned function signature

```ts
type QuestionType = "explain" | "bug_trace" | "review" | "refactor";

async function planQuestion(params: {
  question: string;
  connectedRepoId: string;
}): Promise<{ type: QuestionType; reasoning: string }>
```

### Planned classification approach

One LLM call, with a system prompt describing each of the four categories and a small number of representative examples per category (few-shot prompting), asking the model to return a structured classification (the question type, plus a brief stated reasoning for auditability — useful both for debugging misclassifications and for RFC 0022's future agent-trace logging). No retrieval or graph access is performed at this stage — classification is intended to work from the question's wording alone, keeping this step fast and cheap relative to the specialist investigation that follows.

### Planned fallback behavior for ambiguous questions

A question that doesn't clearly fit any category (or that the model itself expresses low confidence about) will default to `"explain"` — the broadest, least structurally-demanding category, on the reasoning that an overly narrow specialist given an ill-fitting question is more likely to produce a confused or incomplete answer than the broadest specialist is. This default is a deliberate, named choice, not an unhandled edge case.

## Implementation plan

1. Write `planQuestion()` in `backend/src/lib/agents/planner.ts`, with the four-category system prompt and few-shot examples.
2. Manually test against a set of at least 8–10 hand-written example questions, at least two clearly representative of each of the four categories, confirming correct classification for each.
3. Manually test at least 2–3 deliberately ambiguous or category-spanning questions, confirming the fallback-to-`"explain"` behavior triggers as designed.
4. Wire `planQuestion()`'s output into the chat-message route (replacing RFC 0012's direct call to a single agent) as a routing decision only — RFC 0014's specialists are what actually act on that decision.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A dedicated, separate Planner LLM call** *(proposed)* | Clean separation of concerns; classification reasoning is inspectable/loggable independently of the eventual answer; enables genuinely different retrieval/prompting strategies per specialist | An additional LLM call (and its latency/cost) on every single question, even simple ones | **Proposed** |
| **Classify via a smaller, cheaper/non-LLM method** (keyword matching, a lightweight classifier model) | Faster, cheaper than an LLM call | Natural-language questions vary too much in phrasing for reliable keyword-based classification; a lightweight trained classifier would require labeled training data this project doesn't have | Rejected — an LLM call, while not free, handles the actual variability of real user phrasing far more robustly |
| **Skip explicit classification; let each specialist decide for itself whether a question is "its kind"** | No separate Planner step or its added latency | Risks multiple specialists each investigating the same question independently and redundantly, or none confidently claiming it — a coordination problem the Planner is specifically designed to avoid | Rejected |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Misclassification routes a question to the wrong specialist, producing a mismatched or poor-quality answer | Medium (classification is inherently imperfect) | Medium | The `"explain"` fallback for ambiguous cases mitigates the worst outcomes; RFC 0022's future logging will make misclassification patterns visible over time for prompt refinement |
| The added classification call meaningfully increases per-question latency and cost across the entire system | Medium-high (an unavoidable, direct consequence of this design) | Medium | Accepted as the cost of specialization — RFC 0016's streaming design will surface intermediate progress ("classifying your question...") so this latency is not silently invisible to the user |

## Security considerations

- The Planner receives only the question text and a `connectedRepoId` — no code content, no retrieval results — keeping this step's data exposure to an external LLM provider minimal relative to what the eventual specialist call will require.

## Performance considerations

- This adds one LLM round-trip to every question's total latency, on top of whatever the routed specialist itself requires — the cumulative latency budget across Planner → Specialist → Critic (RFC 0015) is worth measuring holistically once all three exist, not evaluated in isolation per-RFC.

## Testing strategy

- The manual classification-accuracy verification (Implementation Plan steps 2–3) is this stage's checkpoint.
- A fixed set of example question/expected-category pairs, once established during manual testing, should be retained as a regression-test fixture (RFC 0023) so future prompt changes can be checked against previously-verified classifications.

## Rollback plan

If Planner-based routing underperforms relative to RFC 0012's single-agent baseline, reverting is straightforward: route every question to a single default specialist (or back to RFC 0012's original undifferentiated agent) while the Planner's prompt is refined — the routing decision is a thin layer sitting in front of RFC 0014's specialists, not deeply entangled with them.

## Migration / rollout

None — new capability layered in front of the existing chat-message route.

## Consequences

**Positive:** enables genuinely specialized handling per question type (RFC 0014), which is a direct prerequisite for this project's differentiation goal.

**Negative:** adds latency and cost to every question, including ones a single well-prompted agent might have answered adequately without any classification step at all.

## Success criteria

- At least 8 of 10 hand-written representative test questions are classified into their expected category.
- Ambiguous test questions reliably fall back to `"explain"` rather than confidently misclassifying into a narrow, ill-fitting category.

## Open questions

- Should classification confidence be exposed and used to trigger a lighter-weight fallback path (e.g., skip specialist investigation entirely for very low-confidence classifications)? Not designed here — worth revisiting once real misclassification patterns are observed.

## Non-goals for this RFC

- The specialists themselves — RFC 0014.
- Any answer verification — RFC 0015.

## References

- Report: "Step 13 — Planner agent," CodeCortex-Complete-Report.md.
