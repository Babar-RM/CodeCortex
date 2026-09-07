import { Driver } from "neo4j-driver";
import { getNeo4jDriver } from "./neo4j";
import { embedTextsWithService } from "./parser-client";
import { searchSemantic, SemanticSearchResult } from "../jobs/pipeline/generate-embeddings";

export interface ContextRelationship {
  type: "CALLS" | "CALLED_BY" | "DEFINES" | "DEFINED_IN" | "IMPORTS" | "INHERITS" | "INHERITED_BY";
  targetName: string;
  targetPath?: string;
}

export interface ContextNode {
  id: string;
  entityType: "function" | "class" | "file";
  entityName: string;
  filePath: string;
  contentChunk?: string;
  source?: "seed" | "neighbor";
  score?: number;
  relationships?: ContextRelationship[];
}

export interface ContextBundle {
  repoId: string;
  question: string;
  seeds: ContextNode[];
  neighbors: ContextNode[];
  rankedNodes: ContextNode[];
  formattedContext: string;
}

export interface HybridRetrieveParams {
  connectedRepoId: string;
  question: string;
  maxSeeds?: number;
  expansionHops?: number;
}

export const DEFAULT_MAX_SEEDS = 5;
export const DEFAULT_EXPANSION_HOPS = 1;

/**
 * Step 1: Embed question using parser service /embed endpoint
 */
export async function embedQuestion(question: string): Promise<number[]> {
  const embeddings = await embedTextsWithService([question]);
  return embeddings.length > 0 ? embeddings[0] : [];
}

/**
 * Step 2: Retrieve top seed nodes via pgvector semantic search
 */
export async function semanticSearchSeeds(
  repoId: string,
  queryVector: number[],
  maxSeeds = DEFAULT_MAX_SEEDS
): Promise<ContextNode[]> {
  if (queryVector.length === 0) {
    return [];
  }

  const searchResults: SemanticSearchResult[] = await searchSemantic(repoId, queryVector, maxSeeds);

  return searchResults.map((res) => ({
    id: res.id,
    entityType: (res.entityType as "function" | "class" | "file") || "function",
    entityName: res.entityName,
    filePath: res.filePath,
    contentChunk: res.contentChunk,
    source: "seed",
    score: res.distance !== undefined ? Math.max(0, 1 - res.distance) : 1.0,
    relationships: [],
  }));
}

/**
 * Step 3: Expand 1-hop neighborhood of seeds in Neo4j graph
 */
export async function expandGraphNeighborhood(
  repoId: string,
  seeds: ContextNode[],
  expansionHops = DEFAULT_EXPANSION_HOPS,
  customDriver?: Driver
): Promise<ContextNode[]> {
  if (seeds.length === 0 || expansionHops < 1) {
    return [];
  }

  const driver = customDriver || getNeo4jDriver();
  let session;
  try {
    session = driver.session();
  } catch {
    // If Neo4j session cannot be established in test/mock environment
    return [];
  }

  const neighborsMap = new Map<string, ContextNode>();
  const seedIds = new Set(seeds.map((s) => `${s.entityType}:${s.filePath}:${s.entityName}`));

  try {
    for (const seed of seeds) {
      if (seed.entityType === "function") {
        // Find callers
        const callersResult = await session.run(
          `
          MATCH (caller:Function { repoId: $repoId })-[:CALLS]->(s:Function { repoId: $repoId, name: $seedName })
          RETURN caller.name AS callerName, caller.filePath AS callerPath
          `,
          { repoId, seedName: seed.entityName }
        );

        for (const record of callersResult.records) {
          const callerName = record.get("callerName") as string;
          const callerPath = record.get("callerPath") as string;
          const key = `function:${callerPath}:${callerName}`;

          if (!seedIds.has(key)) {
            if (!neighborsMap.has(key)) {
              neighborsMap.set(key, {
                id: `neighbor-${key}`,
                entityType: "function",
                entityName: callerName,
                filePath: callerPath,
                source: "neighbor",
                score: 0.5,
                relationships: [],
              });
            }
            neighborsMap.get(key)!.relationships!.push({
              type: "CALLS",
              targetName: seed.entityName,
              targetPath: seed.filePath,
            });
            seed.relationships = seed.relationships || [];
            seed.relationships.push({
              type: "CALLED_BY",
              targetName: callerName,
              targetPath: callerPath,
            });
          }
        }

        // Find callees
        const calleesResult = await session.run(
          `
          MATCH (s:Function { repoId: $repoId, name: $seedName })-[:CALLS]->(callee:Function { repoId: $repoId })
          RETURN callee.name AS calleeName, callee.filePath AS calleePath
          `,
          { repoId, seedName: seed.entityName }
        );

        for (const record of calleesResult.records) {
          const calleeName = record.get("calleeName") as string;
          const calleePath = (record.get("calleePath") as string) || seed.filePath;
          const key = `function:${calleePath}:${calleeName}`;

          if (!seedIds.has(key)) {
            if (!neighborsMap.has(key)) {
              neighborsMap.set(key, {
                id: `neighbor-${key}`,
                entityType: "function",
                entityName: calleeName,
                filePath: calleePath,
                source: "neighbor",
                score: 0.5,
                relationships: [],
              });
            }
            neighborsMap.get(key)!.relationships!.push({
              type: "CALLED_BY",
              targetName: seed.entityName,
              targetPath: seed.filePath,
            });
            seed.relationships = seed.relationships || [];
            seed.relationships.push({
              type: "CALLS",
              targetName: calleeName,
              targetPath: calleePath,
            });
          }
        }
      } else if (seed.entityType === "class") {
        // Find class inheritance
        const inheritsResult = await session.run(
          `
          MATCH (c:Class { repoId: $repoId, name: $seedName })-[:INHERITS]->(parent:Class { repoId: $repoId })
          RETURN parent.name AS parentName, parent.filePath AS parentPath
          `,
          { repoId, seedName: seed.entityName }
        );

        for (const record of inheritsResult.records) {
          const parentName = record.get("parentName") as string;
          const parentPath = (record.get("parentPath") as string) || seed.filePath;
          const key = `class:${parentPath}:${parentName}`;

          if (!seedIds.has(key)) {
            if (!neighborsMap.has(key)) {
              neighborsMap.set(key, {
                id: `neighbor-${key}`,
                entityType: "class",
                entityName: parentName,
                filePath: parentPath,
                source: "neighbor",
                score: 0.5,
                relationships: [],
              });
            }
            seed.relationships = seed.relationships || [];
            seed.relationships.push({
              type: "INHERITS",
              targetName: parentName,
              targetPath: parentPath,
            });
          }
        }
      }
    }
  } catch {
    // Handle Graph traversal errors gracefully
  } finally {
    try {
      await session.close();
    } catch {
      // Ignore session close error
    }
  }

  return Array.from(neighborsMap.values());
}

/**
 * Step 4: Merge seeds and graph neighbors, deduplicate, and rank by score
 */
export function mergeAndRank(seeds: ContextNode[], neighbors: ContextNode[]): ContextNode[] {
  const mergedMap = new Map<string, ContextNode>();

  // Seeds take precedence
  for (const seed of seeds) {
    const key = `${seed.entityType}:${seed.filePath}:${seed.entityName}`;
    mergedMap.set(key, {
      ...seed,
      source: "seed",
      score: seed.score !== undefined ? seed.score : 1.0,
    });
  }

  // Add neighbors if not already present
  for (const neighbor of neighbors) {
    const key = `${neighbor.entityType}:${neighbor.filePath}:${neighbor.entityName}`;
    if (!mergedMap.has(key)) {
      mergedMap.set(key, {
        ...neighbor,
        source: "neighbor",
        score: neighbor.score !== undefined ? neighbor.score : 0.5,
      });
    }
  }

  const allNodes = Array.from(mergedMap.values());

  // Rank descending by score
  return allNodes.sort((a, b) => (b.score || 0) - (a.score || 0));
}

/**
 * Step 5: Format context bundle for consumption by downstream agent prompts
 */
export function assembleBundle(
  repoId: string,
  question: string,
  seeds: ContextNode[],
  neighbors: ContextNode[],
  rankedNodes: ContextNode[]
): ContextBundle {
  const lines: string[] = [];

  lines.push(`=== CONTEXT BUNDLE FOR REPOSITORY: ${repoId} ===`);
  lines.push(`QUESTION: ${question}`);
  lines.push(``);

  lines.push(`--- SEED NODES (Semantic Matches: ${seeds.length}) ---`);
  if (seeds.length === 0) {
    lines.push(`(No seed nodes retrieved)`);
  } else {
    seeds.forEach((seed, idx) => {
      lines.push(
        `${idx + 1}. [${seed.entityType}] ${seed.entityName} (${seed.filePath}) - Score: ${(seed.score || 1.0).toFixed(2)}`
      );
      if (seed.contentChunk) {
        lines.push(`   Content: ${seed.contentChunk}`);
      }
      if (seed.relationships && seed.relationships.length > 0) {
        lines.push(`   Relationships:`);
        seed.relationships.forEach((rel) => {
          lines.push(`     - ${rel.type} -> ${rel.targetName} (${rel.targetPath || "same file"})`);
        });
      }
    });
  }

  lines.push(``);
  lines.push(`--- NEIGHBOR NODES (Graph Expansion: ${neighbors.length}) ---`);
  if (neighbors.length === 0) {
    lines.push(`(No graph neighbors retrieved)`);
  } else {
    neighbors.forEach((nb, idx) => {
      lines.push(
        `${idx + 1}. [${nb.entityType}] ${nb.entityName} (${nb.filePath}) - Score: ${(nb.score || 0.5).toFixed(2)}`
      );
      if (nb.relationships && nb.relationships.length > 0) {
        lines.push(`   Relationships:`);
        nb.relationships.forEach((rel) => {
          lines.push(`     - ${rel.type} -> ${rel.targetName} (${rel.targetPath || "same file"})`);
        });
      }
    });
  }

  lines.push(``);
  lines.push(`=== END OF CONTEXT BUNDLE ===`);

  return {
    repoId,
    question,
    seeds,
    neighbors,
    rankedNodes,
    formattedContext: lines.join("\n"),
  };
}

/**
 * Main hybrid retrieval function combining pgvector semantic search and Neo4j graph expansion
 */
export async function hybridRetrieve(
  params: HybridRetrieveParams,
  customDriver?: Driver
): Promise<ContextBundle> {
  const maxSeeds = params.maxSeeds ?? DEFAULT_MAX_SEEDS;
  const expansionHops = params.expansionHops ?? DEFAULT_EXPANSION_HOPS;

  // Step 1: Embed question
  const queryVector = await embedQuestion(params.question);

  // Step 2: Semantic search seeds
  const seeds = await semanticSearchSeeds(params.connectedRepoId, queryVector, maxSeeds);

  // Step 3: Expand graph neighborhood
  const neighbors = await expandGraphNeighborhood(
    params.connectedRepoId,
    seeds,
    expansionHops,
    customDriver
  );

  // Step 4: Merge and rank
  const rankedNodes = mergeAndRank(seeds, neighbors);

  // Step 5: Assemble context bundle
  return assembleBundle(params.connectedRepoId, params.question, seeds, neighbors, rankedNodes);
}
