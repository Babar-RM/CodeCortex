"use me";
"use client";

import { useState, useCallback } from "react";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

export type AgentStreamEvent =
  | { type: "planning" }
  | { type: "planned"; questionType: string; reasoning?: string }
  | { type: "investigating"; specialist?: string; toolCall?: string }
  | { type: "tool_result"; toolCall?: string; summary?: string }
  | { type: "drafting" }
  | { type: "verifying" }
  | { type: "revising"; feedback?: string }
  | { type: "answer"; content: string; evidence?: Array<{ claim: string; filePath: string; startLine: number; endLine: number }> }
  | { type: "error"; message: string };

export function useAgentStream() {
  const [events, setEvents] = useState<AgentStreamEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finalAnswer, setFinalAnswer] = useState<string | null>(null);

  const resetStream = useCallback(() => {
    setEvents([]);
    setIsStreaming(false);
    setError(null);
    setFinalAnswer(null);
  }, []);

  const sendStreamMessage = useCallback(
    async (chatSessionId: string, content: string) => {
      resetStream();
      setIsStreaming(true);

      try {
        const response = await fetch(`${BACKEND_URL}/api/chat/messages/stream`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ chatSessionId, content }),
        });

        if (!response.ok) {
          let errorMsg = `HTTP ${response.status}: ${response.statusText}`;
          try {
            const errData = await response.json();
            if (errData.error) errorMsg = errData.error;
          } catch {
            // ignore
          }
          throw new Error(errorMsg);
        }

        if (!response.body) {
          throw new Error("Response body stream unavailable");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() || ""; // keep incomplete tail in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;

            const jsonStr = trimmed.replace(/^data:\s*/, "");
            if (!jsonStr) continue;

            try {
              const event: AgentStreamEvent = JSON.parse(jsonStr);
              setEvents((prev) => [...prev, event]);

              if (event.type === "answer") {
                setFinalAnswer(event.content);
              } else if (event.type === "error") {
                setError(event.message);
              }
            } catch (parseErr) {
              console.warn("Could not parse SSE JSON line:", jsonStr, parseErr);
            }
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to connect streaming response";
        setError(message);
      } finally {
        setIsStreaming(false);
      }
    },
    [resetStream]
  );

  return {
    events,
    isStreaming,
    error,
    finalAnswer,
    sendStreamMessage,
    resetStream,
  };
}
