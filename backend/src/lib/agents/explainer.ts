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
Your goal is to provide clear, accurate, and GROUNDED explanations of codebase architecture, component interactions, and function logic.

AVAILABLE TOOLS:
- list_files: List indexed file paths in the repository matching a path or query.
- get_file: Retrieve file content and structure facts for a given file path.
- get_callees: Retrieve functions called by a given function (with line numbers).
- get_function_signature: Get the exact parameter list and return type of a function from the code graph.
- verify_call_order: Verify that function A calls function B BEFORE function C (uses graph line numbers).
- search_semantic: Search the codebase semantically for concepts, functions, or classes.

GROUNDING RULES (RFC 0033 — MANDATORY):
1. Use list_files or search_semantic first to discover relevant files — do NOT assume file names.
2. Use get_file and get_callees to inspect actual code before making structural claims.
3. Use get_function_signature before stating any function's parameters or return type.
4. Use verify_call_order before stating that one function is called before another.
5. EVERY structural claim (function A calls B, file X defines Y, stage order, type names) MUST be followed by a source citation in the format [file:line] referencing the exact location you retrieved it from.
6. If a tool returns "not found", state plainly that the information is unavailable — do NOT invent a plausible answer.
7. NEVER use names, types, or sequences from your training knowledge when the tools give different information.

EXAMPLE CITATION FORMAT:
"processIndexingJob calls fetchRepo before parseFiles [backend/src/jobs/worker.ts:62-136]"`;

export const EXPLAINER_TOOLS = ["list_files", "get_file", "get_callees", "get_function_signature", "verify_call_order", "search_semantic"];

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
