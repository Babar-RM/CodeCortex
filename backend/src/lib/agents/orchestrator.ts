import { Driver } from "neo4j-driver";
import { prisma } from "../prisma";
import { checkInsightCache, writeInsightCache } from "../insight-cache";
import { planQuestion, QuestionType } from "./planner";
import { runExplainerAgent } from "./explainer";
import { runBugTracerAgent } from "./bug-tracer";
import { runReviewerAgent } from "./reviewer";
import { runRefactorerAgent } from "./refactorer";
import { critiqueDraft, CritiqueResult, EvidenceItem } from "./critic";
import { AgentExecutionResult } from "./agent-loop";

export type AgentStreamEvent =
  | { type: "planning" }
  | { type: "planned"; questionType: QuestionType; reasoning: string }
  | { type: "investigating"; specialist: string; toolCall?: string }
  | { type: "tool_result"; toolCall: string; summary: string }
  | { type: "drafting" }
  | { type: "verifying" }
  | { type: "revising"; feedback: string }
  | { type: "answer"; content: string; evidence?: EvidenceItem[] }
  | { type: "error"; message: string };

export interface RunMultiAgentPipelineParams {
  connectedRepoId: string;
  question: string;
  onProgress?: (event: AgentStreamEvent) => void;
  maxIterations?: number;
  maxRevisionRounds?: number;
  skipCache?: boolean;
  similarityThreshold?: number;
  customLlmCompletion?: (prompt: string) => Promise<string>;
  customDriver?: Driver;
}

export interface PipelineResult {
  answer: string;
  questionType: QuestionType;
  criticVerdict: CritiqueResult["verdict"];
  specialistResult: AgentExecutionResult;
  isCached?: boolean;
  evidence?: EvidenceItem[];
}

/**
 * Executes the full Phase 3 multi-agent pipeline (RFC 0016):
 * Planner (RFC 0013) -> Routed Tool-Calling Specialist (RFC 0014) -> Critic Verification (RFC 0015)
 * With Phase 4 Step 17 Insight Cache (RFC 0017) short-circuiting.
 */
export async function runMultiAgentPipeline(
  params: RunMultiAgentPipelineParams
): Promise<PipelineResult> {
  const notify = (event: AgentStreamEvent) => {
    if (params.onProgress) {
      try {
        params.onProgress(event);
      } catch {
        // Ignore progress notification errors
      }
    }
  };

  try {
    // Determine latest commitSha for cache lookup
    let commitSha = "HEAD";
    try {
      const latestJob = await prisma.indexingJob.findFirst({
        where: { connectedRepoId: params.connectedRepoId, status: "SUCCEEDED" },
        orderBy: { createdAt: "desc" },
        select: { commitSha: true },
      });
      if (latestJob?.commitSha) {
        commitSha = latestJob.commitSha;
      }
    } catch {
      // Ignore database errors during disconnected unit tests
    }

    // Step 0: Check Insight Cache (RFC 0017)
    if (!params.skipCache) {
      try {
        const cacheResult = await checkInsightCache({
          connectedRepoId: params.connectedRepoId,
          question: params.question,
          verifiedAtCommitSha: commitSha,
          similarityThreshold: params.similarityThreshold,
        });

        if (cacheResult.hit && cacheResult.cachedAnswer) {
          const cachedQuestionType = (cacheResult.questionType as QuestionType) || "explain";
          notify({ type: "planned", questionType: cachedQuestionType, reasoning: "Cached verified insight found" });
          notify({ type: "answer", content: cacheResult.cachedAnswer });
          return {
            answer: cacheResult.cachedAnswer,
            questionType: cachedQuestionType,
            criticVerdict: "approved",
            specialistResult: {
              specialistName: "Cache",
              question: params.question,
              answer: cacheResult.cachedAnswer,
              toolCallsExecuted: [],
              iterationsUsed: 0,
            },
            isCached: true,
          };
        }
      } catch {
        // Cache miss / error fallback gracefully to full pipeline execution
      }
    }

    // Step 1: Planning / Intent Classification
    notify({ type: "planning" });
    const plan = await planQuestion({
      question: params.question,
      connectedRepoId: params.connectedRepoId,
      customLlmCompletion: params.customLlmCompletion,
    });

    notify({
      type: "planned",
      questionType: plan.type,
      reasoning: plan.reasoning,
    });

    // Step 2: Route to Specialist
    let specialistResult: AgentExecutionResult;
    const specialistParams = {
      question: params.question,
      connectedRepoId: params.connectedRepoId,
      maxIterations: params.maxIterations,
      customLlmCompletion: params.customLlmCompletion,
      customDriver: params.customDriver,
    };

    switch (plan.type) {
      case "bug_trace":
        notify({ type: "investigating", specialist: "Bug-Tracer" });
        specialistResult = await runBugTracerAgent(specialistParams);
        break;
      case "review":
        notify({ type: "investigating", specialist: "Reviewer" });
        specialistResult = await runReviewerAgent(specialistParams);
        break;
      case "refactor":
        notify({ type: "investigating", specialist: "Refactorer" });
        specialistResult = await runRefactorerAgent(specialistParams);
        break;
      case "explain":
      default:
        notify({ type: "investigating", specialist: "Explainer" });
        specialistResult = await runExplainerAgent(specialistParams);
        break;
    }

    // Emit tool results if tools were executed
    for (const toolResult of specialistResult.toolCallsExecuted) {
      notify({
        type: "tool_result",
        toolCall: toolResult.toolName,
        summary: toolResult.result.split("\n")[0] || "Executed tool call",
      });
    }

    notify({ type: "drafting" });

    // Step 3: Critic Verification Loop against Neo4j Graph
    notify({ type: "verifying" });
    let currentAnswer = specialistResult.answer;
    let criticResult: CritiqueResult = { verdict: "approved", answer: currentAnswer, verifiedClaimsCount: 0, evidence: [] };
    const maxRevisions = params.maxRevisionRounds ?? 3;

    for (let round = 1; round <= maxRevisions; round++) {
      criticResult = await critiqueDraft({
        draftAnswer: currentAnswer,
        connectedRepoId: params.connectedRepoId,
        question: params.question,
        revisionRound: round,
        maxRevisionRounds: maxRevisions,
        customLlmCompletion: params.customLlmCompletion,
        customDriver: params.customDriver,
      });

      if (criticResult.verdict === "approved") {
        break;
      }

      if (criticResult.verdict === "revise") {
        notify({ type: "revising", feedback: criticResult.feedback });
        // Trigger revision pass with specialist
        const revisedParams = {
          ...specialistParams,
          question: `${params.question}\n\nCRITIC REVISION FEEDBACK:\n${criticResult.feedback}`,
        };
        switch (plan.type) {
          case "bug_trace":
            specialistResult = await runBugTracerAgent(revisedParams);
            break;
          case "review":
            specialistResult = await runReviewerAgent(revisedParams);
            break;
          case "refactor":
            specialistResult = await runRefactorerAgent(revisedParams);
            break;
          case "explain":
          default:
            specialistResult = await runExplainerAgent(revisedParams);
            break;
        }
        currentAnswer = specialistResult.answer;
      } else if (criticResult.verdict === "unverifiable") {
        currentAnswer = `${currentAnswer}\n\n${criticResult.caveat}`;
        break;
      }
    }

    const finalAnswerText = criticResult.verdict === "unverifiable"
      ? currentAnswer
      : (criticResult as { answer: string }).answer || currentAnswer;

    const evidenceList: EvidenceItem[] = criticResult.verdict === "approved" ? (criticResult.evidence || []) : [];

    notify({ type: "answer", content: finalAnswerText, evidence: evidenceList });

    // Write to InsightCache ONLY if Critic returned "approved" verdict
    if (criticResult.verdict === "approved") {
      try {
        const referencedNodeIds = evidenceList.map((e) => `${e.filePath}:${e.graphNodeName}`);
        await writeInsightCache({
          connectedRepoId: params.connectedRepoId,
          question: params.question,
          answer: finalAnswerText,
          questionType: plan.type,
          verifiedAtCommitSha: commitSha,
          referencedNodeIds,
        });
      } catch {
        // Cache write errors are caught gracefully
      }
    }

    return {
      answer: finalAnswerText,
      questionType: plan.type,
      criticVerdict: criticResult.verdict,
      specialistResult,
      evidence: evidenceList,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Pipeline execution failed";
    notify({ type: "error", message: errorMsg });
    throw err;
  }
}

