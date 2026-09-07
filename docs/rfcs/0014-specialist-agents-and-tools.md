# RFC 0014: Specialist agents + tool-calling

- **Status:** Proposed
- **Phase:** 3 (Step 14)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** new `backend/src/lib/agents/{explainer,bug-tracer,reviewer,refactorer}.ts`, new `backend/src/lib/agents/tools.ts`
- **Depends on:** RFC 0013 (routes to these), RFC 0007 (graph tools query), RFC 0008 (semantic search tool)

## Summary

RFC 0012's single, upfront-retrieval agent will be replaced by four specialized agents — Explainer, Bug-Tracer, Reviewer, Refactorer — each converted from "given a fixed context bundle" to genuine tool-calling: each specialist can request specific graph or search data on demand, iteratively, as its investigation of a question actually requires, rather than receiving one static bundle assembled upfront. This is planned as the single largest implementation effort in the project, and this RFC's design explicitly requires building and fully verifying one specialist (Explainer) before replicating the pattern to the other three.

## Terminology

- **Tool-calling:** an LLM interaction pattern where the model can, mid-response, request the calling application execute a specific function (a "tool") and return its result, which the model then incorporates into its continued reasoning — as opposed to receiving all context upfront in a single static prompt.
- **Tool-calling loop:** the iterative cycle of the model requesting a tool, the application executing it and returning the result, and the model deciding whether to call another tool or produce a final answer.
- **Iteration cap:** a hard limit on how many tool-calling round-trips a single specialist investigation may perform before being forced to produce a final answer (or fail), preventing runaway cost/latency from an agent that never "decides" it has enough information.

## Motivation

### The problem this RFC solves

RFC 0012's single agent (and RFC 0011's retrieval design underneath it) assembles a context bundle *upfront*, before the agent has had any chance to reason about what it actually needs. For simple questions this is fine. For genuinely investigative questions — "what breaks if I change this function," which may require following a chain of callers three or four levels deep, a depth impossible to predict correctly upfront — a fixed, pre-assembled bundle is either too shallow (missing what's actually needed) or wastefully broad (including irrelevant context "just in case"). Tool-calling solves this by letting each specialist request exactly what it needs, when it realizes it needs it, based on what it's already learned from previous tool calls in the same investigation.

### Why this is the largest implementation chunk in the project, and why one specialist first

Four specialists, each needing carefully designed prompts, tool sets, and iteration logic, is a large surface area to get right. This RFC's design deliberately sequences the work: build and fully, manually verify the Explainer specialist alone — including its tool-calling loop, its iteration cap behavior, and its answer quality against real questions — before writing the other three. The other three specialists share the same underlying tool-calling *mechanism*; what differs between them is their system prompt and which tools they're offered, not the loop's core logic. Verifying that mechanism once, thoroughly, before replicating it three more times is a direct application of this project's general "verify before building on top of" discipline, applied here at the level of one feature's internal structure rather than across pipeline stages.

## Background / Prior art

Tool-calling (also called function-calling) is a now-standard capability offered by major LLM providers specifically to support exactly this "let the model request specific external information on demand rather than requiring it all upfront" pattern — this RFC applies that standard capability to code-graph and code-search access specifically.

## Detailed design

### Planned tool set (shared across specialists, offered selectively per specialist)

| Tool | Backs onto | Purpose |
|---|---|---|
| `get_callers(functionName)` | Neo4j (RFC 0007) | List every function that calls the named function |
| `get_callees(functionName)` | Neo4j | List every function the named function calls |
| `get_file(path)` | Filesystem/stored source | Retrieve a specific file's full content |
| `search_semantic(query)` | pgvector (RFC 0008) | Run a fresh semantic search mid-investigation, for a sub-question the agent has formed |
| `get_class_hierarchy(className)` | Neo4j | Walk `INHERITS` relationships for a given class |

Each tool is a thin wrapper around already-existing, already-verified infrastructure (RFC 0007's graph, RFC 0008's embeddings) — this RFC does not introduce new data-access logic, only a new way of exposing existing, verified capabilities to an LLM's decision-making process.

### Planned specialist-to-tool mapping

- **Explainer** (build and verify first): `get_file`, `get_callees`, `search_semantic` — needs to understand what something does and what it relies on, not typically who calls it.
- **Bug-Tracer**: `get_callers`, `get_callees`, `get_file` — the caller-chain-tracing question this project's differentiation argument centers on most directly.
- **Reviewer**: `get_callers`, `get_file`, `get_class_hierarchy` — needs to understand what a proposed change might affect.
- **Refactorer**: `get_callees`, `get_class_hierarchy`, `search_semantic` — needs to understand a function's dependencies and find similar existing patterns elsewhere in the codebase.

### Planned tool-calling loop and iteration cap

Each specialist runs a loop: send the question (plus system prompt and available tools) to the LLM → if it requests a tool, execute it and feed the result back → repeat, up to a fixed iteration cap (planned: 6) → if the cap is reached without a final answer, the specialist must produce its best answer using whatever it has gathered so far, explicitly noting the investigation was cut short, rather than silently returning nothing or erroring.

## Implementation plan

1. Write the shared tool implementations in `backend/src/lib/agents/tools.ts`, each independently testable against the already-verified Neo4j/pgvector infrastructure with no LLM involved at all.
2. Build the Explainer specialist first: its system prompt, its tool subset, and the shared tool-calling loop (planned to live in a shared `runToolCallingAgent()` helper the other three specialists will also use, rather than each reimplementing the loop).
3. Manually verify the Explainer against several real "how does X work" questions on a real indexed repository, specifically checking: does it call tools sensibly (not excessively, not too sparsely), does it stop calling tools once it has enough information, and is its final answer accurate and grounded.
4. Only after step 3 passes, build Reviewer, Bug-Tracer, and Refactorer by reusing the same `runToolCallingAgent()` loop with their own prompts and tool subsets.
5. Manually verify each of the remaining three specialists against at least 2–3 representative questions of their respective type.
6. Wire the Planner's (RFC 0013) classification output to select and invoke the corresponding specialist.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Genuine tool-calling per specialist** *(proposed)* | Investigation depth adapts to what the question actually requires; avoids both under- and over-fetching context | Significantly more implementation complexity and more LLM round-trips per question than RFC 0012's upfront-bundle approach | **Proposed** |
| **Keep RFC 0011's upfront retrieval, just specialize the prompt per question type** | Much simpler; no tool-calling loop to build or debug | Cannot adapt investigation depth to the question — the exact limitation this RFC exists to remove | Rejected — doesn't achieve what specialization is meant to enable |
| **One shared specialist function parameterized by prompt/tools, rather than four separate files** | Less code duplication | Four genuinely different agents with different tool sets and behaviors benefit from being separately readable/editable files, matching this project's general preference for explicit, readable code over clever shared abstraction in exactly this kind of case | Rejected — a shared *loop* (`runToolCallingAgent()`) is reused, but each specialist's prompt/tool-selection lives in its own file for clarity |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A specialist enters an unproductive tool-calling loop, repeatedly calling tools without converging on an answer | Medium (a known general risk of agentic tool-calling systems) | Medium-high (cost, latency, poor UX) | The iteration cap is a hard, non-negotiable backstop; RFC 0020 (Phase 5) will add broader cost controls on top of this per-specialist cap |
| Tool implementations themselves are correct in isolation but the *combination* the LLM chooses is unhelpful (e.g., calling `get_callees` when `get_callers` was actually needed) | Medium | Medium | Caught during the mandatory manual verification per specialist — this is exactly the kind of judgment-quality issue that can only be assessed by inspecting real question/answer/tool-call-sequence examples, not by unit-testing the tools alone |
| Replicating the pattern to the remaining three specialists surfaces a flaw in the shared loop that wasn't visible with only the Explainer | Medium | Medium | This is precisely why the sequencing (Explainer first, fully verified, before the other three) is mandated — a flaw discovered at specialist two is still far cheaper to fix than one discovered after all four are built |

## Security considerations

- Every tool must independently enforce the same `connectedRepoId`/user-ownership scoping already required elsewhere (RFC 0011's note on this applies identically here) — a tool call must never be able to retrieve data belonging to a repository the current user hasn't connected.
- Tool results (code snippets, graph data) are fed back into the LLM conversation and may be sent to an external LLM provider multiple times per investigation (once per tool round-trip) — this compounds RFC 0012's already-noted data-exposure consideration and should be weighed together with it when the specific LLM provider is finalized.

## Performance considerations

- Each tool round-trip is a full LLM API call plus a database query — a multi-tool investigation for a single question could involve several seconds to tens of seconds of cumulative latency, directly motivating RFC 0016's planned streaming of intermediate progress rather than leaving the user staring at a blank loading state for the entire duration.
- The iteration cap (planned: 6) directly bounds worst-case latency and cost per question — this number is a starting point, not fixed permanently; it should be tuned based on real observed investigation lengths once specialists are in real use.

## Testing strategy

- Tool implementations themselves (deterministic wrappers around already-verified Neo4j/pgvector infrastructure) should get direct unit tests requiring no LLM — confirming, e.g., `get_callers("foo")` against a known fixture graph returns exactly the expected function names.
- The specialist-level manual verification described in Implementation Plan (steps 3 and 5) is the actual checkpoint for judgment-quality behavior, which cannot be reduced to a simple pass/fail unit test given the inherent variability of LLM tool-selection behavior.

## Rollback plan

If tool-calling specialists underperform badly relative to RFC 0012's simpler baseline, each specialist can independently fall back to a fixed-tool-budget mode (call a predetermined sequence of tools rather than letting the model choose) without discarding the shared loop infrastructure or the tool implementations themselves, which remain valid regardless of how they're invoked.

## Migration / rollout

None — new capability replacing RFC 0012's single agent as the system's actual responder, with RFC 0013's Planner now sitting in front of it.

## Consequences

**Positive:** investigation depth now genuinely adapts to question complexity, directly addressing RFC 0011/0012's shared upfront-context limitation.

**Negative:** meaningfully more implementation complexity, more LLM cost per question, and a new failure mode (unproductive tool-calling loops) that RFC 0012's simpler design didn't have.

## Success criteria

- The Explainer specialist, verified first, produces accurate, well-grounded answers to real "how does X work" questions, using a sensible (not excessive, not sparse) number of tool calls.
- All four specialists, once built, correctly receive and act on the Planner's routing decision.

## Open questions

- Should the iteration cap be uniform across all four specialists, or tuned per specialist type (e.g., Bug-Tracer might legitimately need more hops than Explainer)? Not decided — revisit once real usage data across all four specialists exists.

## Non-goals for this RFC

- Verifying the specialist's draft answer against the graph — that is RFC 0015's entire purpose, deliberately kept separate.
- Streaming intermediate tool-calling progress to the user — RFC 0016.

## References

- Report: "Step 14 — Specialist agents," CodeCortex-Complete-Report.md.
- RFC 0007, RFC 0008, RFC 0013.
