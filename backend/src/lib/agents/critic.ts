import { Driver } from "neo4j-driver";
import { getNeo4jDriver } from "../neo4j";

export interface FactualClaim {
  type: "CALLS" | "DEFINES" | "INHERITS" | "IMPORTS";
  sourceEntity: string;
  targetEntity: string;
  filePath?: string;
  claimText: string;
}

export interface EvidenceItem {
  claim: string;
  filePath: string;
  startLine: number;
  endLine: number;
  graphNodeType: "Function" | "Class" | "File";
  graphNodeName: string;
}

export interface CritiqueResultApproved {
  verdict: "approved";
  answer: string;
  verifiedClaimsCount: number;
  evidence: EvidenceItem[];
}

export interface CritiqueResultRevise {
  verdict: "revise";
  feedback: string;
  failedClaims: FactualClaim[];
}

export interface CritiqueResultUnverifiable {
  verdict: "unverifiable";
  answer: string;
  caveat: string;
}

export type CritiqueResult =
  | CritiqueResultApproved
  | CritiqueResultRevise
  | CritiqueResultUnverifiable;

export interface CritiqueDraftParams {
  draftAnswer: string;
  connectedRepoId: string;
  question: string;
  revisionRound?: number;
  maxRevisionRounds?: number;
  customLlmCompletion?: (prompt: string) => Promise<string>;
  customDriver?: Driver;
}

export const DEFAULT_MAX_REVISION_ROUNDS = 3;

export const CLAIM_EXTRACTION_SYSTEM_PROMPT = `You are CodeCortex Claim Extraction Engine.
Your task is to extract discrete structural assertions from an AI-generated draft answer about a codebase.

CLAIM TYPES:
1. "CALLS": Claims that function A calls function B (e.g. "handleAuth calls verifyJwt").
2. "DEFINES": Claims that file F defines function/class C (e.g. "auth.ts defines handleAuth").
3. "INHERITS": Claims that class A extends/inherits class B (e.g. "UserController inherits BaseController").
4. "IMPORTS": Claims that file A imports file B (e.g. "routes.ts imports auth.ts").

RESPONSE FORMAT:
You MUST respond with a valid JSON array of claim objects:
[
  {
    "type": "CALLS" | "DEFINES" | "INHERITS" | "IMPORTS",
    "sourceEntity": "name of source entity",
    "targetEntity": "name of target entity",
    "claimText": "original sentence from answer"
  }
]
If there are no checkable structural claims, respond with [].`;

/**
 * Heuristic claim extractor for testing/offline environments
 */
export function extractClaimsHeuristically(draftAnswer: string): FactualClaim[] {
  const claims: FactualClaim[] = [];
  const lines = draftAnswer.split("\n");

  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;

    // Pattern 1: "X calls Y" or "X function calls Y"
    const callsMatch = text.match(/([a-zA-Z0-9_$]+)\s+(?:function\s+)?calls\s+([a-zA-Z0-9_$]+)/i);
    if (callsMatch) {
      claims.push({
        type: "CALLS",
        sourceEntity: callsMatch[1],
        targetEntity: callsMatch[2],
        claimText: text,
      });
      continue;
    }

    // Pattern 2: "X inherits from Y" or "X extends Y"
    const inheritsMatch = text.match(/([a-zA-Z0-9_$]+)\s+(?:inherits\s+from|extends)\s+([a-zA-Z0-9_$]+)/i);
    if (inheritsMatch) {
      claims.push({
        type: "INHERITS",
        sourceEntity: inheritsMatch[1],
        targetEntity: inheritsMatch[2],
        claimText: text,
      });
      continue;
    }

    // Pattern 3: "X defines Y" or "X file defines Y"
    const definesMatch = text.match(/([a-zA-Z0-9._$-]+)\s+defines\s+([a-zA-Z0-9_$]+)/i);
    if (definesMatch) {
      claims.push({
        type: "DEFINES",
        sourceEntity: definesMatch[1],
        targetEntity: definesMatch[2],
        claimText: text,
      });
      continue;
    }
  }

  return claims;
}

/**
 * Extracts factual structural claims from draft answer using LLM or heuristic fallback
 */
export async function extractFactualClaims(
  draftAnswer: string,
  customLlmCompletion?: (prompt: string) => Promise<string>
): Promise<FactualClaim[]> {
  if (!draftAnswer || draftAnswer.trim().length === 0) {
    return [];
  }

  if (customLlmCompletion) {
    try {
      const rawOutput = await customLlmCompletion(
        `${CLAIM_EXTRACTION_SYSTEM_PROMPT}\n\nDRAFT ANSWER:\n${draftAnswer}`
      );
      const jsonMatch = rawOutput.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as FactualClaim[];
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch {
      // Fall through to heuristic extraction
    }
  }

  return extractClaimsHeuristically(draftAnswer);
}

export interface VerifyClaimResult {
  isVerified: boolean;
  evidence?: EvidenceItem;
}

/**
 * Verifies a single factual claim against the Neo4j code graph (RFC 0015 & RFC 0019)
 */
export async function verifyClaimAgainstGraph(
  claim: FactualClaim,
  repoId: string,
  customDriver?: Driver
): Promise<VerifyClaimResult> {
  const driver = customDriver || getNeo4jDriver();
  let session;

  try {
    session = driver.session();

    switch (claim.type) {
      case "CALLS": {
        const res = await session.run(
          `
          MATCH (s:Function { repoId: $repoId, name: $src })-[:CALLS]->(t:Function { repoId: $repoId, name: $tgt })
          RETURN s.filePath AS filePath, s.startLine AS startLine, s.endLine AS endLine
          `,
          { repoId, src: claim.sourceEntity, tgt: claim.targetEntity }
        );
        if (res.records.length > 0) {
          const rec = res.records[0];
          const startLineVal = rec.get("startLine");
          const endLineVal = rec.get("endLine");
          return {
            isVerified: true,
            evidence: {
              claim: claim.claimText,
              filePath: rec.get("filePath") || claim.filePath || "unknown",
              startLine: typeof startLineVal?.toNumber === "function" ? startLineVal.toNumber() : (startLineVal || 1),
              endLine: typeof endLineVal?.toNumber === "function" ? endLineVal.toNumber() : (endLineVal || 1),
              graphNodeType: "Function",
              graphNodeName: claim.sourceEntity,
            },
          };
        }
        return { isVerified: false };
      }

      case "INHERITS": {
        const res = await session.run(
          `
          MATCH (c:Class { repoId: $repoId, name: $src })-[:INHERITS]->(p:Class { repoId: $repoId, name: $tgt })
          RETURN c.filePath AS filePath, c.startLine AS startLine, c.endLine AS endLine
          `,
          { repoId, src: claim.sourceEntity, tgt: claim.targetEntity }
        );
        if (res.records.length > 0) {
          const rec = res.records[0];
          const startLineVal = rec.get("startLine");
          const endLineVal = rec.get("endLine");
          return {
            isVerified: true,
            evidence: {
              claim: claim.claimText,
              filePath: rec.get("filePath") || claim.filePath || "unknown",
              startLine: typeof startLineVal?.toNumber === "function" ? startLineVal.toNumber() : (startLineVal || 1),
              endLine: typeof endLineVal?.toNumber === "function" ? endLineVal.toNumber() : (endLineVal || 1),
              graphNodeType: "Class",
              graphNodeName: claim.sourceEntity,
            },
          };
        }
        return { isVerified: false };
      }

      case "DEFINES": {
        const res = await session.run(
          `
          MATCH (f:File { repoId: $repoId })-[:DEFINES]->(t { repoId: $repoId, name: $tgt })
          WHERE f.path ENDS WITH $src OR f.path = $src
          RETURN f.path AS filePath, labels(t) AS labels, t.startLine AS startLine, t.endLine AS endLine
          `,
          { repoId, src: claim.sourceEntity, tgt: claim.targetEntity }
        );
        if (res.records.length > 0) {
          const rec = res.records[0];
          const labels = rec.get("labels") as string[];
          const isClass = Array.isArray(labels) && labels.includes("Class");
          const startLineVal = rec.get("startLine");
          const endLineVal = rec.get("endLine");
          return {
            isVerified: true,
            evidence: {
              claim: claim.claimText,
              filePath: rec.get("filePath") || claim.sourceEntity,
              startLine: typeof startLineVal?.toNumber === "function" ? startLineVal.toNumber() : (startLineVal || 1),
              endLine: typeof endLineVal?.toNumber === "function" ? endLineVal.toNumber() : (endLineVal || 1),
              graphNodeType: isClass ? "Class" : "Function",
              graphNodeName: claim.targetEntity,
            },
          };
        }
        return { isVerified: false };
      }

      case "IMPORTS": {
        const res = await session.run(
          `
          MATCH (f:File { repoId: $repoId })-[:IMPORTS]->(t:File { repoId: $repoId })
          WHERE f.path ENDS WITH $src AND t.path ENDS WITH $tgt
          RETURN f.path AS filePath
          `,
          { repoId, src: claim.sourceEntity, tgt: claim.targetEntity }
        );
        if (res.records.length > 0) {
          const rec = res.records[0];
          return {
            isVerified: true,
            evidence: {
              claim: claim.claimText,
              filePath: rec.get("filePath") || claim.sourceEntity,
              startLine: 1,
              endLine: 1,
              graphNodeType: "File",
              graphNodeName: claim.targetEntity,
            },
          };
        }
        return { isVerified: false };
      }

      default:
        return { isVerified: false };
    }
  } catch {
    return { isVerified: false };
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {
        // Ignore session close error
      }
    }
  }
}

/**
 * Main Critic Agent workflow (RFC 0015 & RFC 0019)
 * Extracts claims, checks each against Neo4j graph, and returns verdict with evidence data
 */
export async function critiqueDraft(params: CritiqueDraftParams): Promise<CritiqueResult> {
  const revisionRound = params.revisionRound ?? 1;
  const maxRevisionRounds = params.maxRevisionRounds ?? DEFAULT_MAX_REVISION_ROUNDS;

  // Step 1: Extract claims
  const claims = await extractFactualClaims(params.draftAnswer, params.customLlmCompletion);

  if (claims.length === 0) {
    return {
      verdict: "approved",
      answer: params.draftAnswer,
      verifiedClaimsCount: 0,
      evidence: [],
    };
  }

  // Step 2: Verify each claim against Neo4j graph and extract evidence
  const failedClaims: FactualClaim[] = [];
  const evidence: EvidenceItem[] = [];
  let verifiedCount = 0;

  for (const claim of claims) {
    const checkResult = await verifyClaimAgainstGraph(claim, params.connectedRepoId, params.customDriver);
    if (checkResult.isVerified) {
      verifiedCount++;
      if (checkResult.evidence) {
        evidence.push(checkResult.evidence);
      }
    } else {
      failedClaims.push(claim);
    }
  }

  // Step 3: Aggregate results & determine verdict
  if (failedClaims.length === 0) {
    return {
      verdict: "approved",
      answer: params.draftAnswer,
      verifiedClaimsCount: verifiedCount,
      evidence,
    };
  }

  // Check if iteration cap is reached
  if (revisionRound >= maxRevisionRounds) {
    return {
      verdict: "unverifiable",
      answer: params.draftAnswer,
      caveat: `[Warning: ${failedClaims.length} structural claim(s) in this answer could not be verified against the repository code graph.]`,
    };
  }

  // Generate specific revision feedback
  const feedbackLines = failedClaims.map(
    (c) => `- Unverified claim: "${c.claimText}" (Claimed relationship ${c.sourceEntity} ${c.type} ${c.targetEntity} does not exist in the Neo4j code graph).`
  );

  return {
    verdict: "revise",
    feedback: `The following structural claims in your draft answer could not be verified against the code graph:\n${feedbackLines.join("\n")}\nPlease revise your answer to state only verified graph relationships or explicitly clarify unverified assumptions.`,
    failedClaims,
  };
}

