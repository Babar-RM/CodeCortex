import { Request, Response, NextFunction } from "express";
import { connection } from "../jobs/queue";

export interface RateLimitOptions {
  action: string;
  maxRequests: number;
  windowSeconds: number;
}

/**
 * Express middleware to enforce per-user rate limits backed by Redis (RFC 0020).
 * Key format: rate_limit:{userId}:{action}
 */
export function rateLimitUser(options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const key = `rate_limit:${userId}:${options.action}`;

    try {
      if (connection.status === "ready" || connection.status === "connecting" || connection.status === "connect") {
        const currentCount = await connection.incr(key);
        if (currentCount === 1) {
          await connection.expire(key, options.windowSeconds);
        }

        if (currentCount > options.maxRequests) {
          const ttl = await connection.ttl(key);
          const retryAfterSeconds = ttl > 0 ? ttl : options.windowSeconds;
          res.setHeader("Retry-After", String(retryAfterSeconds));
          return res.status(429).json({
            error: `Rate limit exceeded for action '${options.action}'. Maximum allowed is ${options.maxRequests} per ${options.windowSeconds} seconds. Please try again in ${retryAfterSeconds} seconds.`,
            retryAfterSeconds,
          });
        }
      }
    } catch {
      // Fallback gracefully if Redis connection fails or is unavailable during test execution
    }

    return next();
  };
}

export interface TokenBudgetCheckResult {
  allowed: boolean;
  currentUsage: number;
  dailyCap: number;
}

export const DEFAULT_DAILY_TOKEN_CAP = 100_000;

/**
 * Checks if a user has remaining capacity within their daily LLM token budget (RFC 0020).
 * Key format: token_budget:{userId}:{YYYY-MM-DD}
 */
export async function checkTokenBudget(
  userId: string,
  dailyCapTokens = DEFAULT_DAILY_TOKEN_CAP
): Promise<TokenBudgetCheckResult> {
  const today = new Date().toISOString().split("T")[0];
  const key = `token_budget:${userId}:${today}`;

  try {
    if (connection.status === "ready" || connection.status === "connecting" || connection.status === "connect") {
      const val = await connection.get(key);
      const currentUsage = val ? parseInt(val, 10) : 0;
      const allowed = currentUsage < dailyCapTokens;
      return { allowed, currentUsage, dailyCap: dailyCapTokens };
    }
  } catch {
    // Fallback
  }

  return { allowed: true, currentUsage: 0, dailyCap: dailyCapTokens };
}

/**
 * Records LLM token usage for a user against their daily token budget (RFC 0020).
 */
export async function recordTokenUsage(
  userId: string,
  tokensUsed: number
): Promise<number> {
  if (tokensUsed <= 0) return 0;
  const today = new Date().toISOString().split("T")[0];
  const key = `token_budget:${userId}:${today}`;

  try {
    if (connection.status === "ready" || connection.status === "connecting" || connection.status === "connect") {
      const newTotal = await connection.incrby(key, tokensUsed);
      if (newTotal === tokensUsed) {
        await connection.expire(key, 86400 * 2); // 48-hour expiration
      }
      return newTotal;
    }
  } catch {
    // Fallback
  }

  return tokensUsed;
}
