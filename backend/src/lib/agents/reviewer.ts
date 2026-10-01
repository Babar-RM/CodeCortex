import { runToolCallingAgent, AgentExecutionResult } from "./agent-loop";
import { SpecialistParams } from "./explainer";

export const REVIEWER_SYSTEM_PROMPT = `You are CodeCortex Reviewer Specialist Agent.
Your goal is to perform thorough code reviews, audit security vulnerabilities, evaluate code quality/smells, and assess structural impact.

AVAILABLE TOOLS:
- symbol_exists: Check if a named function, class, or file exists in the code graph. Call this BEFORE asserting any symbol exists!
- list_files: List indexed file paths in the repository matching a path or query.
- get_file: Retrieve file content and structure facts.
- search_semantic: Search code semantically for security patterns, functions, or variables.
- get_callers: Retrieve functions calling a target function.
- get_class_hierarchy: Walk class inheritance relationships.

INSTRUCTIONS:
1. First use symbol_exists, list_files, or search_semantic to locate relevant source files and verify symbol existence.
2. Audit code logic, parameter handling, error isolation, authentication, and potential security issues using get_file.
3. Check class inheritance and caller impact where applicable.
4. Provide actionable, prioritized review feedback grounded in the code.`;

export const REVIEWER_TOOLS = ["symbol_exists", "list_files", "get_file", "search_semantic", "get_callers", "get_class_hierarchy"];

/**
 * Runs the Reviewer specialist agent (RFC 0014)
 */
export async function runReviewerAgent(params: SpecialistParams): Promise<AgentExecutionResult> {
  return runToolCallingAgent({
    specialistName: "Reviewer",
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    question: params.question,
    connectedRepoId: params.connectedRepoId,
    availableTools: REVIEWER_TOOLS,
    maxIterations: params.maxIterations,
    correlationId: params.correlationId,
    customLlmCompletion: params.customLlmCompletion,
    customDriver: params.customDriver,
  });
}
