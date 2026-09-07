import dotenv from "dotenv";
dotenv.config();

import { getNeo4jDriver, ensureGraphIndexes, closeNeo4jDriver } from "../lib/neo4j";
import { indexWorker } from "./worker";
import { closeQueue } from "./queue";

export async function startWorker(): Promise<void> {
  console.log("[Worker] Initializing Neo4j graph indexes and constraints...");
  try {
    const neo4jDriver = getNeo4jDriver();
    await ensureGraphIndexes(neo4jDriver);
    console.log("[Worker] Neo4j graph indexes initialized.");
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn(`[Worker] Warning: Neo4j index initialization skipped (${errorMessage})`);
  }

  console.log("[Worker] Starting BullMQ ingestion worker listening on queue 'index-repo'...");
  indexWorker.run();

  const shutdown = async (signal: string) => {
    console.log(`[Worker] Received ${signal}, closing worker gracefully...`);
    try {
      await indexWorker.close();
      await closeQueue();
      await closeNeo4jDriver();
      console.log("[Worker] Graceful shutdown complete.");
      process.exit(0);
    } catch (err: unknown) {
      console.error("[Worker] Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  startWorker();
}
