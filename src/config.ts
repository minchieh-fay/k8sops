import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export type AppConfig = {
  port: number;
  rootDir: string;
  dataDir: string;
  sessionRootDir: string;
  publicDir: string;
  defaultAgentFile: string;
  defaultSkillsDir: string;
  kubectlPath: string;
  sessionMaxCount: number;
  codexBaseUrl: string;
  codexApiKey: string;
  codexModel: string;
};

export function loadConfig(): AppConfig {
  const rootDir = process.cwd();
  const dataDir = path.resolve(rootDir, "data");
  const codexBaseUrl = process.env.LLM_BASE_URL ?? process.env.CODEX_BASE_URL ?? "";
  const codexApiKey = process.env.LLM_API_KEY ?? process.env.CODEX_API_KEY ?? "";
  const codexModel = process.env.LLM_MODEL ?? process.env.CODEX_MODEL ?? "";

  return {
    port: Number(process.env.PORT ?? "3210"),
    rootDir,
    dataDir,
    sessionRootDir: path.resolve(dataDir, "session"),
    publicDir: path.resolve(rootDir, "public"),
    defaultAgentFile: path.resolve(dataDir, "AGENTS.md"),
    defaultSkillsDir: path.resolve(dataDir, ".agents", "skills"),
    kubectlPath: process.env.KUBECTL_PATH ?? "kubectl",
    sessionMaxCount: normalizeSessionMaxCount(process.env.SESSION_MAX_COUNT),
    codexBaseUrl,
    codexApiKey,
    codexModel
  };
}

export function validateCodexConfig(config: AppConfig): void {
  const missing: string[] = [];

  if (!config.codexBaseUrl.trim()) {
    missing.push("LLM_BASE_URL");
  }
  if (!config.codexModel.trim()) {
    missing.push("LLM_MODEL");
  }
  if (!config.codexApiKey.trim()) {
    missing.push("LLM_API_KEY");
  }

  if (missing.length > 0) {
    throw new Error(`llm_config_missing:${missing.join(",")}`);
  }
}

function normalizeSessionMaxCount(value: string | undefined): number {
  const parsed = Number(value ?? "30");
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 30;
  }

  return Math.floor(parsed);
}
