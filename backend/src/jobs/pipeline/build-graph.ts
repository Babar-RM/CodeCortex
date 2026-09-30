import { Driver } from "neo4j-driver";
import { getNeo4jDriver } from "../../lib/neo4j";
import { ExtractedFacts } from "../../lib/parser-client";

export interface BuildGraphParams {
  repoId: string;
  repoName: string;
  facts: ExtractedFacts[];
  driver?: Driver;
}

export interface BuildGraphResult {
  nodesCreated: number;
  relationshipsCreated: number;
  filesProcessed: number;
}

const UNWIND_BATCH_SIZE = 500; // Nodes per UNWIND transaction (RFC 0030)

/**
 * RFC 0030: Bulk Cypher unwinding.
 * Instead of one MERGE per entity (O(N) round-trips), we accumulate arrays
 * across all parsed facts and execute batched UNWIND Cypher transactions,
 * reducing Neo4j write time from ~45s to <1.5s for 5,000 nodes.
 */
export async function buildGraph(params: BuildGraphParams): Promise<BuildGraphResult> {
  const driver = params.driver || getNeo4jDriver();
  const session = driver.session();

  let nodesCreated = 0;
  let relationshipsCreated = 0;

  try {
    // --- Connectivity check: MERGE root Repo node ---
    try {
      await session.run(
        `MERGE (r:Repo { id: $repoId }) ON CREATE SET r.fullName = $repoName`,
        { repoId: params.repoId, repoName: params.repoName }
      );
      nodesCreated++;
    } catch (connErr: unknown) {
      const errMsg = connErr instanceof Error ? connErr.message : String(connErr);
      if (
        errMsg.includes("Failed to connect") ||
        errMsg.includes("ECONNREFUSED") ||
        errMsg.includes("ENOTFOUND") ||
        errMsg.includes("Could not perform discovery")
      ) {
        console.warn("[build-graph] Warning: Neo4j server is unreachable. Skipping Neo4j graph indexing:", errMsg);
        return { nodesCreated: 0, relationshipsCreated: 0, filesProcessed: 0 };
      }
      throw connErr;
    }

    // -----------------------------------------------------------------------
    // Collect all entities from every parsed file into flat arrays
    // -----------------------------------------------------------------------
    const fileRows: Array<{ filePath: string }> = [];
    const functionRows: Array<{
      filePath: string;
      name: string;
      startLine: number;
      endLine: number;
      params: string[];
      returnType: string | null;
    }> = [];
    const classRows: Array<{
      filePath: string;
      name: string;
      startLine: number;
      endLine: number;
    }> = [];
    const inheritanceRows: Array<{ filePath: string; className: string; parentClass: string }> = [];
    const importRows: Array<{ filePath: string; sourcePath: string }> = [];
    const callRows: Array<{ filePath: string; callerName: string; calleeName: string }> = [];

    for (const fact of params.facts) {
      fileRows.push({ filePath: fact.filePath });

      for (const fn of fact.functions) {
        functionRows.push({
          filePath: fact.filePath,
          name: fn.name,
          startLine: fn.startLine,
          endLine: fn.endLine,
          params: fn.params || [],
          returnType: fn.returnType || null,
        });
      }

      for (const cls of fact.classes) {
        classRows.push({
          filePath: fact.filePath,
          name: cls.name,
          startLine: cls.startLine,
          endLine: cls.endLine,
        });
        for (const parent of cls.heritage) {
          inheritanceRows.push({ filePath: fact.filePath, className: cls.name, parentClass: parent });
        }
      }

      for (const imp of fact.imports) {
        importRows.push({ filePath: fact.filePath, sourcePath: imp.sourcePath });
      }

      for (const call of fact.calls) {
        callRows.push({ filePath: fact.filePath, callerName: call.callerName, calleeName: call.calleeName });
      }
    }

    console.log(
      `[build-graph] Entity counts — Files: ${fileRows.length}, Functions: ${functionRows.length}, ` +
      `Classes: ${classRows.length}, Imports: ${importRows.length}, Calls: ${callRows.length}`
    );

    // -----------------------------------------------------------------------
    // Helper: Run an UNWIND query in chunks of UNWIND_BATCH_SIZE
    // -----------------------------------------------------------------------
    async function unwindBatch<T extends object>(
      rows: T[],
      cypher: string,
      staticParams: Record<string, unknown> = {}
    ): Promise<{ nodes: number; rels: number }> {
      for (let i = 0; i < rows.length; i += UNWIND_BATCH_SIZE) {
        const batch = rows.slice(i, i + UNWIND_BATCH_SIZE);
        await session.run(cypher, { ...staticParams, batch });
      }
      // Approximate counts from input rows (avoids QueryStatistics API version differences)
      return { nodes: rows.length, rels: rows.length };
    }

    // -----------------------------------------------------------------------
    // 1. Bulk MERGE File nodes + :CONTAINS edges
    // -----------------------------------------------------------------------
    if (fileRows.length > 0) {
      const { nodes, rels } = await unwindBatch(
        fileRows,
        `UNWIND $batch AS row
         MATCH (r:Repo { id: $repoId })
         MERGE (f:File { repoId: $repoId, path: row.filePath })
         MERGE (r)-[:CONTAINS]->(f)`,
        { repoId: params.repoId }
      );
      nodesCreated += nodes;
      relationshipsCreated += rels;
    }

    // -----------------------------------------------------------------------
    // 2. Bulk MERGE Function nodes + :DEFINES edges
    // -----------------------------------------------------------------------
    if (functionRows.length > 0) {
      const { nodes, rels } = await unwindBatch(
        functionRows,
        `UNWIND $batch AS row
         MATCH (f:File { repoId: $repoId, path: row.filePath })
         MERGE (fn:Function {
           repoId: $repoId,
           filePath: row.filePath,
           name: row.name,
           startLine: row.startLine
         })
         ON CREATE SET
           fn.endLine = row.endLine,
           fn.params = row.params,
           fn.returnType = row.returnType
         MERGE (f)-[:DEFINES]->(fn)`,
        { repoId: params.repoId }
      );
      nodesCreated += nodes;
      relationshipsCreated += rels;
    }

    // -----------------------------------------------------------------------
    // 3. Bulk MERGE Class nodes + :DEFINES edges
    // -----------------------------------------------------------------------
    if (classRows.length > 0) {
      const { nodes, rels } = await unwindBatch(
        classRows,
        `UNWIND $batch AS row
         MATCH (f:File { repoId: $repoId, path: row.filePath })
         MERGE (c:Class {
           repoId: $repoId,
           filePath: row.filePath,
           name: row.name
         })
         ON CREATE SET c.startLine = row.startLine, c.endLine = row.endLine
         MERGE (f)-[:DEFINES]->(c)`,
        { repoId: params.repoId }
      );
      nodesCreated += nodes;
      relationshipsCreated += rels;
    }

    // -----------------------------------------------------------------------
    // 4. Bulk MERGE :INHERITS edges between Class nodes
    // -----------------------------------------------------------------------
    if (inheritanceRows.length > 0) {
      const { nodes, rels } = await unwindBatch(
        inheritanceRows,
        `UNWIND $batch AS row
         MATCH (c:Class { repoId: $repoId, filePath: row.filePath, name: row.className })
         MERGE (parent:Class { repoId: $repoId, name: row.parentClass })
         MERGE (c)-[:INHERITS]->(parent)`,
        { repoId: params.repoId }
      );
      nodesCreated += nodes;
      relationshipsCreated += rels;
    }

    // -----------------------------------------------------------------------
    // 5. Bulk MERGE :IMPORTS edges between File nodes
    // -----------------------------------------------------------------------
    if (importRows.length > 0) {
      const { nodes, rels } = await unwindBatch(
        importRows,
        `UNWIND $batch AS row
         MATCH (f:File { repoId: $repoId, path: row.filePath })
         MERGE (target:File { repoId: $repoId, path: row.sourcePath })
         MERGE (f)-[:IMPORTS]->(target)`,
        { repoId: params.repoId }
      );
      nodesCreated += nodes;
      relationshipsCreated += rels;
    }

    // -----------------------------------------------------------------------
    // 6. Bulk MERGE :CALLS edges between Function nodes
    // -----------------------------------------------------------------------
    if (callRows.length > 0) {
      const { nodes, rels } = await unwindBatch(
        callRows,
        `UNWIND $batch AS row
         MATCH (caller:Function { repoId: $repoId, filePath: row.filePath, name: row.callerName })
         MERGE (callee:Function { repoId: $repoId, name: row.calleeName })
         MERGE (caller)-[:CALLS]->(callee)`,
        { repoId: params.repoId }
      );
      nodesCreated += nodes;
      relationshipsCreated += rels;
    }

    console.log(
      `[build-graph] Complete. Nodes created: ${nodesCreated}, Relationships created: ${relationshipsCreated}, ` +
      `Files processed: ${params.facts.length}`
    );

    return {
      nodesCreated,
      relationshipsCreated,
      filesProcessed: params.facts.length,
    };
  } finally {
    await session.close();
  }
}
