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
          mode: "insensitive",
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
 * Tool: list_files(filter)
 * Lists all indexed files in the repository, optionally matching a filter keyword or path
 */
export async function listFiles(filter: string, repoId: string): Promise<string> {
  try {
    const files = await prisma.codeEmbedding.findMany({
      where: {
        connectedRepoId: repoId,
        ...(filter ? { filePath: { contains: filter, mode: "insensitive" } } : {}),
      },
      select: { filePath: true },
      distinct: ["filePath"],
      take: 25,
    });

    if (files.length === 0) {
      return `No indexed files found matching filter '${filter}'.`;
    }

    const uniquePaths = Array.from(new Set(files.map((f) => f.filePath)));
    return `Indexed files in repository:\n- ${uniquePaths.join("\n- ")}`;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Database query error";
    return `Error listing files: ${errorMsg}`;
  }
}

/**
 * Tool: verify_call_order(callerFunction, firstCallee, secondCallee)
 * RFC 0033 Solution A — verifies that callerFunction calls firstCallee BEFORE secondCallee
 * by comparing lineNumber properties on the CALLS edges.
 */
export async function verifyCallOrder(
  callerFunction: string,
  firstCallee: string,
  secondCallee: string,
  repoId: string,
  customDriver?: Driver
): Promise<string> {
  const driver = customDriver || getNeo4jDriver();
  let session;

  try {
    session = driver.session();
    const res = await session.run(
      `
      MATCH (caller:Function { repoId: $repoId, name: $caller })
      MATCH (caller)-[a:CALLS]->(fa:Function { repoId: $repoId, name: $firstCallee })
      MATCH (caller)-[b:CALLS]->(fb:Function { repoId: $repoId, name: $secondCallee })
      RETURN a.lineNumber AS lineA, b.lineNumber AS lineB
      `,
      { repoId, caller: callerFunction, firstCallee, secondCallee }
    );

    if (res.records.length === 0) {
      return `Cannot verify call order: '${callerFunction}' does not call both '${firstCallee}' and '${secondCallee}' according to the graph.`;
    }

    const rec = res.records[0];
    const lineA = typeof rec.get("lineA")?.toNumber === "function" ? rec.get("lineA").toNumber() : (rec.get("lineA") ?? 0);
    const lineB = typeof rec.get("lineB")?.toNumber === "function" ? rec.get("lineB").toNumber() : (rec.get("lineB") ?? 0);

    if (lineA < lineB) {
      return `VERIFIED: '${callerFunction}' calls '${firstCallee}' (line ${lineA}) BEFORE '${secondCallee}' (line ${lineB}).`;
    } else if (lineA > lineB) {
      return `INCORRECT ORDER: '${callerFunction}' calls '${secondCallee}' (line ${lineB}) BEFORE '${firstCallee}' (line ${lineA}). The claim is wrong.`;
    } else {
      return `SAME LINE: '${callerFunction}' calls both '${firstCallee}' and '${secondCallee}' at line ${lineA} (likely inlined or line numbers unavailable).`;
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Neo4j query error";
    return `Error verifying call order: ${errorMsg}`;
  } finally {
    if (session) {
      try { await session.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Tool: get_function_signature(functionName)
 * RFC 0033 Solution C — retrieves the exact parameter list and return type
 * for a function from the Neo4j graph to verify LLM signature claims.
 */
export async function getFunctionSignature(
  functionName: string,
  repoId: string,
  customDriver?: Driver
): Promise<string> {
  const driver = customDriver || getNeo4jDriver();
  let session;

  try {
    session = driver.session();
    const res = await session.run(
      `
      MATCH (fn:Function { repoId: $repoId, name: $functionName })
      RETURN fn.filePath AS filePath, fn.params AS params, fn.returnType AS returnType,
             fn.startLine AS startLine, fn.endLine AS endLine
      LIMIT 1
      `,
      { repoId, functionName }
    );

    if (res.records.length === 0) {
      return `Function '${functionName}' not found in the code graph.`;
    }

    const rec = res.records[0];
    const filePath = rec.get("filePath") || "unknown";
    const params: string[] = rec.get("params") || [];
    const returnType: string | null = rec.get("returnType") || null;
    const startLine = typeof rec.get("startLine")?.toNumber === "function" ? rec.get("startLine").toNumber() : (rec.get("startLine") ?? "?");
    const endLine = typeof rec.get("endLine")?.toNumber === "function" ? rec.get("endLine").toNumber() : (rec.get("endLine") ?? "?");

    const sig = `${functionName}(${params.join(", ")})${returnType ? `: ${returnType}` : ""}`;
    return `Function signature: ${sig}\nDefined in: ${filePath} (lines ${startLine}–${endLine})`;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Neo4j query error";
    return `Error fetching signature for '${functionName}': ${errorMsg}`;
  } finally {
    if (session) {
      try { await session.close(); } catch { /* ignore */ }
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
  let cleanToolName = toolName.trim().replace(/^(tool|tools|functions|function|repo_browser|action)\./i, "");
  if (cleanToolName.includes(".")) {
    const parts = cleanToolName.split(".");
    cleanToolName = parts[parts.length - 1];
  }

  switch (cleanToolName) {
    case "list_files": {
      const filter = String(args.filter || args.path || args.query || args.arg || "");
      resultText = await listFiles(filter, repoId);
      break;
    }

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

    case "open_file":
    case "read_file":
    case "get_file_content":
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

    // RFC 0033 Solution A — verify call order using lineNumber on CALLS edges
    case "verify_call_order": {
      const caller = String(args.callerFunction || args.caller || args.arg || "");
      const first = String(args.firstCallee || args.first || "");
      const second = String(args.secondCallee || args.second || "");
      resultText = await verifyCallOrder(caller, first, second, repoId, customDriver);
      break;
    }

    // RFC 0033 Solution C — verify function signatures from graph nodes
    case "get_function_signature": {
      const funcName = String(args.functionName || args.name || args.arg || "");
      resultText = await getFunctionSignature(funcName, repoId, customDriver);
      break;
    }

    default:
      resultText = `Unknown tool '${toolName}'. Available tools: list_files, get_callers, get_callees, get_file, search_semantic, get_class_hierarchy, verify_call_order, get_function_signature.`;
      break;
  }

  return {
    toolName,
    args,
    result: resultText,
  };
}
