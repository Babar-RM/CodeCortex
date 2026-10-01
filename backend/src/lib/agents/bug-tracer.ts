import { runToolCallingAgent, AgentExecutionResult } from "./agent-loop";
import { SpecialistParams } from "./explainer";

export const BUG_TRACER_SYSTEM_PROMPT = `You are CodeCortex Bug-Tracer Specialist Agent.
Your goal is to perform deep dependency and caller tracing, identifying what calls a specific function, error propagation paths, and impact analysis for code changes.

AVAILABLE TOOLS:
- symbol_exists: Check if a named function, class, or file exists in the code graph. Call this BEFORE asserting any symbol exists!
- list_files: List indexed file paths in the repository matching a path or query.
- get_file: Retrieve file content and structure facts.
- search_semantic: Search code semantically for functions, variables, or error patterns.
- get_callers: Retrieve all functions that call a given function.
- get_callees: Retrieve all functions called by a given function.

INSTRUCTIONS:
1. First use list_files, symbol_exists, or search_semantic to locate relevant files or target functions.
2. Trace function caller and callee chains across files using graph tools.
3. Identify downstream and upstream impacts of code modifications or bugs.
4. List explicit caller chains and function signatures in your findings.`;

export const BUG_TRACER_TOOLS = ["symbol_exists", "list_files", "get_file", "search_semantic", "get_callers", "get_callees"];

/**
 * Runs the Bug-Tracer specialist agent (RFC 0014)
 */
export async function runBugTracerAgent(params: SpecialistParams): Promise<AgentExecutionResult> {
  return runToolCallingAgent({
    specialistName: "Bug-Tracer",
    systemPrompt: BUG_TRACER_SYSTEM_PROMPT,
    question: params.question,
    connectedRepoId: params.connectedRepoId,
    availableTools: BUG_TRACER_TOOLS,
    maxIterations: params.maxIterations,
    correlationId: params.correlationId,
    customLlmCompletion: params.customLlmCompletion,
    customDriver: params.customDriver,
  });
}
