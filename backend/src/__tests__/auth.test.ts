import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../index";
import { prisma } from "../lib/prisma";
import * as authExpress from "@auth/express";

vi.mock("@auth/express", async () => {
  const actual = await vi.importActual<typeof import("@auth/express")>("@auth/express");
  return {
    ...actual,
    getSession: vi.fn(),
    ExpressAuth: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  };
});

vi.mock("../lib/prisma", () => ({
  withRetry: (fn: any) => fn(),
  prisma: {
    user: {
      upsert: vi.fn(),
    },
  },
}));

describe("Authentication Middleware & GET /api/me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return 401 Unauthorized when no session exists", async () => {
    vi.mocked(authExpress.getSession).mockResolvedValue(null);

    const response = await request(app).get("/api/me");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthorized" });
  });

  it("should return 200 with user data when valid session exists", async () => {
    const mockSession = {
      githubId: "123456",
      githubLogin: "octocat",
      avatarUrl: "https://github.com/images/error/octocat_happy.gif",
      githubAccessToken: "gho_mocktoken123456",
      user: {
        email: "octocat@github.com",
      },
      expires: "2099-01-01T00:00:00.000Z",
    };

    const mockUser = {
      id: "cuid123",
      githubId: "123456",
      githubLogin: "octocat",
      email: "octocat@github.com",
      avatarUrl: "https://github.com/images/error/octocat_happy.gif",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.mocked(authExpress.getSession).mockResolvedValue(mockSession as never);
    vi.mocked(prisma.user.upsert).mockResolvedValue(mockUser as never);

    const response = await request(app).get("/api/me");
    expect(response.status).toBe(200);
    expect(response.body.user.githubId).toBe("123456");
    expect(response.body.user.githubLogin).toBe("octocat");
    expect(response.body.hasToken).toBe(true);
    expect(prisma.user.upsert).toHaveBeenCalledWith({
      where: { githubId: "123456" },
      update: {
        githubLogin: "octocat",
        avatarUrl: "https://github.com/images/error/octocat_happy.gif",
        email: "octocat@github.com",
      },
      create: {
        githubId: "123456",
        githubLogin: "octocat",
        avatarUrl: "https://github.com/images/error/octocat_happy.gif",
        email: "octocat@github.com",
      },
    });
  });
});
