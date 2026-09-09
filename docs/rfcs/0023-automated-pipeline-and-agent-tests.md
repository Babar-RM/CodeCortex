# RFC 0023: Automated pipeline and agent tests

- **Status:** Proposed
- **Phase:** 5 (Step 23)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** `backend/src/__tests__/`, `parser-service/tests/`, new fixture repositories checked into the project
- **Depends on:** effectively all prior RFCs — this RFC formalizes testing gaps each of RFC 0005–0009 and RFC 0011–0019 individually flagged and deferred

## Summary

This RFC consolidates and formally implements the automated-testing work that RFC 0005 through RFC 0019 each individually named as a deferred gap: deterministic, fixture-based end-to-end pipeline tests (covering the full clone-parse-graph-embed sequence against small, checked-in fixture repositories, run against local Postgres/Neo4j/Redis rather than live GitHub access), and a strategy for testing LLM-dependent agent behavior (RFC 0011–0019) despite its inherent non-determinism, via mocked or recorded model responses rather than live, costly, non-reproducible API calls in CI.

## Terminology

- **Fixture repository:** a small, deterministic, checked-into-the-project Git repository (or a static snapshot of one) used as test input, so pipeline tests don't depend on live, potentially-changing external repositories.
- **Recorded/mocked LLM response:** a fixed, previously-captured LLM response substituted for a live API call during testing, making an otherwise non-deterministic, costly external dependency reproducible and free to run repeatedly in CI.
- **Regression test:** a test asserting that previously-verified-correct behavior (established via this project's many manual checkpoints throughout Phases 1–4) continues to hold after future changes, specifically to catch a change that silently breaks something that used to work.

## Motivation

### The problem this RFC solves

This project's own build discipline — manual, hand-verified checkpoints at nearly every RFC (Step 6's caller-attribution check, Step 7's Cypher verification, Step 8's retrieval-quality check, RFC 0011's hardcoded-question verification, RFC 0015's injected-false-claim test, and more) — has been the right call for building correctly and carefully the first time. But every one of those manual checks, by design, only proves correctness *at the moment it was performed*. None of them, on their own, protect against a *future* change silently regressing something that already worked. This RFC exists specifically to convert this project's substantial accumulated manual-verification knowledge into automated regression tests, so future work can move faster without repeatedly re-proving things that were already correct.

### Why this is consolidated into one RFC rather than left scattered

RFC 0005 through RFC 0019 each, individually, flagged their own specific testing gap and deferred it — a reasonable choice at each individual point, given building the underlying capability correctly the first time was the higher priority. But left permanently scattered and deferred, none of those gaps would ever actually get closed by any single RFC's own scope. This RFC exists specifically to be the place where all of those deferred commitments are honored together, treating "add the tests we said we'd add" as a real, first-class piece of work in its own right — not an afterthought.

## Background / Prior art

Testing LLM-dependent systems via recorded/mocked model responses (rather than live API calls) is standard practice specifically because live LLM calls in CI are slow, costly, and non-deterministic — none of which are acceptable properties for a test suite meant to run frequently and reliably. This RFC applies that standard approach to this project's own agent pipeline, while treating the fully deterministic parts of the system (Steps 5–9's ingestion pipeline) with ordinary, non-mocked fixture-based testing, since nothing about that part of the system requires the same accommodation.

## Detailed design

### Planned fixture repository

A single small, deliberately-constructed fixture repository (a handful of JS/TS files with known, hand-verified functions, calls, classes, and imports — deliberately including the specific patterns this project's own manual testing already found tricky, such as a class method calling a standalone function, per RFC 0006's own documented caller-attribution investigation) will be checked directly into this project's own repository (e.g., under `backend/src/__tests__/fixtures/sample-repo/`), giving every automated test a stable, versioned, non-externally-dependent input.

### Planned deterministic pipeline test (the single highest-value test named across RFC 0005–0009)

One end-to-end test running the fixture repository through Steps 5–9 (RFC 0005–0009) against local test instances of Postgres, Neo4j, and Redis (via `docker-compose`'s existing local services, pointed at by test-specific configuration), asserting on:
- Specific expected Cypher query results against the resulting graph (the same kind of "callers of X" check RFC 0007's manual verification performed by hand, now automated).
- Specific expected rows in `code_embeddings` (row count, and — since embedding vectors themselves aren't practical to assert on exactly — at least a known-relevant semantic search returning an expected result, mirroring RFC 0008's manual retrieval-quality check).
- Correct `IndexingJob` status transitions and a correct final `commitSha`.

### Planned parser-service unit tests

Direct, fast, dependency-free pytest tests against `extract_facts()` (RFC 0006), covering the specific hand-verified cases from that RFC's own manual testing — a simple function-to-function call, a class method calling a standalone function (the specific caller-attribution case RFC 0006's own investigation found and fixed), an arrow function assigned via `const`, and import statements with various specifier forms.

### Planned agent-behavior testing strategy

Given LLM outputs are inherently non-deterministic and costly to call repeatedly, this RFC adopts a deliberately layered testing strategy rather than one uniform approach:
- **Deterministic sub-components** of the agent pipeline (RFC 0014's tool implementations themselves, RFC 0015's Cypher-based claim-verification logic) get ordinary, non-mocked unit tests against the fixture repository's known graph — these require no LLM call at all and can be tested with full rigor.
- **LLM-call-dependent behavior** (does the Planner classify correctly, does a specialist choose sensible tools, does the Critic's claim extraction work) is tested via a small, curated set of recorded real LLM responses (captured once, during this RFC's implementation, from the manual verification sessions RFC 0013–0015 already performed) substituted for live calls in CI — this makes these tests deterministic and free to run repeatedly, at the cost of not testing the live model's *current* behavior on every run (a real, accepted limitation, not a hidden one).
- **Retrieval-quality and end-to-end answer-quality checks** (RFC 0011's "is this context actually relevant" and RFC 0012's "is this answer actually grounded" judgments) remain primarily manual, ongoing spot-checks rather than fully automated — this RFC is explicit that judgment-quality assessment of genuinely novel LLM outputs is not a problem full automation solves cleanly, and doesn't pretend otherwise.

## Implementation plan

1. Construct and check in the fixture repository, deliberately including the specific tricky patterns named above.
2. Write the parser-service pytest suite against `extract_facts()`, covering the cases named in Detailed Design.
3. Write the end-to-end pipeline test, running against `docker-compose`'s local Postgres/Neo4j/Redis, asserting on the specific graph/embedding/job-status outcomes named above.
4. Capture a small set of recorded LLM responses from real manual-verification sessions (RFC 0013's classification examples, RFC 0015's injected-false-claim test) and build a lightweight mock/replay mechanism substituting them for live calls in the corresponding automated tests.
5. Write unit tests for RFC 0014's tool implementations and RFC 0015's claim-verification logic directly against the fixture repository's known graph, with no LLM involved.
6. Add all of the above to the relevant CI jobs (`ci.yml`), including a first CI job for `parser-service/` (a gap named as open since RFC 0006's own writing) and — if not already present — a job capable of standing up the `docker-compose` services needed for the end-to-end pipeline test.
7. Manually confirm the full CI suite runs to completion in a reasonable time and reliably passes on an unmodified, known-good state of the codebase (a basic sanity check that this RFC's own additions are themselves correct, not just present).

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Fixture-based deterministic tests plus recorded-LLM-response tests for agent behavior, judgment-quality checks remain manual** *(proposed)* | Automates everything that can be automated reliably; honestly acknowledges the genuine limitations of LLM testing without pretending live LLM calls in CI are a viable answer | Does not automatically catch a scenario where a live LLM model update causes a subtle quality regression on novel questions | **Proposed** |
| **Run live LLM calls in CI for agent tests** | Tests against the real live model on every CI run | Slow, expensive, non-deterministic (flaky CI runs when the model output varies slightly), and leaks repo/test content to external APIs on every PR build | Rejected — unsuitable for a fast, reliable CI suite |
| **No automated pipeline/agent testing; rely indefinitely on manual checkpoints** | Zero implementation work | Every future change risks silently regressing previously-verified behavior; manual testing overhead grows continuously as the system expands | Rejected — unmaintainable long-term |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Mocked/recorded LLM responses drift from how a live model actually responds after a model update, creating false confidence from passing tests | Medium over long time horizons | Medium | Recorded responses should be re-captured periodically (or when upgrading underlying model versions) to keep them representative |
| End-to-end pipeline tests running against real Postgres/Neo4j/Redis containers are flaky or slow in CI | Low-medium | Medium (flaky CI frustrates developers and leads to ignored test results) | Keep the fixture repository very small (handful of files, <100 lines total) so pipeline execution completes in seconds |

## Security considerations

- Fixture repositories must contain only synthetic, dummy test code — never real proprietary code or credentials.
- Recorded LLM responses in test files must be scrubbed of any real API keys or sensitive session data before being checked into source control.

## Performance considerations

- Keeping the fixture repository minimal ensures the automated test suite executes in seconds, maintaining fast developer feedback loops.

## Testing strategy

- The successful execution of the full CI suite (`ci.yml`) including `parser-service` pytest and pipeline fixture tests is this stage's checkpoint.

## Rollback plan

If a specific automated test proves excessively flaky, it can be quarantined or disabled temporarily while keeping the underlying implementation unchanged.

## Consequences

**Positive:** establishes a comprehensive, automated safety net preventing regressions in both ingestion pipeline mechanics and agent verification logic.

**Negative:** adds ongoing maintenance effort to keep fixture repositories and recorded LLM responses updated alongside future pipeline/model changes.

## Success criteria

- `ci.yml` passes cleanly with 100% automated coverage of parser-service facts extraction, end-to-end ingestion pipeline execution, and mocked agent verification loops.
