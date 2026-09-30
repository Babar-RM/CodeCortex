import { prisma } from "./prisma";
import { embedTextsWithService } from "./parser-client";

export interface CheckInsightCacheParams {
  connectedRepoId: string;
  question: string;
  verifiedAtCommitSha: string;
  similarityThreshold?: number;
}

export interface CheckInsightCacheResult {
  hit: boolean;
  cachedAnswer?: string;
  questionType?: string;
  insightId?: string;
  similarity?: number;
}

export interface WriteInsightCacheParams {
  connectedRepoId: string;
  question: string;
  answer: string;
  questionType: string;
  verifiedAtCommitSha: string;
  referencedNodeIds: string[];
}

export const DEFAULT_SIMILARITY_THRESHOLD = 0.95;

export function isNegativeOrIncompleteAnswer(answer: string): boolean {
  if (!answer || answer.trim().length === 0) return true;
  const lower = answer.toLowerCase();
  return (
    answer.trim().startsWith("TOOL:") ||
    lower.includes("tool:") ||
    lower.includes("unknown tool") ||
    lower.includes("tool.get_file") ||
    lower.includes("open_file(") ||
    lower.includes("get_file(") ||
    lower.includes("read_file(") ||
    lower.includes("critic revision feedback:") ||
    lower.includes("ensure a valid llm api key") ||
    lower.includes("unable to locate") ||
    lower.includes("cannot perform a concrete") ||
    lower.includes("can't perform a concrete") ||
    lower.includes("no backend code present") ||
    lower.includes("could you please provide") ||
    lower.includes("i'm unable") ||
    lower.includes("i am unable") ||
    lower.includes("no relevant code") ||
    lower.includes("i don't have access") ||
    lower.includes("i do not have access") ||
    lower.includes("i could not find") ||
    lower.includes("security review")
  );
}

/**
 * Checks if a semantically similar, Critic-approved answer exists in the InsightCache
 * for the specified repository and commit SHA.
 */
export async function checkInsightCache(
  params: CheckInsightCacheParams
): Promise<CheckInsightCacheResult> {
  const threshold = params.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;

  const embeddings = await embedTextsWithService([params.question]);
  const vector = embeddings[0] || [];

  if (vector.length > 0) {
    const vectorString = `[${vector.join(",")}]`;
    try {
      const results = await prisma.$queryRaw<
        Array<{
          id: string;
          question: string;
          answer: string;
          questionType: string;
          verifiedAtCommitSha: string;
          distance: number | null;
        }>
      >`
        SELECT id, question, answer, question_type AS "questionType", verified_at_commit_sha AS "verifiedAtCommitSha",
               (question_embedding <=> ${vectorString}::vector) AS distance
        FROM insight_cache
        WHERE connected_repo_id = ${params.connectedRepoId}
          AND verified_at_commit_sha = ${params.verifiedAtCommitSha}
          AND question_embedding IS NOT NULL
        ORDER BY question_embedding <=> ${vectorString}::vector ASC
        LIMIT 1;
      `;

      if (results.length > 0) {
        const topMatch = results[0];
        if (topMatch.distance !== null && topMatch.distance !== undefined && !isNaN(topMatch.distance)) {
          const similarity = 1 - topMatch.distance;

          if (similarity >= threshold) {
            if (isNegativeOrIncompleteAnswer(topMatch.answer)) {
              return { hit: false };
            }

            await prisma.insightCache.update({
              where: { id: topMatch.id },
              data: {
                lastServedAt: new Date(),
                hitCount: { increment: 1 },
              },
            });

            return {
              hit: true,
              cachedAnswer: topMatch.answer,
              questionType: topMatch.questionType,
              insightId: topMatch.id,
              similarity,
            };
          }
        }
      }
    } catch {
      // Fallback for environments without pgvector
      const fallbackRows = await prisma.insightCache.findMany({
        where: {
          connectedRepoId: params.connectedRepoId,
          verifiedAtCommitSha: params.verifiedAtCommitSha,
        },
        orderBy: { createdAt: "desc" },
        take: 1,
      });

      if (
        fallbackRows.length > 0 &&
        fallbackRows[0].question.trim().toLowerCase() === params.question.trim().toLowerCase()
      ) {
        const row = fallbackRows[0];
        if (isNegativeOrIncompleteAnswer(row.answer)) {
          return { hit: false };
        }
        await prisma.insightCache.update({
          where: { id: row.id },
          data: {
            lastServedAt: new Date(),
            hitCount: { increment: 1 },
          },
        });
        return {
          hit: true,
          cachedAnswer: row.answer,
          questionType: row.questionType,
          insightId: row.id,
          similarity: 1.0,
        };
      }
    }
  } else {
    // If embedding service returned empty vector (fallback), check exact text match
    const fallbackRows = await prisma.insightCache.findMany({
      where: {
        connectedRepoId: params.connectedRepoId,
        verifiedAtCommitSha: params.verifiedAtCommitSha,
      },
      orderBy: { createdAt: "desc" },
    });

    const match = fallbackRows.find(
      (r) => r.question.trim().toLowerCase() === params.question.trim().toLowerCase()
    );

    if (match) {
      if (isNegativeOrIncompleteAnswer(match.answer)) {
        return { hit: false };
      }

      await prisma.insightCache.update({
        where: { id: match.id },
        data: {
          lastServedAt: new Date(),
          hitCount: { increment: 1 },
        },
      });
      return {
        hit: true,
        cachedAnswer: match.answer,
        questionType: match.questionType,
        insightId: match.id,
        similarity: 1.0,
      };
    }
  }

  return { hit: false };
}

/**
 * Writes a Critic-approved answer into the InsightCache.
 * MUST ONLY be called when Critic returns verdict: "approved".
 */
export async function writeInsightCache(
  params: WriteInsightCacheParams
): Promise<string> {
  if (isNegativeOrIncompleteAnswer(params.answer)) {
    return "";
  }
  const embeddings = await embedTextsWithService([params.question]);
  const vector = embeddings[0] || [];

  if (!vector || vector.length === 0) {
    // Do not cache records if we cannot generate a valid embedding vector
    return "";
  }

  const record = await prisma.insightCache.create({
    data: {
      connectedRepoId: params.connectedRepoId,
      question: params.question,
      answer: params.answer,
      questionType: params.questionType,
      verifiedAtCommitSha: params.verifiedAtCommitSha,
      referencedNodeIds: params.referencedNodeIds,
    },
  });

  const vectorLiteral = `[${vector.join(",")}]`;
  try {
    await prisma.$executeRaw`
      UPDATE insight_cache
      SET question_embedding = ${vectorLiteral}::vector
      WHERE id = ${record.id}
    `;
  } catch {
    // If vector assignment fails, clean up record so no null-embedding row remains
    try {
      await prisma.insightCache.delete({ where: { id: record.id } });
    } catch {}
    return "";
  }

  return record.id;
}
