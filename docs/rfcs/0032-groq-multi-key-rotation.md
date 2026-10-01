# RFC 0032 — Groq Multi-Key Rotation on Rate-Limit

**Status:** Implemented  
**Date:** 2026-10-01  
**Author:** Engineering  
**Scope:** `backend/src/lib/llm.ts`, `backend/.env`, `backend/.env.example`

---

## Problem

CodeCortex uses Groq's free-tier inference API (`llama-3.3-70b-versatile` / `openai/gpt-oss-120b`) for all LLM completions. Groq free-tier accounts have per-minute and per-day token limits. Under moderate usage (multiple simultaneous chat sessions or repeated re-indexing), the primary key hits a 429 and the agent returns an empty string — degrading every answer to pure vector-search RAG with no LLM synthesis.

The previous implementation handled 429 with an exponential backoff loop on the **same key**, which meant the user waited up to 60+ seconds before getting a degraded result or the worker re-enqueued endlessly.

---

## Decision

Maintain a **module-level key pool** — an ordered list of `KeySlot` objects, each holding:
- The raw API key string
- A `cooldownUntil` epoch timestamp (initially 0 = "available")

On every LLM call:
1. **Pick the first available** (non-cooled-down) key
2. On **429** — parse Groq's `"Please try again in Xs"` hint from the body, mark that slot as cooled-down for that window, and **immediately rotate** to the next available key — no wasted sleep
3. If **all keys are cooled-down** — sleep until the earliest cooldown expires, then retry
4. Fall back to empty string (RAG-only) only when all attempts across all keys are exhausted

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | Yes | Primary key — always tried first |
| `GROQ_API_KEY_2` | Recommended | Secondary key — activated on primary 429 |
| `GROQ_API_KEY_3` … | Optional | Additional rotation slots (auto-discovered) |
| `GROQ_MODEL` | Yes | Model name (e.g. `llama-3.3-70b-versatile`) |

The pool is built at **process startup** — adding a new `GROQ_API_KEY_N` requires a worker restart. Cooldown state is **in-memory only** and resets on restart.

---

## Key Invariants

- **No key is ever shared between processes** — each worker process maintains its own pool. This is acceptable because the goal is reducing per-process 429s, not coordinating across a fleet.
- **Cooldown is pessimistic** — we always add +1.5 s to Groq's stated retry window to account for clock drift.
- **400 errors are non-retryable** — bad requests are returned immediately without consuming rotation budget.
- **401/403 are non-retryable** — invalid/revoked keys are logged and the call returns empty immediately.

---

## Logging

All key rotation events are logged at `warn` level with key index (never key value):

```
[LLM] Key 1 rate-limited (429). Cooling down for 12s. Rotating to next key...
[LLM] Invoking Groq API (key 2/2) with model 'llama-3.3-70b-versatile' (attempt 2)...
[LLM] Received completion from Groq (key 2/2) (llama-3.3-70b-versatile)
```

---

## UX Impact

| Before | After |
|---|---|
| Primary key 429 → 40–60s backoff → degraded RAG answer | Primary key 429 → instant rotate to key 2 → full LLM answer |
| User sees slow response with "I couldn't verify this" | User gets a normal response at near-identical latency |
| Single point of rate-limit failure | Two independent rate-limit budgets |

---

## Tradeoffs

- **In-memory cooldown** — if the worker crashes and restarts during a key's cooldown window, it will retry that key immediately. Groq will 429 it again and the cooldown will be re-applied. This is acceptable.
- **Ordered pool** — key 1 is always preferred. Key 2 is never used unless key 1 is cooled-down. This means key 1 will always exhaust its daily token budget first. This is intentional — it keeps the pool's "primary" semantics clear.
- **No cross-process coordination** — if the API server and worker both use key 1 simultaneously, they could both hit 429 independently and both rotate. This is fine for the current single-machine dev deployment. A future RFC could coordinate via Redis if needed.
