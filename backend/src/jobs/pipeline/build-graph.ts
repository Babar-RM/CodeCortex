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

export async function buildGraph(params: BuildGraphParams): Promise<BuildGraphResult> {
  const driver = params.driver || getNeo4jDriver();
  const session = driver.session();

  let nodesCreated = 0;
  let relationshipsCreated = 0;

  try {
    await session.run(
      `
      MERGE (r:Repo { id: $repoId })
      ON CREATE SET r.fullName = $repoName
      `,
      { repoId: params.repoId, repoName: params.repoName }
    );
    nodesCreated++;

    for (const fact of params.facts) {
      const filePath = fact.filePath;

      await session.run(
        `
        MERGE (r:Repo { id: $repoId })
        MERGE (f:File { repoId: $repoId, path: $filePath })
        MERGE (r)-[:CONTAINS]->(f)
        `,
        { repoId: params.repoId, filePath }
      );
      nodesCreated++;
      relationshipsCreated++;

      for (const fn of fact.functions) {
        await session.run(
          `
          MATCH (f:File { repoId: $repoId, path: $filePath })
          MERGE (fn:Function {
            repoId: $repoId,
            filePath: $filePath,
            name: $funcName,
            startLine: $startLine
          })
          ON CREATE SET fn.endLine = $endLine, fn.params = $params, fn.returnType = $returnType
          MERGE (f)-[:DEFINES]->(fn)
          `,
          {
            repoId: params.repoId,
            filePath,
            funcName: fn.name,
            startLine: fn.startLine,
            endLine: fn.endLine,
            params: fn.params || [],
            returnType: fn.returnType || null,
          }
        );
        nodesCreated++;
        relationshipsCreated++;
      }

      for (const cls of fact.classes) {
        await session.run(
          `
          MATCH (f:File { repoId: $repoId, path: $filePath })
          MERGE (c:Class {
            repoId: $repoId,
            filePath: $filePath,
            name: $className
          })
          ON CREATE SET c.startLine = $startLine, c.endLine = $endLine
          MERGE (f)-[:DEFINES]->(c)
          `,
          {
            repoId: params.repoId,
            filePath,
            className: cls.name,
            startLine: cls.startLine,
            endLine: cls.endLine,
          }
        );
        nodesCreated++;
        relationshipsCreated++;

        for (const parentClass of cls.heritage) {
          await session.run(
            `
            MATCH (c:Class { repoId: $repoId, filePath: $filePath, name: $className })
            MERGE (parent:Class { repoId: $repoId, name: $parentClass })
            MERGE (c)-[:INHERITS]->(parent)
            `,
            {
              repoId: params.repoId,
              filePath,
              className: cls.name,
              parentClass,
            }
          );
          relationshipsCreated++;
        }
      }

      for (const imp of fact.imports) {
        await session.run(
          `
          MATCH (f:File { repoId: $repoId, path: $filePath })
          MERGE (target:File { repoId: $repoId, path: $sourcePath })
          MERGE (f)-[:IMPORTS]->(target)
          `,
          {
            repoId: params.repoId,
            filePath,
            sourcePath: imp.sourcePath,
          }
        );
        relationshipsCreated++;
      }

      for (const call of fact.calls) {
        await session.run(
          `
          MATCH (caller:Function { repoId: $repoId, filePath: $filePath, name: $callerName })
          MERGE (callee:Function { repoId: $repoId, name: $calleeName })
          MERGE (caller)-[:CALLS]->(callee)
          `,
          {
            repoId: params.repoId,
            filePath,
            callerName: call.callerName,
            calleeName: call.calleeName,
          }
        );
        relationshipsCreated++;
      }
    }

    return {
      nodesCreated,
      relationshipsCreated,
      filesProcessed: params.facts.length,
    };
  } finally {
    await session.close();
  }
}
