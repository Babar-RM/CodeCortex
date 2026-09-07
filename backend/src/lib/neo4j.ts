import neo4j, { Driver } from "neo4j-driver";

let driverInstance: Driver | null = null;

export function getNeo4jDriver(): Driver {
  if (!driverInstance) {
    const uri = process.env.NEO4J_URI || "bolt://localhost:7687";
    const user = process.env.NEO4J_USER || "neo4j";
    const password = process.env.NEO4J_PASSWORD || "password";

    driverInstance = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }
  return driverInstance;
}

export async function ensureGraphIndexes(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `CREATE CONSTRAINT repo_id_unique IF NOT EXISTS FOR (r:Repo) REQUIRE r.id IS UNIQUE`
    );
    await session.run(
      `CREATE INDEX file_repo_path IF NOT EXISTS FOR (f:File) ON (f.repoId, f.path)`
    );
    await session.run(
      `CREATE INDEX fn_repo_name IF NOT EXISTS FOR (fn:Function) ON (fn.repoId, fn.name)`
    );
    await session.run(
      `CREATE INDEX class_repo_name IF NOT EXISTS FOR (c:Class) ON (c.repoId, c.name)`
    );
  } finally {
    await session.close();
  }
}

export async function closeNeo4jDriver(): Promise<void> {
  if (driverInstance) {
    await driverInstance.close();
    driverInstance = null;
  }
}
