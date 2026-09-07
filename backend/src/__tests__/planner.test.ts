import { describe, it, expect, vi } from "vitest";
import { planQuestion, classifyHeuristically } from "../lib/agents/planner";

describe("Planner Agent Module (RFC 0013)", () => {
  const connectedRepoId = "repo_planner_123";

  describe("Heuristic & System Rules Classification", () => {
    it("classifies explanatory questions as 'explain'", async () => {
      const q1 = await planQuestion({ question: "How does authentication work here?", connectedRepoId });
      expect(q1.type).toBe("explain");

      const q2 = await planQuestion({ question: "Explain the user ingestion pipeline.", connectedRepoId });
      expect(q2.type).toBe("explain");
    });

    it("classifies caller tracing / impact analysis questions as 'bug_trace'", async () => {
      const q1 = await planQuestion({ question: "What functions call verifyJwt?", connectedRepoId });
      expect(q1.type).toBe("bug_trace");

      const q2 = await planQuestion({ question: "What breaks if I change processOrder?", connectedRepoId });
      expect(q2.type).toBe("bug_trace");

      const q3 = await planQuestion({ question: "Trace callers of handleAuth function.", connectedRepoId });
      expect(q3.type).toBe("bug_trace");
    });

    it("classifies code auditing / security review questions as 'review'", async () => {
      const q1 = await planQuestion({ question: "Review this function for security vulnerabilities.", connectedRepoId });
      expect(q1.type).toBe("review");

      const q2 = await planQuestion({ question: "Audit the session management code for code smells.", connectedRepoId });
      expect(q2.type).toBe("review");
    });

    it("classifies refactoring / optimization questions as 'refactor'", async () => {
      const q1 = await planQuestion({ question: "How can I refactor this large function?", connectedRepoId });
      expect(q1.type).toBe("refactor");

      const q2 = await planQuestion({ question: "Suggest performance optimizations for this database query.", connectedRepoId });
      expect(q2.type).toBe("refactor");
    });

    it("defaults ambiguous or broad questions to 'explain' per RFC 0013 fallback specification", async () => {
      const q1 = await planQuestion({ question: "Tell me about the repo and maybe fix something.", connectedRepoId });
      expect(q1.type).toBe("explain");

      const q2 = await planQuestion({ question: "What is this project about?", connectedRepoId });
      expect(q2.type).toBe("explain");

      const q3 = await planQuestion({ question: "", connectedRepoId });
      expect(q3.type).toBe("explain");
    });
  });

  describe("Custom LLM Provider Integration & Response Parsing", () => {
    it("parses valid JSON response from custom LLM completion function", async () => {
      const customLlm = vi.fn().mockResolvedValue(
        JSON.stringify({
          type: "bug_trace",
          reasoning: "The query asks for dependency tracking.",
        })
      );

      const result = await planQuestion({
        question: "Custom dependency query",
        connectedRepoId,
        customLlmCompletion: customLlm,
      });

      expect(result.type).toBe("bug_trace");
      expect(result.reasoning).toContain("dependency tracking");
      expect(customLlm).toHaveBeenCalledTimes(1);
    });

    it("falls back to heuristic classification if custom LLM output is unparseable", async () => {
      const customLlm = vi.fn().mockResolvedValue("Sorry, I cannot produce JSON response.");

      const result = await planQuestion({
        question: "What functions call verifyJwt?",
        connectedRepoId,
        customLlmCompletion: customLlm,
      });

      expect(result.type).toBe("bug_trace");
    });

    it("falls back to 'explain' if custom LLM produces invalid question type", async () => {
      const customLlm = vi.fn().mockResolvedValue(
        JSON.stringify({
          type: "unknown_category",
          reasoning: "Invalid type test.",
        })
      );

      const result = await planQuestion({
        question: "General question",
        connectedRepoId,
        customLlmCompletion: customLlm,
      });

      expect(result.type).toBe("explain");
    });
  });

  describe("Direct Heuristic Function", () => {
    it("correctly identifies all 4 categories via classifyHeuristically", () => {
      expect(classifyHeuristically("explain this file").type).toBe("explain");
      expect(classifyHeuristically("who calls this method").type).toBe("bug_trace");
      expect(classifyHeuristically("audit security of this handler").type).toBe("review");
      expect(classifyHeuristically("restructure this class").type).toBe("refactor");
    });
  });
});
