import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchRepo } from "../jobs/pipeline/fetch-repo";
import { processIndexingJob } from "../jobs/worker";
import { prisma } from "../lib/prisma";
import { Job } from "bullmq";

vi.mock("../lib/prisma", () => ({
  prisma: {
    connectedRepo: {
      findUnique: vi.fn(),
    },
    indexingJob: {
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

describe("Private Repository Security Policy (RFC 0010 & Phase 1 Checkpoint)", () => {
  const mockPrivateRepo = {
    id: "repo_private_123",
    userId: "user_123",
    fullName: "octocat/secret-project",
    htmlUrl: "https://github.com/octocat/secret-project",
    isPrivate: true,
    defaultBranch: "main",
    lastIndexedCommitSha: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockJob = {
    id: "job_priv_999",
    data: {
      indexingJobId: "job_priv_999",
      connectedRepoId: "repo_private_123",
    },
  } as Job;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should throw an explicit security error in fetchRepo when isPrivate is true", async () => {
    await expect(
      fetchRepo({
        indexingJobId: "job_priv_999",
        htmlUrl: mockPrivateRepo.htmlUrl,
        isPrivate: true,
      })
    ).rejects.toThrow(
      "Private repositories are not supported in Phase 1 ingestion. GitHub access tokens are not persisted to database storage for security."
    );
  });

  it("should update IndexingJob status to FAILED with explicit message when a private repo is queued", async () => {
    vi.mocked(prisma.connectedRepo.findUnique).mockResolvedValue(mockPrivateRepo);

    await expect(processIndexingJob(mockJob)).rejects.toThrow(
      "Private repositories are not supported in Phase 1 ingestion"
    );

    expect(prisma.indexingJob.update).toHaveBeenCalledWith({
      where: { id: "job_priv_999" },
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: expect.stringContaining("Private repositories are not supported in Phase 1 ingestion"),
      }),
    });
  });
});
