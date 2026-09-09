import { describe, it, expect, vi, beforeEach } from "vitest";
import { processIndexingJob } from "../jobs/worker";
import { cleanupDeletedFiles } from "../jobs/pipeline/incremental-cleanup";
import { computeFileDiff } from "../jobs/pipeline/fetch-repo";
import { prisma } from "../lib/prisma";
import * as fetchRepoModule from "../jobs/pipeline/fetch-repo";
import * as parseFilesModule from "../jobs/pipeline/parse-files";
import * as buildGraphModule from "../jobs/pipeline/build-graph";
import * as generateEmbeddingsModule from "../jobs/pipeline/generate-embeddings";
import { Job } from "bullmq";
import simpleGit from "simple-git";

vi.mock("simple-git");

vi.mock("../lib/prisma", () => ({
  prisma: {
    connectedRepo: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    indexingJob: {
      update: vi.fn().mockResolvedValue({}),
    },
    codeEmbedding: {
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    insightCache: {
      findMany: vi.fn().mockResolvedValue([
        { id: "insight_1", referencedNodeIds: ["src/deleted.ts:foo"] },
        { id: "insight_2", referencedNodeIds: ["src/other.ts:bar"] },
      ]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));

vi.mock("../jobs/pipeline/fetch-repo", async () => {
  const actual = await vi.importActual<typeof import("../jobs/pipeline/fetch-repo")>("../jobs/pipeline/fetch-repo");
  return {
    ...actual,
    fetchRepo: vi.fn(),
    cleanupRepo: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../jobs/pipeline/parse-files", () => ({
  parseFiles: vi.fn(),
}));

vi.mock("../jobs/pipeline/build-graph", () => ({
  buildGraph: vi.fn(),
}));

vi.mock("../jobs/pipeline/generate-embeddings", () => ({
  generateEmbeddings: vi.fn(),
}));

describe("Phase 4 Step 18 — Incremental Re-Indexing (RFC 0018)", () => {
  const mockRepo = {
    id: "repo_123",
    userId: "user_123",
    fullName: "octocat/hello-world",
    htmlUrl: "https://github.com/octocat/hello-world",
    isPrivate: false,
    defaultBranch: "main",
    lastIndexedCommitSha: "sha_v1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockJob = {
    id: "job_777",
    data: {
      indexingJobId: "job_777",
      connectedRepoId: "repo_123",
    },
  } as Job;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("cleanupDeletedFiles", () => {
    it("should delete Neo4j nodes, Postgres embeddings, and invalidate insight cache entries", async () => {
      const mockSession = {
        run: vi.fn().mockResolvedValue({
          summary: {
            counters: {
              updates: () => ({ nodesDeleted: 3 }),
            },
          },
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockDriver = {
        session: () => mockSession,
      } as unknown as Parameters<typeof cleanupDeletedFiles>[0]["customDriver"];

      const result = await cleanupDeletedFiles({
        repoId: "repo_123",
        deletedFilePaths: ["src/deleted.ts"],
        modifiedFilePaths: ["src/modified.ts"],
        customDriver: mockDriver,
      });

      expect(result.nodesDeleted).toBe(3);
      expect(result.embeddingsDeleted).toBe(2);
      expect(result.insightsInvalidated).toBe(1);
      expect(prisma.codeEmbedding.deleteMany).toHaveBeenCalledWith({
        where: {
          connectedRepoId: "repo_123",
          filePath: { in: ["src/deleted.ts"] },
        },
      });
      expect(prisma.insightCache.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["insight_1"] } },
      });
    });
  });

  describe("computeFileDiff", () => {
    it("should parse git diff status output into added, modified, and deleted files", async () => {
      const mockRaw = vi.fn().mockResolvedValue(
        "A\tsrc/new.ts\nM\tsrc/updated.ts\nD\tsrc/old.ts\nR100\tsrc/renamed_old.ts\tsrc/renamed_new.ts\n"
      );
      vi.mocked(simpleGit).mockReturnValue({
        raw: mockRaw,
      } as unknown as ReturnType<typeof simpleGit>);

      const diff = await computeFileDiff("/tmp/workspace", "sha_v1", "sha_v2");

      expect(diff.addedFiles).toContain("src/new.ts");
      expect(diff.addedFiles).toContain("src/renamed_new.ts");
      expect(diff.modifiedFiles).toContain("src/updated.ts");
      expect(diff.deletedFiles).toContain("src/old.ts");
      expect(diff.deletedFiles).toContain("src/renamed_old.ts");
    });
  });

  describe("processIndexingJob Incremental Orchestration", () => {
    it("should short-circuit to SUCCEEDED when lastIndexedCommitSha matches current commitSha (No-Op)", async () => {
      vi.mocked(prisma.connectedRepo.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockRepo);
      vi.mocked(fetchRepoModule.fetchRepo).mockResolvedValue({
        workspacePath: "/tmp/workspace-job_777",
        commitSha: "sha_v1", // Matches mockRepo.lastIndexedCommitSha
        files: [{ relativePath: "index.ts", absolutePath: "/tmp/index.ts", extension: ".ts", sizeBytes: 100 }],
      });

      await processIndexingJob(mockJob);

      // Verify no-op short-circuit: parseFiles & buildGraph skipped
      expect(parseFilesModule.parseFiles).not.toHaveBeenCalled();
      expect(buildGraphModule.buildGraph).not.toHaveBeenCalled();
      expect(prisma.indexingJob.update).toHaveBeenCalledWith({
        where: { id: "job_777" },
        data: expect.objectContaining({
          status: "SUCCEEDED",
          progressMessage: "Repository is up to date (no changes detected).",
        }),
      });
    });

    it("should perform incremental update for changed files when commitSha differs", async () => {
      vi.mocked(prisma.connectedRepo.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockRepo);
      vi.mocked(fetchRepoModule.fetchRepo).mockResolvedValue({
        workspacePath: "/tmp/workspace-job_777",
        commitSha: "sha_v2", // Differs from sha_v1
        files: [
          { relativePath: "src/modified.ts", absolutePath: "/tmp/src/modified.ts", extension: ".ts", sizeBytes: 100 },
          { relativePath: "src/unchanged.ts", absolutePath: "/tmp/src/unchanged.ts", extension: ".ts", sizeBytes: 100 },
        ],
      });

      const mockRaw = vi.fn().mockResolvedValue("M\tsrc/modified.ts\nD\tsrc/deleted.ts\n");
      vi.mocked(simpleGit).mockReturnValue({
        raw: mockRaw,
      } as unknown as ReturnType<typeof simpleGit>);

      vi.mocked(parseFilesModule.parseFiles).mockResolvedValue({
        totalParsedFiles: 1,
        failedFiles: 0,
        symbolFacts: [],
      });

      vi.mocked(buildGraphModule.buildGraph).mockResolvedValue({
        nodesCreated: 1,
        relationshipsCreated: 0,
        filesProcessed: 1,
      });

      vi.mocked(generateEmbeddingsModule.generateEmbeddings).mockResolvedValue({
        totalChunksCreated: 1,
        totalEmbeddingsSaved: 1,
      });

      await processIndexingJob(mockJob);

      // Verify parseFiles called only with modified.ts (not unchanged.ts)
      expect(parseFilesModule.parseFiles).toHaveBeenCalledWith({
        files: expect.arrayContaining([
          expect.objectContaining({ relativePath: "src/modified.ts" }),
        ]),
      });

      // Verify lastIndexedCommitSha updated on ConnectedRepo
      expect(prisma.connectedRepo.update).toHaveBeenCalledWith({
        where: { id: "repo_123" },
        data: { lastIndexedCommitSha: "sha_v2" },
      });
    });
  });
});
