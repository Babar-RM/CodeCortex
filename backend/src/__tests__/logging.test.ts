import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  generateCorrelationId,
  logAgentTrace,
  setTraceLogSink,
  AgentTraceLog,
} from "../lib/logging";
import { runMultiAgentPipeline } from "../lib/agents/orchestrator";
import { runToolCallingAgent } from "../lib/agents/agent-loop";

vi.mock("../lib/prisma", () => ({
  withRetry: (fn: any) => fn(),
  prisma: {
    indexingJob: {
      findFirst: vi.fn().mockResolvedValue({ commitSha: "sha123" }),
    },
    codeEmbedding: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    insightCache: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../lib/agents/tools", () => ({
  executeToolCall: vi.fn().mockImplementation(async (toolName: string) => {
    return {
      toolName,
      result: `Mocked result for ${toolName}`,
    };
  }),
}));

describe("Phase 5 Step 22: Structured Logging and Agent Trace (RFC 0022)", () => {
  let emittedLogs: AgentTraceLog[] = [];

  beforeEach(() => {
    emittedLogs = [];
    vi.clearAllMocks();
    setTraceLogSink((log) => {
      emittedLogs.push(log);
    });
  });

  afterEach(() => {
    setTraceLogSink(null);
  });

  it("should generate a valid UUID correlation ID", () => {
    const correlationId = generateCorrelationId();
    expect(correlationId).toBeDefined();
    expect(typeof correlationId).toBe("string");
    expect(correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it("should format and emit structured trace logs through the trace log sink", () => {
    const correlationId = generateCorrelationId();
    logAgentTrace({
      correlationId,
      connectedRepoId: "repo-123",
      userId: "user-456",
      step: "planned",
      detail: { questionType: "explain", reasoning: "Explainer query" },
    });

    expect(emittedLogs.length).toBe(1);
    expect(emittedLogs[0].correlationId).toBe(correlationId);
    expect(emittedLogs[0].connectedRepoId).toBe("repo-123");
    expect(emittedLogs[0].userId).toBe("user-456");
    expect(emittedLogs[0].step).toBe("planned");
    expect(emittedLogs[0].detail.questionType).toBe("explain");
    expect(emittedLogs[0].timestamp).toBeDefined();
  });

  it("should thread correlationId through runMultiAgentPipeline and emit structured trace sequence", async () => {
    const correlationId = generateCorrelationId();

    const mockLlmCompletion = vi
      .fn()
      .mockImplementation(async (prompt: string) => {
        if (prompt.includes("Planner")) {
          return JSON.stringify({ type: "explain", reasoning: "User is asking for explanation" });
        }
        if (prompt.includes("Explainer")) {
          if (!prompt.includes("TOOL RESULT")) {
            return 'TOOL: get_file({"filePath": "src/auth.ts"})';
          }
          return "Functions in auth.ts handle authentication flow.";
        }
        if (prompt.includes("Critic")) {
          return JSON.stringify({
            verdict: "approved",
            feedback: "",
            verifiedClaimsCount: 1,
            evidence: [{ filePath: "src/auth.ts", graphNodeName: "handleAuth" }],
          });
        }
        return "Default answer";
      });

    const result = await runMultiAgentPipeline({
      connectedRepoId: "repo-trace-test",
      question: "How does auth.ts work?",
      correlationId,
      userId: "user-trace-1",
      skipCache: true,
      customLlmCompletion: mockLlmCompletion,
    });

    expect(result.answer).toContain("Functions in auth.ts handle authentication flow.");

    // Assert that emitted trace logs all share the correlationId
    expect(emittedLogs.length).toBeGreaterThan(0);
    for (const log of emittedLogs) {
      expect(log.correlationId).toBe(correlationId);
      expect(log.connectedRepoId).toBe("repo-trace-test");
    }

    const steps = emittedLogs.map((l) => l.step);
    expect(steps).toContain("planned");
    expect(steps).toContain("tool_call");
    expect(steps).toContain("tool_result");
    expect(steps).toContain("draft");
    expect(steps).toContain("critic_check");
    expect(steps).toContain("approved");
  });

  it("should log cap_hit step when specialist tool calling reaches maxIterations", async () => {
    const correlationId = generateCorrelationId();

    // Mock LLM returning continuous tool calls never providing final answer
    const mockLlmCompletion = vi
      .fn()
      .mockResolvedValue('TOOL: get_file({"filePath": "src/loop.ts"})');

    await runToolCallingAgent({
      specialistName: "Explainer",
      systemPrompt: "System prompt",
      question: "Trigger tool iteration cap",
      connectedRepoId: "repo-cap-test",
      availableTools: ["get_file"],
      maxIterations: 2,
      correlationId,
      customLlmCompletion: mockLlmCompletion,
    });

    const capHitLogs = emittedLogs.filter((l) => l.step === "cap_hit");
    expect(capHitLogs.length).toBe(1);
    expect(capHitLogs[0].detail.capType).toBe("tool_iterations");
    expect(capHitLogs[0].detail.maxIterations).toBe(2);
    expect(capHitLogs[0].detail.specialist).toBe("Explainer");
  });

  it("should log cap_hit step when Critic revision loop reaches maxRevisionRounds", async () => {
    const correlationId = generateCorrelationId();

    const mockLlmCompletion = vi
      .fn()
      .mockImplementation(async (prompt: string) => {
        if (prompt.includes("Planner")) {
          return JSON.stringify({ type: "explain", reasoning: "Explain test" });
        }
        if (prompt.includes("Explainer")) {
          return "authService calls unverifiedFunction";
        }
        if (prompt.includes("Critic")) {
          return JSON.stringify([
            {
              type: "CALLS",
              sourceEntity: "authService",
              targetEntity: "unverifiedFunction",
              claimText: "authService calls unverifiedFunction",
            },
          ]);
        }
        return "authService calls unverifiedFunction";
      });

    await runMultiAgentPipeline({
      connectedRepoId: "repo-revision-cap-test",
      question: "Trigger revision cap",
      correlationId,
      maxRevisionRounds: 2,
      skipCache: true,
      customLlmCompletion: mockLlmCompletion,
    });

    const capHitLogs = emittedLogs.filter((l) => l.step === "cap_hit");
    expect(capHitLogs.length).toBe(1);
    expect(capHitLogs[0].detail.capType).toBe("critic_revisions");
    expect(capHitLogs[0].detail.maxRevisionRounds).toBe(2);
  });
});
