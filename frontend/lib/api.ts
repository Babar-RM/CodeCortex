const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

export type JobStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

export interface IndexingJob {
  id: string;
  connectedRepoId: string;
  status: JobStatus;
  commitSha: string | null;
  progressMessage: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectedRepo {
  id: string;
  userId: string;
  fullName: string;
  htmlUrl: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  indexingJobs: IndexingJob[];
}

export interface User {
  id: string;
  githubId: string;
  githubLogin: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface GithubRepoOption {
  fullName: string;
  htmlUrl: string;
  isPrivate: boolean;
  defaultBranch: string;
}

export interface ChatSession {
  id: string;
  userId: string;
  connectedRepoId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  connectedRepo?: {
    id: string;
    fullName: string;
  };
}

export interface EvidenceItem {
  claim: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface ChatMessage {
  id: string;
  chatSessionId: string;
  role: "USER" | "ASSISTANT";
  content: string;
  evidence?: EvidenceItem[];
  createdAt: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export class RateLimitError extends ApiError {
  constructor(message: string, public limitName?: string, public resetSeconds?: number) {
    super(429, message);
    this.name = "RateLimitError";
  }
}

async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${BACKEND_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    let errorMsg = `HTTP Error ${response.status}: ${response.statusText}`;
    let limitName: string | undefined;
    let resetSeconds: number | undefined;

    try {
      const data = await response.json();
      if (data.error) errorMsg = data.error;
      if (data.limitName) limitName = data.limitName;
      if (data.resetSeconds) resetSeconds = data.resetSeconds;
    } catch {
      // ignore json parse error
    }

    if (response.status === 429) {
      throw new RateLimitError(errorMsg, limitName, resetSeconds);
    }

    throw new ApiError(response.status, errorMsg);
  }

  return response.json() as Promise<T>;
}

export const api = {
  async getMe(): Promise<User | null> {
    try {
      const res = await apiFetch<{ user: User }>("/api/me");
      return res.user;
    } catch {
      return null;
    }
  },

  async listConnectedRepos(): Promise<ConnectedRepo[]> {
    const res = await apiFetch<{ repos: ConnectedRepo[] }>("/api/repos");
    return res.repos;
  },

  async listAvailableGithubRepos(): Promise<GithubRepoOption[]> {
    const res = await apiFetch<{ repos: GithubRepoOption[] }>("/api/repos/github");
    return res.repos;
  },

  async connectRepo(params: {
    fullName: string;
    htmlUrl: string;
    isPrivate: boolean;
    defaultBranch: string;
  }): Promise<ConnectedRepo> {
    const res = await apiFetch<{ repo: ConnectedRepo }>("/api/repos", {
      method: "POST",
      body: JSON.stringify(params),
    });
    return res.repo;
  },

  // Chat API endpoints (RFC 0025)
  async listChatSessions(connectedRepoId?: string): Promise<ChatSession[]> {
    const query = connectedRepoId ? `?connectedRepoId=${encodeURIComponent(connectedRepoId)}` : "";
    const res = await apiFetch<{ sessions: ChatSession[] }>(`/api/chat/sessions${query}`);
    return res.sessions;
  },

  async createChatSession(params: { connectedRepoId: string; title?: string }): Promise<ChatSession> {
    const res = await apiFetch<{ session: ChatSession }>("/api/chat/sessions", {
      method: "POST",
      body: JSON.stringify(params),
    });
    return res.session;
  },

  async getChatMessages(sessionId: string): Promise<ChatMessage[]> {
    const res = await apiFetch<{ messages: ChatMessage[] }>(`/api/chat/sessions/${sessionId}/messages`);
    return res.messages;
  },

  async sendChatMessage(params: {
    chatSessionId: string;
    content: string;
  }): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage }> {
    return apiFetch<{ userMessage: ChatMessage; assistantMessage: ChatMessage }>("/api/chat/messages", {
      method: "POST",
      body: JSON.stringify(params),
    });
  },
};
