import path from "node:path";
import { loadConfig, type AppConfig, validateCodexConfig } from "./config.ts";
import { CodexRunner, decorateSessionDetail } from "./codex-runner.ts";
import { renderPage } from "./html.ts";
import { buildSessionImageUrl, SessionStore } from "./session-store.ts";
import type { SessionEventRecord } from "./types.ts";
import { ensureDir, errorResponse, jsonResponse } from "./utils.ts";

type EventSink = ReadableStreamDefaultController<string>;
type StreamClient = {
  controller: EventSink;
  heartbeat: Timer;
};

export class AppServer {
  private readonly store: SessionStore;
  private readonly clients = new Map<string, Set<StreamClient>>();
  private readonly runner: CodexRunner;
  private cleanupTimer: Timer | null = null;

  constructor(private readonly config: AppConfig) {
    this.store = new SessionStore(config);
    this.runner = new CodexRunner(config, this.store, (sessionId, record) => {
      this.broadcast(sessionId, record);
    });
  }

  async start() {
    await ensureDir(this.config.publicDir);
    await this.store.ensureLayout();
    await this.pruneSessions();
    this.cleanupTimer = setInterval(() => {
      this.pruneSessions().catch((error) => {
        console.error("[session-retention] prune failed", error);
      });
    }, 30 * 60 * 1000);

    return Bun.serve({
      port: this.config.port,
      idleTimeout: 255,
      fetch: (request) => this.route(request)
    });
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(renderPage(), {
        headers: {
          "content-type": "text/html; charset=utf-8"
        }
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
      return this.serveStatic(url.pathname);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ status: "ok", port: this.config.port });
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const body = await request.json().catch(() => null);
      const kubeconfig =
        body && typeof body === "object" && typeof (body as Record<string, unknown>).kubeconfig === "string"
          ? (body as Record<string, string>).kubeconfig
          : "";

      if (!kubeconfig.trim()) {
        return errorResponse(400, "kubeconfig_required", "新建会话时必须提供 kubeconfig");
      }

      try {
        const meta = await this.store.createSession(kubeconfig);
        return jsonResponse({ item: meta }, 201);
      } catch (error) {
        return mapAppError(error);
      }
    }

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      return jsonResponse({ items: await this.store.listSessions() });
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (request.method === "GET" && sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      const detail = await this.store.getSession(sessionId);
      if (!detail) {
        return errorResponse(404, "session_not_found", sessionId);
      }

      return jsonResponse({ item: decorateSessionDetail(detail) });
    }

    const messageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (request.method === "POST" && messageMatch) {
      const sessionId = decodeURIComponent(messageMatch[1]);
      const form = await request.formData();
      const prompt = String(form.get("prompt") ?? "");
      const images = form
        .getAll("images")
        .filter((item): item is File => item instanceof File && item.size > 0);

      try {
        const result = await this.runner.submitMessage(sessionId, {
          prompt,
          images
        });
        return jsonResponse(result, 202);
      } catch (error) {
        return mapAppError(error);
      }
    }

    const streamMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
    if (request.method === "GET" && streamMatch) {
      const sessionId = decodeURIComponent(streamMatch[1]);
      const detail = await this.store.getSession(sessionId);
      if (!detail) {
        return errorResponse(404, "session_not_found", sessionId);
      }
      return this.openStream(sessionId, request);
    }

    const fileMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/files\/([^/]+)$/);
    if (request.method === "GET" && fileMatch) {
      const sessionId = decodeURIComponent(fileMatch[1]);
      const fileName = decodeURIComponent(fileMatch[2]);
      return this.serveSessionFile(sessionId, fileName);
    }

    return errorResponse(404, "not_found", url.pathname);
  }

  private async serveStatic(pathname: string): Promise<Response> {
    const filePath = path.join(this.config.publicDir, pathname.replace("/assets/", ""));
    try {
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        return errorResponse(404, "asset_not_found", pathname);
      }

      return new Response(file, {
        headers: {
          "content-type": contentTypeFor(filePath)
        }
      });
    } catch {
      return errorResponse(404, "asset_not_found", pathname);
    }
  }

  private async serveSessionFile(sessionId: string, fileName: string): Promise<Response> {
    if (fileName.includes("/") || fileName.includes("\\")) {
      return errorResponse(400, "invalid_file_name", fileName);
    }

    const sessionDir = this.store.getSessionDir(sessionId);
    const filePath = path.join(sessionDir, fileName);

    try {
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        return errorResponse(404, "file_not_found", buildSessionImageUrl(sessionId, fileName));
      }

      return new Response(file, {
        headers: {
          "content-type": file.type || contentTypeFor(filePath)
        }
      });
    } catch {
      return errorResponse(404, "file_not_found", fileName);
    }
  }

  private openStream(sessionId: string, request: Request): Response {
    const stream = new ReadableStream<string>({
      start: (controller) => {
        const client = this.registerClient(sessionId, controller);
        const cleanup = () => this.unregisterClient(sessionId, client);
        request.signal.addEventListener("abort", cleanup, { once: true });
        controller.enqueue(`data: ${JSON.stringify({ type: "hello", sessionId })}\n\n`);
      },
      cancel: () => {
        this.unregisterAllClients(sessionId);
      }
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive"
      }
    });
  }

  private registerClient(sessionId: string, controller: EventSink): StreamClient {
    const heartbeat = setInterval(() => {
      try {
        controller.enqueue(`: keepalive ${Date.now()}\n\n`);
      } catch {
        this.unregisterClient(sessionId, client);
      }
    }, 5000);

    const client: StreamClient = {
      controller,
      heartbeat
    };

    const bucket = this.clients.get(sessionId) ?? new Set<StreamClient>();
    bucket.add(client);
    this.clients.set(sessionId, bucket);
    return client;
  }

  private unregisterClient(sessionId: string, client: StreamClient | null): void {
    const bucket = this.clients.get(sessionId);
    if (!bucket) {
      return;
    }

    if (client) {
      clearInterval(client.heartbeat);
      bucket.delete(client);
    } else {
      for (const item of bucket) {
        clearInterval(item.heartbeat);
      }
      bucket.clear();
    }

    if (bucket.size === 0) {
      this.clients.delete(sessionId);
    }
  }

  private unregisterAllClients(sessionId: string): void {
    this.unregisterClient(sessionId, null);
  }

  private broadcast(sessionId: string, record: SessionEventRecord): void {
    const bucket = this.clients.get(sessionId);
    if (!bucket || bucket.size === 0) {
      return;
    }

    const payload = `data: ${JSON.stringify({ type: "event", record })}\n\n`;
    for (const client of [...bucket]) {
      try {
        client.controller.enqueue(payload);
      } catch {
        this.unregisterClient(sessionId, client);
      }
    }
  }

  private async pruneSessions(): Promise<void> {
    const protectedIds = new Set<string>();

    for (const sessionId of this.clients.keys()) {
      protectedIds.add(sessionId);
    }
    for (const sessionId of this.runner.listRunningSessionIds()) {
      protectedIds.add(sessionId);
    }

    const removedIds = await this.store.pruneOldSessions(this.config.sessionMaxCount, protectedIds);
    if (removedIds.length > 0) {
      console.log(
        `[session-retention] removed ${removedIds.length} session(s): ${removedIds.join(", ")}`
      );
    }
  }
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function mapAppError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "session_not_found") {
    return errorResponse(404, "session_not_found", message);
  }
  if (message === "session_busy") {
    return errorResponse(409, "session_busy", "当前会话已有任务在运行");
  }
  if (message === "prompt_required") {
    return errorResponse(400, "prompt_required", "问题描述不能为空");
  }
  if (message === "kubeconfig_required") {
    return errorResponse(400, "kubeconfig_required", "当前会话缺少 kubeconfig");
  }
  if (message.startsWith("kubeconfig_yaml_invalid:") || message.startsWith("kubeconfig_invalid:")) {
    return errorResponse(400, "kubeconfig_invalid", message.split(":").slice(1).join(":"));
  }
  return errorResponse(500, "internal_error", message);
}

export function createServer() {
  const config = loadConfig();
  validateCodexConfig(config);
  return new AppServer(config);
}
