import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import { fetchRepo } from "../jobs/pipeline/fetch-repo";
import { processIndexingJob } from "../jobs/worker";
import { getInstallationAccessToken } from "../lib/github-app";
import { prisma } from "../lib/prisma";
import { Job } from "bullmq";
import simpleGit from "simple-git";

vi.mock("simple-git");

vi.mock("../lib/prisma", () => ({
  withRetry: (fn: () => unknown) => fn(),
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

vi.mock("../jobs/pipeline/parse-files", () => ({
  parseFiles: vi.fn().mockResolvedValue({ symbolFacts: [] }),
}));

vi.mock("../jobs/pipeline/build-graph", () => ({
  buildGraph: vi.fn().mockResolvedValue({ nodesCreated: 0, relationshipsCreated: 0 }),
}));

vi.mock("../jobs/pipeline/generate-embeddings", () => ({
  generateEmbeddings: vi.fn().mockResolvedValue({ embeddingsStored: 0 }),
}));

describe("Private Repository Access & Installation Token Policy (RFC 0021)", () => {
  const mockPrivateRepo = {
    id: "repo_private_123",
    userId: "user_123",
    fullName: "octocat/secret-project",
    htmlUrl: "https://github.com/octocat/secret-project",
    isPrivate: true,
    installationId: "inst_777",
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

    const mockGitInstance = {
      clone: vi.fn().mockImplementation(async (_url: string, targetPath: string) => {
        await fs.promises.mkdir(targetPath, { recursive: true });
      }),
      revparse: vi.fn().mockResolvedValue("abc123def456"),
      raw: vi.fn().mockResolvedValue(""),
    };
    vi.mocked(simpleGit).mockReturnValue(mockGitInstance as unknown as ReturnType<typeof simpleGit>);
  });

  it("should generate synthetic installation token when env variables are not set", async () => {
    const token = await getInstallationAccessToken({ installationId: "inst_777" });
    expect(token).toBe("ghs_synthetic_inst_777");
  });

  it("should construct authenticated clone URL in fetchRepo when accessToken is provided", async () => {
    const gitMock = simpleGit();
    const result = await fetchRepo({
      indexingJobId: "job_priv_999",
      htmlUrl: mockPrivateRepo.htmlUrl,
      isPrivate: true,
      defaultBranch: mockPrivateRepo.defaultBranch,
      accessToken: "ghs_test_token_123",
    });

    expect(gitMock.clone).toHaveBeenCalledWith(
      "https://x-access-token:ghs_test_token_123@github.com/octocat/secret-project",
      expect.stringContaining("workspace-job_priv_999"),
      expect.arrayContaining(["--depth", "1", "--branch", "main"])
    );
    expect(result.commitSha).toBe("abc123def456");
  });

  it("should process indexing job for private repo using installation token without erroring", async () => {
    vi.mocked(prisma.connectedRepo.findUnique).mockResolvedValue(mockPrivateRepo);

    await processIndexingJob(mockJob);

    expect(prisma.indexingJob.update).toHaveBeenCalledWith({
      where: { id: "job_priv_999" },
      data: expect.objectContaining({
        status: "SUCCEEDED",
        progressMessage: "Indexing completed successfully.",
      }),
    });
  });
});

