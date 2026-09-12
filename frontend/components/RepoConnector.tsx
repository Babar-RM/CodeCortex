"use me";
"use client";

import React, { useEffect, useState, useCallback } from "react";
import {
  api,
  ConnectedRepo,
  GithubRepoOption,
  JobStatus,
  RateLimitError,
} from "@/lib/api";
import { RateLimitBanner } from "./RateLimitBanner";
import {
  GitBranch,
  Lock,
  Globe,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Plus,
  Loader2,
  AlertCircle,
  ExternalLink,
  ShieldAlert,
} from "lucide-react";

export function RepoConnector() {
  const [connectedRepos, setConnectedRepos] = useState<ConnectedRepo[]>([]);
  const [availableRepos, setAvailableRepos] = useState<GithubRepoOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [selectedRepoFullName, setSelectedRepoFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rateLimitInfo, setRateLimitInfo] = useState<{ limitName?: string; resetSeconds?: number } | null>(null);

  const fetchRepos = useCallback(async () => {
    try {
      const repos = await api.listConnectedRepos();
      setConnectedRepos(repos);
      setError(null);
      setRateLimitInfo(null);
      return repos;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load repos";
      setError(message);
      return [];
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchAvailable = useCallback(async () => {
    try {
      const githubRepos = await api.listAvailableGithubRepos();
      setAvailableRepos(githubRepos);
    } catch (err: unknown) {
      // GitHub repo list may fail if offline or not linked
      console.warn("Could not fetch available GitHub repos", err);
    }
  }, []);

  useEffect(() => {
    fetchRepos();
    fetchAvailable();
  }, [fetchRepos, fetchAvailable]);

  // RFC 0024: Polling loop every 2.5 seconds while any job is in non-terminal state (PENDING or RUNNING)
  useEffect(() => {
    const hasNonTerminalJob = connectedRepos.some((repo) => {
      const latestJob = repo.indexingJobs[0];
      const status = latestJob?.status;
      return status === "PENDING" || status === "RUNNING";
    });

    if (!hasNonTerminalJob) return;

    const interval = setInterval(async () => {
      await fetchRepos();
    }, 2500);

    return () => clearInterval(interval);
  }, [connectedRepos, fetchRepos]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRepoFullName) return;

    const target = availableRepos.find((r) => r.fullName === selectedRepoFullName);
    if (!target) return;

    setIsConnecting(true);
    setError(null);
    setRateLimitInfo(null);

    try {
      await api.connectRepo({
        fullName: target.fullName,
        htmlUrl: target.htmlUrl,
        isPrivate: target.isPrivate,
        defaultBranch: target.defaultBranch,
      });
      setSelectedRepoFullName("");
      await fetchRepos();
    } catch (err: unknown) {
      if (err instanceof RateLimitError) {
        setRateLimitInfo({ limitName: err.limitName, resetSeconds: err.resetSeconds });
        setError(err.message);
      } else {
        const message = err instanceof Error ? err.message : "Failed to connect repository";
        setError(message);
      }
    } finally {
      setIsConnecting(false);
    }
  };

  const renderStatusBadge = (status: JobStatus | undefined) => {
    switch (status) {
      case "PENDING":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-800 text-slate-300 border border-slate-700 animate-pulse">
            <Clock className="w-3.5 h-3.5 text-slate-400" />
            Pending
          </span>
        );
      case "RUNNING":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-950/80 text-blue-300 border border-blue-800/60">
            <RefreshCw className="w-3.5 h-3.5 text-blue-400 animate-spin" />
            Indexing...
          </span>
        );
      case "SUCCEEDED":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-950/80 text-emerald-300 border border-emerald-800/60">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            Ready
          </span>
        );
      case "FAILED":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-950/80 text-rose-300 border border-rose-800/60">
            <XCircle className="w-3.5 h-3.5 text-rose-400" />
            Failed
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-800 text-slate-400 border border-slate-700">
            Unknown
          </span>
        );
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto space-y-6">
      {/* Top Header Card */}
      <div className="p-6 rounded-2xl bg-surface border border-border/60 shadow-xl backdrop-blur-md">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
              Connected Repositories
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              Connect a GitHub repository to build its dependency graph & semantic embeddings.
            </p>
          </div>
          <button
            onClick={() => fetchRepos()}
            className="p-2 rounded-lg bg-surface-card hover:bg-slate-800 border border-border text-slate-300 transition-colors"
            title="Refresh Repositories"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Connect Form */}
        {(() => {
          const selectedTargetRepo = availableRepos.find((r) => r.fullName === selectedRepoFullName);
          const isSelectedAccessible = selectedTargetRepo ? selectedTargetRepo.accessible !== false : true;

          return (
            <>
              <form onSubmit={handleConnect} className="mt-6 flex gap-3">
                <select
                  value={selectedRepoFullName}
                  onChange={(e) => setSelectedRepoFullName(e.target.value)}
                  disabled={isConnecting || availableRepos.length === 0}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-slate-900 border border-border text-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50"
                >
                  <option value="">
                    {availableRepos.length === 0
                      ? "No available GitHub repositories found"
                      : "-- Select a GitHub Repository to Connect --"}
                  </option>
                  {availableRepos.map((repo) => {
                    const isAccessible = repo.accessible !== false;
                    return (
                      <option key={repo.fullName} value={repo.fullName}>
                        {repo.fullName} {repo.isPrivate ? "(Private)" : "(Public)"}{" "}
                        {isAccessible ? "✓ Accessible" : "(Needs App Scope)"}
                      </option>
                    );
                  })}
                </select>
                <button
                  type="submit"
                  disabled={!selectedRepoFullName || !isSelectedAccessible || isConnecting}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-primary-600 to-accent-cyan hover:from-primary-500 hover:to-cyan-400 text-white text-sm font-semibold flex items-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary-500/20"
                >
                  {isConnecting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4" />
                  )}
                  Connect Repo
                </button>
              </form>

              {/* GitHub App Installation Scope Guidance (RFC 0029) */}
              {selectedTargetRepo && !isSelectedAccessible && (
                <div className="mt-4 p-4 rounded-xl bg-slate-900 border border-slate-800 text-xs space-y-3">
                  <div className="flex items-center gap-2 text-amber-300 font-semibold">
                    <ShieldAlert className="w-4 h-4 text-amber-400" />
                    <span>GitHub App Installation Scope Required</span>
                  </div>
                  <p className="text-slate-400 leading-relaxed">
                    Repository <strong className="text-white">{selectedTargetRepo.fullName}</strong> is not yet covered by your GitHub App installation. Grant CodeCortex access by updating your installation scope on GitHub.
                  </p>
                  <a
                    href={selectedTargetRepo.installationUrl || "https://github.com/settings/installations"}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-primary-600 hover:bg-primary-500 text-white font-semibold transition-colors"
                  >
                    <span>Update GitHub App Installation Scope</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              )}
            </>
          );
        })()}

        {error && (
          rateLimitInfo ? (
            <div className="mt-4">
              <RateLimitBanner
                message={error}
                limitName={rateLimitInfo.limitName}
                resetSeconds={rateLimitInfo.resetSeconds}
                onClose={() => {
                  setError(null);
                  setRateLimitInfo(null);
                }}
              />
            </div>
          ) : (
            <div className="mt-4 p-3 rounded-lg bg-rose-950/50 border border-rose-800/50 text-rose-300 text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )
        )}
      </div>

      {/* Repository List */}
      <div className="space-y-4">
        {isLoading ? (
          <div className="p-8 text-center bg-surface rounded-2xl border border-border">
            <Loader2 className="w-6 h-6 animate-spin text-primary-500 mx-auto" />
            <p className="text-sm text-slate-400 mt-2">Loading repositories...</p>
          </div>
        ) : connectedRepos.length === 0 ? (
          <div className="p-12 text-center bg-surface rounded-2xl border border-border/60">
            <GitBranch className="w-10 h-10 text-slate-600 mx-auto mb-3" />
            <h3 className="text-base font-semibold text-slate-200">No repositories connected yet</h3>
            <p className="text-sm text-slate-400 max-w-md mx-auto mt-1">
              Select a repository above to trigger automatic shallow cloning, AST parsing, graph generation, and vector embeddings.
            </p>
          </div>
        ) : (
          connectedRepos.map((repo) => {
            const latestJob = repo.indexingJobs[0];
            const isRunning = latestJob?.status === "RUNNING";
            const isFailed = latestJob?.status === "FAILED";

            return (
              <div
                key={repo.id}
                className="p-5 rounded-2xl bg-surface border border-border/80 hover:border-primary-500/40 transition-all shadow-md space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {repo.isPrivate ? (
                      <Lock className="w-4 h-4 text-amber-400" />
                    ) : (
                      <Globe className="w-4 h-4 text-slate-400" />
                    )}
                    <a
                      href={repo.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold text-white hover:text-primary-400 transition-colors text-base"
                    >
                      {repo.fullName}
                    </a>
                    <span className="text-xs text-slate-500 px-2 py-0.5 rounded bg-slate-900 border border-slate-800 font-mono">
                      {repo.defaultBranch}
                    </span>
                  </div>
                  <div>{renderStatusBadge(latestJob?.status)}</div>
                </div>

                {/* Live Progress Message (RFC 0024 Requirement) */}
                {isRunning && (
                  <div className="pt-2 border-t border-slate-800/80 flex items-center gap-2">
                    <RefreshCw className="w-3.5 h-3.5 text-blue-400 animate-spin flex-shrink-0" />
                    <span className="text-xs font-mono text-blue-300">
                      {latestJob.progressMessage || "Processing repository..."}
                    </span>
                  </div>
                )}

                {/* Error Message rendering for FAILED status */}
                {isFailed && latestJob?.errorMessage && (
                  <div className="pt-2 border-t border-slate-800/80 flex items-start gap-2 text-rose-300 text-xs">
                    <AlertCircle className="w-3.5 h-3.5 text-rose-400 flex-shrink-0 mt-0.5" />
                    <span className="font-mono">{latestJob.errorMessage}</span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
