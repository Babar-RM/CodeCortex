import { prisma } from "../lib/prisma";
import { getNeo4jDriver, closeNeo4jDriver } from "../lib/neo4j";
import { connection, closeQueue } from "../jobs/queue";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, "../../.env") });

async function clearAllDatabases() {
  console.log("Starting full database wipe...\n");

  // 1. PostgreSQL Cleanup
  console.log("1. Clearing PostgreSQL data...");
  try {
    const deletedInsights = await prisma.insightCache.deleteMany({});
    const deletedEmbeddings = await prisma.codeEmbedding.deleteMany({});
    const deletedMessages = await prisma.chatMessage.deleteMany({});
    const deletedSessions = await prisma.chatSession.deleteMany({});
    const deletedJobs = await prisma.indexingJob.deleteMany({});
    const deletedRepos = await prisma.connectedRepo.deleteMany({});
    const deletedUsers = await prisma.user.deleteMany({});

    console.log(`   - Deleted ${deletedInsights.count} InsightCache records`);
    console.log(`   - Deleted ${deletedEmbeddings.count} CodeEmbedding records`);
    console.log(`   - Deleted ${deletedMessages.count} ChatMessage records`);
    console.log(`   - Deleted ${deletedSessions.count} ChatSession records`);
    console.log(`   - Deleted ${deletedJobs.count} IndexingJob records`);
    console.log(`   - Deleted ${deletedRepos.count} ConnectedRepo records`);
    console.log(`   - Deleted ${deletedUsers.count} User records`);
    console.log("   ✅ PostgreSQL successfully cleared.\n");
  } catch (err: any) {
    console.error("   ❌ Failed to clear PostgreSQL:", err.message || err);
  }

  // 2. Neo4j Graph Database Cleanup
  console.log("2. Clearing Neo4j Graph Database...");
  try {
    const driver = getNeo4jDriver();
    const session = driver.session();
    const result = await session.run("MATCH (n) DETACH DELETE n RETURN count(n) as deletedCount");
    const count = result.records[0]?.get("deletedCount")?.toString() || "0";
    await session.close();
    await closeNeo4jDriver();
    console.log(`   - Deleted ${count} Neo4j nodes and all associated relationships`);
    console.log("   ✅ Neo4j successfully cleared.\n");
  } catch (err: any) {
    console.error("   ❌ Failed to clear Neo4j:", err.message || err);
  }

  // 3. Redis Queue & Cache Cleanup
  console.log("3. Clearing Redis queues and cache...");
  try {
    await connection.connect().catch(() => {});
    await connection.flushall();
    await closeQueue();
    console.log("   - Flushed all Redis keys & BullMQ job queues");
    console.log("   ✅ Redis successfully cleared.\n");
  } catch (err: any) {
    console.error("   ❌ Failed to clear Redis:", err.message || err);
  }

  console.log("All requested databases have been completely wiped.");
  process.exit(0);
}

clearAllDatabases().catch((err) => {
  console.error("Fatal error during database cleanup:", err);
  process.exit(1);
});
