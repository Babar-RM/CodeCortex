"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { api, User } from "@/lib/api";
import { Github, Network, ShieldCheck, Cpu, ArrowRight } from "lucide-react";

export default function LandingPage() {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    api.getMe().then((u) => {
      setUser(u);
      setIsLoading(false);
    });
  }, []);

  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

  return (
    <div className="min-h-screen flex flex-col justify-between bg-gradient-to-b from-background via-slate-950 to-background">
      {/* Header Navigation */}
      <header className="w-full max-w-7xl mx-auto px-6 py-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary-500 to-accent-cyan flex items-center justify-center shadow-lg shadow-primary-500/20">
            <Network className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-xl tracking-tight text-white">CodeCortex</span>
        </div>
        <div>
          {isLoading ? (
            <div className="w-24 h-9 bg-slate-800 rounded-xl animate-pulse" />
          ) : user ? (
            <Link
              href="/dashboard"
              className="px-5 py-2.5 rounded-xl bg-primary-600 hover:bg-primary-500 text-white font-medium text-sm flex items-center gap-2 transition-all shadow-md shadow-primary-600/30"
            >
              Dashboard
              <ArrowRight className="w-4 h-4" />
            </Link>
          ) : (
            <form action={`${backendUrl}/auth/signin/github`} method="POST">
              <input type="hidden" name="redirectTo" value="http://localhost:3000/dashboard" />
              <button
                type="submit"
                className="px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white font-medium text-sm flex items-center gap-2 transition-all shadow-md cursor-pointer"
              >
                <Github className="w-4 h-4" />
                Sign in with GitHub
              </button>
            </form>
          )}
        </div>
      </header>

      {/* Hero Section */}
      <main className="w-full max-w-5xl mx-auto px-6 py-16 text-center space-y-8">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-slate-900 border border-slate-800 text-xs font-medium text-accent-cyan">
          <span className="w-2 h-2 rounded-full bg-accent-cyan animate-pulse" />
          Multi-Agent AI Codebase Knowledge Graph
        </div>

        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-white leading-tight max-w-3xl mx-auto">
          Understand complex codebases with{" "}
          <span className="bg-gradient-to-r from-primary-400 via-accent-cyan to-accent-violet bg-clip-text text-transparent">
            graph-verified AI agents
          </span>
        </h1>

        <p className="text-slate-400 text-lg sm:text-xl max-w-2xl mx-auto font-normal">
          CodeCortex parses your GitHub repositories into Neo4j dependency graphs and semantic embeddings, verified by dedicated Critic agents for zero hallucinations.
        </p>

        <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-4">
          <form action={`${backendUrl}/auth/signin/github`} method="POST" className="w-full sm:w-auto">
            <input type="hidden" name="redirectTo" value="http://localhost:3000/dashboard" />
            <button
              type="submit"
              className="w-full sm:w-auto px-8 py-4 rounded-xl bg-gradient-to-r from-primary-600 via-primary-500 to-accent-cyan hover:brightness-110 text-white font-semibold text-base flex items-center justify-center gap-3 transition-all shadow-xl shadow-primary-500/25 cursor-pointer"
            >
              <Github className="w-5 h-5" />
              Connect GitHub App & Repositories
            </button>
          </form>
        </div>

        {/* Feature Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-16 text-left">
          <div className="p-6 rounded-2xl bg-surface/80 border border-border/80 backdrop-blur-sm space-y-3">
            <div className="w-10 h-10 rounded-lg bg-blue-950/80 border border-blue-800/60 flex items-center justify-center text-blue-400">
              <Network className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-bold text-white">Living Knowledge Graph</h3>
            <p className="text-sm text-slate-400">
              AST parser extracts call graphs, imports, and symbol definitions directly into Neo4j using tree-sitter.
            </p>
          </div>

          <div className="p-6 rounded-2xl bg-surface/80 border border-border/80 backdrop-blur-sm space-y-3">
            <div className="w-10 h-10 rounded-lg bg-cyan-950/80 border border-cyan-800/60 flex items-center justify-center text-cyan-400">
              <Cpu className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-bold text-white">6-Agent Team</h3>
            <p className="text-sm text-slate-400">
              Planner, Explainer, Bug-Tracer, Reviewer, and Refactorer work together over hybrid vector & graph retrieval.
            </p>
          </div>

          <div className="p-6 rounded-2xl bg-surface/80 border border-border/80 backdrop-blur-sm space-y-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-950/80 border border-emerald-800/60 flex items-center justify-center text-emerald-400">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-bold text-white">Critic Verification</h3>
            <p className="text-sm text-slate-400">
              Every single answer is verified against real code structure by the Critic agent before being rendered.
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full max-w-7xl mx-auto px-6 py-8 border-t border-slate-900 flex items-center justify-between text-xs text-slate-500">
        <div>© 2026 CodeCortex Inc. All rights reserved.</div>
        <div>Built with Next.js, Express, Neo4j & pgvector</div>
      </footer>
    </div>
  );
}
