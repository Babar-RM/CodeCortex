import { Queue } from "bullmq";
import Redis from "ioredis";

export interface IndexRepoJobPayload {
  indexingJobId: string;
  connectedRepoId: string;
}

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

export const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  enableOfflineQueue: false,
});

// Suppress unhandled redis connection error logs during offline unit tests
connection.on("error", () => {
  // Silent error handling when Redis is not running locally in test environment
});

export const indexRepoQueue = new Queue<IndexRepoJobPayload>("index-repo", {
  connection: connection as unknown as Redis,
});


export async function closeQueue(): Promise<void> {
  try {
    await indexRepoQueue.close();
    await connection.quit();
  } catch {
    // Ignore close errors if connection was not established
  }
}
