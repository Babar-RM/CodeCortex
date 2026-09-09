import { Driver } from "neo4j-driver";
import { getNeo4jDriver } from "../../lib/neo4j";
import { prisma } from "../../lib/prisma";

export interface CleanupDeletedFilesParams {
  repoId: string;
  deletedFilePaths: string[];
  modifiedFilePaths?: string[];
  customDriver?: Driver;
}

export interface CleanupResult {
  nodesDeleted: number;
  embeddingsDeleted: number;
  insightsInvalidated: number;
}

export async function cleanupDeletedFiles(
  params: CleanupDeletedFilesParams
): Promise<CleanupResult> {
  let nodesDeleted = 0;
  let embeddingsDeleted = 0;
  let insightsInvalidated = 0;

  if (
    params.deletedFilePaths.length === 0 &&
    (!params.modifiedFilePaths || params.modifiedFilePaths.length === 0)
  ) {
    return { nodesDeleted, embeddingsDeleted, insightsInvalidated };
  }

  // 1. Clean up Neo4j graph nodes and relationships for deleted files
  if (params.deletedFilePaths.length > 0) {
    const driver = params.customDriver || getNeo4jDriver();
    const session = driver.session();
    try {
      const cypher = `
        MATCH (f:File {repoId: $repoId})
        WHERE f.path IN $deletedFilePaths
        OPTIONAL MATCH (f)-[:DEFINES]->(entity)
        DETACH DELETE entity, f
      `;
      const result = await session.run(cypher, {
        repoId: params.repoId,
        deletedFilePaths: params.deletedFilePaths,
      });
      nodesDeleted = result.summary.counters.updates().nodesDeleted || 0;
    } catch (err) {
      console.warn(`[incremental-cleanup] Neo4j deletion warning:`, err);
    } finally {
      await session.close();
    }

    // 2. Clean up Postgres CodeEmbedding records for deleted files
    try {
      const deleteResult = await prisma.codeEmbedding.deleteMany({
        where: {
          connectedRepoId: params.repoId,
          filePath: { in: params.deletedFilePaths },
        },
      });
      embeddingsDeleted = deleteResult.count;
    } catch (err) {
      console.warn(`[incremental-cleanup] Postgres codeEmbedding deletion warning:`, err);
    }
  }

  // 3. Invalidate InsightCache entries for deleted or modified files
  const touchedPaths = [...params.deletedFilePaths, ...(params.modifiedFilePaths || [])];
  if (touchedPaths.length > 0) {
    try {
      const cachedInsights = await prisma.insightCache.findMany({
        where: { connectedRepoId: params.repoId },
        select: { id: true, referencedNodeIds: true },
      });

      const idsToInvalidate: string[] = [];
      for (const insight of cachedInsights) {
        const touches = insight.referencedNodeIds.some((nodeId) =>
          touchedPaths.some((path) => nodeId.includes(path))
        );
        if (touches) {
          idsToInvalidate.push(insight.id);
        }
      }

      if (idsToInvalidate.length > 0) {
        const invalidateResult = await prisma.insightCache.deleteMany({
          where: { id: { in: idsToInvalidate } },
        });
        insightsInvalidated = invalidateResult.count;
      }
    } catch (err) {
      console.warn(`[incremental-cleanup] InsightCache invalidation warning:`, err);
    }
  }

  return { nodesDeleted, embeddingsDeleted, insightsInvalidated };
}
