import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import fs from "fs";
import { parseFiles } from "../jobs/pipeline/parse-files";
import { buildGraph } from "../jobs/pipeline/build-graph";
import { generateEmbeddings } from "../jobs/pipeline/generate-embeddings";
import { parseFileWithService } from "../lib/parser-client";

vi.mock("../lib/parser-client", () => ({
  parseFileWithService: vi.fn(),
  embedTextsWithService: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
    codeEmbedding: {
      create: vi.fn().mockResolvedValue({ id: "emb-1" }),
      createMany: vi.fn().mockResolvedValue({ count: 3 }),
    },
  },
}));

vi.mock("../lib/neo4j", () => ({
  getNeo4jDriver: vi.fn().mockReturnValue({
    session: () => ({
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  }),
}));

describe("Phase 5 Step 23: End-to-End Fixture Pipeline Test (RFC 0023)", () => {
  const fixturePath = path.join(__dirname, "fixtures", "sample-repo");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should load fixture files and execute parseFiles stage deterministically", async () => {
    const authPath = path.join(fixturePath, "auth.ts");
    const helpersPath = path.join(fixturePath, "helpers.ts");
    const basePath = path.join(fixturePath, "base.ts");

    expect(fs.existsSync(authPath)).toBe(true);
    expect(fs.existsSync(helpersPath)).toBe(true);
    expect(fs.existsSync(basePath)).toBe(true);

    vi.mocked(parseFileWithService)
      .mockResolvedValueOnce({
        file_path: "auth.ts",
        language: "typescript",
        functions: [{ name: "handleAuth", start_line: 10, end_line: 12 }],
        classes: [{ name: "AuthManager", heritage: ["BaseManager"], start_line: 4, end_line: 8 }],
        imports: [{ source_path: "./helpers", imported_names: ["verifyToken"] }],
        calls: [{ caller_name: "handleAuth", callee_name: "verifyToken", line_number: 11 }],
        error: null,
      })
      .mockResolvedValueOnce({
        file_path: "helpers.ts",
        language: "typescript",
        functions: [{ name: "verifyToken", start_line: 1, end_line: 3 }],
        classes: [],
        imports: [],
        calls: [],
        error: null,
      })
      .mockResolvedValueOnce({
        file_path: "base.ts",
        language: "typescript",
        functions: [],
        classes: [{ name: "BaseManager", heritage: [], start_line: 1, end_line: 6 }],
        imports: [],
        calls: [],
        error: null,
      });

    const fileList = [
      { relativePath: "auth.ts", absolutePath: authPath, extension: ".ts", sizeBytes: 200 },
      { relativePath: "helpers.ts", absolutePath: helpersPath, extension: ".ts", sizeBytes: 100 },
      { relativePath: "base.ts", absolutePath: basePath, extension: ".ts", sizeBytes: 150 },
    ];

    const parseResult = await parseFiles({
      indexingJobId: "job-e2e-123",
      files: fileList,
    });

    expect(parseResult.totalParsedFiles).toBe(3);
    expect(parseResult.failedFiles).toBe(0);
    expect(parseResult.symbolFacts.length).toBe(3);

    // Verify buildGraph stage with extracted facts
    const graphResult = await buildGraph({
      repoId: "repo-e2e-123",
      repoName: "sample-repo",
      facts: parseResult.symbolFacts,
    });

    expect(graphResult).toBeDefined();
    expect(graphResult.filesProcessed).toBe(3);

    // Verify generateEmbeddings stage
    const embeddingResult = await generateEmbeddings({
      repoId: "repo-e2e-123",
      facts: parseResult.symbolFacts,
    });

    expect(embeddingResult).toBeDefined();
    expect(embeddingResult.totalEmbeddingsSaved).toBeGreaterThan(0);
  });
});
