import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import { rateLimitUser, checkTokenBudget, recordTokenUsage } from "../middleware/rateLimit";
import { connection } from "../jobs/queue";

vi.mock("../jobs/queue", () => ({
  connection: {
    status: "ready",
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
    get: vi.fn(),
    incrby: vi.fn(),
  },
}));

describe("Phase 5 Step 20 — Rate Limiting & Cost Controls (RFC 0020)", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let nextFn: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReq = {
      user: {
        id: "user_test_123",
        githubId: "123",
        githubLogin: "octocat",
        email: "octocat@github.com",
        avatarUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    };
    nextFn = vi.fn() as unknown as NextFunction;
  });

  describe("rateLimitUser Middleware", () => {
    it("should allow request and call next() when requests are below limit", async () => {
      vi.mocked(connection.incr).mockResolvedValue(1);
      vi.mocked(connection.expire).mockResolvedValue(1);

      const middleware = rateLimitUser({
        action: "test_action",
        maxRequests: 5,
        windowSeconds: 3600,
      });

      await middleware(mockReq as Request, mockRes as Response, nextFn);

      expect(connection.incr).toHaveBeenCalledWith("rate_limit:user_test_123:test_action");
      expect(connection.expire).toHaveBeenCalledWith("rate_limit:user_test_123:test_action", 3600);
      expect(nextFn).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalledWith(429);
    });

    it("should return 429 Too Many Requests when request limit is exceeded", async () => {
      vi.mocked(connection.incr).mockResolvedValue(6); // 6 > max 5
      vi.mocked(connection.ttl).mockResolvedValue(1800);

      const middleware = rateLimitUser({
        action: "index_repo",
        maxRequests: 5,
        windowSeconds: 3600,
      });

      await middleware(mockReq as Request, mockRes as Response, nextFn);

      expect(nextFn).not.toHaveBeenCalled();
      expect(mockRes.setHeader).toHaveBeenCalledWith("Retry-After", "1800");
      expect(mockRes.status).toHaveBeenCalledWith(429);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("Rate limit exceeded for action 'index_repo'"),
          retryAfterSeconds: 1800,
        })
      );
    });

    it("should return 401 Unauthorized if user is not attached to request", async () => {
      mockReq.user = undefined;

      const middleware = rateLimitUser({
        action: "test_action",
        maxRequests: 5,
        windowSeconds: 3600,
      });

      await middleware(mockReq as Request, mockRes as Response, nextFn);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(nextFn).not.toHaveBeenCalled();
    });
  });

  describe("Token Budget Tracking", () => {
    it("should return allowed: true when daily token usage is below cap", async () => {
      vi.mocked(connection.get).mockResolvedValue("25000");

      const result = await checkTokenBudget("user_test_123", 100_000);

      expect(result.allowed).toBe(true);
      expect(result.currentUsage).toBe(25000);
      expect(result.dailyCap).toBe(100_000);
    });

    it("should return allowed: false when daily token usage reaches cap", async () => {
      vi.mocked(connection.get).mockResolvedValue("105000");

      const result = await checkTokenBudget("user_test_123", 100_000);

      expect(result.allowed).toBe(false);
      expect(result.currentUsage).toBe(105000);
    });

    it("should increment daily token usage with recordTokenUsage", async () => {
      vi.mocked(connection.incrby).mockResolvedValue(1500);
      vi.mocked(connection.expire).mockResolvedValue(1);

      const newTotal = await recordTokenUsage("user_test_123", 1500);

      expect(newTotal).toBe(1500);
      expect(connection.incrby).toHaveBeenCalled();
    });
  });
});
