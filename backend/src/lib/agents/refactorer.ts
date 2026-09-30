import { runToolCallingAgent, AgentExecutionResult } from "./agent-loop";
import { SpecialistParams } from "./explainer";

export const REFACTORER_SYSTEM_PROMPT = `You are CodeCortex Refactorer Specialist Agent.
Your goal is to propose code refactoring suggestions, performance optimizations, simplification of complex logic, and clean design pattern implementations.

AVAILABLE TOOLS:
- list_files: List indexed file paths in the repository matching a path or query.
- get_file: Retrieve file content and structure facts for a given file.
- get_callees: Retrieve functions called by a target function.
- get_class_hierarchy: Walk class inheritance relationships.
- search_semantic: Search codebase semantically for reusable helper functions or patterns.

INSTRUCTIONS:
1. Use list_files or search_semantic to locate relevant files to refactor.
2. Inspect file structure and dependencies with get_file and get_callees.
3. Search for existing similar code patterns to avoid duplicate utilities.
4. Provide concrete refactoring code snippets and structural improvements.`;

export const REFACTORER_TOOLS = ["list_files", "get_file", "get_callees", "get_class_hierarchy", "search_semantic"];

/**
 * Runs the Refactorer specialist agent (RFC 0014)
 */
export async function runRefactorerAgent(params: SpecialistParams): Promise<AgentExecutionResult> {
  return runToolCallingAgent({
    specialistName: "Refactorer",
    systemPrompt: REFACTORER_SYSTEM_PROMPT,
    question: params.question,
    connectedRepoId: params.connectedRepoId,
    availableTools: REFACTORER_TOOLS,
    maxIterations: params.maxIterations,
    correlationId: params.correlationId,
    customLlmCompletion: params.customLlmCompletion,
    customDriver: params.customDriver,
  });
}
