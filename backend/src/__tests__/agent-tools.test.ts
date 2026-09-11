import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getCallers,
  getCallees,
  getFile,
  getClassHierarchy,
  searchSemanticTool,
  executeToolCall,
} from "../lib/agents/tools";
import { prisma } from "../lib/prisma";
import { Driver } from "neo4j-driver";

vi.mock("../lib/prisma", () => ({
  prisma: {
    codeEmbedding: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../lib/retrieval", () => ({
  embedQuestion: vi.fn().mockResolvedValue([0.1, 0.2]),
  semanticSearchSeeds: vi.fn().mockResolvedValue([
    {
      entityType: "Function",
      entityName: "handleAuth",
      filePath: "src/auth.ts",
      contentChunk: "export function handleAuth()",
    },
  ]),
}));

interface MockRecord {
  get: (key: string) => string | number | null;
}

describe("Phase 5 Step 23: Agent Tools Unit Tests (RFC 0023)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockDriver = (records: MockRecord[]): Driver =>
    ({
      session: () => ({
        run: vi.fn().mockResolvedValue({ records }),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    } as unknown as Driver);

  it("should format get_callers output correctly when records exist", async () => {
    const mockDriver = createMockDriver([
      { get: (key: string) => (key === "callerName" ? "authenticate" : "src/auth.ts") },
    ]);

    const result = await getCallers("handleAuth", "repo-123", mockDriver);
    expect(result).toContain("Callers of function 'handleAuth':");
    expect(result).toContain("authenticate (src/auth.ts)");
  });

  it("should handle get_callers with empty graph results gracefully", async () => {
    const mockDriver = createMockDriver([]);
    const result = await getCallers("nonExistent", "repo-123", mockDriver);
    expect(result).toContain("No callers found in the graph for function 'nonExistent'.");
  });

  it("should format get_callees output correctly when records exist", async () => {
    const mockDriver = createMockDriver([
      { get: (key: string) => (key === "calleeName" ? "verifyToken" : "src/helpers.ts") },
    ]);

    const result = await getCallees("handleAuth", "repo-123", mockDriver);
    expect(result).toContain("Functions called by 'handleAuth':");
    expect(result).toContain("verifyToken (src/helpers.ts)");
  });

  it("should format get_file output from Prisma code embeddings", async () => {
    vi.mocked(prisma.codeEmbedding.findMany).mockResolvedValue([
      {
        id: "1",
        createdAt: new Date(),
        connectedRepoId: "repo-123",
        filePath: "src/auth.ts",
        entityType: "Function",
        entityName: "handleAuth",
        contentChunk: "function handleAuth() {}",
      },
    ]);

    const result = await getFile("src/auth.ts", "repo-123");
    expect(result).toContain("Content & structure for file 'src/auth.ts':");
    expect(result).toContain("[Function] handleAuth: function handleAuth() {}");
  });

  it("should format get_class_hierarchy output correctly when records exist", async () => {
    const mockDriver = createMockDriver([
      { get: (key: string) => (key === "parentName" ? "BaseManager" : "src/base.ts") },
    ]);

    const result = await getClassHierarchy("AuthManager", "repo-123", mockDriver);
    expect(result).toContain("Class 'AuthManager' inherits from:");
    expect(result).toContain("BaseManager (src/base.ts)");
  });

  it("should format search_semantic tool output correctly", async () => {
    const result = await searchSemanticTool("authentication logic", "repo-123");
    expect(result).toContain("Semantic search results for 'authentication logic':");
    expect(result).toContain("handleAuth (src/auth.ts)");
  });

  it("should dispatch tool call correctly through executeToolCall dispatcher", async () => {
    const mockDriver = createMockDriver([
      { get: (key: string) => (key === "callerName" ? "authenticate" : "src/auth.ts") },
    ]);

    const toolResult = await executeToolCall(
      "get_callers",
      { functionName: "handleAuth" },
      "repo-123",
      mockDriver
    );

    expect(toolResult.toolName).toBe("get_callers");
    expect(toolResult.result).toContain("authenticate");
  });
});
