export type QuestionType = "explain" | "bug_trace" | "review" | "refactor";

export interface PlanQuestionParams {
  question: string;
  connectedRepoId: string;
  customLlmCompletion?: (prompt: string) => Promise<string>;
}

export interface PlannerResult {
  type: QuestionType;
  reasoning: string;
}

export const PLANNER_SYSTEM_PROMPT = `You are CodeCortex Planner Agent, responsible for classifying natural-language software engineering questions into exactly one of four categories:

CATEGORIES:
1. "explain": Questions asking how code works, module overviews, or architectural explanations.
   Examples: "How does authentication work?", "Explain the user ingestion pipeline.", "What is the purpose of this file?"

2. "bug_trace": Questions asking about call chains, caller dependencies, impact analysis, or tracing bugs/errors.
   Examples: "What functions call verifyJwt?", "What breaks if I change processOrder?", "Trace callers of handleAuth."

3. "review": Questions asking to review code, audit security, identify code smells, or review proposed changes.
   Examples: "Review this function for security vulnerabilities.", "Audit the session management code."

4. "refactor": Questions asking to refactor, optimize, restructure, or apply design patterns to existing code.
   Examples: "How can I refactor this large function?", "Suggest performance optimizations for this database query."

FALLBACK RULE:
If a question is ambiguous, broad, or spans multiple categories, classify it as "explain".

RESPONSE FORMAT:
You MUST respond with a valid JSON object strictly matching this schema:
{
  "type": "explain" | "bug_trace" | "review" | "refactor",
  "reasoning": "A concise single-sentence justification for the classification."
}`;

/**
 * Heuristic fallback classifier for testing/offline environments when no remote LLM response is present
 */
export function classifyHeuristically(question: string): PlannerResult {
  const lower = question.toLowerCase();

  // Bug trace / caller chain / impact analysis patterns
  if (
    lower.includes("call") ||
    lower.includes("caller") ||
    lower.includes("callee") ||
    lower.includes("break") ||
    lower.includes("impact") ||
    lower.includes("trace") ||
    lower.includes("depend")
  ) {
    return {
      type: "bug_trace",
      reasoning: "Question asks for caller dependency tracing, call structure, or impact analysis.",
    };
  }

  // Code review / audit / security patterns
  if (
    lower.includes("review") ||
    lower.includes("audit") ||
    lower.includes("vulnerab") ||
    lower.includes("smell") ||
    lower.includes("security") ||
    lower.includes("quality")
  ) {
    return {
      type: "review",
      reasoning: "Question asks for code review, security auditing, or quality assessment.",
    };
  }

  // Refactor / optimization / restructuring patterns
  if (
    lower.includes("refactor") ||
    lower.includes("optimi") ||
    lower.includes("restructur") ||
    lower.includes("simplif") ||
    lower.includes("clean up") ||
    lower.includes("pattern")
  ) {
    return {
      type: "refactor",
      reasoning: "Question asks for code refactoring, structural cleanup, or performance optimization.",
    };
  }

  // Fallback to "explain" per RFC 0013 spec
  return {
    type: "explain",
    reasoning: "Question is general or explanatory; defaulting to 'explain' category.",
  };
}

/**
 * Classifies a user question using one LLM call (or heuristic fallback) (RFC 0013)
 */
export async function planQuestion(params: PlanQuestionParams): Promise<PlannerResult> {
  const { question, customLlmCompletion } = params;

  if (!question || question.trim().length === 0) {
    return {
      type: "explain",
      reasoning: "Empty question provided; defaulting to 'explain'.",
    };
  }

  // If a custom LLM provider is passed, invoke it
  if (customLlmCompletion) {
    try {
      const rawOutput = await customLlmCompletion(
        `${PLANNER_SYSTEM_PROMPT}\n\nUSER QUESTION: "${question}"`
      );

      // Attempt JSON parsing
      const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { type?: string; reasoning?: string };
        const validTypes: QuestionType[] = ["explain", "bug_trace", "review", "refactor"];
        if (parsed.type && validTypes.includes(parsed.type as QuestionType)) {
          return {
            type: parsed.type as QuestionType,
            reasoning: parsed.reasoning || `Classified as ${parsed.type}.`,
          };
        }
      }
    } catch {
      // Fall through to heuristic classification on parsing error
    }
  }

  // Check remote API key availability
  const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY;
  if (apiKey && !customLlmCompletion) {
    try {
      const response = await fetch(process.env.LLM_API_URL || "https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: process.env.LLM_MODEL || "gpt-3.5-turbo",
          messages: [
            { role: "system", content: PLANNER_SYSTEM_PROMPT },
            { role: "user", content: `USER QUESTION: "${question}"` },
          ],
          temperature: 0.0,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]) as { type?: string; reasoning?: string };
            const validTypes: QuestionType[] = ["explain", "bug_trace", "review", "refactor"];
            if (parsed.type && validTypes.includes(parsed.type as QuestionType)) {
              return {
                type: parsed.type as QuestionType,
                reasoning: parsed.reasoning || `Classified as ${parsed.type}.`,
              };
            }
          }
        }
      }
    } catch {
      // Fall through to heuristic classification
    }
  }

  // Fallback to heuristic classification for offline/test environments
  return classifyHeuristically(question);
}
