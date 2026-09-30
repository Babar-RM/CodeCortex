import { prisma } from "../lib/prisma";

async function cleanDatabase() {
  console.log("[Clean DB] Truncating all PostgreSQL tables...");
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE chat_messages, chat_sessions, code_embeddings, indexing_jobs, connected_repos, users, insight_cache CASCADE;`
  );
  console.log("✅ All PostgreSQL database tables cleared cleanly!");
  process.exit(0);
}

cleanDatabase().catch((err) => {
  console.error("❌ Failed to clean database:", err);
  process.exit(1);
});
