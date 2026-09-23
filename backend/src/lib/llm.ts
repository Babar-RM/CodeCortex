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
    } else {
      const errText = await response.text();
      console.warn(`[LLM] API call failed with status ${response.status}:`, errText);
    }
  } catch (err: unknown) {
    console.error("[LLM] Exception calling LLM API:", err);
  }

  return "";
}
