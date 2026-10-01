# RFC 0033 — Grounding LLM Answers Against the Code Graph (Hallucination Reduction)

**Status:** Proposed  
**Date:** 2026-10-01  
**Author:** Engineering  
**Scope:** Multi-agent pipeline, Critic agent, retrieval layer, agent tools

---

## Problem Statement

CodeCortex was asked "How does the ingestion pipeline work end to end?" about its own codebase. The answer contained the following **verifiably false claims**:

| Hallucination | Ground Truth |
|---|---|
| Stage order: Parse → Embed → Graph | Real order: Parse → **Graph → Embed** (`worker.ts` lines 136→149→165) |
| `enqueueJob()` function in `queue.ts` | No such function — `indexRepoQueue.add()` is called directly |
| Type names `ParsedFile`, `EmbeddingChunk` | Real types: `ExtractedFacts`, `ParseFilesResult` |
| `cleanupStaleData(repoId, latestCommit)` | Real: `cleanupDeletedFiles({ repoId, deletedFilePaths, modifiedFilePaths })` |
| Cleanup is the **last** stage | Cleanup runs **before** parse/graph/embed (prunes old data first) |
| "Notifies downstream services at completion" | Only sets `status: SUCCEEDED` in Postgres; frontend polls |
| Embedding via "OpenAI, Cohere" | Local `bge-small-en-v1.5` via `parser-service` — no external API |
| Missing: no-op short-circuit on same commitSha | Entirely absent from the answer |
| Missing: GitHub App installation token fetch | Entirely absent from the answer |

The answer was **structurally plausible** but factually wrong in 9 significant ways. This is the core failure mode the Critic agent is meant to prevent — but it can only verify what the graph actually contains.

---

## Root Cause Analysis

### Why the answer was wrong

The Groq LLM synthesized an answer from:
1. **Partial code snippets** retrieved via vector similarity — these gave the right "shape" but not the full detail
2. **Training priors** — the model's general knowledge of pipeline architectures filled in gaps with plausible-but-wrong details
3. **A sparse graph** — at the time of the query, the CodeCortex repo had just been re-indexed after a full DB wipe. The Neo4j graph may have been incomplete or the retrieval didn't surface the key `worker.ts` call chain

### Why the Critic didn't catch it

The Critic agent verifies claims by running Cypher queries against Neo4j. For it to catch "stage order is wrong", the graph must contain:
- `(:Function {name: "processIndexingJob"})` with `CALLS` edges in the right order
- Function call chains capturing `fetchRepo → parseFiles → buildGraph → generateEmbeddings`

If these nodes/edges are missing from the graph, the Critic has nothing to verify against and marks claims as `unverifiable` rather than `false`.

---

## Proposed Solutions

### Solution A — Enrich the graph with call-chain ordering (RECOMMENDED)

**What:** When `build-graph.ts` writes the Neo4j graph, attach a `callOrder` property to each `CALLS` edge so the Critic can verify "A is called before B in function F".

**How:**
- In `build-graph.ts`, parse the `calls` array from `ExtractedFacts` in the order they appear (they are already line-number ordered)
- Write `CALLS` edges with a `lineNumber` property (already captured) and a `callerFunction` property
- Add a Critic tool `verify_call_order(caller, calleeA, calleeB)` that runs:
  ```cypher
  MATCH (f:Function {name: $caller})-[a:CALLS]->(fa:Function {name: $calleeA})
  MATCH (f)-[b:CALLS]->(fb:Function {name: $calleeB})
  WHERE a.lineNumber < b.lineNumber
  RETURN count(*) > 0 AS inOrder
  ```

**Impact:** Catches "wrong stage order" hallucinations directly from the graph.

---

### Solution B — Source-anchored answer generation

**What:** Require the Explainer agent to cite the **exact file path + line number** for every structural claim it makes. The Critic then verifies that the cited location actually contains the claimed code.

**How:**
- Update the Explainer system prompt: "Every factual claim about code structure MUST be followed by `[file:line]` citing the exact source location."
- Add a Critic tool `verify_code_at_location(filePath, lineRange, claim)` that:
  1. Reads the actual file from the indexed code embeddings or workspace
  2. Checks if the claim is consistent with the actual code at that location
- If the citation is wrong or the claim doesn't match, the Critic flags it for revision.

**Impact:** Forces grounding at generation time, not just post-hoc verification. Harder to hallucinate when you must cite a source.

---

### Solution C — Function signature graph nodes

**What:** Index function **signatures** (name, parameters, return type) as first-class graph nodes rather than just embedding text. The Critic can then run exact-match queries.

**How:**
- Already partially implemented (`ExtractedFacts.functions[].params`) — extend `build-graph.ts` to write `params` as a node property
- Add a Critic tool `verify_function_signature(name, params, returnType)` 
- When the LLM claims "function X takes Y" — the Critic verifies against the graph

**Impact:** Catches parameter/return type hallucinations (e.g., the wrong `cleanupStaleData` signature above).

---

### Solution D — Incremental re-indexing trigger after DB wipe

**What:** After a `clear-all-db` operation, automatically re-queue every `ConnectedRepo` for re-indexing so the graph is never empty when users start asking questions.

**How:**
- Update `clear-all-db.ts` to enqueue an `index-repo` job for every repo after clearing
- Or add a `/api/admin/reindex-all` endpoint
- Ensure the graph is populated before users can ask chat questions (UI guard: show "Indexing…" if no embeddings exist for the repo)

**Impact:** The empty-graph problem that caused the hallucination above won't recur after a wipe.

---

## Recommended Implementation Order

| Priority | Solution | Effort | Impact |
|---|---|---|---|
| P0 — Do first | **D** (re-index after wipe) | Low | Ensures graph is populated |
| P1 — Core fix | **B** (source-anchored answers) | Medium | Prevents generation-time hallucination |
| P2 — Verification | **A** (call-chain ordering in graph) | Medium | Critic can catch order errors |
| P3 — Nice to have | **C** (function signature nodes) | Low | Critic catches signature errors |

---

## Acceptance Criteria

When this RFC is implemented, the same question ("How does the ingestion pipeline work end to end?") should:

1. Correctly state the stage order: `fetchRepo → parseFiles → buildGraph → generateEmbeddings`
2. Cite `worker.ts` line ranges for each stage call
3. Name `cleanupDeletedFiles` with the correct signature
4. Mention the no-op short-circuit on `commitSha` match
5. State that embeddings are local (`bge-small-en-v1.5` via `parser-service`)
6. NOT mention `enqueueJob`, `ParsedFile`, `EmbeddingChunk`, or "OpenAI/Cohere"

The Critic must reject any draft that contains the hallucinations listed in the Problem Statement table above.

---

## What Will NOT Be Fixed Here

- **General LLM knowledge contamination** — the model will always have training priors. The goal is not to eliminate them but to ensure the Critic catches when they contradict the actual graph.
- **Completely unindexed repos** — if a repo has never been indexed, answers will always be degraded. This is by design (Phase 0 requirement: "backend before frontend").
