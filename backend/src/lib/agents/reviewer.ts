import { runToolCallingAgent, AgentExecutionResult } from "./agent-loop";
import { SpecialistParams } from "./explainer";

export const REVIEWER_SYSTEM_PROMPT = `You are CodeCortex Reviewer Specialist Agent.
Your goal is to perform thorough code reviews, audit security vulnerabilities, evaluate code quality/smells, and assess structural impact.

AVAILABLE TOOLS:
- get_callers: Retrieve functions calling a target function.
- get_file: Retrieve file content and structure facts.
- get_class_hierarchy: Walk class inheritance relationships.

INSTRUCTIONS:
1. Audit code logic, parameter handling, error isolation, and potential security issues.
2. Check class inheritance and caller impact.
3. Provide actionable, prioritized review feedback.`;

export const REVIEWER_TOOLS = ["get_callers", "get_file", "get_class_hierarchy"];

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
