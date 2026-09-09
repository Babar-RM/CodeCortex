# RFC 0018: Incremental re-indexing

- **Status:** Proposed
- **Phase:** 4 (Step 18)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** `backend/src/jobs/worker.ts` (extends RFC 0009), `backend/src/jobs/pipeline/` (adds a diff step)
- **Depends on:** RFC 0005 (repeats fetching, now diff-aware), RFC 0007/0008 (partial updates instead of full rewrites), RFC 0009 (extends the job orchestration), RFC 0003's Open Question (denormalized `lastIndexedCommitSha`)

## Summary

When a repository already connected and previously indexed is re-indexed (either user-triggered or, eventually, automatically on a schedule), the pipeline will diff the new commit against the last successfully indexed commit and update only the graph nodes, edges, and embeddings for files that actually changed — rather than RFC 0005–0009's current behavior of unconditionally re-cloning, re-parsing, and re-embedding the entire repository from scratch on every index.

## Terminology

- **Full re-index:** re-running the entire Phase 1 pipeline (RFC 0005–0009) against a repository's complete current file set, regardless of what has or hasn't changed since the last index — the current, only-available behavior this RFC improves upon.
- **Incremental re-index:** re-running the pipeline only against the specific files that changed between two commits, leaving unchanged files' graph nodes and embeddings untouched.
- **Diff (in this context):** the set of added, modified, and deleted files between the previously-indexed commit and the newly-fetched one, computable via a standard `git diff --name-status` between two commit SHAs.

## Motivation

### The problem this RFC solves

RFC 0009's worker, as currently designed, treats every indexing job identically — a first-time connect and a "please refresh this, I just pushed a small change" request both trigger the exact same full clone-parse-graph-embed sequence across the entire repository. For a large repository where a user has changed one file, this is enormously wasteful: minutes of clone/parse/embed time and real LLM-adjacent (embedding) compute cost spent re-processing hundreds or thousands of files that didn't change at all.

### Why this is sequenced in Phase 4, not earlier

Incremental re-indexing is meaningfully more complex than the full-reindex baseline RFC 0005–0009 already established, and its correctness depends on that baseline already being solid and verified (there's no point optimizing an update path for a pipeline whose full-run correctness hasn't been proven). It's also explicitly not required for either Phase 1's or Phase 2/3's own checkpoints — those only ever needed *a* working index, not an efficiently *updatable* one. This RFC belongs in Phase 4 specifically because it's a genuine efficiency optimization on top of an already-working, already-verified foundation, not a correctness requirement of any earlier phase.

## Background / Prior art

Incremental compilation/analysis — reprocessing only what changed since a known-good prior state, identified via a diff against that prior state — is an extremely common pattern in build systems, static analyzers, and IDEs specifically because the alternative (always reprocessing everything) scales poorly with codebase size. This RFC applies that same well-established pattern to CodeCortex's own indexing pipeline.

## Detailed design

### Planned diff step

Before Step 5's clone, fetch just the new commit SHA (a lightweight remote lookup, not a full clone) and compare it against the repository's last successfully indexed commit — retrieved via the most recent `SUCCEEDED` `IndexingJob.commitSha` for this `ConnectedRepo` (per RFC 0003's existing, if slightly awkward, per-job-lookup pattern — this RFC's implementation is the natural point to finally resolve RFC 0003's own flagged Open Question about denormalizing a `lastIndexedCommitSha` directly onto `ConnectedRepo`, since this RFC's diff step needs that exact value on every re-index and benefits directly from not re-deriving it via a job-history query each time).

If the new commit matches the last indexed commit exactly, the job completes immediately as a no-op (`SUCCEEDED`, with a `progressMessage` explicitly stating nothing had changed) — no clone, no parsing, no re-embedding at all.

If they differ, run `git diff --name-status <lastIndexedSha> <newSha>` (requiring a fetch of both commits, not a full history clone — still consistent with RFC 0005's shallow-clone philosophy) to produce three sets: added files, modified files, deleted files.

### Planned per-set handling

- **Added and modified files**: pass through Steps 6–8 (RFC 0006–0008) exactly as before, but scoped only to this subset of files, not the full repository.
- **Deleted files**: their corresponding `File`/`Function`/`Class` nodes and all edges touching them must be explicitly removed from Neo4j (a `DETACH DELETE` scoped by `repoId` and `path`), and their corresponding `CodeEmbedding` rows deleted from Postgres — RFC 0007's `MERGE`-based writes handle *updates* to unchanged-identity nodes correctly by design, but they do not, on their own, handle removal of nodes whose backing file no longer exists at all; this RFC's diff step must explicitly add that removal logic, which RFC 0007 never needed for its own full-reindex-only design.
- **Unchanged files**: no action at all — their existing graph nodes and embeddings remain exactly as they are, which is the entire point of this RFC's efficiency gain.

### Interaction with RFC 0017's insight cache

Every graph node touched (created, updated, or deleted) by an incremental re-index should be checked against `InsightCache.referencedNodeIds` — any cached insight referencing a touched node must be invalidated (deleted or marked stale) as part of this same job, closing the loop RFC 0017 explicitly deferred to this RFC.

## Implementation plan

1. Resolve RFC 0003's Open Question: add a `lastIndexedCommitSha` column directly to `ConnectedRepo`, updated on every `SUCCEEDED` job completion — a small, additive migration.
2. Implement a lightweight "get latest commit SHA" check (no full clone) as the very first step of the worker's job processing, before any of RFC 0005's cloning logic runs.
3. Implement the no-op-if-unchanged short-circuit.
4. Implement the diff-and-partition logic (added/modified/deleted) using `git diff --name-status` against a shallow, two-commit-aware clone (or, if simpler and still efficient enough, the existing full shallow clone with the diff computed locally afterward — to be decided at implementation time based on actual measured cost of each approach).
5. Route added/modified files through the existing RFC 0006–0008 pipeline stages, unmodified except for being given a smaller file list.
6. Implement the explicit deleted-file graph/embedding cleanup logic described above.
7. Wire in `InsightCache` invalidation for every touched node.
8. Manually verify: index a fixture repository fully once, make a small, deliberate change to exactly one file (modify a function's body, changing what it calls), re-index, and confirm — via direct Cypher/SQL inspection — that only that one file's graph nodes/embeddings were touched, with every other file's data byte-for-byte unchanged (e.g., unchanged `createdAt` timestamps on untouched rows).
9. Manually verify the deleted-file case: delete a file from the fixture repository, re-index, and confirm its corresponding graph nodes and embeddings are actually gone, not merely stale.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Diff-based incremental re-indexing** *(proposed)* | Dramatically reduces re-index cost/time proportional to how little actually changed; the correct long-term behavior for a product where users will realistically re-index the same repo repeatedly as they keep working on it | Meaningfully more implementation complexity than the existing full-reindex baseline, including new deletion-handling logic RFC 0007 never needed | **Proposed** |
| **Keep full re-indexing indefinitely, rely on RFC 0017's cache alone for cost savings** | No new pipeline complexity | Doesn't address the actual re-indexing cost itself, only reduces how often a *question* triggers new LLM work — a repository connected by an active team, being re-indexed frequently as code changes, would still pay full re-index cost every time regardless of how well question-caching works | Rejected — the two RFCs solve genuinely different costs and are complementary, not substitutes for each other |
| **Time-based partial re-indexing** (e.g., only re-index files modified in the last N days by file-system timestamp, without a real git diff) | Simpler than computing a genuine commit-to-commit diff | Fragile and imprecise — file modification timestamps don't reliably reflect actual content changes relevant to the graph, and this approach has no clean way to detect deletions at all | Rejected — a real git diff is a more precise, more reliable signal already directly available |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The deleted-file cleanup logic misses an edge case, leaving orphaned graph nodes or stale embeddings for files that no longer exist | Medium (a genuinely new code path RFC 0007's original design never had to handle) | Medium-high (silently incorrect graph/retrieval data, exactly the kind of subtle error this project's manual-checkpoint discipline exists to catch) | Explicit, mandatory manual verification of the deleted-file case (Implementation Plan step 9), not merely assumed to work because the added/modified path was tested |
| A renamed file (which git often reports distinctly from a pure add+delete) is handled incorrectly, either duplicating or losing its graph data | Medium | Medium | Worth explicitly testing as part of step 8/9's manual verification once implementation begins — flagged here as a specific edge case to not overlook, not yet resolved in this RFC's design |
| Incremental indexing introduces a subtle divergence from full-reindex behavior over many repeated incremental updates (a graph slowly "drifting" from what a full re-index would produce) | Low-medium, rising with the number of consecutive incremental updates without an intervening full re-index | Medium | Worth considering an occasional forced full re-index (e.g., every Nth incremental update, or on a periodic schedule) as a correctness safety net — flagged as an Open Question, not designed here |

## Security considerations

- No new security surface beyond what RFC 0005–0009 already established — this RFC changes *what subset* of a repository's files are processed, not any access-control or credential-handling logic.

## Performance considerations

- This RFC's entire purpose is a performance improvement — for a repository where a small fraction of files changed since the last index, total re-index time should scale with the size of the diff, not the size of the whole repository.
- The no-op short-circuit (identical commit, nothing to do) is the cheapest possible case and should complete in well under a second, a meaningful improvement over even attempting a full clone unconditionally as the current baseline does.

## Testing strategy

- The single-file-change manual verification (Implementation Plan step 8) is this stage's core checkpoint — confirming precisely that only the changed file's data was touched, nothing else.
- The deleted-file manual verification (step 9) is equally mandatory, given it's a genuinely new code path.
- Both should become fixture-based regression tests (RFC 0023) once stable, given they're deterministic and don't require an LLM to verify.

## Rollback plan

If incremental re-indexing proves unreliable (e.g., the deleted-file or rename-handling edge cases prove too fragile to trust), the rollback is straightforward given this RFC's diff step sits in front of, not intertwined with, RFC 0005–0009's existing full-pipeline logic: simply skip the diff step and always treat every re-index as a full re-index, exactly as the pre-RFC-0018 baseline behaved, with zero changes required to RFC 0005–0009 themselves.

## Migration / rollout

The `lastIndexedCommitSha` column addition to `ConnectedRepo` is additive. For repositories already indexed before this RFC ships, their first re-index after this change deploys will have no prior `lastIndexedCommitSha` recorded yet (if not backfilled) and should fall back to a full re-index for that one transition — worth stating explicitly as expected, one-time behavior, not a bug.

## Consequences

**Positive:** re-indexing cost scales with actual change size, not repository size — a substantial, ongoing efficiency win for any repository re-indexed repeatedly over its lifetime.

**Negative:** introduces genuinely new complexity (diffing, deletion handling, potential drift over many incremental updates) on top of an already-complex pipeline, with correctness risks RFC 0005–0009's original full-reindex-only design never had to consider.

## Success criteria

- Re-indexing a fixture repository after a single-file change touches only that file's graph nodes and embeddings, verified by direct inspection, with all other data byte-for-byte unchanged.
- Re-indexing after a file deletion correctly removes that file's graph data entirely, with no orphaned nodes remaining.

## Open questions

- Should an occasional forced full re-index run periodically as a drift-correction safety net, even when incremental updates are otherwise working correctly? Flagged, not designed here.
- How should file renames specifically be detected and handled, distinct from a plain add+delete? Not resolved in this RFC's current design — flagged as a specific case to test and potentially refine during implementation.

## Non-goals for this RFC

- Automatic, schedule-triggered re-indexing (as opposed to user-triggered) — not designed here; this RFC only makes re-indexing (however triggered) more efficient, it does not introduce a new triggering mechanism.
- Insight cache invalidation's own detailed design — that lives in RFC 0017; this RFC only specifies that touched nodes must be checked against it, not the cache's internal mechanics.

## References

- Report: "Step 18 — Incremental re-indexing," CodeCortex-Complete-Report.md.
- RFC 0003 (the `lastIndexedCommitSha` Open Question this RFC resolves), RFC 0005–0009.
- Git documentation: `git diff --name-status`.
