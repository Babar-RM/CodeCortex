import { Driver } from "neo4j-driver";
import { getNeo4jDriver } from "../neo4j";
import { prisma } from "../prisma";
import { embedQuestion, semanticSearchSeeds } from "../retrieval";

export interface ToolResult {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
}

/**
 * Tool: get_callers(functionName)
 * Queries Neo4j for functions calling the specified function
 */
export async function getCallers(
  functionName: string,
  repoId: string,
  customDriver?: Driver
): Promise<string> {
  const driver = customDriver || getNeo4jDriver();
  let session;

  try {
    session = driver.session();
    const cypherResult = await session.run(
      `
      MATCH (caller:Function { repoId: $repoId })-[:CALLS]->(target:Function { repoId: $repoId, name: $functionName })
      RETURN caller.name AS callerName, caller.filePath AS callerPath
      `,
      { repoId, functionName }
    );

    if (cypherResult.records.length === 0) {
      return `No callers found in the graph for function '${functionName}'.`;
    }

    const callers = cypherResult.records.map(
      (r) => `${r.get("callerName")} (${r.get("callerPath")})`
    );

    return `Callers of function '${functionName}':\n- ${callers.join("\n- ")}`;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Neo4j query error";
    return `Error querying callers for '${functionName}': ${errorMsg}`;
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
 * Tool: get_callees(functionName)
 * Queries Neo4j for functions called by the specified function
 */
export async function getCallees(
  functionName: string,
  repoId: string,
  customDriver?: Driver
): Promise<string> {
  const driver = customDriver || getNeo4jDriver();
  let session;

  try {
    session = driver.session();
    const cypherResult = await session.run(
      `
      MATCH (source:Function { repoId: $repoId, name: $functionName })-[:CALLS]->(callee:Function { repoId: $repoId })
      RETURN callee.name AS calleeName, callee.filePath AS calleePath
      `,
      { repoId, functionName }
    );

    if (cypherResult.records.length === 0) {
      return `No callees found in the graph for function '${functionName}'.`;
    }

    const callees = cypherResult.records.map(
      (r) => `${r.get("calleeName")} (${r.get("calleePath") || "same file"})`
    );

    return `Functions called by '${functionName}':\n- ${callees.join("\n- ")}`;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Neo4j query error";
    return `Error querying callees for '${functionName}': ${errorMsg}`;
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
 * Tool: get_file(filePath)
 * Queries Postgres code_embeddings table for stored file chunks and code facts
 */
export async function getFile(filePath: string, repoId: string): Promise<string> {
  try {
    const chunks = await prisma.codeEmbedding.findMany({
      where: {
        connectedRepoId: repoId,
        filePath: {
          contains: filePath,
        },
      },
      take: 10,
    });

    if (chunks.length === 0) {
      return `File '${filePath}' was not found or has no indexed chunks.`;
    }

    const lines: string[] = [`Content & structure for file '${filePath}':`];
    chunks.forEach((c) => {
      lines.push(`- [${c.entityType}] ${c.entityName}: ${c.contentChunk}`);
    });

    return lines.join("\n");
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Database query error";
    return `Error reading file '${filePath}': ${errorMsg}`;
  }
}

/**
 * Tool: search_semantic(query)
 * Generates vector embedding for query and runs pgvector semantic similarity search
 */
export async function searchSemanticTool(query: string, repoId: string): Promise<string> {
  try {
    const vector = await embedQuestion(query);
    const seeds = await semanticSearchSeeds(repoId, vector, 5);

    if (seeds.length === 0) {
      return `No semantic matches found for query '${query}'.`;
    }

    const lines: string[] = [`Semantic search results for '${query}':`];
    seeds.forEach((s, idx) => {
      lines.push(
        `${idx + 1}. [${s.entityType}] ${s.entityName} (${s.filePath}) - ${s.contentChunk || ""}`
      );
    });

    return lines.join("\n");
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Semantic search error";
    return `Error performing semantic search for '${query}': ${errorMsg}`;
  }
}

/**
 * Tool: get_class_hierarchy(className)
 * Queries Neo4j for class inheritance relationships (INHERITS)
 */
export async function getClassHierarchy(
  className: string,
  repoId: string,
  customDriver?: Driver
): Promise<string> {
  const driver = customDriver || getNeo4jDriver();
  let session;

  try {
    session = driver.session();
    const cypherResult = await session.run(
      `
      MATCH (c:Class { repoId: $repoId, name: $className })-[:INHERITS]->(parent:Class { repoId: $repoId })
      RETURN parent.name AS parentName, parent.filePath AS parentPath
      `,
      { repoId, className }
    );

    if (cypherResult.records.length === 0) {
      return `No parent class inheritance found for class '${className}'.`;
    }

    const parents = cypherResult.records.map(
      (r) => `${r.get("parentName")} (${r.get("parentPath") || "same file"})`
    );

    return `Class '${className}' inherits from:\n- ${parents.join("\n- ")}`;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Neo4j query error";
    return `Error querying class hierarchy for '${className}': ${errorMsg}`;
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
 * Main dispatcher to execute a tool call requested by a specialist agent
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  repoId: string,
  customDriver?: Driver
): Promise<ToolResult> {
  let resultText = "";

  switch (toolName) {
    case "get_callers": {
      const funcName = String(args.functionName || args.name || args.arg || "");
      resultText = await getCallers(funcName, repoId, customDriver);
      break;
    }

    case "get_callees": {
      const funcName = String(args.functionName || args.name || args.arg || "");
      resultText = await getCallees(funcName, repoId, customDriver);
      break;
    }

    case "get_file": {
      const path = String(args.filePath || args.path || args.name || args.arg || "");
      resultText = await getFile(path, repoId);
      break;
    }

    case "search_semantic": {
      const query = String(args.query || args.text || args.arg || "");
      resultText = await searchSemanticTool(query, repoId);
      break;
    }

    case "get_class_hierarchy": {
      const clsName = String(args.className || args.name || args.arg || "");
      resultText = await getClassHierarchy(clsName, repoId, customDriver);
      break;
    }

    default:
      resultText = `Unknown tool '${toolName}'. Available tools: get_callers, get_callees, get_file, search_semantic, get_class_hierarchy.`;
      break;
  }

  return {
    toolName,
    args,
    result: resultText,
  };
}
