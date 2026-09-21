import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth";
import { rateLimitUser } from "../middleware/rateLimit";
import { prisma } from "../lib/prisma";
import { indexRepoQueue } from "../jobs/queue";


export const connectRepoSchema = z.object({
  fullName: z
    .string()
    .min(1)
    .regex(/^[^/]+\/[^/]+$/, "Expected 'owner/repo'"),
  htmlUrl: z.string().url(),
  isPrivate: z.boolean().default(false),
  defaultBranch: z.string().default("main"),
  installationId: z.string().optional(),
});

export const reposRouter = Router();

reposRouter.use(requireAuth);

/**
 * GET /api/repos/github
 * Fetches accessible repositories from GitHub's REST API using the session access token.
 */
reposRouter.get("/github", async (req: Request, res: Response) => {
  if (!req.githubAccessToken) {
    return res.status(401).json({ error: "Missing GitHub access token" });
  }

  try {
    const response = await fetch("https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member", {
      headers: {
        Authorization: `Bearer ${req.githubAccessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "CodeCortex-Backend",
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: "Failed to fetch repositories from GitHub" });
    }

    interface GitHubRepoItem {
      id: number;
      name: string;
      full_name: string;
      html_url: string;
      private: boolean;
      default_branch: string;
      description?: string | null;
      updated_at?: string;
    }

    const data = (await response.json()) as GitHubRepoItem[];

    const repos = data.map((repo) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      htmlUrl: repo.html_url,
      isPrivate: repo.private,
      defaultBranch: repo.default_branch,
      description: repo.description || null,
      updatedAt: repo.updated_at,
    }));

    return res.status(200).json({ repos });
  } catch (error) {
    console.error("Error fetching GitHub repos:", error);
    return res.status(500).json({ error: "Failed to communicate with GitHub API" });
  }
});

/**
 * POST /api/repos
 * Validates repo payload, upserts ConnectedRepo, and creates a PENDING IndexingJob.
 */
reposRouter.post(
  "/",
  rateLimitUser({ action: "index_repo", maxRequests: 5, windowSeconds: 3600 }),
  async (req: Request, res: Response) => {
  const parseResult = connectRepoSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: "Invalid request payload",
      details: parseResult.error.format(),
    });
  }

  const { fullName, htmlUrl, isPrivate, defaultBranch, installationId } = parseResult.data;
  const userId = req.user!.id;

  try {
    const repo = await prisma.connectedRepo.upsert({
      where: {
        userId_fullName: {
          userId,
          fullName,
        },
      },
      update: {
        htmlUrl,
        isPrivate,
        defaultBranch,
        ...(installationId ? { installationId } : {}),
      },
      create: {
        userId,
        fullName,
        htmlUrl,
        isPrivate,
        defaultBranch,
        installationId,
      },
    });

    const job = await prisma.indexingJob.create({
      data: {
        connectedRepoId: repo.id,
        status: "PENDING",
        progressMessage: "Queued for indexing",
      },
    });

    try {
      await indexRepoQueue.add("index-repo", {
        indexingJobId: job.id,
        connectedRepoId: repo.id,
      });
    } catch (queueErr) {
      console.warn("[repos] Warning: Could not enqueue job to Redis:", queueErr);
    }

    return res.status(201).json({ repo, job });

  } catch (error) {
    console.error("Error connecting repo:", error);
    return res.status(500).json({ error: "Failed to connect repository" });
  }
});

/**
 * GET /api/repos
 * Returns all connected repositories for the user with their latest indexing job status.
 */
reposRouter.get("/", async (req: Request, res: Response) => {
  const userId = req.user!.id;

  try {
    const repos = await prisma.connectedRepo.findMany({
      where: { userId },
      include: {
        indexingJobs: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.status(200).json({ repos });
  } catch (error) {
    console.error("Error fetching connected repos:", error);
    return res.status(500).json({ error: "Failed to fetch connected repositories" });
  }
});
