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

// ---------------------------------------------------------------------------
// RFC 0031: Structured fallback formatter
// Produces clean human-readable Markdown when LLM is unavailable
// ---------------------------------------------------------------------------
export function formatStructuredFallbackAnswer(params: {
  question: string;
  specialistName: string;
  toolResults: ToolResult[];
}): string {
  const cleanQuestion = params.question
    .split("\n")[0]
    .split("[Instruction:")[0]
    .split("CRITIC REVISION")[0]
    .trim();

  const analyzedFiles = Array.from(
    new Set(
      params.toolResults
        .map((t) => {
          const a = (t.args || {}) as Record<string, unknown>;
          return (a.filePath || a.path || a.query) as string | undefined;
        })
        .filter(Boolean)
    )
  ) as string[];

  const recentFacts = params.toolResults
    .slice(-3)
    .filter((tr) => tr.result && tr.result.trim().length > 20)
    .map((tr) => {
      // Trim very long tool results
      const snippet = tr.result.length > 600 ? tr.result.substring(0, 600) + "\n..." : tr.result;
      return `#### Findings from \`${tr.toolName}\`\n\`\`\`\n${snippet}\n\`\`\``;
    })
    .join("\n\n");

  return `## 🔍 Analysis: ${cleanQuestion}

### Summary
The **${params.specialistName}** agent investigated your repository and gathered the following structural facts.

${
  analyzedFiles.length > 0
    ? `### 📂 Inspected Files\n${analyzedFiles.map((f) => `- \`${f}\``).join("\n")}`
    : "### 📂 Scope\n- Repository root and indexed structural manifests"
}

${recentFacts ? `### 📋 Key Findings\n${recentFacts}` : "### 📋 Key Findings\nNo specific code entities were flagged during this investigation."}

---
> **Note:** For richer multi-agent AI reasoning, ensure a valid \`GROQ_API_KEY\` is set in \`backend/.env\`.`;
}

// ---------------------------------------------------------------------------
// RFC 0031: Final Synthesis Pass
// Compiles all retrieved tool facts into a clean Markdown answer via LLM
// ---------------------------------------------------------------------------
async function synthesizeGroundedAnswer(params: {
  question: string;
  specialistName: string;
  toolResults: ToolResult[];
  customLlmCompletion?: (prompt: string) => Promise<string>;
}): Promise<string> {
  const cleanQuestion = params.question
    .split("\n")[0]
    .split("[Instruction:")[0]
    .split("CRITIC REVISION")[0]
    .trim();

  if (params.toolResults.length === 0) {
    return formatStructuredFallbackAnswer({
      question: params.question,
      specialistName: params.specialistName,
      toolResults: [],
    });
  }

  // Build the context string from tool results
  const contextBlocks = params.toolResults
    .map((tr, idx) => {
      const snippet = tr.result.length > 800 ? tr.result.substring(0, 800) + "\n[truncated]" : tr.result;
      return `[Fact ${idx + 1} — retrieved via ${tr.toolName}]\n${snippet}`;
    })
    .join("\n\n---\n\n");

  const synthesisPrompt = `You are CodeCortex's Senior Technical Assistant.
Synthesize a comprehensive, human-readable, well-structured answer for the user's question based STRICTLY on the retrieved repository facts below.

RULES:
1. DO NOT include raw developer notes, iteration counters, or system debug headers.
2. DO NOT include raw "Content & structure for file" prefixes or tool invocation metadata.
3. DO NOT reference facts as "(Fact 1)", "(Fact 2)", etc. — integrate all findings naturally into the text.
4. Structure your response with clear Markdown headings (e.g., ## Summary, ## Findings, ## Recommendations).
5. Format ALL file paths, code symbol names, and line numbers in inline code (\`path/to/file.ts\`).
6. Format tables using proper Markdown table syntax.
7. Use **bold** for key terms and \`code\` for identifiers — do NOT use asterisks as bullets inside prose.
8. If facts are incomplete, state what was analyzed and provide actionable next steps.
9. Keep the tone professional, precise, and developer-friendly.

User Question: ${cleanQuestion}

Retrieved Repository Facts:
${contextBlocks}

Respond with a clean, complete, human-readable Markdown answer:`;

  let synthesized = "";

  try {
    if (params.customLlmCompletion) {
      synthesized = await params.customLlmCompletion(synthesisPrompt);
    } else {
      const { callLLMCompletion } = await import("../llm");
      synthesized = await callLLMCompletion(synthesisPrompt, { temperature: 0.3 });
    }
  } catch {
    // LLM error — fall through to structured fallback
  }

  // Validate the synthesized output is clean prose (not a raw TOOL: call or debug string)
  if (
    synthesized &&
    synthesized.trim().length > 80 &&
    !synthesized.trim().startsWith("TOOL:") &&
    !synthesized.includes("[Note: Specialist investigation")
  ) {
    return synthesized.trim();
  }

  // If LLM unavailable or returned junk, use the structured formatter
  return formatStructuredFallbackAnswer({
    question: params.question,
    specialistName: params.specialistName,
    toolResults: params.toolResults,
  });
}

// ---------------------------------------------------------------------------
// RFC 0031: Strip all internal debug/trace leakage from the final answer
// ---------------------------------------------------------------------------
function sanitizeFinalAnswer(answer: string): string {
  let clean = answer;

  // Strip the "[Note: Specialist investigation reached the maximum iteration cap of N.]" header
  clean = clean.replace(/\[Note:[^\]]*iteration cap[^\]]*\]\s*/gi, "");

  // Strip "Content & structure for file 'X':" prefixes from inline tool dumps
  clean = clean.replace(/Content & structure for file '[^']*':\s*/gi, "");

  // Strip "[file] X: File X (language: Y)" raw indexer output lines
  clean = clean.replace(/\[file\][^\n]*\n?/gi, "");

  // Strip "Based on gathered facts, here is the best available answer to your question." coda
  clean = clean.replace(/Based on gathered facts, here is the best available answer to your question\.?\s*/gi, "");

  // Strip raw TOOL: ... lines left over in the answer body
  clean = clean.replace(/^TOOL:.*$/gm, "");

  // Strip Critic revision noise
  clean = clean.replace(/CRITIC REVISION FEEDBACK:[\s\S]*?(?=\n##|\n---|\Z)/gi, "");

  // Strip \"[Warning: N structural claim(s)...]\" caveats that appear in isolation
  clean = clean.replace(/\[Warning:[^\]]*structural claim[^\]]*\]\s*/gi, "");

  // Strip internal fact reference labels like "(Fact 1)", "[Fact 2 — retrieved via get_file]"
  clean = clean.replace(/\(Fact \d+\)/gi, "");
  clean = clean.replace(/\[Fact \d+[^\]]*\]/gi, "");
  clean = clean.replace(/— retrieved via \w+/gi, "");

  // Collapse multiple consecutive blank lines
  clean = clean.replace(/\n{4,}/g, "\n\n");

  return clean.trim();
}

// ---------------------------------------------------------------------------
// Tool call parser (unchanged from original)
// ---------------------------------------------------------------------------
export function parseToolCallRequest(
  output: string
): { toolName: string; args: Record<string, unknown> } | null {
  if (!output || typeof output !== "string") return null;

  let cleanOutput = output.trim();
  while (cleanOutput.toUpperCase().startsWith("TOOL:")) {
    cleanOutput = cleanOutput.substring(5).trim();
  }

  const toolCallMatch = cleanOutput.match(/([a-zA-Z0-9._]+)\s*\(([^]*)\)/);
  if (toolCallMatch) {
    let rawToolName = toolCallMatch[1].trim();
    let rawArg = toolCallMatch[2].trim();

    if (
      rawToolName.toUpperCase() === "TOOL" ||
      rawToolName.toUpperCase() === "TOOLS" ||
      rawToolName.toUpperCase() === "FUNCTION" ||
      rawToolName.toUpperCase() === "FUNCTIONS"
    ) {
      const innerMatch = rawArg.match(/([a-zA-Z0-9._]+)\s*\(([^]*)\)/);
      if (innerMatch) {
        rawToolName = innerMatch[1].trim();
        rawArg = innerMatch[2].trim();
      }
    }

    rawToolName = rawToolName.replace(/^(tool|tools|functions|function|repo_browser|action)\./i, "");
    if (rawToolName.includes(".")) {
      const parts = rawToolName.split(".");
      rawToolName = parts[parts.length - 1];
    }

    if (["open_file", "read_file", "get_file_content", "view_file", "read_code", "cat", "file_content"].includes(rawToolName)) {
      rawToolName = "get_file";
    } else if (["code_search", "search", "semantic_search", "find_code", "grep"].includes(rawToolName)) {
      rawToolName = "search_semantic";
    } else if (["find_files", "search_files", "list", "ls", "dir"].includes(rawToolName)) {
      rawToolName = "list_files";
    } else if (["callers", "find_callers"].includes(rawToolName)) {
      rawToolName = "get_callers";
    } else if (["callees", "find_callees"].includes(rawToolName)) {
      rawToolName = "get_callees";
    } else if (["class_hierarchy", "inheritance"].includes(rawToolName)) {
      rawToolName = "get_class_hierarchy";
    }

    if (rawArg.endsWith(")") && !rawArg.startsWith("(")) {
      let openBraces = 0;
      let closeIndex = -1;
      for (let i = 0; i < rawArg.length; i++) {
        if (rawArg[i] === "{" || rawArg[i] === "[") openBraces++;
        if (rawArg[i] === "}" || rawArg[i] === "]") openBraces--;
        if (rawArg[i] === ")" && openBraces === 0) {
          closeIndex = i;
          break;
        }
      }
      if (closeIndex !== -1) {
        rawArg = rawArg.substring(0, closeIndex).trim();
      } else if (rawArg.endsWith(")")) {
        rawArg = rawArg.slice(0, -1).trim();
      }
    }

    try {
      if (rawArg.startsWith("{") && rawArg.endsWith("}")) {
        const parsed = JSON.parse(rawArg) as Record<string, unknown>;
        return { toolName: rawToolName, args: parsed };
      }
    } catch {
      const jsonObjMatch = rawArg.match(/\{[\s\S]*\}/);
      if (jsonObjMatch) {
        try {
          const parsed = JSON.parse(jsonObjMatch[0]) as Record<string, unknown>;
          return { toolName: rawToolName, args: parsed };
        } catch {}
      }
    }

    const cleanArg = rawArg.replace(/^["']|["']$/g, "").trim();
    return {
      toolName: rawToolName,
      args: { functionName: cleanArg, filePath: cleanArg, query: cleanArg, className: cleanArg, filter: cleanArg, path: cleanArg },
    };
  }

  try {
    const jsonMatch = cleanOutput.match(/\{[\s\S]*"name"\s*:\s*"([^"]+)"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { name?: string; arguments?: Record<string, unknown> };
      if (parsed.name) {
        let toolName = parsed.name.trim();
        toolName = toolName.replace(/^(tool|tools|functions|function|repo_browser|action)\./i, "");
        if (toolName.includes(".")) {
          const parts = toolName.split(".");
          toolName = parts[parts.length - 1];
        }
        if (["open_file", "read_file", "get_file_content", "view_file", "read_code", "cat", "file_content"].includes(toolName)) {
          toolName = "get_file";
        } else if (["code_search", "search", "semantic_search", "find_code", "grep"].includes(toolName)) {
          toolName = "search_semantic";
        } else if (["find_files", "search_files", "list", "ls", "dir"].includes(toolName)) {
          toolName = "list_files";
        }
        const args = parsed.arguments || {};
        return { toolName, args };
      }
    }
  } catch {
    // Ignore JSON parse error
  }

  return null;
}

// ---------------------------------------------------------------------------
// RFC 0031: Tool call de-duplication key generator
// ---------------------------------------------------------------------------
function makeToolCallKey(toolName: string, args: Record<string, unknown>): string {
  const a = args as Record<string, string | undefined>;
  const primary = a.filePath || a.path || a.query || a.functionName || a.className || a.filter || "";
  return `${toolName}::${String(primary).toLowerCase().trim()}`;
}

// ---------------------------------------------------------------------------
// Shared Tool-Calling Agent Loop (RFC 0014 + RFC 0031 enhancements)
// ---------------------------------------------------------------------------
export async function runToolCallingAgent(
  params: ToolCallingAgentParams
): Promise<AgentExecutionResult> {
  const maxIterations = params.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const toolCallsExecuted: ToolResult[] = [];

  // RFC 0031: Track executed tool+arg keys to prevent identical duplicate calls
  const executedToolKeys = new Set<string>();

  const conversationTranscript: string[] = [];
  conversationTranscript.push(`SYSTEM: ${params.systemPrompt}`);
  conversationTranscript.push(`AVAILABLE TOOLS: ${params.availableTools.join(", ")}, open_file, read_file`);
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

    if (params.customLlmCompletion) {
      try {
        llmOutput = await params.customLlmCompletion(currentPrompt);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : "LLM completion error";
        llmOutput = `Error calling LLM: ${errorMsg}`;
      }
    } else {
      const { callLLMCompletion } = await import("../llm");
      llmOutput = await callLLMCompletion(currentPrompt);
    }

    // If no LLM output (key not configured), skip to synthesis immediately
    if (!llmOutput) {
      break;
    }

    const toolRequest = parseToolCallRequest(llmOutput);
    const validSystemTools = ["list_files", "get_file", "get_callers", "get_callees", "get_class_hierarchy", "search_semantic"];
    const allowedTools = Array.from(new Set([...params.availableTools, ...validSystemTools, "open_file", "read_file"]));

    if (toolRequest) {
      if (allowedTools.includes(toolRequest.toolName)) {
        // RFC 0031: De-duplicate identical tool+argument combinations
        const callKey = makeToolCallKey(toolRequest.toolName, toolRequest.args);
        if (executedToolKeys.has(callKey)) {
          // Tell the LLM it already ran this — ask it to explore somewhere new
          conversationTranscript.push(
            `TOOL RESULT (${toolRequest.toolName}): [DUPLICATE CALL SKIPPED] You already retrieved this result. ` +
            `Please explore a different file, directory, or search query to find more relevant information. ` +
            `Available tools: ${params.availableTools.join(", ")}.`
          );
          continue;
        }
        executedToolKeys.add(callKey);

        if (params.correlationId) {
          logAgentTrace({
            correlationId: params.correlationId,
            connectedRepoId: params.connectedRepoId,
            step: "tool_call",
            detail: { specialist: params.specialistName, tool: toolRequest.toolName, args: toolRequest.args, iteration },
          });
        }

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
        conversationTranscript.push(`ASSISTANT (Tool Call): TOOL: ${toolRequest.toolName}`);
        conversationTranscript.push(
          `TOOL RESULT (${toolRequest.toolName}): Tool '${toolRequest.toolName}' is NOT available or allowed. ` +
          `Do NOT execute shell/exec commands. Available tools: ${params.availableTools.join(", ")}. ` +
          `Please use one of the available tools or provide your final answer directly.`
        );
      }
    } else {
      // No tool call — LLM provided a direct text answer
      finalAnswer = llmOutput;
      break;
    }
  }

  // ---------------------------------------------------------------------------
  // RFC 0031: Mandatory Final Synthesis Pass
  // If cap was hit without a clean text answer, synthesize from gathered facts
  // ---------------------------------------------------------------------------
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

    console.log(
      `[agent-loop] ${params.specialistName} reached iteration cap (${maxIterations}). ` +
      `Triggering final synthesis pass over ${toolCallsExecuted.length} gathered facts...`
    );

    finalAnswer = await synthesizeGroundedAnswer({
      question: params.question,
      specialistName: params.specialistName,
      toolResults: toolCallsExecuted,
      customLlmCompletion: params.customLlmCompletion,
    });
  }

  // ---------------------------------------------------------------------------
  // RFC 0031: Handle any leftover raw TOOL: syntax in the final answer
  // ---------------------------------------------------------------------------
  if (finalAnswer.trim().startsWith("TOOL:") || /^TOOL:/m.test(finalAnswer)) {
    const rawToolReq = parseToolCallRequest(finalAnswer);
    const validTools = ["list_files", "get_file", "get_callers", "get_callees", "get_class_hierarchy", "search_semantic"];
    if (rawToolReq && validTools.includes(rawToolReq.toolName)) {
      try {
        const toolRes = await executeToolCall(
          rawToolReq.toolName,
          rawToolReq.args,
          params.connectedRepoId,
          params.customDriver
        );
        toolCallsExecuted.push(toolRes);
        // Synthesize from the updated facts including this last result
        finalAnswer = await synthesizeGroundedAnswer({
          question: params.question,
          specialistName: params.specialistName,
          toolResults: toolCallsExecuted,
          customLlmCompletion: params.customLlmCompletion,
        });
      } catch {
        finalAnswer = formatStructuredFallbackAnswer({
          question: params.question,
          specialistName: params.specialistName,
          toolResults: toolCallsExecuted,
        });
      }
    } else {
      finalAnswer = formatStructuredFallbackAnswer({
        question: params.question,
        specialistName: params.specialistName,
        toolResults: toolCallsExecuted,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // RFC 0031: Sanitize any remaining internal debug strings from final answer
  // ---------------------------------------------------------------------------
  finalAnswer = sanitizeFinalAnswer(finalAnswer);

  // Final safety net — if still empty after all processing
  if (!finalAnswer || finalAnswer.trim().length < 20) {
    finalAnswer = formatStructuredFallbackAnswer({
      question: params.question,
      specialistName: params.specialistName,
      toolResults: toolCallsExecuted,
    });
  }

  return {
    specialistName: params.specialistName,
    question: params.question,
    answer: finalAnswer,
    toolCallsExecuted,
    iterationsUsed,
  };
}
