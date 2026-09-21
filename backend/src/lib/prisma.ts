import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    errorFormat: "pretty",
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * Utility: retry a Prisma operation with exponential backoff.
 * Neon free-tier connections can be cold-started and may drop.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  retries = 3,
  baseDelayMs = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      const isConnectionError =
        error instanceof Error &&
        (error.message.includes("Can't reach database server") ||
         error.message.includes("ConnectionReset") ||
         error.message.includes("connection was forcibly closed") ||
         error.message.includes("Connection timed out") ||
         error.message.includes("Connection refused") ||
         error.message.includes("terminating connection") ||
         error.message.includes("administrator command") ||
         error.message.includes("57P01"));

      if (isConnectionError && attempt < retries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        console.warn(
          `[prisma] Connection error (attempt ${attempt}/${retries}), retrying in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw new Error("withRetry: exhausted all retries");
}
