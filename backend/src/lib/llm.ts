import dotenv from "dotenv";
dotenv.config();

export interface LLMCompletionOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
}

// ---------------------------------------------------------------------------
// RFC 0032 — Multi-key Groq API rotation
// ---------------------------------------------------------------------------
// We maintain an ordered list of Groq API keys.  Each key carries its own
// per-key "cooldown" timestamp: when a 429 is received and the Groq
// retry-after header (or body hint) says it will be a while, we mark that
// key as cooled-down until that time and immediately rotate to the next one.
// The scheduler re-enables a key automatically once its cooldown expires.
// ---------------------------------------------------------------------------

interface KeySlot {
  key: string;
  cooldownUntil: number; // epoch ms — 0 means "available now"
}

function buildKeyPool(): KeySlot[] {
  const keys: string[] = [];

  // Primary key
  if (process.env.GROQ_API_KEY) keys.push(process.env.GROQ_API_KEY.trim());
  // Secondary key (RFC 0032)
  if (process.env.GROQ_API_KEY_2) keys.push(process.env.GROQ_API_KEY_2.trim());
  // Allow arbitrary numbered extras: GROQ_API_KEY_3, _4 …
  let n = 3;
  while (process.env[`GROQ_API_KEY_${n}`]) {
    keys.push(process.env[`GROQ_API_KEY_${n}`]!.trim());
    n++;
  }

  return keys.filter(Boolean).map((k) => ({ key: k, cooldownUntil: 0 }));
}

// Module-level pool — lives for the process lifetime.
// Mutated in-place so cooldown state persists across requests.
const groqKeyPool: KeySlot[] = buildKeyPool();

/** Returns the index of the first available (non-cooled-down) key, or -1. */
function pickAvailableKey(): number {
  const now = Date.now();
  for (let i = 0; i < groqKeyPool.length; i++) {
    if (groqKeyPool[i].cooldownUntil <= now) return i;
  }
  return -1;
}

/** Returns the earliest cooldown expiry across all keys (for logging). */
function earliestCooldownMs(): number {
  return Math.max(0, Math.min(...groqKeyPool.map((s) => s.cooldownUntil)) - Date.now());
}

/**
 * Parse Groq's "retry after" hint from a 429 response.
 * Groq embeds "Please try again in Xs" in the JSON body.
 * Returns milliseconds to wait (minimum 3 s, capped at 120 s).
 */
async function parseRetryAfterMs(response: Response): Promise<number> {
  const DEFAULT_MS = 5_000;
  try {
    const text = await response.text();
    const match = text.match(/Please try again in ([0-9.]+)s/i);
    if (match?.[1]) {
      const sec = parseFloat(match[1]);
      if (!isNaN(sec) && sec > 0) {
        return Math.min(Math.ceil(sec * 1000) + 1500, 120_000);
      }
    }
  } catch {
    // ignore parse errors
  }
  return DEFAULT_MS;
}

/**
 * Unified LLM completion utility — RFC 0032: multi-key Groq rotation.
 *
 * Strategy:
 *   1. Pick first available (non-cooled-down) key.
 *   2. On 429: mark that key cooled-down for the retry-after window, then
 *      immediately try the next available key — no sleep wasted.
 *   3. If ALL keys are cooled-down: sleep until the earliest one recovers,
 *      then retry from the top.
 *   4. Falls back to empty string (RAG-only) if no keys are configured or
 *      all retries are exhausted.
 */
export async function callLLMCompletion(
  prompt: string,
  options: LLMCompletionOptions = {}
): Promise<string> {
  // Short-circuit network calls during unit test runs
  if (process.env.NODE_ENV === "test" && !process.env.TEST_ENABLE_REAL_LLM) {
    return "";
  }

  if (groqKeyPool.length === 0) {
    console.warn(
      "[LLM] Warning: No GROQ_API_KEY configured in backend/.env. Falling back to vector-search RAG."
    );
    return "";
  }

  const apiUrl = "https://api.groq.com/openai/v1/chat/completions";
  const model =
    options.model ||
    process.env.GROQ_MODEL ||
    "llama-3.3-70b-versatile";

  const messages: { role: string; content: string }[] = [];
  if (options.systemPrompt) {
    messages.push({ role: "system", content: options.systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  const MAX_GLOBAL_ATTEMPTS = groqKeyPool.length * 3; // each key gets ≤3 attempts

  for (let attempt = 0; attempt < MAX_GLOBAL_ATTEMPTS; attempt++) {
    const keyIdx = pickAvailableKey();

    if (keyIdx === -1) {
      // All keys rate-limited — sleep until the earliest recovery
      const waitMs = earliestCooldownMs() + 500;
      console.warn(
        `[LLM] All ${groqKeyPool.length} Groq key(s) are rate-limited. Sleeping ${Math.round(waitMs / 1000)}s until earliest recovery...`
      );
      await new Promise((r) => setTimeout(r, waitMs));
      continue; // re-evaluate after sleep
    }

    const slot = groqKeyPool[keyIdx];
    const keyLabel = groqKeyPool.length > 1 ? ` (key ${keyIdx + 1}/${groqKeyPool.length})` : "";
    console.log(`[LLM] Invoking Groq API${keyLabel} with model '${model}' (attempt ${attempt + 1})...`);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${slot.key}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.2,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          choices?: { message?: { content?: string; reasoning?: string } }[];
        };
        const msg = data.choices?.[0]?.message;
        const resultText = (msg?.content || msg?.reasoning || "").trim();
        if (resultText) {
          console.log(`[LLM] Received completion from Groq${keyLabel} (${model})`);
        }
        return resultText;
      }

      if (response.status === 429) {
        const retryMs = await parseRetryAfterMs(response);
        console.warn(
          `[LLM] Key ${keyIdx + 1} rate-limited (429). Cooling down for ${Math.round(retryMs / 1000)}s. Rotating to next key...`
        );
        slot.cooldownUntil = Date.now() + retryMs;
        // Don't sleep — immediately loop and try next available key
        continue;
      }

      if (response.status === 400) {
        try {
          const errData = (await response.json()) as {
            error?: { message?: string; failed_generation?: string };
          };
          if (errData.error?.failed_generation) {
            const fg = errData.error.failed_generation;
            try {
              const parsed = JSON.parse(fg) as {
                name?: string;
                arguments?: Record<string, unknown>;
              };
              const toolName = (parsed.name || "").replace(/^repo_browser\./, "");
              const argsStr = JSON.stringify(parsed.arguments || {});
              if (toolName) {
                console.log(
                  `[LLM] Recovered tool call from Groq failed_generation: TOOL: ${toolName}(${argsStr})`
                );
                return `TOOL: ${toolName}(${argsStr})`;
              }
            } catch {
              return fg;
            }
          }
          console.warn(`[LLM] API call failed with status 400:`, JSON.stringify(errData));
        } catch {
          const errText = await response.text();
          console.warn(`[LLM] API call failed with status 400:`, errText);
        }
        return ""; // 400 is non-retryable
      }

      // Other non-retryable errors (401, 403, 500 etc.)
      const errText = await response.text();
      console.warn(`[LLM] API call failed with status ${response.status}:`, errText);
      return "";
    } catch (err: unknown) {
      console.error(
        `[LLM] Network exception calling Groq${keyLabel} (attempt ${attempt + 1}/${MAX_GLOBAL_ATTEMPTS}):`,
        err
      );
      // Brief backoff before retrying
      if (attempt + 1 < MAX_GLOBAL_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  console.error(`[LLM] All ${MAX_GLOBAL_ATTEMPTS} attempts exhausted. Falling back to RAG-only answer.`);
  return "";
}
