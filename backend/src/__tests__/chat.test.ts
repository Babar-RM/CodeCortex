import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { User, ConnectedRepo, ChatSession, ChatMessage } from "@prisma/client";
import { app } from "../index";
import { prisma } from "../lib/prisma";
import { askSingleAgent } from "../lib/agent";
import { HybridRetrieveParams } from "../lib/retrieval";
import * as authExpress from "@auth/express";

vi.mock("@auth/express", async () => {
  const actual = await vi.importActual<typeof import("@auth/express")>("@auth/express");
  return {
    ...actual,
    getSession: vi.fn(),
    ExpressAuth: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  };
});

// Mock retrieval
vi.mock("../lib/retrieval", () => ({
  hybridRetrieve: vi.fn().mockImplementation(async (params: HybridRetrieveParams) => {
    if (params.question && params.question.includes("unanswerable")) {
      return {
        repoId: params.connectedRepoId,
        question: params.question,
        seeds: [],
        neighbors: [],
        rankedNodes: [],
        formattedContext: `=== CONTEXT BUNDLE FOR REPOSITORY: ${params.connectedRepoId} ===\n(No seed nodes retrieved)\n=== END OF CONTEXT BUNDLE ===`,
      };
    }

    return {
      repoId: params.connectedRepoId,
      question: params.question,
      seeds: [
        {
          id: "s1",
          entityType: "function",
          entityName: "handleAuth",
          filePath: "src/auth.ts",
          contentChunk: "function handleAuth(req, res) in src/auth.ts",
          source: "seed",
          score: 0.9,
          relationships: [],
        },
      ],
      neighbors: [],
      rankedNodes: [],
      formattedContext: `=== CONTEXT BUNDLE FOR REPOSITORY: ${params.connectedRepoId} ===\n1. [function] handleAuth in src/auth.ts\n=== END OF CONTEXT BUNDLE ===`,
    };
  }),
}));

const mockGetSession = authExpress.getSession as unknown as ReturnType<typeof vi.fn>;

describe("Single-Agent LLM Integration & Chat Persistence (RFC 0012)", () => {
  const mockUser = {
    id: "user_chat_123",
    githubId: "gh_chat_123",
    githubLogin: "chatuser",
    email: "chat@example.com",
    avatarUrl: "https://avatar.com/u",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockAuthSession = {
    githubId: mockUser.githubId,
    githubLogin: mockUser.githubLogin,
    avatarUrl: mockUser.avatarUrl,
    user: { email: mockUser.email },
    expires: "2099-01-01T00:00:00.000Z",
  };

  const mockRepo = {
    id: "repo_chat_123",
    userId: mockUser.id,
    fullName: "chatuser/demo-repo",
    htmlUrl: "https://github.com/chatuser/demo-repo",
    isPrivate: false,
    defaultBranch: "main",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockSession = {
    id: "session_123",
    userId: mockUser.id,
    connectedRepoId: mockRepo.id,
    title: "Chat for chatuser/demo-repo",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("askSingleAgent Engine", () => {
    it("returns grounded answer when context is retrieved", async () => {
      const result = await askSingleAgent({
        connectedRepoId: mockRepo.id,
        question: "how does authentication work",
      });

      expect(result.answer).toContain("Based on the repository context retrieved");
      expect(result.contextBundle.repoId).toBe(mockRepo.id);
    });

    it("returns explicit unanswerable response when no context matches", async () => {
      const result = await askSingleAgent({
        connectedRepoId: mockRepo.id,
        question: "unanswerable question about alien code",
      });

      expect(result.answer).toContain("does not contain enough information");
    });
  });

  describe("POST /api/chat/sessions", () => {
    it("returns 401 Unauthorized when unauthenticated", async () => {
      mockGetSession.mockResolvedValue(null);

      const res = await request(app).post("/api/chat/sessions").send({
        connectedRepoId: mockRepo.id,
      });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("returns 404 if connected repository is not owned by user", async () => {
      mockGetSession.mockResolvedValue(mockAuthSession);
      vi.spyOn(prisma.user, "upsert").mockResolvedValue(mockUser as unknown as User);
      vi.spyOn(prisma.connectedRepo, "findFirst").mockResolvedValue(null);

      const res = await request(app).post("/api/chat/sessions").send({
        connectedRepoId: "other_repo",
      });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found or access denied");
    });

    it("returns 201 Created and creates chat session", async () => {
      mockGetSession.mockResolvedValue(mockAuthSession);
      vi.spyOn(prisma.user, "upsert").mockResolvedValue(mockUser as unknown as User);
      vi.spyOn(prisma.connectedRepo, "findFirst").mockResolvedValue(mockRepo as unknown as ConnectedRepo);
      vi.spyOn(prisma.chatSession, "create").mockResolvedValue(mockSession as unknown as ChatSession);

      const res = await request(app).post("/api/chat/sessions").send({
        connectedRepoId: mockRepo.id,
      });

      expect(res.status).toBe(201);
      expect(res.body.session.id).toBe("session_123");
    });
  });

  describe("GET /api/chat/sessions", () => {
    it("returns user chat sessions", async () => {
      mockGetSession.mockResolvedValue(mockAuthSession);
      vi.spyOn(prisma.user, "upsert").mockResolvedValue(mockUser as unknown as User);
      vi.spyOn(prisma.chatSession, "findMany").mockResolvedValue([mockSession] as unknown as ChatSession[]);

      const res = await request(app).get("/api/chat/sessions");

      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(1);
      expect(res.body.sessions[0].id).toBe("session_123");
    });
  });

  describe("POST /api/chat/messages", () => {
    it("saves user message, triggers agent answer, saves assistant reply, and returns both", async () => {
      mockGetSession.mockResolvedValue(mockAuthSession);
      vi.spyOn(prisma.user, "upsert").mockResolvedValue(mockUser as unknown as User);
      vi.spyOn(prisma.chatSession, "findFirst").mockResolvedValue(mockSession as unknown as ChatSession);

      const mockUserMsg = {
        id: "msg_user_1",
        chatSessionId: mockSession.id,
        role: "USER",
        content: "how does handleAuth work?",
        createdAt: new Date(),
      };

      const mockAssistantMsg = {
        id: "msg_asst_1",
        chatSessionId: mockSession.id,
        role: "ASSISTANT",
        content: "Based on the repository context retrieved...",
        createdAt: new Date(),
      };

      vi.spyOn(prisma.chatMessage, "create")
        .mockResolvedValueOnce(mockUserMsg as unknown as ChatMessage)
        .mockResolvedValueOnce(mockAssistantMsg as unknown as ChatMessage);

      vi.spyOn(prisma.chatMessage, "findMany").mockResolvedValue([mockUserMsg] as unknown as ChatMessage[]);
      vi.spyOn(prisma.chatSession, "update").mockResolvedValue(mockSession as unknown as ChatSession);

      const res = await request(app).post("/api/chat/messages").send({
        chatSessionId: mockSession.id,
        content: "how does handleAuth work?",
      });

      expect(res.status).toBe(201);
      expect(res.body.userMessage.content).toBe("how does handleAuth work?");
      expect(res.body.assistantMessage.role).toBe("ASSISTANT");
      expect(prisma.chatMessage.create).toHaveBeenCalledTimes(2);
    });
  });

  describe("GET /api/chat/sessions/:id/messages", () => {
    it("returns message history for valid session", async () => {
      mockGetSession.mockResolvedValue(mockAuthSession);
      vi.spyOn(prisma.user, "upsert").mockResolvedValue(mockUser as unknown as User);
      vi.spyOn(prisma.chatSession, "findFirst").mockResolvedValue(mockSession as unknown as ChatSession);

      const mockMessages = [
        { id: "m1", chatSessionId: mockSession.id, role: "USER", content: "hi", createdAt: new Date() },
        { id: "m2", chatSessionId: mockSession.id, role: "ASSISTANT", content: "hello", createdAt: new Date() },
      ];

      vi.spyOn(prisma.chatMessage, "findMany").mockResolvedValue(mockMessages as unknown as ChatMessage[]);

      const res = await request(app).get(`/api/chat/sessions/${mockSession.id}/messages`);

      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(2);
    });

    it("returns 404 when requesting session owned by another user", async () => {
      mockGetSession.mockResolvedValue(mockAuthSession);
      vi.spyOn(prisma.user, "upsert").mockResolvedValue(mockUser as unknown as User);
      vi.spyOn(prisma.chatSession, "findFirst").mockResolvedValue(null);

      const res = await request(app).get("/api/chat/sessions/foreign_session/messages");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("access denied");
    });
  });
});
