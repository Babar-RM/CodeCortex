import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractFactualClaims,
  extractClaimsHeuristically,
  verifyClaimAgainstGraph,
  critiqueDraft,
  FactualClaim,
} from "../lib/agents/critic";
import { Driver } from "neo4j-driver";

describe("Phase 5 Step 23: Critic Claim Verification Unit Tests (RFC 0023)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockDriver = (records: any[]): Driver =>
    ({
      session: () => ({
        run: vi.fn().mockResolvedValue({ records }),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    } as unknown as Driver);

  it("should extract CALLS, INHERITS, and DEFINES claims heuristically from text", () => {
    const draftText = `
    handleAuth function calls verifyToken.
    AuthManager extends BaseManager.
    auth.ts defines handleAuth.
    `;

    const claims = extractClaimsHeuristically(draftText);
    expect(claims.length).toBe(3);

    const types = claims.map((c) => c.type);
    expect(types).toContain("CALLS");
    expect(types).toContain("INHERITS");
    expect(types).toContain("DEFINES");

    const callsClaim = claims.find((c) => c.type === "CALLS");
    expect(callsClaim?.sourceEntity).toBe("handleAuth");
    expect(callsClaim?.targetEntity).toBe("verifyToken");
  });

  it("should verify CALLS claim against Neo4j code graph when relationship exists", async () => {
    const claim: FactualClaim = {
      type: "CALLS",
      sourceEntity: "handleAuth",
      targetEntity: "verifyToken",
      claimText: "handleAuth calls verifyToken",
    };

    const mockDriver = createMockDriver([
      {
        get: (key: string) => {
          if (key === "filePath") return "src/auth.ts";
          if (key === "startLine") return 10;
          if (key === "endLine") return 12;
          return null;
        },
      },
    ]);

    const result = await verifyClaimAgainstGraph(claim, "repo-123", mockDriver);
    expect(result.isVerified).toBe(true);
    expect(result.evidence).toBeDefined();
    expect(result.evidence?.filePath).toBe("src/auth.ts");
    expect(result.evidence?.graphNodeName).toBe("handleAuth");
  });

  it("should return isVerified false when claim does not exist in Neo4j graph", async () => {
    const claim: FactualClaim = {
      type: "CALLS",
      sourceEntity: "handleAuth",
      targetEntity: "nonExistent",
      claimText: "handleAuth calls nonExistent",
    };

    const mockDriver = createMockDriver([]);
    const result = await verifyClaimAgainstGraph(claim, "repo-123", mockDriver);
    expect(result.isVerified).toBe(false);
  });

  it("should return approved verdict when all extracted claims pass graph verification", async () => {
    const draftAnswer = "handleAuth function calls verifyToken.";
    const mockDriver = createMockDriver([
      {
        get: (key: string) => {
          if (key === "filePath") return "src/auth.ts";
          if (key === "startLine") return 10;
          if (key === "endLine") return 12;
          return null;
        },
      },
    ]);

    const critique = await critiqueDraft({
      draftAnswer,
      connectedRepoId: "repo-123",
      question: "How does handleAuth work?",
      customDriver: mockDriver,
    });

    expect(critique.verdict).toBe("approved");
    if (critique.verdict === "approved") {
      expect(critique.verifiedClaimsCount).toBe(1);
      expect(critique.evidence.length).toBe(1);
      expect(critique.evidence[0].filePath).toBe("src/auth.ts");
    }
  });

  it("should return revise verdict when structural claim fails graph verification", async () => {
    const draftAnswer = "handleAuth function calls invalidFunction.";
    const mockDriver = createMockDriver([]); // No records found in Neo4j graph

    const critique = await critiqueDraft({
      draftAnswer,
      connectedRepoId: "repo-123",
      question: "How does handleAuth work?",
      revisionRound: 1,
      maxRevisionRounds: 3,
      customDriver: mockDriver,
    });

    expect(critique.verdict).toBe("revise");
    if (critique.verdict === "revise") {
      expect(critique.feedback).toContain("invalidFunction");
      expect(critique.failedClaims.length).toBe(1);
    }
  });
});
