import { Driver } from "neo4j-driver";
import { runToolCallingAgent, AgentExecutionResult } from "./agent-loop";

export interface SpecialistParams {
  question: string;
  connectedRepoId: string;
  maxIterations?: number;
  correlationId?: string;
  customLlmCompletion?: (prompt: string) => Promise<string>;
  customDriver?: Driver;
}

export const EXPLAINER_SYSTEM_PROMPT = `You are CodeCortex Explainer Specialist Agent.
Your goal is to provide clear, accurate, and structured explanations of codebase architecture, component interactions, and function logic.

AVAILABLE TOOLS:
- list_files: List indexed file paths in the repository matching a path or query.
- get_file: Retrieve file content and structure facts for a given file path.
- get_callees: Retrieve functions called by a given function.
- search_semantic: Search the codebase semantically for concepts, functions, or classes.

INSTRUCTIONS:
1. First use list_files or search_semantic to discover relevant repository files.
2. Use get_file and get_callees to inspect required code files and function calls.
3. Synthesize clear explanations with concrete file references and function names.
4. State plainly if code details are missing or unavailable.`;

export const EXPLAINER_TOOLS = ["list_files", "get_file", "get_callees", "search_semantic"];

/**
 * Runs the Explainer specialist agent (RFC 0014)
 */
export async function runExplainerAgent(params: SpecialistParams): Promise<AgentExecutionResult> {
  return runToolCallingAgent({
    specialistName: "Explainer",
    systemPrompt: EXPLAINER_SYSTEM_PROMPT,
    question: params.question,
    connectedRepoId: params.connectedRepoId,
    availableTools: EXPLAINER_TOOLS,
    maxIterations: params.maxIterations,
    correlationId: params.correlationId,
    customLlmCompletion: params.customLlmCompletion,
    customDriver: params.customDriver,
  });
}
