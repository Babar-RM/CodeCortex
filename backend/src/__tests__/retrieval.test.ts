import { describe, it, expect, vi, beforeEach } from "vitest";
import { Driver } from "neo4j-driver";
import {
  embedQuestion,
  semanticSearchSeeds,
  expandGraphNeighborhood,
  mergeAndRank,
  assembleBundle,
  hybridRetrieve,
  ContextNode,
} from "../lib/retrieval";

vi.mock("../lib/parser-client", () => ({
  embedTextsWithService: vi.fn().mockImplementation(async (texts: string[]) => {
    return texts.map(() => new Array(384).fill(0.1));
  }),
}));

vi.mock("../jobs/pipeline/generate-embeddings", () => ({
  searchSemantic: vi.fn().mockImplementation(async (_repoId: string, _vec: number[], limit = 5) => {
    return [
      {
        id: "emb-1",
        entityType: "function",
        entityName: "handleAuth",
        filePath: "src/auth.ts",
        contentChunk: "function handleAuth(req, res) in src/auth.ts",
        distance: 0.1,
      },
      {
        id: "emb-2",
        entityType: "function",
        entityName: "processUser",
        filePath: "src/user.ts",
        contentChunk: "function processUser(data) in src/user.ts",
        distance: 0.3,
      },
    ].slice(0, limit);
  }),
}));

describe("Hybrid Retrieval Module (RFC 0011)", () => {
  const repoId = "test-repo-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("embedQuestion", () => {
    it("returns vector array when embed service responds", async () => {
      const vector = await embedQuestion("how does auth work?");
      expect(vector).toHaveLength(384);
      expect(vector[0]).toBe(0.1);
    });
  });

  describe("semanticSearchSeeds", () => {
    it("converts semantic search results into seed ContextNodes", async () => {
      const dummyVec = new Array(384).fill(0.1);
      const seeds = await semanticSearchSeeds(repoId, dummyVec, 5);

      expect(seeds).toHaveLength(2);
      expect(seeds[0].entityName).toBe("handleAuth");
      expect(seeds[0].source).toBe("seed");
      expect(seeds[0].score).toBeCloseTo(0.9);
      expect(seeds[1].entityName).toBe("processUser");
    });

    it("returns empty array if query vector is empty", async () => {
      const seeds = await semanticSearchSeeds(repoId, []);
      expect(seeds).toEqual([]);
    });
  });

  describe("expandGraphNeighborhood", () => {
    it("expands callers and callees via Neo4j session", async () => {
      const seeds: ContextNode[] = [
        {
          id: "seed-1",
          entityType: "function",
          entityName: "handleAuth",
          filePath: "src/auth.ts",
          source: "seed",
          score: 0.9,
          relationships: [],
        },
      ];

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
          if (query.includes("MATCH (s:Function") && query.includes("-[:CALLS]->")) {
            return {
              records: [
                {
                  get: (key: string) => (key === "calleeName" ? "verifyJwt" : "src/jwt.ts"),
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

      const neighbors = await expandGraphNeighborhood(repoId, seeds, 1, mockDriver);

      expect(neighbors).toHaveLength(2);
      expect(neighbors.map((n) => n.entityName)).toContain("loginRoute");
      expect(neighbors.map((n) => n.entityName)).toContain("verifyJwt");
      expect(seeds[0].relationships).toHaveLength(2);
    });

    it("returns empty array if driver fails gracefully", async () => {
      const mockDriver = {
        session: () => {
          throw new Error("Connection failed");
        },
      } as unknown as Driver;

      const neighbors = await expandGraphNeighborhood(repoId, [], 1, mockDriver);
      expect(neighbors).toEqual([]);
    });
  });

  describe("mergeAndRank", () => {
    it("deduplicates nodes and ranks seeds above neighbors", () => {
      const seeds: ContextNode[] = [
        {
          id: "seed-1",
          entityType: "function",
          entityName: "fnA",
          filePath: "a.ts",
          source: "seed",
          score: 0.95,
        },
      ];

      const neighbors: ContextNode[] = [
        {
          id: "neighbor-1",
          entityType: "function",
          entityName: "fnA", // duplicate
          filePath: "a.ts",
          source: "neighbor",
          score: 0.5,
        },
        {
          id: "neighbor-2",
          entityType: "function",
          entityName: "fnB",
          filePath: "b.ts",
          source: "neighbor",
          score: 0.5,
        },
      ];

      const ranked = mergeAndRank(seeds, neighbors);

      expect(ranked).toHaveLength(2);
      expect(ranked[0].entityName).toBe("fnA");
      expect(ranked[0].source).toBe("seed");
      expect(ranked[0].score).toBe(0.95);
      expect(ranked[1].entityName).toBe("fnB");
      expect(ranked[1].source).toBe("neighbor");
    });
  });

  describe("assembleBundle", () => {
    it("formats context bundle into readable prompt structure", () => {
      const seeds: ContextNode[] = [
        {
          id: "s1",
          entityType: "function",
          entityName: "handleAuth",
          filePath: "src/auth.ts",
          contentChunk: "function handleAuth()",
          source: "seed",
          score: 0.9,
          relationships: [{ type: "CALLS", targetName: "verifyJwt", targetPath: "src/jwt.ts" }],
        },
      ];

      const neighbors: ContextNode[] = [
        {
          id: "n1",
          entityType: "function",
          entityName: "verifyJwt",
          filePath: "src/jwt.ts",
          source: "neighbor",
          score: 0.5,
        },
      ];

      const ranked = mergeAndRank(seeds, neighbors);
      const bundle = assembleBundle(repoId, "How does auth work?", seeds, neighbors, ranked);

      expect(bundle.repoId).toBe(repoId);
      expect(bundle.question).toBe("How does auth work?");
      expect(bundle.formattedContext).toContain("=== CONTEXT BUNDLE FOR REPOSITORY: test-repo-123 ===");
      expect(bundle.formattedContext).toContain("QUESTION: How does auth work?");
      expect(bundle.formattedContext).toContain("--- SEED NODES (Semantic Matches: 1) ---");
      expect(bundle.formattedContext).toContain("1. [function] handleAuth (src/auth.ts)");
      expect(bundle.formattedContext).toContain("--- NEIGHBOR NODES (Graph Expansion: 1) ---");
      expect(bundle.formattedContext).toContain("1. [function] verifyJwt (src/jwt.ts)");
    });
  });

  describe("hybridRetrieve (end-to-end deterministic retrieval)", () => {
    it("executes hybrid retrieval for semantic question", async () => {
      const bundle = await hybridRetrieve({
        connectedRepoId: repoId,
        question: "how does authentication work here",
        maxSeeds: 5,
        expansionHops: 1,
      });

      expect(bundle.repoId).toBe(repoId);
      expect(bundle.question).toBe("how does authentication work here");
      expect(bundle.seeds.length).toBeGreaterThan(0);
      expect(bundle.rankedNodes.length).toBeGreaterThan(0);
      expect(bundle.formattedContext).toContain("=== CONTEXT BUNDLE FOR REPOSITORY:");
    });

    it("executes hybrid retrieval for structural question", async () => {
      const bundle = await hybridRetrieve({
        connectedRepoId: repoId,
        question: "what calls processUser function",
      });

      expect(bundle.question).toBe("what calls processUser function");
      expect(bundle.seeds).toBeDefined();
      expect(bundle.formattedContext).toBeDefined();
    });

    it("executes hybrid retrieval for mixed question", async () => {
      const bundle = await hybridRetrieve({
        connectedRepoId: repoId,
        question: "explain user data processing and where it is defined",
      });

      expect(bundle.question).toBe("explain user data processing and where it is defined");
      expect(bundle.rankedNodes).toBeDefined();
    });
  });
});
