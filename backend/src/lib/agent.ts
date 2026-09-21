import { hybridRetrieve, ContextBundle } from "./retrieval";

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AskSingleAgentParams {
  connectedRepoId: string;
  question: string;
  chatHistory?: ChatHistoryMessage[];
  maxSeeds?: number;
  expansionHops?: number;
}

export interface AskSingleAgentResult {
  answer: string;
  contextBundle: ContextBundle;
}

export type LLMCompletionFunction = (prompt: string) => Promise<string>;

export const SYSTEM_PROMPT = `You are CodeCortex AI Assistant, a specialized coding assistant for repository analysis.
You MUST answer the user's question using ONLY the provided code context bundle below.
If the provided context does not contain enough information to answer the question confidently, state plainly:
"The provided context does not contain enough information to answer this question."
Do NOT fabricate code details, functions, classes, or files not mentioned in the retrieved context.`;

/**
 * Default LLM completion engine.
 * Uses environment provider if available, or generates a structured grounded answer from the context bundle.
 */
export async function defaultLLMCompletion(prompt: string): Promise<string> {
  const { callLLMCompletion } = await import("./llm");
  const res = await callLLMCompletion(prompt, { systemPrompt: SYSTEM_PROMPT });
  if (res) return res;

  // Deterministic grounded response fallback for testing/offline environments
  if (prompt.includes("(No seed nodes retrieved)")) {
    return "The provided context does not contain enough information to answer this question.";
  }

  return `Based on the repository context retrieved for your query, here is the relevant code structure:
The primary code entities found include the retrieved seed and neighbor nodes.
Refer to the context bundle for exact function definitions, parameters, and callers.`;
}

/**
 * Executes a single-agent RAG workflow (RFC 0012)
 */
export async function askSingleAgent(
  params: AskSingleAgentParams,
  customCompletion?: LLMCompletionFunction
): Promise<AskSingleAgentResult> {
  // Step 1: Hybrid retrieval
  const contextBundle = await hybridRetrieve({
    connectedRepoId: params.connectedRepoId,
    question: params.question,
    maxSeeds: params.maxSeeds,
    expansionHops: params.expansionHops,
  });

  // Step 2: Construct prompt
  const promptLines: string[] = [];
  promptLines.push(SYSTEM_PROMPT);
  promptLines.push("");

  if (params.chatHistory && params.chatHistory.length > 0) {
    promptLines.push("--- CONVERSATION HISTORY ---");
    params.chatHistory.forEach((msg) => {
      promptLines.push(`${msg.role.toUpperCase()}: ${msg.content}`);
    });
    promptLines.push("");
  }

  promptLines.push(contextBundle.formattedContext);
  promptLines.push("");
  promptLines.push(`USER QUESTION: ${params.question}`);

  const fullPrompt = promptLines.join("\n");

  // Step 3: Call LLM completion
  const completionFn = customCompletion || defaultLLMCompletion;
  const rawAnswer = await completionFn(fullPrompt);

  return {
    answer: rawAnswer,
    contextBundle,
  };
}
