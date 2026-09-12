"use me";
"use client";

import React, { useState, useEffect, useRef } from "react";
import { ChatMessage, api } from "@/lib/api";
import {
  Send,
  User,
  Bot,
  Loader2,
  AlertCircle,
  Sparkles,
  GitBranch,
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
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages(initialMessages);
  }, [initialMessages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isSending]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = inputContent.trim();
    if (!content || isSending) return;

    setError(null);
    setInputContent("");
    setIsSending(true);

    // Optimistic user message (RFC 0025)
    const optimisticId = `optimistic-${Date.now()}`;
    const optimisticUserMsg: DisplayMessage = {
      id: optimisticId,
      chatSessionId,
      role: "USER",
      content,
      createdAt: new Date().toISOString(),
      isOptimistic: true,
    };

    setMessages((prev) => [...prev, optimisticUserMsg]);

    try {
      const response = await api.sendChatMessage({
        chatSessionId,
        content,
      });

      // Replace optimistic message with confirmed backend response
      setMessages((prev) =>
        prev
          .filter((m) => m.id !== optimisticId)
          .concat(response.userMessage, response.assistantMessage)
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to send message";
      setError(msg);

      // Revert or mark optimistic message as failed
      setMessages((prev) =>
        prev.map((m) =>
          m.id === optimisticId ? { ...m, isError: true, isOptimistic: false } : m
        )
      );
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  };

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
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-primary-950/80 border border-primary-800/60 flex items-center justify-center text-primary-400 shadow-xl">
              <Sparkles className="w-8 h-8" />
            </div>
            <div className="space-y-1 max-w-md">
              <h3 className="font-bold text-white text-lg">Ask CodeCortex Anything</h3>
              <p className="text-sm text-slate-400">
                Ask structural or architectural questions about functions, call paths, imports, bugs, or refactoring in this repository.
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
                    } ${msg.isError ? "border-rose-500 bg-rose-950/50 text-rose-200" : ""}`}
                  >
                    {msg.content}
                  </div>

                  {msg.isOptimistic && (
                    <div className="text-[10px] text-primary-400 flex items-center gap-1 justify-end">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Sending...
                    </div>
                  )}

                  {msg.isError && (
                    <div className="text-[10px] text-rose-400 flex items-center gap-1 justify-end">
                      <AlertCircle className="w-3 h-3" />
                      Failed to send
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}

        {/* Loading Indicator for Assistant Thinking */}
        {isSending && (
          <div className="flex gap-3 max-w-3xl mr-auto">
            <div className="w-8 h-8 rounded-xl bg-surface-card border border-border text-cyan-400 flex items-center justify-center flex-shrink-0">
              <Bot className="w-4 h-4" />
            </div>
            <div className="p-4 rounded-2xl rounded-tl-none bg-surface border border-border/80 text-slate-400 text-sm flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-primary-400" />
              <span>Analyzing graph dependency & generating verified response...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Error Alert Banner */}
      {error && (
        <div className="px-6 py-2 bg-rose-950/80 border-t border-rose-800 text-rose-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
          <button
            onClick={() => setError(null)}
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
            placeholder="Ask a question about this repository codebase (Shift+Enter for new line)..."
            rows={1}
            disabled={isSending}
            className="flex-1 bg-transparent text-slate-100 placeholder-slate-500 text-sm p-2 resize-none focus:outline-none max-h-32 min-h-[40px]"
          />
          <button
            type="submit"
            disabled={!inputContent.trim() || isSending}
            className="p-2.5 rounded-xl bg-gradient-to-r from-primary-600 to-accent-cyan hover:brightness-110 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-primary-600/30"
          >
            {isSending ? (
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
