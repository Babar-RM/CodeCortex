import { runToolCallingAgent, AgentExecutionResult } from "./agent-loop";
import { SpecialistParams } from "./explainer";

export const BUG_TRACER_SYSTEM_PROMPT = `You are CodeCortex Bug-Tracer Specialist Agent.
Your goal is to perform deep dependency and caller tracing, identifying what calls a specific function, error propagation paths, and impact analysis for code changes.

AVAILABLE TOOLS:
- get_callers: Retrieve all functions that call a given function.
- get_callees: Retrieve all functions called by a given function.
- get_file: Retrieve file content and structure facts.

INSTRUCTIONS:
1. Trace function caller and callee chains across files using graph tools.
2. Identify downstream and upstream impacts of code modifications or bugs.
3. List explicit caller chains and function signatures in your findings.`;

export const BUG_TRACER_TOOLS = ["get_callers", "get_callees", "get_file"];

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
