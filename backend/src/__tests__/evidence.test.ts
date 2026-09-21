import { describe, it, expect, vi, beforeEach } from "vitest";
import { critiqueDraft, verifyClaimAgainstGraph, FactualClaim } from "../lib/agents/critic";
import { runMultiAgentPipeline } from "../lib/agents/orchestrator";
import * as plannerModule from "../lib/agents/planner";
import * as explainerModule from "../lib/agents/explainer";

vi.mock("../lib/prisma", () => ({
  withRetry: (fn: any) => fn(),
  prisma: {
    insightCache: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    indexingJob: {
      findFirst: vi.fn().mockResolvedValue({ commitSha: "commit_sha_123" }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("../lib/agents/planner", () => ({
  planQuestion: vi.fn(),
}));

vi.mock("../lib/agents/explainer", () => ({
  runExplainerAgent: vi.fn(),
}));

describe("Phase 4 Step 19 — Evidence Data in API Responses (RFC 0019)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("verifyClaimAgainstGraph & Evidence Extraction", () => {
    it("should extract evidence details for CALLS claim when verified against Neo4j", async () => {
      const mockSession = {
        run: vi.fn().mockResolvedValue({
          records: [
            {
              get: (key: string) => {
                if (key === "filePath") return "src/auth.ts";
                if (key === "startLine") return 15;
                if (key === "endLine") return 40;
                return null;
              },
            },
          ],
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockDriver = {
        session: () => mockSession,
      } as unknown as Parameters<typeof verifyClaimAgainstGraph>[2];

      const claim: FactualClaim = {
        type: "CALLS",
        sourceEntity: "handleAuth",
        targetEntity: "verifyJwt",
        claimText: "handleAuth calls verifyJwt",
      };

      const result = await verifyClaimAgainstGraph(claim, "repo_123", mockDriver);

      expect(result.isVerified).toBe(true);
      expect(result.evidence).toEqual({
        claim: "handleAuth calls verifyJwt",
        filePath: "src/auth.ts",
        startLine: 15,
        endLine: 40,
        graphNodeType: "Function",
        graphNodeName: "handleAuth",
      });
    });

    it("should extract evidence details for DEFINES claim when verified against Neo4j", async () => {
      const mockSession = {
        run: vi.fn().mockResolvedValue({
          records: [
            {
              get: (key: string) => {
                if (key === "filePath") return "src/user.ts";
                if (key === "labels") return ["Class"];
                if (key === "startLine") return 5;
                if (key === "endLine") return 30;
                return null;
              },
            },
          ],
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockDriver = {
        session: () => mockSession,
      } as unknown as Parameters<typeof verifyClaimAgainstGraph>[2];

      const claim: FactualClaim = {
        type: "DEFINES",
        sourceEntity: "user.ts",
        targetEntity: "UserController",
        claimText: "user.ts defines UserController",
      };

      const result = await verifyClaimAgainstGraph(claim, "repo_123", mockDriver);

      expect(result.isVerified).toBe(true);
      expect(result.evidence).toEqual({
        claim: "user.ts defines UserController",
        filePath: "src/user.ts",
        startLine: 5,
        endLine: 30,
        graphNodeType: "Class",
        graphNodeName: "UserController",
      });
    });
  });

  describe("critiqueDraft Evidence Retention", () => {
    it("should return approved verdict with evidence array attached", async () => {
      const mockSession = {
        run: vi.fn().mockResolvedValue({
          records: [
            {
              get: (key: string) => {
                if (key === "filePath") return "src/auth.ts";
                if (key === "startLine") return 10;
                if (key === "endLine") return 25;
                return null;
              },
            },
          ],
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockDriver = {
        session: () => mockSession,
      } as unknown as Parameters<typeof critiqueDraft>[0]["customDriver"];

      const result = await critiqueDraft({
        draftAnswer: "handleAuth calls verifyJwt in the authentication flow.",
        connectedRepoId: "repo_123",
        question: "How does auth work?",
        customDriver: mockDriver,
      });

      expect(result.verdict).toBe("approved");
      if (result.verdict === "approved") {
        expect(result.verifiedClaimsCount).toBe(1);
        expect(result.evidence).toHaveLength(1);
        expect(result.evidence[0]).toEqual({
          claim: "handleAuth calls verifyJwt in the authentication flow.",
          filePath: "src/auth.ts",
          startLine: 10,
          endLine: 25,
          graphNodeType: "Function",
          graphNodeName: "handleAuth",
        });
      }
    });
  });

  describe("runMultiAgentPipeline Evidence Threading", () => {
    it("should return evidence array in final PipelineResult and SSE notifications", async () => {
      vi.mocked(plannerModule.planQuestion).mockResolvedValue({
        type: "explain",
        reasoning: "Explanation plan",
      });

      vi.mocked(explainerModule.runExplainerAgent).mockResolvedValue({
        specialistName: "Explainer",
        question: "Explain auth flow",
        answer: "handleAuth calls verifyJwt in src/auth.ts",
        toolCallsExecuted: [],
        iterationsUsed: 1,
      });

      const mockSession = {
        run: vi.fn().mockResolvedValue({
          records: [
            {
              get: (key: string) => {
                if (key === "filePath") return "src/auth.ts";
                if (key === "startLine") return 12;
                if (key === "endLine") return 35;
                return null;
              },
            },
          ],
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockDriver = {
        session: () => mockSession,
      } as unknown as Parameters<typeof runMultiAgentPipeline>[0]["customDriver"];

      const events: Array<{ type: string; evidence?: unknown }> = [];

      const result = await runMultiAgentPipeline({
        connectedRepoId: "repo_123",
        question: "Explain auth flow",
        skipCache: true,
        customDriver: mockDriver,
        onProgress: (evt) => events.push(evt),
      });

      expect(result.criticVerdict).toBe("approved");
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence![0].graphNodeName).toBe("handleAuth");

      const answerEvent = events.find((e) => e.type === "answer");
      expect(answerEvent).toBeDefined();
      expect(answerEvent?.evidence).toBeDefined();
    });
  });
});
