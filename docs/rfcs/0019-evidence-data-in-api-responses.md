# RFC 0019: Evidence data in API responses

- **Status:** Proposed
- **Phase:** 4 (Step 19)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** the chat-message route's response shape (extends RFC 0012/0016), `frontend/lib/api.ts`
- **Depends on:** RFC 0015 (the Critic's verification produces the evidence this RFC exposes)

## Summary

The chat-message endpoint's response will be extended to include structured "evidence" alongside the final answer prose — the specific graph nodes, file paths, and line ranges the Critic (RFC 0015) actually verified the answer's factual claims against — so the frontend can render an answer with concrete, clickable, inspectable references back to real source locations, rather than prose alone that asks the user to simply trust it.

## Terminology

- **Evidence (in this context):** the specific, structured set of graph nodes and source locations that back a given answer's verified claims — distinct from the answer's prose, which is generated text describing what that evidence means.
- **Grounding reference:** a single evidence item — a file path, a line range, and which claim in the answer it supports.

## Motivation

### The problem this RFC solves

By the time RFC 0015's Critic exists, this system genuinely *has* verified, structured evidence backing every claim in an approved answer — the Critic's verification process, by construction, checked each claim against specific graph nodes. RFC 0012 and RFC 0016's response designs, however, only ever surface the final prose answer, discarding that structured verification evidence the moment it's used internally. This RFC exists to stop discarding it — exposing it to the frontend turns "trust me, this is verified" into "here's exactly what was checked, and where," which is a meaningfully stronger and more inspectable claim for a user to evaluate for themselves.

### Why this is a Phase 4 refinement, not a Phase 3 requirement

RFC 0015's Critic already provides the actual verification guarantee regardless of whether that evidence is ever surfaced to the user — Phase 3's own success criteria (an answer is actually checked against the graph) are fully met without this RFC existing at all. This RFC is explicitly a trust-and-transparency improvement layered on top of an already-complete guarantee, not a correctness requirement — which is precisely why it's sequenced in Phase 4 alongside other efficiency/experience refinements, not bundled into Phase 3's core agent-building work.

## Background / Prior art

Surfacing citations or source references alongside an AI-generated answer — rather than prose alone — is an increasingly standard pattern across RAG-based products generally, specifically because it lets a user independently verify a claim rather than needing to take the system's word for it. This RFC applies that same pattern here, with a specific advantage over many general RAG citation implementations: because RFC 0015's Critic performed *actual* verification (not just retrieval), the evidence this RFC surfaces represents genuinely checked facts, not merely "here's the context that was retrieved and might be relevant."

## Detailed design

### Planned response shape addition

```ts
type AnswerWithEvidence = {
  content: string;
  evidence: Array<{
    claim: string;           // the specific claim this evidence supports, in the Critic's own extracted wording
    filePath: string;
    startLine: number;
    endLine: number;
    graphNodeType: "Function" | "Class";
    graphNodeName: string;
  }>;
};
```

### Planned data flow

RFC 0015's `critiqueDraft()` already extracts individual claims and checks each against the graph as part of its normal verification process — this RFC requires that function's `approved` return path to additionally retain and return the specific node/location data each verified claim was checked against, rather than discarding it once the check itself succeeds. No new verification logic is introduced; this RFC is purely about not throwing away data the Critic already computes internally.

### Planned frontend rendering

Each evidence item becomes a clickable reference within or alongside the answer's prose (e.g., inline citation markers, or a collapsible "sources" section), linking to the specific file/line range — giving the user a direct, concrete way to jump to and independently inspect exactly what the answer's claims are based on.

## Implementation plan

1. Modify `critiqueDraft()`'s (RFC 0015) internal claim-checking logic to retain, per successfully-verified claim, the specific file path, line range, and graph node identity the Cypher check matched against — this data already exists transiently during verification; this change only prevents it from being discarded.
2. Extend `critiqueDraft()`'s `approved` return type to include the `evidence` array described above.
3. Thread this through the chat-message route's response (and, if RFC 0016 is already built, as part of the final `"answer"` SSE event's payload) to the frontend.
4. Update `frontend/lib/api.ts`'s response type and build the corresponding evidence-rendering UI.
5. Manually verify: ask a real question, receive an answer, and confirm each evidence item's referenced file/line range genuinely does contain the code supporting its associated claim — a manual spot-check that the evidence is accurate, not merely present.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Expose the Critic's own verification evidence directly** *(proposed)* | Zero new verification logic — reuses exactly what the Critic already checks; evidence is guaranteed consistent with what was actually verified, by construction | Requires threading additional data through RFC 0015's existing return path, a moderate refactor of an already-built function | **Proposed** |
| **Have a separate process re-derive "supporting evidence" for an already-generated answer, independent of the Critic's own verification** | Could be added without modifying RFC 0015's internals at all | Duplicates verification-adjacent work the Critic already performed; risks the re-derived evidence subtly disagreeing with what was actually checked, since it's a separate process operating after the fact rather than the actual verification record itself | Rejected — directly contradicts the "evidence should be exactly what was verified" principle this RFC is built around |
| **Only show evidence for `unverifiable` answers (to explain what's missing), not `approved` ones** | Narrower scope, less work | Misses the larger value: showing evidence for confidently *approved* answers is what turns "trust the system" into "verify it yourself," which is valuable specifically for correct answers, not primarily for flagged uncertain ones | Rejected — evidence is valuable precisely because it's attached to answers the system is confident are correct |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Evidence line ranges become stale relative to the current file content if shown for an answer from a previous session, after the file has since changed (interacts with RFC 0018's re-indexing) | Medium once RFC 0018 exists and repositories are re-indexed over time | Low-medium (a confusing but not dangerous UX issue — clicking through to a slightly-shifted line range) | Worth considering, in a future refinement, storing evidence relative to the specific `commitSha` it was verified against (already recorded via RFC 0017's `verifiedAtCommitSha` pattern) so the frontend could indicate "this evidence is from an earlier version of the file" — not designed in full here, flagged as an Open Question |
| Threading evidence data through RFC 0015's return path introduces a regression in its existing, already-verified claim-checking logic | Low-medium (any refactor of already-working code carries some risk) | Medium | RFC 0015's existing manual verification test cases (the injected-false-claim test, in particular) should be re-run after this RFC's changes to confirm verification behavior itself is unchanged, only its data retention |

## Security considerations

- Evidence data (file paths, line ranges, graph node names) is drawn from the same repository content already accessible to the requesting user via every other endpoint in this system — no new data exposure beyond what's already correctly scoped and authorized elsewhere.

## Performance considerations

- Retaining already-computed data during verification (rather than discarding it) adds negligible overhead to RFC 0015's existing process — this RFC does not introduce any new queries or LLM calls, only changes what data an already-running process returns.

## Testing strategy

- The manual accuracy spot-check (Implementation Plan step 5) — confirming evidence genuinely points to code that supports its associated claim — is this stage's checkpoint.
- RFC 0015's existing verification test cases should be re-run to confirm this RFC's refactor didn't regress the underlying verification logic itself.

## Rollback plan

If evidence data proves unreliable or its threading through RFC 0015 introduces unexpected complexity, the rollback is simply not returning the `evidence` field (or returning it empty) while investigating — the underlying Critic verification behavior itself is unaffected either way, since this RFC only changes what data is *returned*, not what is *checked*.

## Migration / rollout

Additive to the existing response contract — the `evidence` field can be added without breaking existing frontend code that doesn't yet know to render it (an unrecognized additional field is simply ignored by JSON-parsing consumers written before this RFC).

## Consequences

**Positive:** turns this project's internal verification guarantee into something a user can directly, independently inspect, meaningfully strengthening the practical trust value of "this answer was verified" beyond just asserting it in prose.

**Negative:** couples the frontend more tightly to the specific internal shape of the Critic's verification process — a future change to how RFC 0015 performs verification internally must now also consider whether it affects this RFC's evidence-exposure contract, an added maintenance consideration that didn't exist before this RFC.

## Success criteria

- Every piece of evidence returned for a real, approved answer, manually spot-checked, genuinely does contain the code supporting its associated claim at the referenced file/line range.

## Open questions

- Should evidence be tied to a specific commit SHA, with the frontend indicating when displayed evidence is from a now-outdated version of the file (interacting with RFC 0018)? Flagged, not designed here.

## Non-goals for this RFC

- Any change to what the Critic actually verifies or how — this RFC only changes what data is retained and returned from an already-existing process.
- Evidence for `revise`-in-progress or `unverifiable` answers beyond what's naturally available — this RFC's primary focus is `approved` answers.

## References

- Report: "Step 19 — Evidence display," CodeCortex-Complete-Report.md.
- RFC 0015.
