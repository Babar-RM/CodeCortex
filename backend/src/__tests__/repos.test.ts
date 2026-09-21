import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../index";
import { prisma } from "../lib/prisma";
import * as authExpress from "@auth/express";
import { connectRepoSchema } from "../routes/repos";

vi.mock("@auth/express", async () => {
  const actual = await vi.importActual<typeof import("@auth/express")>("@auth/express");
  return {
    ...actual,
    getSession: vi.fn(),
    ExpressAuth: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  };
});

vi.mock("../middleware/rateLimit", () => ({
  rateLimitUser: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/prisma", () => ({
  withRetry: (fn: any) => fn(),
  prisma: {
    user: {
      upsert: vi.fn(),
    },
    connectedRepo: {
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
    indexingJob: {
      create: vi.fn(),
    },
  },
}));

describe("Repo Connection API (RFC 0004)", () => {
  const mockUser = {
    id: "user_cuid_123",
    githubId: "123456",
    githubLogin: "octocat",
    email: "octocat@github.com",
    avatarUrl: "https://github.com/images/error/octocat_happy.gif",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockSession = {
    githubId: "123456",
    githubLogin: "octocat",
    avatarUrl: "https://github.com/images/error/octocat_happy.gif",
    githubAccessToken: "gho_mocktoken123456",
    user: { email: "octocat@github.com" },
    expires: "2099-01-01T00:00:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("connectRepoSchema Validation", () => {
    it("should pass for valid owner/repo payloads", () => {
      const result = connectRepoSchema.safeParse({
        fullName: "facebook/react",
        htmlUrl: "https://github.com/facebook/react",
        isPrivate: false,
        defaultBranch: "main",
      });
      expect(result.success).toBe(true);
    });

    it("should fail for invalid fullName formats", () => {
      const result = connectRepoSchema.safeParse({
        fullName: "invalid-name-without-slash",
        htmlUrl: "https://github.com/facebook/react",
      });
      expect(result.success).toBe(false);
    });

    it("should fail for invalid htmlUrl formats", () => {
      const result = connectRepoSchema.safeParse({
        fullName: "facebook/react",
        htmlUrl: "not-a-valid-url",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("POST /api/repos", () => {
    it("should return 401 Unauthorized when unauthenticated", async () => {
      vi.mocked(authExpress.getSession).mockResolvedValue(null);

      const response = await request(app).post("/api/repos").send({
        fullName: "octocat/Hello-World",
        htmlUrl: "https://github.com/octocat/Hello-World",
      });

      expect(response.status).toBe(401);
    });

    it("should return 400 Bad Request when payload is invalid", async () => {
      vi.mocked(authExpress.getSession).mockResolvedValue(mockSession as never);
      vi.mocked(prisma.user.upsert).mockResolvedValue(mockUser as never);

      const response = await request(app).post("/api/repos").send({
        fullName: "invalidrepo",
        htmlUrl: "https://github.com/octocat/Hello-World",
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid request payload");
    });

    it("should return 201 Created, upsert repo, and create PENDING indexing job", async () => {
      const mockRepo = {
        id: "repo_cuid_123",
        userId: mockUser.id,
        fullName: "octocat/Hello-World",
        htmlUrl: "https://github.com/octocat/Hello-World",
        isPrivate: false,
        defaultBranch: "main",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockJob = {
        id: "job_cuid_123",
        connectedRepoId: mockRepo.id,
        status: "PENDING",
        commitSha: null,
        progressMessage: "Queued for indexing",
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(authExpress.getSession).mockResolvedValue(mockSession as never);
      vi.mocked(prisma.user.upsert).mockResolvedValue(mockUser as never);
      vi.mocked(prisma.connectedRepo.upsert).mockResolvedValue(mockRepo as never);
      vi.mocked(prisma.indexingJob.create).mockResolvedValue(mockJob as never);

      const response = await request(app).post("/api/repos").send({
        fullName: "octocat/Hello-World",
        htmlUrl: "https://github.com/octocat/Hello-World",
        isPrivate: false,
        defaultBranch: "main",
      });

      expect(response.status).toBe(201);
      expect(response.body.repo.fullName).toBe("octocat/Hello-World");
      expect(response.body.job.status).toBe("PENDING");

      expect(prisma.connectedRepo.upsert).toHaveBeenCalledWith({
        where: {
          userId_fullName: {
            userId: mockUser.id,
            fullName: "octocat/Hello-World",
          },
        },
        update: {
          htmlUrl: "https://github.com/octocat/Hello-World",
          isPrivate: false,
          defaultBranch: "main",
        },
        create: {
          userId: mockUser.id,
          fullName: "octocat/Hello-World",
          htmlUrl: "https://github.com/octocat/Hello-World",
          isPrivate: false,
          defaultBranch: "main",
        },
      });

      expect(prisma.indexingJob.create).toHaveBeenCalledWith({
        data: {
          connectedRepoId: mockRepo.id,
          status: "PENDING",
          progressMessage: "Queued for indexing",
        },
      });
    });
  });

  describe("GET /api/repos", () => {
    it("should return 401 Unauthorized when unauthenticated", async () => {
      vi.mocked(authExpress.getSession).mockResolvedValue(null);

      const response = await request(app).get("/api/repos");
      expect(response.status).toBe(401);
    });

    it("should return connected repositories with latest indexing job", async () => {
      const mockConnectedRepos = [
        {
          id: "repo_1",
          userId: mockUser.id,
          fullName: "octocat/Hello-World",
          htmlUrl: "https://github.com/octocat/Hello-World",
          isPrivate: false,
          defaultBranch: "main",
          indexingJobs: [
            {
              id: "job_1",
              status: "PENDING",
              progressMessage: "Queued for indexing",
            },
          ],
        },
      ];

      vi.mocked(authExpress.getSession).mockResolvedValue(mockSession as never);
      vi.mocked(prisma.user.upsert).mockResolvedValue(mockUser as never);
      vi.mocked(prisma.connectedRepo.findMany).mockResolvedValue(mockConnectedRepos as never);

      const response = await request(app).get("/api/repos");

      expect(response.status).toBe(200);
      expect(response.body.repos).toHaveLength(1);
      expect(response.body.repos[0].fullName).toBe("octocat/Hello-World");
      expect(response.body.repos[0].indexingJobs[0].status).toBe("PENDING");
    });
  });

  describe("GET /api/repos/github", () => {
    it("should return 401 if githubAccessToken is missing", async () => {
      const sessionWithoutToken = { ...mockSession, githubAccessToken: undefined };
      vi.mocked(authExpress.getSession).mockResolvedValue(sessionWithoutToken as never);
      vi.mocked(prisma.user.upsert).mockResolvedValue(mockUser as never);

      const response = await request(app).get("/api/repos/github");
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Missing GitHub access token");
    });

    it("should fetch and map user repositories from GitHub API", async () => {
      vi.mocked(authExpress.getSession).mockResolvedValue(mockSession as never);
      vi.mocked(prisma.user.upsert).mockResolvedValue(mockUser as never);

      const mockGithubApiResponse = [
        {
          id: 1296269,
          name: "Hello-World",
          full_name: "octocat/Hello-World",
          private: false,
          html_url: "https://github.com/octocat/Hello-World",
          description: "This your first repo!",
          default_branch: "master",
          updated_at: "2026-08-01T00:00:00Z",
        },
      ];

      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => mockGithubApiResponse,
      } as Response);

      const response = await request(app).get("/api/repos/github");

      expect(response.status).toBe(200);
      expect(response.body.repos).toHaveLength(1);
      expect(response.body.repos[0]).toEqual({
        id: 1296269,
        name: "Hello-World",
        fullName: "octocat/Hello-World",
        htmlUrl: "https://github.com/octocat/Hello-World",
        isPrivate: false,
        defaultBranch: "master",
        description: "This your first repo!",
        updatedAt: "2026-08-01T00:00:00Z",
      });

      fetchSpy.mockRestore();
    });
  });
});
