import { describe, it, expect, vi, beforeEach } from "vitest";
import { Driver } from "neo4j-driver";
import {
  getCallers,
  getCallees,
  getFile,
  getClassHierarchy,
  executeToolCall,
} from "../lib/agents/tools";
import { parseToolCallRequest, runToolCallingAgent } from "../lib/agents/agent-loop";
import { runExplainerAgent } from "../lib/agents/explainer";
import { runBugTracerAgent } from "../lib/agents/bug-tracer";
import { runReviewerAgent } from "../lib/agents/reviewer";
import { runRefactorerAgent } from "../lib/agents/refactorer";

vi.mock("../lib/prisma", () => ({
  withRetry: (fn: () => unknown) => fn(),
  prisma: {
    codeEmbedding: {
      findMany: vi.fn().mockImplementation(async (args: { where?: { filePath?: { contains?: string } } }) => {
        if (args.where?.filePath?.contains === "nonexistent") {
          return [];
        }
        return [
          {
            id: "emb-1",
            connectedRepoId: "repo_spec_123",
            entityType: "function",
            entityName: "handleAuth",
            filePath: "src/auth.ts",
            contentChunk: "function handleAuth(req, res)",
          },
        ];
      }),
    },
  },
}));

vi.mock("../lib/retrieval", () => ({
  embedQuestion: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  semanticSearchSeeds: vi.fn().mockResolvedValue([
    {
      id: "s1",
      entityType: "function",
      entityName: "handleAuth",
      filePath: "src/auth.ts",
      contentChunk: "function handleAuth(req, res)",
      source: "seed",
      score: 0.9,
    },
  ]),
}));

describe("Specialist Agents & Tool-Calling (RFC 0014)", () => {
  const repoId = "repo_spec_123";

  const mockSession = {
    run: vi.fn().mockImplementation(async (query: string) => {
      if (query.includes("MATCH (caller:Function")) {
        return {
          records: [
            {
              get: (key: string) => (key === "callerName" ? "loginRoute" : "src/routes.ts"),
            },
          ],
        };
      }
      if (query.includes("MATCH (source:Function") && query.includes("-[:CALLS]->")) {
        return {
          records: [
            {
              get: (key: string) => (key === "calleeName" ? "verifyJwt" : "src/jwt.ts"),
            },
          ],
        };
      }
      if (query.includes("MATCH (c:Class") && query.includes("-[:INHERITS]->")) {
        return {
          records: [
            {
              get: (key: string) => (key === "parentName" ? "BaseController" : "src/base.ts"),
            },
          ],
        };
      }
      return { records: [] };
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockDriver = {
    session: () => mockSession,
  } as unknown as Driver;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Tools Module (tools.ts)", () => {
    it("getCallers queries Neo4j for callers", async () => {
      const res = await getCallers("verifyJwt", repoId, mockDriver);
      expect(res).toContain("Callers of function 'verifyJwt':");
      expect(res).toContain("loginRoute");
    });

    it("getCallees queries Neo4j for callees", async () => {
      const res = await getCallees("loginRoute", repoId, mockDriver);
      expect(res).toContain("Functions called by 'loginRoute':");
      expect(res).toContain("verifyJwt");
    });

    it("getFile reads indexed code chunks from database", async () => {
      const res = await getFile("src/auth.ts", repoId);
      expect(res).toContain("Content & structure for file 'src/auth.ts':");
      expect(res).toContain("handleAuth");
    });

    it("getClassHierarchy queries Neo4j for class inheritance", async () => {
      const res = await getClassHierarchy("UserController", repoId, mockDriver);
      expect(res).toContain("Class 'UserController' inherits from:");
      expect(res).toContain("BaseController");
    });

    it("executeToolCall dispatches tool names correctly", async () => {
      const toolRes = await executeToolCall("get_callers", { functionName: "handleAuth" }, repoId, mockDriver);
      expect(toolRes.toolName).toBe("get_callers");
      expect(toolRes.result).toContain("Callers of function 'handleAuth':");
    });
  });

  describe("Agent Loop Parser & Loop Execution (agent-loop.ts)", () => {
    it("parseToolCallRequest parses TOOL: name(args) string", () => {
      const parsed = parseToolCallRequest('TOOL: get_callers({"functionName": "handleAuth"})');
      expect(parsed).not.toBeNull();
      expect(parsed!.toolName).toBe("get_callers");
      expect(parsed!.args.functionName).toBe("handleAuth");
    });

    it("runs tool calling loop and returns answer", async () => {
      let callCount = 0;
      const customLlm = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return 'TOOL: get_callees({"functionName": "handleAuth"})';
        }
        return "Final Explanation: handleAuth calls verifyJwt for JWT validation.";
      });

      const res = await runToolCallingAgent({
        specialistName: "Explainer",
        systemPrompt: "Explain code",
        question: "How does handleAuth work?",
        connectedRepoId: repoId,
        availableTools: ["get_callees"],
        customLlmCompletion: customLlm,
        customDriver: mockDriver,
      });

      expect(res.specialistName).toBe("Explainer");
      expect(res.answer).toContain("Final Explanation:");
      expect(res.toolCallsExecuted).toHaveLength(1);
      expect(res.toolCallsExecuted[0].toolName).toBe("get_callees");
    });

    it("enforces max iterations cap (default 6)", async () => {
      const customLlm = vi.fn().mockResolvedValue('TOOL: get_callees({"functionName": "loop"})');

      const res = await runToolCallingAgent({
        specialistName: "Explainer",
        systemPrompt: "Loop agent",
        question: "Infinite loop test",
        connectedRepoId: repoId,
        availableTools: ["get_callees"],
        maxIterations: 3,
        customLlmCompletion: customLlm,
        customDriver: mockDriver,
      });

      expect(res.iterationsUsed).toBe(3);
      expect(res.answer).toContain("Analysis");
    });
  });

  describe("Explainer Specialist (explainer.ts)", () => {
    it("executes Explainer agent with explainer tools", async () => {
      const res = await runExplainerAgent({
        question: "How does auth work?",
        connectedRepoId: repoId,
        customDriver: mockDriver,
      });

      expect(res.specialistName).toBe("Explainer");
      expect(res.answer).toBeDefined();
    });
  });

  describe("Bug-Tracer Specialist (bug-tracer.ts)", () => {
    it("executes Bug-Tracer agent with bug tracer tools", async () => {
      const res = await runBugTracerAgent({
        question: "What functions call handleAuth?",
        connectedRepoId: repoId,
        customDriver: mockDriver,
      });

      expect(res.specialistName).toBe("Bug-Tracer");
      expect(res.answer).toBeDefined();
    });
  });

  describe("Reviewer Specialist (reviewer.ts)", () => {
    it("executes Reviewer agent with reviewer tools", async () => {
      const res = await runReviewerAgent({
        question: "Review auth.ts for security vulnerabilities",
        connectedRepoId: repoId,
        customDriver: mockDriver,
      });

      expect(res.specialistName).toBe("Reviewer");
      expect(res.answer).toBeDefined();
    });
  });

  describe("Refactorer Specialist (refactorer.ts)", () => {
    it("executes Refactorer agent with refactorer tools", async () => {
      const res = await runRefactorerAgent({
        question: "How to refactor handleAuth?",
        connectedRepoId: repoId,
        customDriver: mockDriver,
      });

      expect(res.specialistName).toBe("Refactorer");
      expect(res.answer).toBeDefined();
    });
  });
});
