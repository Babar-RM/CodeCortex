"use me";
"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { ChatSession, ConnectedRepo, api } from "@/lib/api";
import {
  MessageSquare,
  Plus,
  GitBranch,
  Clock,
  Loader2,
  ChevronRight,
  Sparkles,
} from "lucide-react";

interface ChatSessionListProps {
  sessions: ChatSession[];
  connectedRepos: ConnectedRepo[];
  currentSessionId?: string;
  onSessionCreated?: (session: ChatSession) => void;
}

export function ChatSessionList({
  sessions,
  connectedRepos,
  currentSessionId,
  onSessionCreated,
}: ChatSessionListProps) {
  const router = useRouter();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedRepoId, setSelectedRepoId] = useState<string>("");
  const [customTitle, setCustomTitle] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreateSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRepoId) {
      setError("Please select a connected repository");
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const newSession = await api.createChatSession({
        connectedRepoId: selectedRepoId,
        title: customTitle.trim() || undefined,
      });

      setIsModalOpen(false);
      setCustomTitle("");
      setSelectedRepoId("");

      if (onSessionCreated) {
        onSessionCreated(newSession);
      }
      router.push(`/chat/${newSession.id}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create session";
      setError(msg);
    } finally {
      setIsCreating(false);
    }
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="w-full flex flex-col h-full bg-surface/50 border-r border-border/80 text-slate-200">
      {/* Sidebar Header */}
      <div className="p-4 border-b border-border/80 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-primary-400" />
          <h2 className="font-bold text-sm text-white tracking-wide">Conversations</h2>
        </div>
        <button
          onClick={() => {
            setIsModalOpen(true);
            if (connectedRepos.length > 0 && !selectedRepoId) {
              setSelectedRepoId(connectedRepos[0].id);
            }
          }}
          className="p-1.5 rounded-lg bg-primary-600 hover:bg-primary-500 text-white font-medium text-xs flex items-center gap-1 transition-all shadow-md shadow-primary-600/30"
          title="New Chat Session"
        >
          <Plus className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">New</span>
        </button>
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {sessions.length === 0 ? (
          <div className="p-6 text-center text-slate-500 text-xs space-y-2">
            <Sparkles className="w-6 h-6 mx-auto text-slate-600" />
            <p>No chat conversations yet.</p>
            <button
              onClick={() => setIsModalOpen(true)}
              className="text-primary-400 hover:underline font-medium"
            >
              Start a new session
            </button>
          </div>
        ) : (
          sessions.map((session) => {
            const isActive = session.id === currentSessionId;
            return (
              <button
                key={session.id}
                onClick={() => router.push(`/chat/${session.id}`)}
                className={`w-full text-left p-3 rounded-xl transition-all border flex items-center justify-between group ${
                  isActive
                    ? "bg-primary-950/70 border-primary-500/60 text-white shadow-md"
                    : "bg-slate-900/40 border-transparent hover:bg-slate-800/60 hover:border-border text-slate-300"
                }`}
              >
                <div className="space-y-1 overflow-hidden pr-2">
                  <div className="font-semibold text-xs truncate group-hover:text-white transition-colors">
                    {session.title}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-slate-400">
                    <span className="flex items-center gap-1 truncate text-cyan-400 font-mono">
                      <GitBranch className="w-3 h-3 flex-shrink-0" />
                      {session.connectedRepo?.fullName || "Repository"}
                    </span>
                    <span>•</span>
                    <span className="flex items-center gap-0.5 text-slate-500">
                      <Clock className="w-2.5 h-2.5" />
                      {formatDate(session.updatedAt)}
                    </span>
                  </div>
                </div>
                <ChevronRight className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${
                  isActive ? "text-primary-400 translate-x-0.5" : "text-slate-600 opacity-0 group-hover:opacity-100"
                }`} />
              </button>
            );
          })
        )}
      </div>

      {/* New Session Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-surface border border-border rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-primary-400" />
                Start New AI Chat Session
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-white text-sm"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateSession} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">
                  Select Connected Repository
                </label>
                <select
                  value={selectedRepoId}
                  onChange={(e) => setSelectedRepoId(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-border text-xs text-slate-200 focus:ring-2 focus:ring-primary-500 focus:outline-none"
                >
                  <option value="">-- Select Repo --</option>
                  {connectedRepos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.fullName} ({repo.defaultBranch})
                    </option>
                  ))}
                </select>
                {connectedRepos.length === 0 && (
                  <p className="text-[11px] text-amber-400">
                    No repositories connected. Please connect a repo on the Dashboard first.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">
                  Session Title (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Code structure & architecture Q&A"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-border text-xs text-slate-200 focus:ring-2 focus:ring-primary-500 focus:outline-none"
                />
              </div>

              {error && (
                <div className="p-2.5 rounded-lg bg-rose-950/60 border border-rose-800 text-rose-300 text-xs">
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!selectedRepoId || isCreating}
                  className="px-4 py-2 rounded-xl bg-primary-600 hover:bg-primary-500 text-xs text-white font-semibold flex items-center gap-1.5 disabled:opacity-50"
                >
                  {isCreating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  Create Session
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
