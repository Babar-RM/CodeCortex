import crypto from "crypto";

export type AgentTraceStep =
  | "planned"
  | "tool_call"
  | "tool_result"
  | "draft"
  | "critic_check"
  | "revise"
  | "approved"
  | "unverifiable"
  | "cap_hit";

export interface AgentTraceLog {
  correlationId: string;
  connectedRepoId: string;
  userId?: string;
  step: AgentTraceStep;
  timestamp?: string;
  durationMs?: number;
  detail: Record<string, unknown>;
}

export type TraceLogSink = (log: AgentTraceLog) => void;
let activeTraceLogSink: TraceLogSink | null = null;

/**
 * Sets a custom sink for trace logs (useful for unit testing trace emissions).
 */
export function setTraceLogSink(sink: TraceLogSink | null): void {
  activeTraceLogSink = sink;
}

/**
 * Generates a unique UUID correlation ID for a question processing lifecycle (RFC 0022).
 */
export function generateCorrelationId(): string {
  return crypto.randomUUID();
}

/**
 * Emits a structured JSON log entry for agent trace events (RFC 0022).
 */
export function logAgentTrace(log: AgentTraceLog): void {
  const entry: AgentTraceLog = {
    ...log,
    timestamp: log.timestamp || new Date().toISOString(),
  };

  const structuredPayload = {
    level: "info",
    type: "agent_trace",
    correlationId: entry.correlationId,
    connectedRepoId: entry.connectedRepoId,
    userId: entry.userId,
    step: entry.step,
    timestamp: entry.timestamp,
    durationMs: entry.durationMs,
    detail: entry.detail,
  };

  if (activeTraceLogSink) {
    activeTraceLogSink(entry);
  }

  console.log(JSON.stringify(structuredPayload));
}
