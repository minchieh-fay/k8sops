export type SessionStatus = "draft" | "running" | "idle" | "error";

export type SessionMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  hasKubeconfig: boolean;
  threadId: string | null;
  turnCount: number;
  lastPrompt: string | null;
  lastResponse: string | null;
  lastError: string | null;
};

export type SessionSummary = SessionMeta & {
  preview: string;
};

export type SessionTurnStatus = "queued" | "running" | "completed" | "failed";

export type SessionTurn = {
  id: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  status: SessionTurnStatus;
  prompt: string;
  response: string | null;
  partialResponse: string | null;
  error: string | null;
  images: string[];
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  } | null;
};

export type SessionEventRecord = {
  timestamp: string;
  turnId: number;
  event: unknown;
};

export type SessionDetail = {
  meta: SessionMeta;
  turns: SessionTurn[];
  events: SessionEventRecord[];
};
