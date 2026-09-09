import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { rateLimitUser, checkTokenBudget } from "../middleware/rateLimit";
import { askSingleAgent, ChatHistoryMessage } from "../lib/agent";
import { runMultiAgentPipeline, AgentStreamEvent } from "../lib/agents/orchestrator";

export const chatRouter = Router();

// Apply requireAuth to all chat endpoints
chatRouter.use(requireAuth);

const CreateSessionSchema = z.object({
  connectedRepoId: z.string().min(1, "connectedRepoId is required"),
  title: z.string().optional(),
});

const PostMessageSchema = z.object({
  chatSessionId: z.string().min(1, "chatSessionId is required"),
  content: z.string().min(1, "content cannot be empty"),
});

/**
 * POST /api/chat/sessions
 * Create a new chat session scoped to a connected repo owned by the authenticated user
 */
chatRouter.post("/sessions", async (req: Request, res: Response) => {
  try {
    const parseResult = CreateSessionSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: parseResult.error.issues[0].message });
    }

    const { connectedRepoId, title } = parseResult.data;

    // Verify repository ownership
    const repo = await prisma.connectedRepo.findFirst({
      where: {
        id: connectedRepoId,
        userId: req.user!.id,
      },
    });

    if (!repo) {
      return res.status(404).json({ error: "Connected repository not found or access denied" });
    }

    const session = await prisma.chatSession.create({
      data: {
        userId: req.user!.id,
        connectedRepoId,
        title: title || `Chat for ${repo.fullName}`,
      },
    });

    return res.status(201).json({ session });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : "Internal server error";
    return res.status(500).json({ error: errorMessage });
  }
});

/**
 * GET /api/chat/sessions
 * List chat sessions owned by the authenticated user (optional ?connectedRepoId= filter)
 */
chatRouter.get("/sessions", async (req: Request, res: Response) => {
  try {
    const connectedRepoId = req.query.connectedRepoId as string | undefined;

    const sessions = await prisma.chatSession.findMany({
      where: {
        userId: req.user!.id,
        ...(connectedRepoId ? { connectedRepoId } : {}),
      },
      orderBy: { updatedAt: "desc" },
      include: {
        connectedRepo: {
          select: {
            id: true,
            fullName: true,
          },
        },
      },
    });

    return res.json({ sessions });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : "Internal server error";
    return res.status(500).json({ error: errorMessage });
  }
});

/**
 * POST /api/chat/messages
 * Post a user message, trigger single-agent LLM retrieval & completion, save assistant reply, return both
 */
chatRouter.post(
  "/messages",
  rateLimitUser({ action: "ask_question", maxRequests: 30, windowSeconds: 3600 }),
  async (req: Request, res: Response) => {
    try {
      const parseResult = PostMessageSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: parseResult.error.issues[0].message });
      }

      const { chatSessionId, content } = parseResult.data;

      // Verify daily token budget (RFC 0020)
      const tokenCheck = await checkTokenBudget(req.user!.id);
      if (!tokenCheck.allowed) {
        return res.status(429).json({
          error: `Daily token budget of ${tokenCheck.dailyCap} tokens exceeded for user. Current usage: ${tokenCheck.currentUsage} tokens. Budget resets at midnight UTC.`,
        });
      }

      // Verify session ownership
      const session = await prisma.chatSession.findFirst({
        where: {
          id: chatSessionId,
          userId: req.user!.id,
        },
      });

      if (!session) {
        return res.status(404).json({ error: "Chat session not found or access denied" });
      }

      // Save user message
      const userMessage = await prisma.chatMessage.create({
        data: {
          chatSessionId,
          role: "USER",
          content,
        },
      });

      // Fetch prior messages as chat history
      const previousMessages = await prisma.chatMessage.findMany({
        where: { chatSessionId },
        orderBy: { createdAt: "asc" },
      });

      const chatHistory: ChatHistoryMessage[] = previousMessages
        .filter((m) => m.id !== userMessage.id)
        .map((m) => ({
          role: m.role === "USER" ? "user" : "assistant",
          content: m.content,
        }));

      // Trigger single-agent LLM response
      const agentResult = await askSingleAgent({
        connectedRepoId: session.connectedRepoId,
        question: content,
        chatHistory,
      });

      // Save assistant message
      const assistantMessage = await prisma.chatMessage.create({
        data: {
          chatSessionId,
          role: "ASSISTANT",
          content: agentResult.answer,
        },
      });

      // Update session updatedAt timestamp
      await prisma.chatSession.update({
        where: { id: chatSessionId },
        data: { updatedAt: new Date() },
      });

      return res.status(201).json({
        userMessage,
        assistantMessage,
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : "Internal server error";
      return res.status(500).json({ error: errorMessage });
    }
  }
);

/**
 * POST /api/chat/messages/stream
 * Real-time Server-Sent Events (SSE) endpoint streaming intermediate multi-agent pipeline progress (RFC 0016)
 */
chatRouter.post(
  "/messages/stream",
  rateLimitUser({ action: "ask_question", maxRequests: 30, windowSeconds: 3600 }),
  async (req: Request, res: Response) => {
    try {
      const parseResult = PostMessageSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: parseResult.error.issues[0].message });
      }

      const { chatSessionId, content } = parseResult.data;

      // Verify daily token budget (RFC 0020)
      const tokenCheck = await checkTokenBudget(req.user!.id);
      if (!tokenCheck.allowed) {
        return res.status(429).json({
          error: `Daily token budget of ${tokenCheck.dailyCap} tokens exceeded for user. Current usage: ${tokenCheck.currentUsage} tokens. Budget resets at midnight UTC.`,
        });
      }

      // Verify session ownership
      const session = await prisma.chatSession.findFirst({
        where: {
          id: chatSessionId,
          userId: req.user!.id,
        },
      });

      if (!session) {
        return res.status(404).json({ error: "Chat session not found or access denied" });
      }

      // Set SSE Headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }

      // Helper to send JSON SSE event data
      const sendSSEEvent = (event: AgentStreamEvent) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      // Save user message
      await prisma.chatMessage.create({
        data: {
          chatSessionId,
          role: "USER",
          content,
        },
      });

      // Execute multi-agent pipeline with real-time SSE progress streaming
      const pipelineResult = await runMultiAgentPipeline({
        connectedRepoId: session.connectedRepoId,
        question: content,
        onProgress: sendSSEEvent,
      });

      // Save assistant reply message
      await prisma.chatMessage.create({
        data: {
          chatSessionId,
          role: "ASSISTANT",
          content: pipelineResult.answer,
        },
      });

      // Update session updatedAt timestamp
      await prisma.chatSession.update({
        where: { id: chatSessionId },
        data: { updatedAt: new Date() },
      });

      return res.end();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : "Internal server error";
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: "error", message: errorMessage })}\n\n`);
        return res.end();
      }
      return res.status(500).json({ error: errorMessage });
    }
  }
);

/**
 * GET /api/chat/sessions/:id/messages
 * List full message history for a chat session owned by the authenticated user
 */
chatRouter.get("/sessions/:id/messages", async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;

    // Verify session ownership
    const session = await prisma.chatSession.findFirst({
      where: {
        id: sessionId,
        userId: req.user!.id,
      },
    });

    if (!session) {
      return res.status(404).json({ error: "Chat session not found or access denied" });
    }

    const messages = await prisma.chatMessage.findMany({
      where: { chatSessionId: sessionId },
      orderBy: { createdAt: "asc" },
    });

    return res.json({ messages });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : "Internal server error";
    return res.status(500).json({ error: errorMessage });
  }
});
