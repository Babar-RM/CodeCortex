import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { Driver } from "neo4j-driver";
import { User, ChatSession, ChatMessage } from "@prisma/client";
import { app } from "../index";
import { prisma } from "../lib/prisma";
import { runMultiAgentPipeline, AgentStreamEvent } from "../lib/agents/orchestrator";
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
  prisma: {
    user: { upsert: vi.fn() },
    connectedRepo: { findFirst: vi.fn() },
    chatSession: { findFirst: vi.fn(), update: vi.fn() },
    chatMessage: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    codeEmbedding: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "emb-1",
          connectedRepoId: "repo_stream_123",
          entityType: "function",
          entityName: "handleAuth",
          filePath: "src/auth.ts",
          contentChunk: "function handleAuth(req, res)",
        },
      ]),
    },
  },
}));

vi.mock("../lib/retrieval", () => ({
  embedQuestion: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  semanticSearchSeeds: vi.fn().mockResolvedValue([
    {
      id: "s1",
      entityType: "function",
      entityName: "handleAuth",
      filePath: "src/auth.ts",
      contentChunk: "function handleAuth(req, res)",
      source: "seed",
      score: 0.9,
    },
  ]),
}));

const mockGetSession = authExpress.getSession as unknown as ReturnType<typeof vi.fn>;

describe("Agent Step Streaming & Multi-Agent Orchestrator (RFC 0016)", () => {
  const mockUser = {
    id: "user_stream_123",
    githubId: "gh_stream_123",
    githubLogin: "streamuser",
    email: "stream@example.com",
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
    id: "repo_stream_123",
    userId: mockUser.id,
    fullName: "streamuser/demo-repo",
    htmlUrl: "https://github.com/streamuser/demo-repo",
    isPrivate: false,
    defaultBranch: "main",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockSession = {
    id: "session_stream_123",
    userId: mockUser.id,
    connectedRepoId: mockRepo.id,
    title: "Stream Session",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockNeo4jSession = {
    run: vi.fn().mockImplementation(async (query: string, _params: Record<string, string>) => {
      if (query.includes("MATCH (caller:Function") || query.includes("MATCH (s:Function")) {
        return { records: [{ get: () => "node" }] };
      }
      return { records: [] };
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockDriver = {
    session: () => mockNeo4jSession,
  } as unknown as Driver;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("runMultiAgentPipeline Orchestration", () => {
    it("executes full pipeline emitting planning -> planned -> investigating -> verifying -> answer events", async () => {
      const eventsEmitted: AgentStreamEvent[] = [];

      const result = await runMultiAgentPipeline({
        connectedRepoId: mockRepo.id,
        question: "How does handleAuth work?",
        onProgress: (evt) => eventsEmitted.push(evt),
        customDriver: mockDriver,
      });

      expect(result.questionType).toBe("explain");
      expect(result.answer).toBeDefined();

      const eventTypes = eventsEmitted.map((e) => e.type);
      expect(eventTypes).toContain("planning");
      expect(eventTypes).toContain("planned");
      expect(eventTypes).toContain("investigating");
      expect(eventTypes).toContain("drafting");
      expect(eventTypes).toContain("verifying");
      expect(eventTypes).toContain("answer");
    });

    it("routes bug_trace question to Bug-Tracer specialist", async () => {
      const eventsEmitted: AgentStreamEvent[] = [];

      const result = await runMultiAgentPipeline({
        connectedRepoId: mockRepo.id,
        question: "What functions call handleAuth?",
        onProgress: (evt) => eventsEmitted.push(evt),
        customDriver: mockDriver,
      });

      expect(result.questionType).toBe("bug_trace");
      const investigatingEvent = eventsEmitted.find((e) => e.type === "investigating") as Extract<AgentStreamEvent, { type: "investigating" }>;
      expect(investigatingEvent.specialist).toBe("Bug-Tracer");
    });

    it("routes review question to Reviewer specialist", async () => {
      const eventsEmitted: AgentStreamEvent[] = [];

      const result = await runMultiAgentPipeline({
        connectedRepoId: mockRepo.id,
        question: "Review auth.ts for security vulnerabilities",
        onProgress: (evt) => eventsEmitted.push(evt),
        customDriver: mockDriver,
      });

      expect(result.questionType).toBe("review");
      const investigatingEvent = eventsEmitted.find((e) => e.type === "investigating") as Extract<AgentStreamEvent, { type: "investigating" }>;
      expect(investigatingEvent.specialist).toBe("Reviewer");
    });

    it("routes refactor question to Refactorer specialist", async () => {
      const eventsEmitted: AgentStreamEvent[] = [];

      const result = await runMultiAgentPipeline({
        connectedRepoId: mockRepo.id,
        question: "How can I refactor this large function?",
        onProgress: (evt) => eventsEmitted.push(evt),
        customDriver: mockDriver,
      });

      expect(result.questionType).toBe("refactor");
      const investigatingEvent = eventsEmitted.find((e) => e.type === "investigating") as Extract<AgentStreamEvent, { type: "investigating" }>;
      expect(investigatingEvent.specialist).toBe("Refactorer");
    });
  });

  describe("POST /api/chat/messages/stream (SSE Route)", () => {
    it("returns 401 Unauthorized when unauthenticated", async () => {
      mockGetSession.mockResolvedValue(null);

      const res = await request(app).post("/api/chat/messages/stream").send({
        chatSessionId: mockSession.id,
        content: "Hello",
      });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("streams SSE event data and persists user/assistant messages", async () => {
      mockGetSession.mockResolvedValue(mockAuthSession);
      vi.spyOn(prisma.user, "upsert").mockResolvedValue(mockUser as unknown as User);
      vi.spyOn(prisma.chatSession, "findFirst").mockResolvedValue(mockSession as unknown as ChatSession);

      const mockUserMsg = {
        id: "msg_user_stream_1",
        chatSessionId: mockSession.id,
        role: "USER",
        content: "How does handleAuth work?",
        createdAt: new Date(),
      };

      const mockAssistantMsg = {
        id: "msg_asst_stream_1",
        chatSessionId: mockSession.id,
        role: "ASSISTANT",
        content: "Based on investigation...",
        createdAt: new Date(),
      };

      vi.spyOn(prisma.chatMessage, "create")
        .mockResolvedValueOnce(mockUserMsg as unknown as ChatMessage)
        .mockResolvedValueOnce(mockAssistantMsg as unknown as ChatMessage);

      vi.spyOn(prisma.chatSession, "update").mockResolvedValue(mockSession as unknown as ChatSession);

      const res = await request(app)
        .post("/api/chat/messages/stream")
        .send({
          chatSessionId: mockSession.id,
          content: "How does handleAuth work?",
        });

      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.text).toContain("data: ");
      expect(res.text).toContain('"type":"planning"');
      expect(res.text).toContain('"type":"answer"');
      expect(prisma.chatMessage.create).toHaveBeenCalledTimes(2);
    });
  });
});
