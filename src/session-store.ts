import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import type { AppConfig } from "./config.ts";
import type {
  SessionDetail,
  SessionEventRecord,
  SessionMeta,
  SessionSummary,
  SessionTurn
} from "./types.ts";
import {
  deriveTitle,
  ensureDir,
  formatSessionId,
  nowIso,
  readJsonFile,
  writeJsonFile
} from "./utils.ts";

const META_FILE = "session.json";
const TURNS_FILE = "turns.json";
const EVENTS_FILE = "events.jsonl";

export class SessionStore {
  constructor(private readonly config: AppConfig) {}

  async ensureLayout(): Promise<void> {
    await ensureDir(this.config.dataDir);
    await ensureDir(this.config.sessionRootDir);
  }

  async createSession(kubeconfig: string): Promise<SessionMeta> {
    const createdAt = nowIso();
    const id = await this.allocateSessionId();
    const sessionDir = this.getSessionDir(id);

    await ensureDir(sessionDir);
    await ensureDir(path.join(sessionDir, ".kube"));
    await ensureDir(path.join(sessionDir, ".home"));
    await ensureDir(path.join(sessionDir, "bin"));

    await this.copyOptionalWorkspaceArtifacts(sessionDir);
    await this.writeKubectlWrapper(sessionDir);
    await this.storeKubeconfig(id, kubeconfig);

    const meta: SessionMeta = {
      id,
      title: "新会话",
      createdAt,
      updatedAt: createdAt,
      status: "idle",
      hasKubeconfig: true,
      threadId: null,
      turnCount: 0,
      lastPrompt: null,
      lastResponse: null,
      lastError: null
    };

    await this.saveMeta(meta);
    await this.saveTurns(id, []);
    return meta;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const dirents = await fs.readdir(this.config.sessionRootDir, { withFileTypes: true }).catch(() => []);
    const sessions = await Promise.all(
      dirents
        .filter((item) => item.isDirectory())
        .map(async (item) => this.loadMeta(item.name).catch(() => null))
    );

    return sessions
      .filter((item): item is SessionMeta => item !== null)
      .map((meta) => ({
        ...meta,
        preview: meta.lastPrompt ?? meta.title
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async pruneOldSessions(maxCount: number, protectedIds: Set<string> = new Set()): Promise<string[]> {
    const metas = await this.listSessionMetas();
    if (metas.length <= maxCount) {
      return [];
    }

    const minimumBatch = Math.max(1, Math.ceil(maxCount * 0.2));
    const mustRemove = metas.length - maxCount;
    const removeTarget = Math.max(minimumBatch, mustRemove);

    const removable = metas
      .filter((meta) => !protectedIds.has(meta.id))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    const victims = removable.slice(0, removeTarget);
    const removedIds: string[] = [];

    for (const meta of victims) {
      await fs.rm(this.getSessionDir(meta.id), { recursive: true, force: true });
      removedIds.push(meta.id);
    }

    return removedIds;
  }

  async getSession(id: string): Promise<SessionDetail | null> {
    const meta = await this.loadMeta(id).catch(() => null);
    if (!meta) {
      return null;
    }

    const turns = await this.loadTurns(id);
    const events = await this.loadEvents(id);
    return { meta, turns, events };
  }

  getSessionDir(id: string): string {
    return path.join(this.config.sessionRootDir, id);
  }

  getMetaPath(id: string): string {
    return path.join(this.getSessionDir(id), META_FILE);
  }

  getTurnsPath(id: string): string {
    return path.join(this.getSessionDir(id), TURNS_FILE);
  }

  getEventsPath(id: string): string {
    return path.join(this.getSessionDir(id), EVENTS_FILE);
  }

  async loadMeta(id: string): Promise<SessionMeta> {
    return readJsonFile<SessionMeta>(this.getMetaPath(id), null as never);
  }

  async saveMeta(meta: SessionMeta): Promise<void> {
    await writeJsonFile(this.getMetaPath(meta.id), meta);
  }

  async loadTurns(id: string): Promise<SessionTurn[]> {
    return readJsonFile<SessionTurn[]>(this.getTurnsPath(id), []);
  }

  async saveTurns(id: string, turns: SessionTurn[]): Promise<void> {
    await writeJsonFile(this.getTurnsPath(id), turns);
  }

  async loadEvents(id: string): Promise<SessionEventRecord[]> {
    const filePath = this.getEventsPath(id);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SessionEventRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async appendEvent(id: string, record: SessionEventRecord): Promise<void> {
    await fs.appendFile(this.getEventsPath(id), `${JSON.stringify(record)}\n`, "utf8");
  }

  async storeKubeconfig(id: string, content: string): Promise<void> {
    const normalized = normalizeKubeconfig(content);
    const filePath = path.join(this.getSessionDir(id), ".kube", "config");
    await fs.writeFile(filePath, normalized, { encoding: "utf8", mode: 0o600 });
  }

  async storeImages(id: string, files: File[]): Promise<string[]> {
    if (files.length === 0) {
      return [];
    }

    const sessionDir = this.getSessionDir(id);
    const existing = await fs.readdir(sessionDir).catch(() => []);
    let nextIndex =
      existing
        .map((name) => name.match(/^(\d+)\.[A-Za-z0-9]+$/))
        .filter((item): item is RegExpMatchArray => Boolean(item))
        .reduce((max, item) => Math.max(max, Number(item[1])), 0) + 1;

    const saved: string[] = [];
    for (const file of files) {
      const extension = extensionFromFile(file);
      const fileName = `${nextIndex}.${extension}`;
      const arrayBuffer = await file.arrayBuffer();
      await fs.writeFile(path.join(sessionDir, fileName), new Uint8Array(arrayBuffer));
      saved.push(fileName);
      nextIndex += 1;
    }

    return saved;
  }

  async initializeFirstPrompt(id: string, prompt: string): Promise<void> {
    const sessionDir = this.getSessionDir(id);
    const descPath = path.join(sessionDir, "desc.txt");
    try {
      await fs.access(descPath);
    } catch {
      await fs.writeFile(descPath, `${prompt.trim()}\n`, "utf8");
    }
  }

  async appendConversation(
    id: string,
    prompt: string,
    response: string | null,
    images: string[]
  ): Promise<void> {
    const lines = [
      `## User ${nowIso()}`,
      "",
      prompt.trim(),
      "",
      ...(images.length > 0 ? [`Images: ${images.join(", ")}`, ""] : []),
      `## Assistant ${nowIso()}`,
      "",
      response?.trim() || "(no response)",
      "",
      ""
    ];

    await fs.appendFile(path.join(this.getSessionDir(id), "conversation.md"), lines.join("\n"), "utf8");
  }

  async createTurn(id: string, prompt: string, images: string[]): Promise<SessionTurn> {
    const turns = await this.loadTurns(id);
    const turn: SessionTurn = {
      id: turns.length + 1,
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
      status: "queued",
      prompt,
      response: null,
      partialResponse: null,
      error: null,
      images,
      usage: null
    };

    turns.push(turn);
    await this.saveTurns(id, turns);
    return turn;
  }

  async updateTurn(id: string, turnId: number, patch: Partial<SessionTurn>): Promise<SessionTurn> {
    const turns = await this.loadTurns(id);
    const index = turns.findIndex((item) => item.id === turnId);
    if (index < 0) {
      throw new Error(`turn_not_found:${turnId}`);
    }

    const next = { ...turns[index], ...patch };
    turns[index] = next;
    await this.saveTurns(id, turns);
    return next;
  }

  async updateMeta(id: string, patch: Partial<SessionMeta>): Promise<SessionMeta> {
    const current = await this.loadMeta(id);
    const next = {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt ?? nowIso()
    };
    await this.saveMeta(next);
    return next;
  }

  private async allocateSessionId(): Promise<string> {
    const base = formatSessionId();
    let attempt = 0;

    while (true) {
      const id = attempt === 0 ? base : `${base}-${attempt}`;
      try {
        await fs.access(this.getSessionDir(id));
        attempt += 1;
      } catch {
        return id;
      }
    }
  }

  private async listSessionMetas(): Promise<SessionMeta[]> {
    const dirents = await fs.readdir(this.config.sessionRootDir, { withFileTypes: true }).catch(() => []);
    const sessions = await Promise.all(
      dirents
        .filter((item) => item.isDirectory())
        .map(async (item) => this.loadMeta(item.name).catch(() => null))
    );

    return sessions.filter((item): item is SessionMeta => item !== null);
  }

  private async copyOptionalWorkspaceArtifacts(sessionDir: string): Promise<void> {
    await copyIfExists(this.config.defaultAgentFile, path.join(sessionDir, "AGENTS.md"));
    await copyDirIfExists(
      this.config.defaultSkillsDir,
      path.join(sessionDir, ".agents", "skills")
    );
  }

  private async writeKubectlWrapper(sessionDir: string): Promise<void> {
    const wrapperPath = path.join(sessionDir, "bin", "kubectl");
    const script = `#!/bin/sh
exec "${this.config.kubectlPath}" --kubeconfig="${path.join(sessionDir, ".kube", "config")}" "$@"
`;
    await fs.writeFile(wrapperPath, script, { encoding: "utf8", mode: 0o755 });
  }
}

async function copyIfExists(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await ensureDir(path.dirname(targetPath));
    await fs.copyFile(sourcePath, targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function copyDirIfExists(sourceDir: string, targetDir: string): Promise<void> {
  try {
    await fs.access(sourceDir);
  } catch {
    return;
  }

  await ensureDir(targetDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirIfExists(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

function extensionFromFile(file: File): string {
  const fromName = file.name.split(".").pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]+$/.test(fromName)) {
    return fromName;
  }

  const fromType = file.type.split("/").pop()?.toLowerCase();
  return fromType && /^[a-z0-9]+$/.test(fromType) ? fromType : "bin";
}

export function normalizeKubeconfig(content: string): string {
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (error) {
    throw new Error(`kubeconfig_yaml_invalid:${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("kubeconfig_invalid:内容不是 YAML 对象");
  }

  const value = parsed as Record<string, unknown>;
  if (value.apiVersion !== "v1") {
    throw new Error("kubeconfig_invalid:缺少 apiVersion: v1");
  }
  if (value.kind !== "Config") {
    throw new Error("kubeconfig_invalid:缺少 kind: Config");
  }

  for (const field of ["clusters", "contexts", "users"]) {
    if (!Array.isArray(value[field]) || value[field].length === 0) {
      throw new Error(`kubeconfig_invalid:${field} 不能为空`);
    }
  }

  if (typeof value["current-context"] !== "string" || !value["current-context"]) {
    throw new Error("kubeconfig_invalid:缺少 current-context");
  }

  const clusters = value["clusters"] as Array<Record<string, unknown>>;
  for (const item of clusters) {
    const cluster = item["cluster"];
    if (!cluster || typeof cluster !== "object" || Array.isArray(cluster)) {
      throw new Error("kubeconfig_invalid:clusters[*].cluster 必须是对象");
    }

    const clusterRecord = cluster as Record<string, unknown>;
    delete clusterRecord["certificate-authority"];
    delete clusterRecord["certificate-authority-data"];
    clusterRecord["insecure-skip-tls-verify"] = true;
  }

  return (
    yaml.dump(value, {
      lineWidth: -1,
      noRefs: true,
      quotingType: '"',
      forceQuotes: false
    }).trimEnd() + "\n"
  );
}

export function buildSessionImageUrl(sessionId: string, fileName: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileName)}`;
}

export function applySessionPreview(session: SessionMeta): SessionSummary {
  return {
    ...session,
    preview: session.lastPrompt ?? session.title
  };
}

export function titleFromPrompt(prompt: string): string {
  return deriveTitle(prompt);
}
