# RFC 0017: Insight cache

- **Status:** Proposed
- **Phase:** 4 (Step 17)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** new `InsightCache` Prisma model, new `backend/src/lib/insight-cache.ts`
- **Depends on:** RFC 0015 (only caches Critic-verified answers), RFC 0018 (cache invalidation ties to re-indexing)

## Summary

Verified, Critic-approved answers will be cached per repository, keyed on semantic similarity to the originating question, so a new question closely resembling a previously-answered one can be served (or substantially accelerated) from the cache rather than re-running the full Planner → Specialist → Critic pipeline from scratch. Only answers that reached the Critic's `approved` verdict (RFC 0015) are eligible for caching — `unverifiable` answers are never cached, since caching an unverified claim would mean repeatedly serving a possibly-wrong answer with increasing apparent authority each time it's reused.

## Terminology

- **Insight (in this context):** a cached, verified question/answer pair, along with enough metadata (which repo, which commit it was verified against, which graph nodes it referenced) to know when it's still valid.
- **Cache hit / near-hit:** a new question is a cache hit if it's judged sufficiently semantically similar to a cached question that the cached answer can be reused directly or with minimal adaptation, as opposed to a cache miss requiring full re-investigation.
- **Staleness:** a cached insight becoming invalid because the underlying code it was verified against has since changed — the specific condition this RFC's invalidation design must detect and act on.

## Motivation

### The problem this RFC solves

By the time RFC 0013–0016 are all built, answering even a moderately complex question can involve a Planner call, several specialist tool-calling round-trips, and multiple Critic revision rounds — a genuinely expensive, multi-call pipeline in both latency and LLM cost. Many real usage patterns involve users asking closely related or even near-identical questions repeatedly (a team onboarding several people who all ask "how does auth work here," or one person re-asking a slight rephrasing of an earlier question) — re-running the full pipeline from scratch every single time is wasteful given the answer, once genuinely verified, does not change unless the underlying code does.

### Why this can only be built after Phase 3, not before

Caching only makes sense — and only remains safe — if what's being cached has already been verified as correct (RFC 0015's Critic). Caching an *unverified* draft answer would mean silently converting this project's core differentiator (verified answers) into something structurally weaker than what it replaces: a plausible-sounding answer served repeatedly, gaining false authority through reuse without ever having been genuinely checked. This is why this RFC is sequenced explicitly after, and dependent on, the Critic existing and being fully verified first.

## Background / Prior art

Caching LLM outputs keyed on semantic similarity (rather than exact string matching) is an established pattern for reducing cost/latency in LLM-heavy applications — the specific addition this RFC makes to that general pattern is tying cache validity to a verifiable, checkable condition (whether the underlying code has changed since verification) rather than a fixed time-based expiry, which is possible here specifically because RFC 0018's incremental re-indexing gives this system a precise signal for "has anything actually changed."

## Detailed design

### Planned schema addition

```prisma
model InsightCache {
  id                  String   @id @default(cuid())
  connectedRepoId     String
  connectedRepo       ConnectedRepo @relation(fields: [connectedRepoId], references: [id], onDelete: Cascade)

  question            String
  questionEmbedding   Unsupported("vector(384)")
  answer              String
  questionType        String   // mirrors RFC 0013's QuestionType
  verifiedAtCommitSha String  // the commit this answer was verified against

  referencedNodeIds   String[] // graph node identifiers the answer's verified claims depended on

  createdAt           DateTime @default(now())
  lastServedAt        DateTime @default(now())
  hitCount            Int      @default(0)

  @@index([connectedRepoId])
  @@map("insight_cache")
}
```

`referencedNodeIds` records which specific graph nodes (functions/classes) the Critic actually verified claims against for this answer — this is the specific mechanism RFC 0018's invalidation design will use to determine staleness precisely, rather than crudely invalidating an entire repository's cache on any change anywhere in it.

### Planned cache-check flow

1. On a new question, embed it (the same model already used throughout, RFC 0008/0011) and run a `pgvector` similarity search against `InsightCache.questionEmbedding`, scoped to the `connectedRepoId`.
2. If a sufficiently close match exists (planned similarity threshold to be tuned empirically, not fixed speculatively here) **and** its `verifiedAtCommitSha` matches the repo's current commit (or, once RFC 0018 exists, its `referencedNodeIds` haven't been touched by any change since), serve the cached answer directly, incrementing `hitCount` and updating `lastServedAt`.
3. Otherwise, fall through to the full Planner → Specialist → Critic pipeline exactly as before, and on reaching an `approved` verdict, write a new `InsightCache` row.

### Why a similarity threshold, not exact-match caching

Real users rarely phrase the identical question twice verbatim; a cache that only serves exact string matches would rarely hit in practice, defeating the purpose. A similarity-based approach captures genuinely equivalent-in-substance questions phrased differently — at the cost of needing a carefully tuned threshold (too loose risks serving a stale or subtly mismatched answer to a genuinely different question; too strict rarely hits at all).

## Implementation plan

1. Add the `InsightCache` model via a Prisma migration.
2. Implement `checkInsightCache({ connectedRepoId, question })`, performing the embed-and-search step described above.
3. Implement `writeInsightCache({ ... })`, called only from the point in the chat-message flow where the Critic returns `approved` (RFC 0015) — never from `revise` or `unverifiable` paths.
4. Wire `checkInsightCache()` as the first step in the chat-message route, before the Planner is invoked, with a cache hit short-circuiting the rest of the pipeline entirely.
5. Manually verify: ask a question, get a verified answer, ask a clearly-equivalent rephrasing of the same question, and confirm the second request is served from cache (observably faster, and — via logging — confirmed to have skipped the full pipeline) with an answer consistent with the first.
6. Manually verify the negative case: ask two questions that are superficially similar in wording but substantively different in what they're asking, and confirm the second is *not* incorrectly served the first's cached answer — tuning the similarity threshold as needed based on this observation.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Semantic-similarity cache of Critic-verified answers only** *(proposed)* | Captures real-world question rephrasing; never serves an unverified answer | Requires careful threshold tuning; adds one embedding-and-search step to every question, even cache misses | **Proposed** |
| **Exact-string-match caching** | Trivial to implement, no threshold tuning needed | Rarely hits in practice, since real questions are rarely phrased identically twice | Rejected — insufficient hit rate to justify the feature |
| **Cache all draft answers, verified or not** | Higher cache-hit potential (more answers eligible for caching) | Directly undermines this project's core verification guarantee by potentially serving an unverified, possibly-wrong answer repeatedly with increasing apparent authority | Rejected outright — not a real option under this project's own stated constraints |
| **Time-based cache expiry instead of commit/node-based invalidation** | Simpler to implement than tracking `referencedNodeIds` | Either expires too eagerly (discarding still-valid answers, wasting the cache's benefit) or too lazily (serving a stale answer after code has actually changed) — a fixed time window has no relationship to whether the code actually changed | Rejected in favor of the more precise, code-change-driven invalidation RFC 0018 enables |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A stale cached answer is served after the underlying code changed, because invalidation logic (dependent on RFC 0018) has a gap | Medium until RFC 0018 is fully built and tested together with this RFC | High (directly serves an incorrect, previously-true-but-now-false answer with the appearance of having been verified) | This RFC's `verifiedAtCommitSha` check provides a coarse but immediate safety net (any commit change invalidates matches) even before RFC 0018's finer-grained, node-level invalidation is fully built |
| The similarity threshold is set too loosely, serving a mismatched answer to a genuinely different question | Medium (threshold tuning is inherently empirical, not something to get exactly right on the first attempt) | Medium-high (a wrong answer served with unwarranted confidence, since it appears to come from the "verified" cache) | Explicitly named as requiring the negative-case manual verification in Implementation Plan step 6, not assumed correct by default |

## Security considerations

- Cached insights must be scoped by `connectedRepoId` and checked for user ownership exactly like every other repo-scoped resource in this project — no new pattern introduced here, but worth restating given this is a new table.

## Performance considerations

- A cache hit is the entire point of this RFC's performance benefit — turning a multi-call, multi-second pipeline into a single embedding-and-search operation.
- A cache miss adds one additional embedding-and-search step to every question that doesn't hit — a small, acceptable overhead relative to the multi-call pipeline it precedes.

## Testing strategy

- The positive (rephrased-question cache hit) and negative (superficially-similar-but-different-question non-hit) manual verifications in Implementation Plan are this stage's checkpoint.
- Once a stable threshold is empirically settled, a fixed set of question-pair examples (should-hit and should-not-hit) should become a regression fixture (RFC 0023).

## Rollback plan

If caching introduces more staleness/correctness risk than its performance benefit justifies, the rollback is disabling the cache-check step in the chat-message route (falling through to the full pipeline unconditionally) — the `InsightCache` table itself and its write path can remain harmlessly inert while this is investigated, requiring no schema rollback.

## Migration / rollout

Additive — a new table, no changes to existing schema.

## Consequences

**Positive:** meaningfully reduces cost and latency for realistic patterns of repeated/rephrased questions, without weakening the verification guarantee (since only `approved` answers are ever cached).

**Negative:** introduces a genuinely tricky correctness dependency on RFC 0018's invalidation logic being right — a cache is only as trustworthy as its invalidation is reliable.

## Success criteria

- A rephrased version of a previously-answered, verified question is served from cache, correctly and observably bypassing the full pipeline.
- A superficially similar but substantively different question is correctly *not* served a mismatched cached answer.

## Open questions

- Exact similarity threshold — deliberately left to empirical tuning during implementation, not fixed speculatively in this RFC.
- Should cache entries ever expire purely by age, as a backstop against invalidation logic gaps, independent of RFC 0018's precision? Worth considering as defense-in-depth, not decided here.

## Non-goals for this RFC

- The invalidation mechanism's precise implementation — RFC 0018.
- Caching anything other than fully Critic-approved answers — explicitly, permanently out of scope, not merely deferred.

## References

- Report: "Step 17 — Insight cache," CodeCortex-Complete-Report.md.
- RFC 0015, RFC 0008.
