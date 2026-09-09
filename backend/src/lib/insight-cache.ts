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

export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

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
          distance: number;
        }>
      >`
        SELECT id, question, answer, question_type AS "questionType", verified_at_commit_sha AS "verifiedAtCommitSha",
               (question_embedding <=> ${vectorString}::vector) AS distance
        FROM insight_cache
        WHERE connected_repo_id = ${params.connectedRepoId}
          AND verified_at_commit_sha = ${params.verifiedAtCommitSha}
        ORDER BY question_embedding <=> ${vectorString}::vector ASC
        LIMIT 1;
      `;

      if (results.length > 0) {
        const topMatch = results[0];
        const similarity = 1 - topMatch.distance;

        if (similarity >= threshold) {
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
  const embeddings = await embedTextsWithService([params.question]);
  const vector = embeddings[0] || [];

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

  if (vector.length > 0) {
    const vectorLiteral = `[${vector.join(",")}]`;
    try {
      await prisma.$executeRaw`
        UPDATE insight_cache
        SET question_embedding = ${vectorLiteral}::vector
        WHERE id = ${record.id}
      `;
    } catch {
      // Fallback gracefully if pgvector is not available in environment
    }
  }

  return record.id;
}
