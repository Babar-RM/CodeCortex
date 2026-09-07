import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractCodeChunks,
  generateEmbeddings,
  searchSemantic,
  DEFAULT_BATCH_SIZE,
} from "../jobs/pipeline/generate-embeddings";
import * as parserClient from "../lib/parser-client";
import { prisma } from "../lib/prisma";

vi.mock("../lib/prisma", () => ({
  prisma: {
    codeEmbedding: {
      create: vi.fn().mockImplementation(async (args) => ({
        id: "embedding_uuid_123",
        ...args.data,
        createdAt: new Date(),
      })),
      findMany: vi.fn().mockResolvedValue([
        {
          id: "embedding_uuid_123",
          connectedRepoId: "repo_123",
          entityType: "function",
          entityName: "calculateTotal",
          filePath: "src/calculator.ts",
          contentChunk: "function calculateTotal(items)",
          createdAt: new Date(),
        },
      ]),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([
      {
        id: "embedding_uuid_123",
        entityType: "function",
        entityName: "calculateTotal",
        filePath: "src/calculator.ts",
        contentChunk: "function calculateTotal(items)",
        distance: 0.12,
      },
    ]),
  },
}));

describe("Pipeline Stage 4: generateEmbeddings (RFC 0008)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should extract structured code chunks from ExtractedFacts array", () => {
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
        imports: [],
        calls: [],
        error: null,
      },
    ];

    const chunks = extractCodeChunks(mockFacts);

    expect(chunks).toHaveLength(3); // 1 file, 1 function, 1 class

    expect(chunks[0].entityType).toBe("file");
    expect(chunks[0].entityName).toBe("src/calculator.ts");

    expect(chunks[1].entityType).toBe("function");
    expect(chunks[1].entityName).toBe("calculateTotal");
    expect(chunks[1].contentChunk).toContain("function calculateTotal(items): number");

    expect(chunks[2].entityType).toBe("class");
    expect(chunks[2].entityName).toBe("Calculator");
    expect(chunks[2].contentChunk).toContain("class Calculator extends BaseCalculator");
  });

  it("should batch chunk texts, request embeddings, and save records to Prisma", async () => {
    const mockFacts = [
      {
        filePath: "src/app.ts",
        language: "typescript",
        functions: [{ name: "run", startLine: 1, endLine: 5, params: [] }],
        classes: [],
        imports: [],
        calls: [],
        error: null,
      },
    ];

    vi.spyOn(parserClient, "embedTextsWithService").mockResolvedValue([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);

    const result = await generateEmbeddings({
      repoId: "repo_123",
      facts: mockFacts,
      batchSize: 50,
    });

    expect(result.totalChunksCreated).toBe(2);
    expect(result.totalEmbeddingsSaved).toBe(2);
    expect(prisma.codeEmbedding.create).toHaveBeenCalledTimes(2);
  });

  it("should execute parameterized vector search query scoped by repoId", async () => {
    const queryVector = Array(384).fill(0.01);
    const results = await searchSemantic("repo_123", queryVector, 5);

    expect(results).toHaveLength(1);
    expect(results[0].entityName).toBe("calculateTotal");
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it("should define DEFAULT_BATCH_SIZE constant as 50", () => {
    expect(DEFAULT_BATCH_SIZE).toBe(50);
  });
});
