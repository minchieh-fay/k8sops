import { createServer } from "./server.ts";

try {
  const app = createServer();
  const server = await app.start();
  console.log(`k8sops listening on http://localhost:${server.port}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("llm_config_missing:")) {
    const missing = message.slice("llm_config_missing:".length).split(",");
    console.error("Missing LLM config.");
    console.error(`Set these env vars or put them in .env: ${missing.join(", ")}`);
    process.exit(1);
  }

  throw error;
}
