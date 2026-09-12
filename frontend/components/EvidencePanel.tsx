"use me";
"use client";

import React, { useState } from "react";
import { EvidenceItem } from "@/lib/api";
import {
  ShieldCheck,
  FileCode,
  ExternalLink,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface EvidencePanelProps {
  evidence: EvidenceItem[];
  repoFullName?: string;
  commitSha?: string;
}

export function EvidencePanel({
  evidence,
  repoFullName,
  commitSha,
}: EvidencePanelProps) {
  const [isOpen, setIsOpen] = useState(true);

  if (!evidence || evidence.length === 0) return null;

  const getGithubUrl = (item: EvidenceItem) => {
    if (!repoFullName) return null;
    const sha = commitSha || "main";
    const lineHash =
      item.startLine === item.endLine
        ? `#L${item.startLine}`
        : `#L${item.startLine}-L${item.endLine}`;
    return `https://github.com/${repoFullName}/blob/${sha}/${item.filePath}${lineHash}`;
  };

  return (
    <div className="mt-3 rounded-xl border border-emerald-900/60 bg-emerald-950/20 overflow-hidden text-slate-200">
      {/* Panel Header */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-3.5 py-2 bg-emerald-950/40 hover:bg-emerald-950/60 flex items-center justify-between text-xs font-semibold text-emerald-300 transition-colors"
      >
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>Graph Verified Sources ({evidence.length})</span>
        </div>
        {isOpen ? (
          <ChevronUp className="w-3.5 h-3.5 text-emerald-400" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-emerald-400" />
        )}
      </button>

      {/* Cards List */}
      {isOpen && (
        <div className="p-3 space-y-2 bg-slate-950/40">
          {evidence.map((item, idx) => {
            const githubUrl = getGithubUrl(item);
            return (
              <div
                key={idx}
                className="p-3 rounded-lg bg-surface/80 border border-slate-800/80 hover:border-emerald-800/60 transition-all space-y-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-mono text-cyan-300">
                    <FileCode className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
                    <span className="truncate">{item.filePath}</span>
                    <span className="text-slate-500">
                      :L{item.startLine}-{item.endLine}
                    </span>
                  </div>

                  {githubUrl && (
                    <a
                      href={githubUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400 hover:text-emerald-300 bg-emerald-950/80 border border-emerald-800/60 px-2 py-0.5 rounded-md transition-colors flex-shrink-0"
                      title="Open file at line range on GitHub"
                    >
                      View on GitHub
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>

                <p className="text-xs text-slate-300 leading-relaxed font-sans italic border-l-2 border-emerald-500/50 pl-2.5 py-0.5">
                  &ldquo;{item.claim}&rdquo;
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
