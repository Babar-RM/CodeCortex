"use me";
"use client";

import React, { useState, useEffect, useRef } from "react";
import { ChatMessage, api } from "@/lib/api";
import { useAgentStream, AgentStreamEvent } from "@/lib/useAgentStream";
import {
  Send,
  User,
  Bot,
  Loader2,
  AlertCircle,
  Sparkles,
  GitBranch,
  ChevronDown,
  ChevronUp,
  BrainCircuit,
  CheckCircle2,
  Wrench,
  ShieldCheck,
  RotateCcw,
} from "lucide-react";

interface ChatThreadProps {
  chatSessionId: string;
  initialMessages: ChatMessage[];
  repoFullName?: string;
}

interface DisplayMessage extends ChatMessage {
  isOptimistic?: boolean;
  isError?: boolean;
}

export function ChatThread({
  chatSessionId,
  initialMessages,
  repoFullName,
}: ChatThreadProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>(initialMessages);
  const [inputContent, setInputContent] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [showReasoning, setShowReasoning] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const {
    events,
    isStreaming,
    error: streamError,
    finalAnswer,
    sendStreamMessage,
  } = useAgentStream();

  useEffect(() => {
    setMessages(initialMessages);
  }, [initialMessages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, events, isStreaming]);

  // When finalAnswer arrives from SSE, append assistant message into history
  useEffect(() => {
    if (finalAnswer && !isStreaming) {
      setMessages((prev) => {
        // avoid duplicating if already present
        const last = prev[prev.length - 1];
        if (last && last.role === "ASSISTANT" && last.content === finalAnswer) {
          return prev;
        }
        return [
          ...prev,
          {
            id: `assistant-${Date.now()}`,
            chatSessionId,
            role: "ASSISTANT",
            content: finalAnswer,
            createdAt: new Date().toISOString(),
          },
        ];
      });
    }
  }, [finalAnswer, isStreaming, chatSessionId]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = inputContent.trim();
    if (!content || isStreaming) return;

    setLocalError(null);
    setInputContent("");

    // Optimistic User Message
    const optimisticId = `optimistic-${Date.now()}`;
    const optimisticUserMsg: DisplayMessage = {
      id: optimisticId,
      chatSessionId,
      role: "USER",
      content,
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, optimisticUserMsg]);
    setShowReasoning(true);

    try {
      // Trigger SSE streaming pipeline (RFC 0026)
      await sendStreamMessage(chatSessionId, content);
    } catch (err: unknown) {
      // Fallback to sync API if SSE endpoint encounters error
      console.warn("SSE Stream failed, falling back to sync endpoint", err);
      try {
        const syncResponse = await api.sendChatMessage({ chatSessionId, content });
        setMessages((prev) =>
          prev
            .filter((m) => m.id !== optimisticId)
            .concat(syncResponse.userMessage, syncResponse.assistantMessage)
        );
      } catch (fallbackErr: unknown) {
        const msg = fallbackErr instanceof Error ? fallbackErr.message : "Failed to send message";
        setLocalError(msg);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  };

  const renderEventItem = (evt: AgentStreamEvent, idx: number) => {
    switch (evt.type) {
      case "planning":
        return (
          <div key={idx} className="flex items-center gap-2 text-xs text-slate-400">
            <BrainCircuit className="w-3.5 h-3.5 text-primary-400 animate-pulse" />
            <span>Analyzing question intent and context...</span>
          </div>
        );
      case "planned":
        return (
          <div key={idx} className="flex items-center gap-2 text-xs text-cyan-300 font-mono">
            <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400" />
            <span>
              Route: <strong>{evt.questionType}</strong> — {evt.reasoning}
            </span>
          </div>
        );
      case "investigating":
        return (
          <div key={idx} className="flex items-center gap-2 text-xs text-slate-300 font-mono">
            <Wrench className="w-3.5 h-3.5 text-amber-400" />
            <span>
              {evt.specialist ? `${evt.specialist} agent` : "Agent"} executing tool:{" "}
              <code className="text-amber-300 bg-slate-900 px-1 py-0.5 rounded">{evt.toolCall || "code search"}</code>
            </span>
          </div>
        );
      case "tool_result":
        return (
          <div key={idx} className="text-[11px] text-slate-400 font-mono pl-5 border-l border-slate-800">
            ↳ {evt.summary}
          </div>
        );
      case "drafting":
        return (
          <div key={idx} className="flex items-center gap-2 text-xs text-slate-300">
            <Sparkles className="w-3.5 h-3.5 text-violet-400 animate-pulse" />
            <span>Drafting grounded answer from retrieved graph facts...</span>
          </div>
        );
      case "verifying":
        return (
          <div key={idx} className="flex items-center gap-2 text-xs text-emerald-300 font-medium">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>Critic Agent verifying claims against graph database...</span>
          </div>
        );
      case "revising":
        return (
          <div key={idx} className="flex items-center gap-2 text-xs text-rose-300 font-mono">
            <RotateCcw className="w-3.5 h-3.5 text-rose-400 animate-spin" />
            <span>Critic revision round: {evt.feedback}</span>
          </div>
        );
      default:
        return null;
    }
  };

  const activeError = localError || streamError;

  return (
    <div className="flex-1 flex flex-col h-full bg-background overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border/80 bg-surface/60 backdrop-blur-md flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-primary-400" />
          <h1 className="font-bold text-base text-white">CodeCortex Assistant</h1>
          {repoFullName && (
            <span className="hidden sm:inline-flex items-center gap-1 text-xs text-cyan-400 bg-slate-900 border border-slate-800 px-2.5 py-0.5 rounded-full font-mono">
              <GitBranch className="w-3 h-3" />
              {repoFullName}
            </span>
          )}
        </div>
      </div>

      {/* Message List */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {messages.length === 0 && events.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-primary-950/80 border border-primary-800/60 flex items-center justify-center text-primary-400 shadow-xl">
              <BrainCircuit className="w-8 h-8" />
            </div>
            <div className="space-y-1 max-w-md">
              <h3 className="font-bold text-white text-lg">Ask CodeCortex Anything</h3>
              <p className="text-sm text-slate-400">
                Multi-agent streaming answers verified against your codebase graph.
              </p>
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const isUser = msg.role === "USER";
            return (
              <div
                key={msg.id}
                className={`flex gap-3 max-w-3xl ${
                  isUser ? "ml-auto flex-row-reverse" : "mr-auto"
                }`}
              >
                {/* Avatar */}
                <div
                  className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 text-xs font-bold ${
                    isUser
                      ? "bg-primary-600 text-white shadow-md shadow-primary-600/30"
                      : "bg-surface-card border border-border text-cyan-400"
                  }`}
                >
                  {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                </div>

                {/* Message Bubble */}
                <div className="space-y-1 max-w-2xl">
                  <div
                    className={`p-4 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                      isUser
                        ? "bg-primary-600 text-white rounded-tr-none shadow-lg shadow-primary-600/20"
                        : "bg-surface border border-border/80 text-slate-200 rounded-tl-none shadow-md"
                    }`}
                  >
                    {msg.content}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {/* Live SSE Streaming Thought Trace Panel (RFC 0026) */}
        {(isStreaming || events.length > 0) && (
          <div className="max-w-3xl mr-auto space-y-2">
            <div className="bg-surface-card/80 border border-slate-800 rounded-2xl overflow-hidden shadow-lg">
              <button
                type="button"
                onClick={() => setShowReasoning(!showReasoning)}
                className="w-full px-4 py-2.5 bg-slate-900/80 hover:bg-slate-900 border-b border-slate-800/80 flex items-center justify-between text-xs font-semibold text-slate-300"
              >
                <div className="flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4 text-primary-400 animate-pulse" />
                  <span>Agent Reasoning & Execution Log ({events.length} steps)</span>
                </div>
                {showReasoning ? (
                  <ChevronUp className="w-4 h-4 text-slate-400" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-slate-400" />
                )}
              </button>

              {showReasoning && (
                <div className="p-4 space-y-2.5 max-h-60 overflow-y-auto bg-slate-950/60 font-sans">
                  {events.map((evt, idx) => renderEventItem(evt, idx))}
                  {isStreaming && (
                    <div className="flex items-center gap-2 text-xs text-primary-400 font-medium pt-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Pipeline active...</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Error Banner */}
      {activeError && (
        <div className="px-6 py-2 bg-rose-950/80 border-t border-rose-800 text-rose-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{activeError}</span>
          </div>
          <button
            onClick={() => setLocalError(null)}
            className="text-rose-400 hover:text-rose-200 font-bold"
          >
            ✕
          </button>
        </div>
      )}

      {/* Input Form */}
      <form onSubmit={handleSend} className="p-4 border-t border-border/80 bg-surface/60 backdrop-blur-md">
        <div className="max-w-4xl mx-auto flex items-end gap-3 bg-slate-900 border border-border rounded-2xl p-2.5 focus-within:ring-2 focus-within:ring-primary-500 transition-all">
          <textarea
            value={inputContent}
            onChange={(e) => setInputContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question (SSE multi-agent streaming active)..."
            rows={1}
            disabled={isStreaming}
            className="flex-1 bg-transparent text-slate-100 placeholder-slate-500 text-sm p-2 resize-none focus:outline-none max-h-32 min-h-[40px]"
          />
          <button
            type="submit"
            disabled={!inputContent.trim() || isStreaming}
            className="p-2.5 rounded-xl bg-gradient-to-r from-primary-600 to-accent-cyan hover:brightness-110 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-primary-600/30"
          >
            {isStreaming ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
