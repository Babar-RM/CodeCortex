"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, User } from "@/lib/api";
import { RepoConnector } from "@/components/RepoConnector";
import { Network, LogOut, MessageSquare, Loader2 } from "lucide-react";

export default function DashboardPage() {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    api.getMe().then((u) => {
      if (!u) {
        // Not authenticated, redirect to landing page
        router.push("/");
      } else {
        setUser(u);
        setIsLoading(false);
      }
    });
  }, [router]);

  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary-500 mx-auto" />
          <p className="text-sm text-slate-400">Loading your CodeCortex dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top Navbar */}
      <nav className="w-full border-b border-border/80 bg-surface/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-500 to-accent-cyan flex items-center justify-center shadow-lg shadow-primary-500/20">
                <Network className="w-5 h-5 text-white" />
              </div>
              <span className="font-bold text-lg tracking-tight text-white">CodeCortex</span>
            </Link>

            <div className="hidden sm:flex items-center gap-1">
              <Link
                href="/dashboard"
                className="px-3.5 py-2 rounded-lg bg-slate-800 text-white text-xs font-semibold"
              >
                Repositories
              </Link>
              <Link
                href="/chat"
                className="px-3.5 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-900 text-xs font-medium transition-colors flex items-center gap-1.5"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                Chat AI
              </Link>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {user && (
              <div className="flex items-center gap-3">
                {user.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.avatarUrl}
                    alt={user.githubLogin}
                    className="w-8 h-8 rounded-full border border-slate-700"
                  />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-300">
                    {user.githubLogin.slice(0, 2).toUpperCase()}
                  </div>
                )}
                <span className="text-xs font-semibold text-slate-200 hidden md:inline">
                  {user.githubLogin}
                </span>
              </div>
            )}

            <a
              href={`${backendUrl}/auth/signout`}
              className="p-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-white transition-colors"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </a>
          </div>
        </div>
      </nav>

      {/* Main Dashboard Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8">
        <RepoConnector />
      </main>
    </div>
  );
}
