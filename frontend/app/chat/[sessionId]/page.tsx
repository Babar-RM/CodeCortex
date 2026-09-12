"use me";
"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api, User, ChatSession, ChatMessage, ConnectedRepo } from "@/lib/api";
import { ChatSessionList } from "@/components/ChatSessionList";
import { ChatThread } from "@/components/ChatThread";
import { Network, LogOut, Loader2 } from "lucide-react";

export default function ChatSessionPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.sessionId as string;

  const [user, setUser] = useState<User | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [connectedRepos, setConnectedRepos] = useState<ConnectedRepo[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentSession, setCurrentSession] = useState<ChatSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const u = await api.getMe();
        if (!u) {
          router.push("/");
          return;
        }
        setUser(u);

        const [repos, allSessions] = await Promise.all([
          api.listConnectedRepos(),
          api.listChatSessions(),
        ]);

        setConnectedRepos(repos);
        setSessions(allSessions);

        const session = allSessions.find((s) => s.id === sessionId);
        if (session) {
          setCurrentSession(session);
          const history = await api.getChatMessages(sessionId);
          setMessages(history);
        } else {
          // session not found
          console.warn("Session not found:", sessionId);
        }
      } catch (err) {
        console.error("Error loading chat session page", err);
      } finally {
        setIsLoading(false);
      }
    }

    if (sessionId) {
      loadData();
    }
  }, [sessionId, router]);

  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

  if (isLoading) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary-500 mx-auto" />
          <p className="text-sm text-slate-400">Loading conversation thread...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* Top Navbar */}
      <nav className="w-full border-b border-border/80 bg-surface/80 backdrop-blur-md z-50">
        <div className="max-w-7xl mx-auto px-6 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary-500 to-accent-cyan flex items-center justify-center shadow-lg shadow-primary-500/20">
                <Network className="w-4 h-4 text-white" />
              </div>
              <span className="font-bold text-base tracking-tight text-white">CodeCortex</span>
            </Link>

            <div className="flex items-center gap-1">
              <Link
                href="/dashboard"
                className="px-3.5 py-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-900 text-xs font-medium transition-colors"
              >
                Repositories
              </Link>
              <Link
                href="/chat"
                className="px-3.5 py-1.5 rounded-lg bg-slate-800 text-white text-xs font-semibold"
              >
                Chat AI
              </Link>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {user && (
              <div className="flex items-center gap-2">
                {user.avatarUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.avatarUrl}
                    alt={user.githubLogin}
                    className="w-7 h-7 rounded-full border border-slate-700"
                  />
                )}
                <span className="text-xs font-semibold text-slate-300 hidden sm:inline">
                  {user.githubLogin}
                </span>
              </div>
            )}
            <a
              href={`${backendUrl}/auth/signout`}
              className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-white transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </a>
          </div>
        </div>
      </nav>

      {/* Main Chat View */}
      <div className="flex-1 flex overflow-hidden">
        <div className="w-80 flex-shrink-0">
          <ChatSessionList
            sessions={sessions}
            connectedRepos={connectedRepos}
            currentSessionId={sessionId}
          />
        </div>
        <div className="flex-1">
          <ChatThread
            chatSessionId={sessionId}
            initialMessages={messages}
            repoFullName={currentSession?.connectedRepo?.fullName}
          />
        </div>
      </div>
    </div>
  );
}
