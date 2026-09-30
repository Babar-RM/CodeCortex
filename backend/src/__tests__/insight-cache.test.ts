import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkInsightCache, writeInsightCache } from "../lib/insight-cache";
import { prisma } from "../lib/prisma";
import * as parserClient from "../lib/parser-client";
import { runMultiAgentPipeline } from "../lib/agents/orchestrator";
import * as criticModule from "../lib/agents/critic";
import * as plannerModule from "../lib/agents/planner";
import * as explainerModule from "../lib/agents/explainer";

vi.mock("../lib/prisma", () => ({
  withRetry: (fn: () => unknown) => fn(),
  prisma: {
    insightCache: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    indexingJob: {
      findFirst: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("../lib/parser-client", () => ({
  embedTextsWithService: vi.fn(),
}));

vi.mock("../lib/agents/planner", () => ({
  planQuestion: vi.fn(),
}));

vi.mock("../lib/agents/explainer", () => ({
  runExplainerAgent: vi.fn(),
}));

vi.mock("../lib/agents/critic", () => ({
  critiqueDraft: vi.fn(),
}));

describe("Phase 4 Step 17 — Insight Cache (RFC 0017)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("writeInsightCache", () => {
    it("should write a new InsightCache record and execute raw vector UPDATE", async () => {
      vi.mocked(parserClient.embedTextsWithService).mockResolvedValue([[0.1, 0.2, 0.3]]);
      vi.mocked(prisma.insightCache.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight_123",
        connectedRepoId: "repo_1",
        question: "How does authentication work?",
        answer: "Authentication uses GitHub OAuth and JWT cookies.",
        questionType: "explain",
        verifiedAtCommitSha: "commit_abc",
        referencedNodeIds: ["func_auth"],
        createdAt: new Date(),
        lastServedAt: new Date(),
        hitCount: 0,
      });

      const insightId = await writeInsightCache({
        connectedRepoId: "repo_1",
        question: "How does authentication work?",
        answer: "Authentication uses GitHub OAuth and JWT cookies.",
        questionType: "explain",
        verifiedAtCommitSha: "commit_abc",
        referencedNodeIds: ["func_auth"],
      });

      expect(insightId).toBe("insight_123");
      expect(prisma.insightCache.create).toHaveBeenCalledWith({
        data: {
          connectedRepoId: "repo_1",
          question: "How does authentication work?",
          answer: "Authentication uses GitHub OAuth and JWT cookies.",
          questionType: "explain",
          verifiedAtCommitSha: "commit_abc",
          referencedNodeIds: ["func_auth"],
        },
      });
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });
  });

  describe("checkInsightCache", () => {
    it("should return hit: true and update lastServedAt when similarity >= threshold", async () => {
      vi.mocked(parserClient.embedTextsWithService).mockResolvedValue([[0.1, 0.2, 0.3]]);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([
        {
          id: "insight_123",
          question: "How does auth work?",
          answer: "Authentication uses Auth.js and GitHub OAuth.",
          questionType: "explain",
          verifiedAtCommitSha: "commit_abc",
          distance: 0.05, // similarity = 1 - 0.05 = 0.95 >= 0.85
        },
      ]);
      vi.mocked(prisma.insightCache.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await checkInsightCache({
        connectedRepoId: "repo_1",
        question: "Explain authentication flow",
        verifiedAtCommitSha: "commit_abc",
      });

      expect(result.hit).toBe(true);
      expect(result.cachedAnswer).toBe("Authentication uses Auth.js and GitHub OAuth.");
      expect(result.questionType).toBe("explain");
      expect(result.insightId).toBe("insight_123");
      expect(result.similarity).toBeCloseTo(0.95);
      expect(prisma.insightCache.update).toHaveBeenCalledWith({
        where: { id: "insight_123" },
        data: {
          lastServedAt: expect.any(Date),
          hitCount: { increment: 1 },
        },
      });
    });

    it("should return hit: false when similarity is below threshold", async () => {
      vi.mocked(parserClient.embedTextsWithService).mockResolvedValue([[0.1, 0.2, 0.3]]);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([
        {
          id: "insight_456",
          question: "What is database schema?",
          answer: "Schema includes user, repo, embeddings.",
          questionType: "explain",
          verifiedAtCommitSha: "commit_abc",
          distance: 0.3, // similarity = 1 - 0.3 = 0.70 < 0.85
        },
      ]);

      const result = await checkInsightCache({
        connectedRepoId: "repo_1",
        question: "How does auth work?",
        verifiedAtCommitSha: "commit_abc",
        similarityThreshold: 0.85,
      });

      expect(result.hit).toBe(false);
      expect(prisma.insightCache.update).not.toHaveBeenCalled();
    });

    it("should fall back gracefully to text comparison if embedding service is offline", async () => {
      vi.mocked(parserClient.embedTextsWithService).mockResolvedValue([]);
      vi.mocked(prisma.insightCache.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "insight_789",
          question: "How does auth work?",
          answer: "Auth uses GitHub OAuth.",
          questionType: "explain",
          verifiedAtCommitSha: "commit_abc",
          referencedNodeIds: [],
          createdAt: new Date(),
          lastServedAt: new Date(),
          hitCount: 1,
          connectedRepoId: "repo_1",
        },
      ]);

      const result = await checkInsightCache({
        connectedRepoId: "repo_1",
        question: "how does auth work?",
        verifiedAtCommitSha: "commit_abc",
      });

      expect(result.hit).toBe(true);
      expect(result.cachedAnswer).toBe("Auth uses GitHub OAuth.");
    });
  });

  describe("Multi-agent Orchestrator Caching Rules", () => {
    it("should short-circuit execution pipeline when cache hit occurs", async () => {
      vi.mocked(prisma.indexingJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ commitSha: "commit_abc" });
      vi.mocked(parserClient.embedTextsWithService).mockResolvedValue([[0.1, 0.2, 0.3]]);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([
        {
          id: "insight_999",
          question: "How does auth work?",
          answer: "Cached verified answer: GitHub OAuth",
          questionType: "explain",
          verifiedAtCommitSha: "commit_abc",
          distance: 0.02,
        },
      ]);

      const result = await runMultiAgentPipeline({
        connectedRepoId: "repo_1",
        question: "How does auth work?",
      });

      expect(result.isCached).toBe(true);
      expect(result.answer).toBe("Cached verified answer: GitHub OAuth");
      // Planner and Specialists must NOT be called on cache hit
      expect(plannerModule.planQuestion).not.toHaveBeenCalled();
      expect(explainerModule.runExplainerAgent).not.toHaveBeenCalled();
    });

    it("ONLY writes to cache when Critic verdict is 'approved', NEVER when 'unverifiable'", async () => {
      vi.mocked(prisma.indexingJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ commitSha: "commit_abc" });
      vi.mocked(parserClient.embedTextsWithService).mockResolvedValue([]); // cache miss
      vi.mocked(prisma.insightCache.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      vi.mocked(plannerModule.planQuestion).mockResolvedValue({
        type: "explain",
        reasoning: "Test explanation",
      });

      vi.mocked(explainerModule.runExplainerAgent).mockResolvedValue({
        specialistName: "Explainer",
        question: "Is X function called by Y?",
        answer: "Draft answer about code",
        toolCallsExecuted: [],
        iterationsUsed: 1,
      });

      // Critic returns unverifiable verdict
      vi.mocked(criticModule.critiqueDraft).mockResolvedValue({
        verdict: "unverifiable",
        answer: "Draft answer about code",
        caveat: "Cannot verify claim against Neo4j",
      });

      const result = await runMultiAgentPipeline({
        connectedRepoId: "repo_1",
        question: "Is X function called by Y?",
      });

      expect(result.criticVerdict).toBe("unverifiable");
      // Must NOT write to cache
      expect(prisma.insightCache.create).not.toHaveBeenCalled();
    });
  });
});
