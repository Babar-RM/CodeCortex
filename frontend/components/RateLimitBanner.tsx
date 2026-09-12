"use me";
"use client";

import React from "react";
import { ShieldAlert, Clock, X } from "lucide-react";

interface RateLimitBannerProps {
  message: string;
  limitName?: string;
  resetSeconds?: number;
  onClose?: () => void;
}

export function RateLimitBanner({
  message,
  limitName,
  resetSeconds,
  onClose,
}: RateLimitBannerProps) {
  const formatResetTime = (seconds?: number) => {
    if (!seconds || seconds <= 0) return "shortly";
    if (seconds < 60) return `in ${seconds} seconds`;
    const mins = Math.ceil(seconds / 60);
    if (mins < 60) return `in ${mins} minute${mins > 1 ? "s" : ""}`;
    const hours = Math.ceil(mins / 60);
    return `in ${hours} hour${hours > 1 ? "s" : ""}`;
  };

  return (
    <div className="p-4 rounded-xl bg-amber-950/80 border border-amber-700/80 text-amber-200 shadow-xl flex items-start justify-between gap-3 text-xs leading-relaxed animate-in fade-in slide-in-from-top-2">
      <div className="flex items-start gap-3">
        <div className="w-7 h-7 rounded-lg bg-amber-900/60 border border-amber-700 flex items-center justify-center flex-shrink-0 text-amber-400">
          <ShieldAlert className="w-4 h-4" />
        </div>
        <div className="space-y-1">
          <div className="font-bold text-white flex items-center gap-2 text-sm">
            <span>Rate Limit Exceeded</span>
            {limitName && (
              <span className="px-2 py-0.5 rounded bg-amber-900/80 border border-amber-700 font-mono text-[10px] text-amber-300">
                {limitName}
              </span>
            )}
          </div>
          <p className="text-amber-300/90">{message}</p>
          {resetSeconds !== undefined && (
            <div className="flex items-center gap-1.5 text-amber-400 font-medium text-[11px] pt-1">
              <Clock className="w-3 h-3" />
              <span>Limit resets {formatResetTime(resetSeconds)}</span>
            </div>
          )}
        </div>
      </div>

      {onClose && (
        <button
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-amber-900/60 text-amber-400 hover:text-white transition-colors flex-shrink-0"
          title="Dismiss warning"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
