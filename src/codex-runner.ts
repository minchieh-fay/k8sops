import fs from "node:fs/promises";
import path from "node:path";
import { Codex, type ThreadEvent } from "@openai/codex-sdk";
import type { AppConfig } from "./config.ts";
import { buildSessionImageUrl, SessionStore, titleFromPrompt } from "./session-store.ts";
import type { SessionEventRecord, SessionTurn } from "./types.ts";
import { nowIso } from "./utils.ts";

type TurnNotifier = (sessionId: string, record: SessionEventRecord) => void;

export class CodexRunner {
  private readonly runningSessions = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: SessionStore,
    private readonly notify: TurnNotifier
  ) {}

  isRunning(sessionId: string): boolean {
    return this.runningSessions.has(sessionId);
  }

  listRunningSessionIds(): string[] {
    return [...this.runningSessions];
  }

  async submitMessage(
    sessionId: string,
    input: {
      prompt: string;
      images: File[];
    }
  ): Promise<{ turnId: number }> {
    const detail = await this.store.getSession(sessionId);
    if (!detail) {
      throw new Error("session_not_found");
    }
    if (this.runningSessions.has(sessionId)) {
      throw new Error("session_busy");
    }

    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new Error("prompt_required");
    }

    if (!detail.meta.hasKubeconfig) {
      throw new Error("kubeconfig_required");
    }

    await this.store.initializeFirstPrompt(sessionId, prompt);
    const images = await this.store.storeImages(sessionId, input.images);
    const turn = await this.store.createTurn(sessionId, prompt, images);

    const metaPatch =
      detail.meta.turnCount === 0
        ? { title: titleFromPrompt(prompt) }
        : {};

    await this.store.updateMeta(sessionId, {
      ...metaPatch,
      status: "running",
      turnCount: detail.meta.turnCount + 1,
      lastPrompt: prompt,
      lastError: null
    });

    this.runTurn(sessionId, turn.id).catch((error) => {
      console.error(`[codex-runner] ${sessionId} failed`, error);
    });

    return { turnId: turn.id };
  }

  private async runTurn(sessionId: string, turnId: number): Promise<void> {
    this.runningSessions.add(sessionId);
    let finalResponse = "";

    try {
      const detail = await this.store.getSession(sessionId);
      if (!detail) {
        throw new Error("session_not_found");
      }

      const turn = detail.turns.find((item) => item.id === turnId);
      if (!turn) {
        throw new Error(`turn_not_found:${turnId}`);
      }

      await this.store.updateTurn(sessionId, turnId, {
        status: "running",
        startedAt: nowIso()
      });

      const codex = new Codex({
        baseUrl: this.config.codexBaseUrl,
        apiKey: this.config.codexApiKey,
        env: await this.buildSessionEnv(sessionId)
      });

      const threadOptions = {
        model: this.config.codexModel,
        workingDirectory: this.store.getSessionDir(sessionId),
        skipGitRepoCheck: true,
        sandboxMode: "danger-full-access" as const,
        approvalPolicy: "never" as const,
        networkAccessEnabled: true,
        webSearchMode: "live" as const
      };

      const thread = detail.meta.threadId
        ? codex.resumeThread(detail.meta.threadId, threadOptions)
        : codex.startThread(threadOptions);

      const input = [
        { type: "text" as const, text: turn.prompt },
        ...turn.images.map((fileName) => ({
          type: "local_image" as const,
          path: path.join(this.store.getSessionDir(sessionId), fileName)
        }))
      ];

      const { events } = await thread.runStreamed(input);
      let usage: SessionTurn["usage"] = null;
      let turnFailure: string | null = null;

      for await (const event of events) {
        if (thread.id && thread.id !== detail.meta.threadId) {
          await this.store.updateMeta(sessionId, { threadId: thread.id });
        }

        if (event.type === "item.completed" && event.item.type === "agent_message") {
          finalResponse = event.item.text;
          await this.store.updateTurn(sessionId, turnId, {
            partialResponse: finalResponse
          });
        }

        if (event.type === "turn.completed") {
          usage = {
            inputTokens: event.usage.input_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
            outputTokens: event.usage.output_tokens,
            reasoningOutputTokens: event.usage.reasoning_output_tokens
          };
        }

        if (event.type === "turn.failed") {
          turnFailure = event.error.message;
        }

        if (event.type === "error") {
          turnFailure = event.message;
        }

        await this.persistEvent(sessionId, turnId, event);
      }

      if (turnFailure) {
        throw new Error(turnFailure);
      }

      await this.store.updateTurn(sessionId, turnId, {
        status: "completed",
        completedAt: nowIso(),
        response: finalResponse,
        partialResponse: finalResponse,
        usage
      });

      await this.store.updateMeta(sessionId, {
        status: "idle",
        lastResponse: finalResponse
      });

      await this.store.appendConversation(sessionId, turn.prompt, finalResponse, turn.images);
    } catch (error) {
      const message = normalizeCodexError(error);
      await this.store.updateTurn(sessionId, turnId, {
        status: "failed",
        completedAt: nowIso(),
        response: finalResponse || null,
        partialResponse: finalResponse || null,
        error: message
      });

      await this.store.updateMeta(sessionId, {
        status: "error",
        lastError: message
      });

      await this.persistEvent(sessionId, turnId, {
        type: "error",
        message
      });
    } finally {
      this.runningSessions.delete(sessionId);
    }
  }

  private async persistEvent(sessionId: string, turnId: number, event: ThreadEvent | { type: "error"; message: string }) {
    const record: SessionEventRecord = {
      timestamp: nowIso(),
      turnId,
      event
    };
    await this.store.appendEvent(sessionId, record);
    this.notify(sessionId, record);
  }

  private async buildSessionEnv(sessionId: string): Promise<Record<string, string>> {
    const sessionDir = this.store.getSessionDir(sessionId);
    const homeDir = path.join(sessionDir, ".home");
    const kubeconfig = path.join(sessionDir, ".kube", "config");
    const sessionBin = path.join(sessionDir, "bin");
    const existingPath = process.env.PATH ?? "";

    await fs.mkdir(path.join(homeDir, ".codex"), { recursive: true });

    return {
      ...process.env,
      HOME: homeDir,
      KUBECONFIG: kubeconfig,
      PATH: `${sessionBin}:${existingPath}`
    } as Record<string, string>;
  }
}

function normalizeCodexError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("401 Unauthorized") || message.includes("Missing bearer or basic authentication")) {
    return "LLM 鉴权失败，请检查 .env 或环境变量中的 LLM_BASE_URL / LLM_MODEL / LLM_API_KEY 配置。";
  }

  return message;
}

export function decorateSessionDetail(detail: Awaited<ReturnType<SessionStore["getSession"]>>) {
  if (!detail) {
    return null;
  }

  return {
    ...detail,
    turns: detail.turns.map((turn) => ({
      ...turn,
      imageUrls: turn.images.map((fileName) => buildSessionImageUrl(detail.meta.id, fileName))
    }))
  };
}
