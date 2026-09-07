import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildGraph } from "../jobs/pipeline/build-graph";
import { ensureGraphIndexes, getNeo4jDriver, closeNeo4jDriver } from "../lib/neo4j";
import { Driver, Session } from "neo4j-driver";

describe("Pipeline Stage 3: buildGraph (RFC 0007)", () => {
  let mockSession: { run: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  let mockDriver: Driver;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockDriver = {
      session: vi.fn().mockReturnValue(mockSession as unknown as Session),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Driver;
  });

  it("should initialize Neo4j uniqueness constraints and indexes", async () => {
    await ensureGraphIndexes(mockDriver);

    expect(mockSession.run).toHaveBeenCalledTimes(4);
    expect(mockSession.run).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("CREATE CONSTRAINT repo_id_unique IF NOT EXISTS FOR (r:Repo)")
    );
    expect(mockSession.run).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("CREATE INDEX file_repo_path IF NOT EXISTS FOR (f:File)")
    );
    expect(mockSession.run).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("CREATE INDEX fn_repo_name IF NOT EXISTS FOR (fn:Function)")
    );
    expect(mockSession.run).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("CREATE INDEX class_repo_name IF NOT EXISTS FOR (c:Class)")
    );
    expect(mockSession.close).toHaveBeenCalled();
  });

  it("should execute parameterized MERGE queries scoped by repoId for nodes and relationships", async () => {
    const mockFacts = [
      {
        filePath: "src/calculator.ts",
        language: "typescript",
        functions: [
          {
            name: "calculateTotal",
            startLine: 4,
            endLine: 8,
            params: ["items"],
            returnType: "number",
          },
        ],
        classes: [
          {
            name: "Calculator",
            startLine: 10,
            endLine: 15,
            heritage: ["BaseCalculator"],
          },
        ],
        imports: [
          {
            sourcePath: "react",
            importedSymbols: ["useState"],
          },
        ],
        calls: [
          {
            callerName: "run",
            calleeName: "calculateTotal",
            lineNumber: 12,
          },
        ],
        error: null,
      },
    ];

    const result = await buildGraph({
      repoId: "repo_123",
      repoName: "octocat/hello-world",
      facts: mockFacts,
      driver: mockDriver,
    });

    expect(result.filesProcessed).toBe(1);
    expect(result.nodesCreated).toBeGreaterThan(0);
    expect(result.relationshipsCreated).toBeGreaterThan(0);

    // Verify all Cypher calls passed repoId in parameters
    const calls = mockSession.run.mock.calls;
    for (const call of calls) {
      const query = call[0] as string;
      const params = call[1] as Record<string, unknown>;

      // Ensure MERGE is used instead of CREATE for idempotency
      expect(query).toContain("MERGE");
      expect(query).not.toContain("CREATE (");

      // Ensure repoId parameterization
      expect(params).toHaveProperty("repoId", "repo_123");
    }

    expect(mockSession.close).toHaveBeenCalled();
  });

  it("should return driver singleton from getNeo4jDriver and close cleanly", async () => {
    const driver = getNeo4jDriver();
    expect(driver).toBeDefined();

    await closeNeo4jDriver();
  });
});
