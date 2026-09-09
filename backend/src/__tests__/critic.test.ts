import { describe, it, expect, vi, beforeEach } from "vitest";
import { Driver } from "neo4j-driver";
import {
  extractClaimsHeuristically,
  extractFactualClaims,
  verifyClaimAgainstGraph,
  critiqueDraft,
  FactualClaim,
} from "../lib/agents/critic";

describe("Critic Agent Module (RFC 0015)", () => {
  const repoId = "repo_critic_123";

  // Mock Neo4j driver
  const mockSession = {
    run: vi.fn().mockImplementation(async (query: string, params: Record<string, string>) => {
      // Valid graph relationship: handleAuth calls verifyJwt
      if (
        query.includes("MATCH (s:Function") &&
        params.src === "handleAuth" &&
        params.tgt === "verifyJwt"
      ) {
        return { records: [{ get: () => "node" }] };
      }

      // Valid graph relationship: UserController inherits BaseController
      if (
        query.includes("MATCH (c:Class") &&
        params.src === "UserController" &&
        params.tgt === "BaseController"
      ) {
        return { records: [{ get: () => "node" }] };
      }

      // Valid graph relationship: auth.ts defines handleAuth
      if (
        query.includes("MATCH (f:File") &&
        params.src === "auth.ts" &&
        params.tgt === "handleAuth"
      ) {
        return { records: [{ get: () => "node" }] };
      }

      // Default: no matching records found in graph
      return { records: [] };
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockDriver = {
    session: () => mockSession,
  } as unknown as Driver;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Claim Extraction", () => {
    it("extracts CALLS, INHERITS, and DEFINES claims heuristically", () => {
      const text = `
        handleAuth calls verifyJwt to check access.
        UserController extends BaseController for HTTP handlers.
        auth.ts defines handleAuth for identity management.
        This sentence is general commentary.
      `;

      const claims = extractClaimsHeuristically(text);
      expect(claims).toHaveLength(3);
      expect(claims[0].type).toBe("CALLS");
      expect(claims[0].sourceEntity).toBe("handleAuth");
      expect(claims[0].targetEntity).toBe("verifyJwt");

      expect(claims[1].type).toBe("INHERITS");
      expect(claims[1].sourceEntity).toBe("UserController");

      expect(claims[2].type).toBe("DEFINES");
      expect(claims[2].targetEntity).toBe("handleAuth");
    });

    it("parses LLM JSON claim extraction response when custom completion is provided", async () => {
      const customLlm = vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            type: "CALLS",
            sourceEntity: "processOrder",
            targetEntity: "calculateTotal",
            claimText: "processOrder calls calculateTotal",
          },
        ])
      );

      const claims = await extractFactualClaims("Some answer text", customLlm);
      expect(claims).toHaveLength(1);
      expect(claims[0].sourceEntity).toBe("processOrder");
    });
  });

  describe("Graph Verification (verifyClaimAgainstGraph)", () => {
    it("returns true when relationship exists in Neo4j graph", async () => {
      const claim: FactualClaim = {
        type: "CALLS",
        sourceEntity: "handleAuth",
        targetEntity: "verifyJwt",
        claimText: "handleAuth calls verifyJwt",
      };

      const isVerified = await verifyClaimAgainstGraph(claim, repoId, mockDriver);
      expect(isVerified).toBe(true);
    });

    it("returns false when relationship does not exist in Neo4j graph", async () => {
      const claim: FactualClaim = {
        type: "CALLS",
        sourceEntity: "handleAuth",
        targetEntity: "fakeFunction",
        claimText: "handleAuth calls fakeFunction",
      };

      const isVerified = await verifyClaimAgainstGraph(claim, repoId, mockDriver);
      expect(isVerified).toBe(false);
    });
  });

  describe("Critique Workflow (critiqueDraft)", () => {
    it("returns 'approved' verdict when all claims verify against graph", async () => {
      const draft = "handleAuth calls verifyJwt to check user tokens.";
      const res = await critiqueDraft({
        draftAnswer: draft,
        connectedRepoId: repoId,
        question: "How does auth work?",
        customDriver: mockDriver,
      });

      expect(res.verdict).toBe("approved");
      if (res.verdict === "approved") {
        expect(res.answer).toBe(draft);
        expect(res.verifiedClaimsCount).toBe(1);
      }
    });

    it("returns 'revise' verdict with specific feedback when false claim is injected", async () => {
      const draft = "handleAuth calls nonExistentFunction to process credentials.";
      const res = await critiqueDraft({
        draftAnswer: draft,
        connectedRepoId: repoId,
        question: "How does auth work?",
        revisionRound: 1,
        maxRevisionRounds: 3,
        customDriver: mockDriver,
      });

      expect(res.verdict).toBe("revise");
      if (res.verdict === "revise") {
        expect(res.feedback).toContain("could not be verified against the code graph");
        expect(res.failedClaims).toHaveLength(1);
        expect(res.failedClaims[0].targetEntity).toBe("nonExistentFunction");
      }
    });

    it("returns 'unverifiable' verdict when revision cap (round 3) is reached", async () => {
      const draft = "handleAuth calls nonExistentFunction to process credentials.";
      const res = await critiqueDraft({
        draftAnswer: draft,
        connectedRepoId: repoId,
        question: "How does auth work?",
        revisionRound: 3, // At cap
        maxRevisionRounds: 3,
        customDriver: mockDriver,
      });

      expect(res.verdict).toBe("unverifiable");
      if (res.verdict === "unverifiable") {
        expect(res.caveat).toContain("could not be verified against the repository code graph");
        expect(res.answer).toBe(draft);
      }
    });

    it("returns 'approved' with 0 claims if draft contains no checkable structural claims", async () => {
      const draft = "This is general commentary explaining high level design without naming function calls.";
      const res = await critiqueDraft({
        draftAnswer: draft,
        connectedRepoId: repoId,
        question: "Overview query",
        customDriver: mockDriver,
      });

      expect(res.verdict).toBe("approved");
      if (res.verdict === "approved") {
        expect(res.verifiedClaimsCount).toBe(0);
      }
    });
  });
});
