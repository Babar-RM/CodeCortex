import { describe, it, expect, vi, beforeEach } from "vitest";
import { processIndexingJob } from "../jobs/worker";
import { indexRepoQueue } from "../jobs/queue";
import { prisma } from "../lib/prisma";
import * as fetchRepoModule from "../jobs/pipeline/fetch-repo";
import * as parseFilesModule from "../jobs/pipeline/parse-files";
import * as buildGraphModule from "../jobs/pipeline/build-graph";
import * as generateEmbeddingsModule from "../jobs/pipeline/generate-embeddings";
import { Job } from "bullmq";

vi.mock("../lib/prisma", () => ({
  withRetry: (fn: any) => fn(),
  prisma: {
    connectedRepo: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    indexingJob: {
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../jobs/pipeline/fetch-repo", () => ({
  fetchRepo: vi.fn(),
  cleanupRepo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../jobs/pipeline/parse-files", () => ({
  parseFiles: vi.fn(),
}));

vi.mock("../jobs/pipeline/build-graph", () => ({
  buildGraph: vi.fn(),
}));

vi.mock("../jobs/pipeline/generate-embeddings", () => ({
  generateEmbeddings: vi.fn(),
}));

describe("Pipeline Orchestration & Worker Process (RFC 0009)", () => {
  const mockRepo = {
    id: "repo_123",
    userId: "user_123",
    fullName: "octocat/hello-world",
    htmlUrl: "https://github.com/octocat/hello-world",
    isPrivate: false,
    installationId: null,
    defaultBranch: "main",
    lastIndexedCommitSha: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockJob = {
    id: "job_999",
    data: {
      indexingJobId: "job_999",
      connectedRepoId: "repo_123",
    },
  } as Job;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should define indexRepoQueue with index-repo name", () => {
    expect(indexRepoQueue.name).toBe("index-repo");
  });

  it("should execute pipeline stages 5 to 8 sequentially and set status to SUCCEEDED", async () => {
    vi.mocked(prisma.connectedRepo.findUnique).mockResolvedValue(mockRepo);

    vi.mocked(fetchRepoModule.fetchRepo).mockResolvedValue({
      workspacePath: "backend/tmp/workspace-job_999",
      commitSha: "sha123456",
      files: [{ relativePath: "index.ts", absolutePath: "/tmp/index.ts", extension: ".ts", sizeBytes: 100 }],
    });

    vi.mocked(parseFilesModule.parseFiles).mockResolvedValue({
      totalParsedFiles: 1,
      failedFiles: 0,
      symbolFacts: [
        {
          filePath: "index.ts",
          language: "typescript",
          functions: [],
          classes: [],
          imports: [],
          calls: [],
          error: null,
        },
      ],
    });

    vi.mocked(buildGraphModule.buildGraph).mockResolvedValue({
      nodesCreated: 2,
      relationshipsCreated: 1,
      filesProcessed: 1,
    });

    vi.mocked(generateEmbeddingsModule.generateEmbeddings).mockResolvedValue({
      totalChunksCreated: 1,
      totalEmbeddingsSaved: 1,
    });

    await processIndexingJob(mockJob);

    // Verify pipeline function invocations
    expect(fetchRepoModule.fetchRepo).toHaveBeenCalledWith({
      indexingJobId: "job_999",
      htmlUrl: mockRepo.htmlUrl,
      defaultBranch: mockRepo.defaultBranch,
      isPrivate: false,
    });
    expect(parseFilesModule.parseFiles).toHaveBeenCalled();
    expect(buildGraphModule.buildGraph).toHaveBeenCalledWith({
      repoId: "repo_123",
      repoName: "octocat/hello-world",
      facts: expect.any(Array),
    });
    expect(generateEmbeddingsModule.generateEmbeddings).toHaveBeenCalledWith({
      repoId: "repo_123",
      facts: expect.any(Array),
    });

    // Verify status transition progression to SUCCEEDED
    expect(prisma.indexingJob.update).toHaveBeenCalledWith({
      where: { id: "job_999" },
      data: expect.objectContaining({
        status: "SUCCEEDED",
        progressMessage: "Indexing completed successfully.",
      }),
    });

    // Verify workspace cleanup block
    expect(fetchRepoModule.cleanupRepo).toHaveBeenCalledWith("backend/tmp/workspace-job_999");
  });

  it("should catch pipeline stage errors, set status to FAILED, and clean up workspace", async () => {
    vi.mocked(prisma.connectedRepo.findUnique).mockResolvedValue(mockRepo);

    vi.mocked(fetchRepoModule.fetchRepo).mockResolvedValue({
      workspacePath: "backend/tmp/workspace-job_999",
      commitSha: "sha123456",
      files: [],
    });

    vi.mocked(parseFilesModule.parseFiles).mockRejectedValue(new Error("Parser microservice un-reachable"));

    await expect(processIndexingJob(mockJob)).rejects.toThrow("Parser microservice un-reachable");

    // Verify status transition to FAILED
    expect(prisma.indexingJob.update).toHaveBeenCalledWith({
      where: { id: "job_999" },
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: "Parser microservice un-reachable",
      }),
    });

    // Verify cleanup runs even on pipeline failure
    expect(fetchRepoModule.cleanupRepo).toHaveBeenCalledWith("backend/tmp/workspace-job_999");
  });
});
