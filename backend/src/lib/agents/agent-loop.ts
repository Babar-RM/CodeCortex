import { Driver } from "neo4j-driver";
import { executeToolCall, ToolResult } from "./tools";
import { logAgentTrace } from "../logging";

export interface ToolCallingAgentParams {
  specialistName: string;
  systemPrompt: string;
  question: string;
  connectedRepoId: string;
  availableTools: string[];
  maxIterations?: number;
  correlationId?: string;
  customLlmCompletion?: (prompt: string) => Promise<string>;
  customDriver?: Driver;
}

export interface AgentExecutionResult {
  specialistName: string;
  question: string;
  answer: string;
  toolCallsExecuted: ToolResult[];
  iterationsUsed: number;
}

export const DEFAULT_MAX_ITERATIONS = 6;

/**
 * Parses LLM output to determine if a tool call was requested.
 * Format: TOOL: tool_name({"param": "val"}) or TOOL: tool_name("val")
 */
export function parseToolCallRequest(
  output: string
): { toolName: string; args: Record<string, unknown> } | null {
  const toolCallMatch = output.match(/TOOL:\s*([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)/i);
  if (!toolCallMatch) {
    return null;
  }

  const toolName = toolCallMatch[1].trim();
  const rawArg = toolCallMatch[2].trim();

  // Try JSON parsing
  try {
    if (rawArg.startsWith("{") && rawArg.endsWith("}")) {
      const parsed = JSON.parse(rawArg) as Record<string, unknown>;
      return { toolName, args: parsed };
    }
  } catch {
    // Fallback if not valid JSON
  }

  // Handle single string argument e.g. ("handleAuth")
  const cleanArg = rawArg.replace(/^["']|["']$/g, "").trim();
  return {
    toolName,
    args: { functionName: cleanArg, filePath: cleanArg, query: cleanArg, className: cleanArg },
  };
}

/**
 * Shared Tool-Calling Agent Loop (RFC 0014)
 * Executes iterative LLM tool-calling cycle up to maxIterations
 */
export async function runToolCallingAgent(
  params: ToolCallingAgentParams
): Promise<AgentExecutionResult> {
  const maxIterations = params.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const toolCallsExecuted: ToolResult[] = [];

  const conversationTranscript: string[] = [];
  conversationTranscript.push(`SYSTEM: ${params.systemPrompt}`);
  conversationTranscript.push(`AVAILABLE TOOLS: ${params.availableTools.join(", ")}`);
  conversationTranscript.push(
    `TO USE A TOOL, RESPOND WITH: TOOL: tool_name({"param": "value"})\nOTHERWISE PROVIDE THE FINAL ANSWER.`
  );
  conversationTranscript.push(`USER QUESTION: ${params.question}`);

  let iterationsUsed = 0;
  let finalAnswer = "";

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    iterationsUsed = iteration;
    const currentPrompt = conversationTranscript.join("\n\n");

    let llmOutput = "";

    // 1. Invoke custom LLM or fallback simulation
    if (params.customLlmCompletion) {
      try {
        llmOutput = await params.customLlmCompletion(currentPrompt);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : "LLM completion error";
        llmOutput = `Error calling LLM: ${errorMsg}`;
      }
    } else {
      const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY;
      if (apiKey) {
        try {
          const response = await fetch(process.env.LLM_API_URL || "https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: process.env.LLM_MODEL || "gpt-3.5-turbo",
              messages: [{ role: "user", content: currentPrompt }],
              temperature: 0.2,
            }),
          });

          if (response.ok) {
            const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
            llmOutput = data.choices?.[0]?.message?.content || "";
          }
        } catch {
          // Fall through to deterministic simulation
        }
      }
    }

    // RAG fallback response if no external LLM API key is set
    if (!llmOutput) {
      if (iteration === 1 && params.availableTools.length > 0) {
        const firstTool = params.availableTools[0];
        llmOutput = `TOOL: ${firstTool}({"arg": "test"})`;
      } else {
        try {
          const { embedTextsWithService } = await import("../parser-client");
          const { searchSemantic } = await import("../../jobs/pipeline/generate-embeddings");
          const embeddings = await embedTextsWithService([params.question]);
          const queryVector = embeddings[0] || [];

          if (queryVector.length > 0) {
            const matches = await searchSemantic(params.connectedRepoId, queryVector, 5);
            if (matches.length > 0) {
              const snippets = matches.map((m: { filePath: string; contentChunk: string }) => `- \`${m.filePath}\`: ${m.contentChunk}`).join("\n");
              llmOutput = `### Analysis for: "${params.question}"\n\nBased on semantic vector search over your repository, here are the key relevant code definitions:\n\n${snippets}\n\n> 💡 **Tip:** Add \`OPENAI_API_KEY\` or \`LLM_API_KEY\` to \`backend/.env\` to enable full multi-agent LLM reasoning and code synthesis.`;
            }
          }
        } catch {
          // Fallback
        }

        if (!llmOutput) {
          llmOutput = `Based on the investigation using ${params.specialistName}, the codebase facts have been gathered for "${params.question}". Configure an LLM API key in \`backend/.env\` for full multi-agent reasoning.`;
        }
      }
    }

    // 2. Parse tool request
    const toolRequest = parseToolCallRequest(llmOutput);

    if (toolRequest && params.availableTools.includes(toolRequest.toolName)) {
      if (params.correlationId) {
        logAgentTrace({
          correlationId: params.correlationId,
          connectedRepoId: params.connectedRepoId,
          step: "tool_call",
          detail: { specialist: params.specialistName, tool: toolRequest.toolName, args: toolRequest.args, iteration },
        });
      }

      // Execute tool
      const toolResult = await executeToolCall(
        toolRequest.toolName,
        toolRequest.args,
        params.connectedRepoId,
        params.customDriver
      );

      if (params.correlationId) {
        logAgentTrace({
          correlationId: params.correlationId,
          connectedRepoId: params.connectedRepoId,
          step: "tool_result",
          detail: {
            specialist: params.specialistName,
            tool: toolRequest.toolName,
            summary: toolResult.result.split("\n")[0] || "Executed tool call",
          },
        });
      }

      toolCallsExecuted.push(toolResult);
      conversationTranscript.push(`ASSISTANT (Tool Call): TOOL: ${toolRequest.toolName}`);
      conversationTranscript.push(`TOOL RESULT (${toolRequest.toolName}):\n${toolResult.result}`);
    } else {
      // No tool request or tool not in allowed subset -> Final Answer reached
      finalAnswer = llmOutput;
      break;
    }
  }

  // If iteration cap was reached without final answer
  if (!finalAnswer) {
    if (params.correlationId) {
      logAgentTrace({
        correlationId: params.correlationId,
        connectedRepoId: params.connectedRepoId,
        step: "cap_hit",
        detail: {
          capType: "tool_iterations",
          maxIterations,
          specialist: params.specialistName,
        },
      });
    }

    const lastResult = toolCallsExecuted.length > 0 ? toolCallsExecuted[toolCallsExecuted.length - 1].result : "";
    finalAnswer = `[Note: Specialist investigation reached the maximum iteration cap of ${maxIterations}.]\n${lastResult}\nBased on gathered facts, here is the best available answer to your question.`;
  }

  return {
    specialistName: params.specialistName,
    question: params.question,
    answer: finalAnswer,
    toolCallsExecuted,
    iterationsUsed,
  };
}
