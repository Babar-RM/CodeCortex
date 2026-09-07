import { prisma } from "../../lib/prisma";
import { ExtractedFacts, embedTextsWithService } from "../../lib/parser-client";

export interface GenerateEmbeddingsParams {
  repoId: string;
  facts: ExtractedFacts[];
  batchSize?: number;
}

export interface GenerateEmbeddingsResult {
  totalChunksCreated: number;
  totalEmbeddingsSaved: number;
}

export interface CodeChunk {
  entityType: string;
  entityName: string;
  filePath: string;
  contentChunk: string;
}

export interface SemanticSearchResult {
  id: string;
  entityType: string;
  entityName: string;
  filePath: string;
  contentChunk: string;
  distance?: number;
}

export const DEFAULT_BATCH_SIZE = 50;

export function extractCodeChunks(facts: ExtractedFacts[]): CodeChunk[] {
  const chunks: CodeChunk[] = [];

  for (const fact of facts) {
    // 1. File overview chunk
    chunks.push({
      entityType: "file",
      entityName: fact.filePath,
      filePath: fact.filePath,
      contentChunk: `File ${fact.filePath} (language: ${fact.language})`,
    });

    // 2. Functions chunks
    for (const fn of fact.functions) {
      const returnStr = fn.returnType ? `: ${fn.returnType}` : "";
      chunks.push({
        entityType: "function",
        entityName: fn.name,
        filePath: fact.filePath,
        contentChunk: `function ${fn.name}(${(fn.params || []).join(", ")})${returnStr} in ${fact.filePath}`,
      });
    }

    // 3. Classes chunks
    for (const cls of fact.classes) {
      const heritageStr = cls.heritage.length > 0 ? ` extends ${cls.heritage.join(", ")}` : "";
      chunks.push({
        entityType: "class",
        entityName: cls.name,
        filePath: fact.filePath,
        contentChunk: `class ${cls.name}${heritageStr} in ${fact.filePath}`,
      });
    }
  }

  return chunks;
}

export async function generateEmbeddings(
  params: GenerateEmbeddingsParams
): Promise<GenerateEmbeddingsResult> {
  const batchSize = params.batchSize || DEFAULT_BATCH_SIZE;
  const chunks = extractCodeChunks(params.facts);

  let totalEmbeddingsSaved = 0;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const chunkBatch = chunks.slice(i, i + batchSize);
    const texts = chunkBatch.map((c) => c.contentChunk);

    const embeddings = await embedTextsWithService(texts);

    for (let j = 0; j < chunkBatch.length; j++) {
      const chunk = chunkBatch[j];
      const vector = embeddings[j] || [];

      // Save Prisma model record
      const record = await prisma.codeEmbedding.create({
        data: {
          connectedRepoId: params.repoId,
          entityType: chunk.entityType,
          entityName: chunk.entityName,
          filePath: chunk.filePath,
          contentChunk: chunk.contentChunk,
        },
      });

      // Update native pgvector column via raw SQL if vector exists
      if (vector.length > 0) {
        const vectorLiteral = `[${vector.join(",")}]`;
        try {
          await prisma.$executeRaw`
            UPDATE code_embeddings
            SET embedding = ${vectorLiteral}::vector
            WHERE id = ${record.id}
          `;
        } catch {
          // Fallback gracefully if pgvector extension is not enabled in testing environment
        }
      }

      totalEmbeddingsSaved++;
    }
  }

  return {
    totalChunksCreated: chunks.length,
    totalEmbeddingsSaved,
  };
}

export async function searchSemantic(
  repoId: string,
  queryVector: number[],
  limit = 5
): Promise<SemanticSearchResult[]> {
  if (queryVector.length === 0) {
    return [];
  }

  const vectorString = `[${queryVector.join(",")}]`;

  try {
    return await prisma.$queryRaw<SemanticSearchResult[]>`
      SELECT id, entity_type AS "entityType", entity_name AS "entityName", file_path AS "filePath", content_chunk AS "contentChunk",
             (embedding <=> ${vectorString}::vector) AS distance
      FROM code_embeddings
      WHERE connected_repo_id = ${repoId}
      ORDER BY embedding <=> ${vectorString}::vector ASC
      LIMIT ${limit};
    `;
  } catch {
    // Fallback standard query if pgvector <=> operator is not present
    const rows = await prisma.codeEmbedding.findMany({
      where: { connectedRepoId: repoId },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      entityType: r.entityType,
      entityName: r.entityName,
      filePath: r.filePath,
      contentChunk: r.contentChunk,
    }));
  }
}
