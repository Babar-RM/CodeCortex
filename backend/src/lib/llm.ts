import dotenv from "dotenv";
dotenv.config();

export interface LLMCompletionOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
}

/**
 * Unified LLM completion utility supporting Groq, OpenAI, Anthropic, or custom endpoints.
 * Prioritizes GROQ_API_KEY (free fast inference with LLaMA 3.3 70B / 8B), OPENAI_API_KEY, or LLM_API_KEY.
 */
export async function callLLMCompletion(
  prompt: string,
  options: LLMCompletionOptions = {}
): Promise<string> {
  // Short-circuit network calls during unit test runs to ensure fast, deterministic offline execution
  if (process.env.NODE_ENV === "test" && !process.env.TEST_ENABLE_REAL_LLM) {
    return "";
  }

  const apiKey =
    process.env.GROQ_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.LLM_API_KEY;

  if (!apiKey) {
    console.warn("[LLM] Warning: No GROQ_API_KEY or OPENAI_API_KEY set in backend/.env. Falling back to vector search RAG.");
    return "";
  }

  const isGroq = Boolean(process.env.GROQ_API_KEY);
  const apiUrl =
    process.env.LLM_API_URL ||
    (isGroq
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://api.openai.com/v1/chat/completions");

  const model =
    options.model ||
    process.env.GROQ_MODEL ||
    process.env.LLM_MODEL ||
    (isGroq ? "openai/gpt-oss-120b" : "gpt-3.5-turbo");

  const messages: { role: string; content: string }[] = [];
  if (options.systemPrompt) {
    messages.push({ role: "system", content: options.systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  console.log(`[LLM] Invoking ${isGroq ? "Groq API" : "LLM API"} using model: '${model}'...`);

  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.2,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as { choices?: { message?: { content?: string; reasoning?: string } }[] };
        const msg = data.choices?.[0]?.message;
        const resultText = (msg?.content || msg?.reasoning || "").trim();
        if (resultText) {
          console.log(`[LLM] Received completion from ${isGroq ? "Groq" : "LLM"} (${model})`);
        }
        return resultText;
      } else if (response.status === 429 && attempt < maxRetries) {
        const errText = await response.text();
        const match = errText.match(/Please try again in ([0-9.]+)s/i);
        let delayMs = 4000 * attempt;
        if (match && match[1]) {
          const waitSec = parseFloat(match[1]);
          if (!isNaN(waitSec)) {
            delayMs = Math.ceil(waitSec * 1000) + 1500;
          }
        }
        console.warn(`[LLM] Rate limited (429), retrying attempt ${attempt}/${maxRetries} in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      } else if (response.status === 400) {
        try {
          const errData = (await response.json()) as { error?: { message?: string; failed_generation?: string } };
          if (errData.error?.failed_generation) {
            const fg = errData.error.failed_generation;
            try {
              const parsed = JSON.parse(fg) as { name?: string; arguments?: Record<string, unknown> };
              const toolName = (parsed.name || "").replace(/^repo_browser\./, "");
              const argsStr = JSON.stringify(parsed.arguments || {});
              if (toolName) {
                console.log(`[LLM] Recovered tool call from Groq failed_generation: TOOL: ${toolName}(${argsStr})`);
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
        break;
      } else {
        const errText = await response.text();
        console.warn(`[LLM] API call failed with status ${response.status}:`, errText);
        break;
      }
    } catch (err: unknown) {
      console.error(`[LLM] Exception calling LLM API (attempt ${attempt}/${maxRetries}):`, err);
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        continue;
      }
      break;
    }
  }

  return "";
}
