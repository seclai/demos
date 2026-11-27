// Server-only configuration. Values come from the real environment, or from
// `.env` in development (Node's built-in loader; no dotenv dependency).

import { existsSync } from "node:fs";
import path from "node:path";

if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* malformed .env: fall through to the checks below */
  }
}

export interface AppConfig {
  apiKey: string;
  agentId: string;
  sessionSecret: string;
  dataDir: string;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const apiKey = process.env.SECLAI_API_KEY;
  const agentId = process.env.SECLAI_AGENT_ID;
  const sessionSecret = process.env.SESSION_SECRET;

  if (!apiKey || apiKey === "your_api_key_here") {
    throw new Error("SECLAI_API_KEY is not set. Copy .env.example to .env and add your key.");
  }
  if (!agentId) {
    throw new Error("SECLAI_AGENT_ID is not set. Create the agent from the gallery and paste its id into .env.");
  }
  if (!sessionSecret || sessionSecret === "change_me") {
    throw new Error("SESSION_SECRET is not set. Put a long random string in .env (for example `openssl rand -hex 32`).");
  }

  cached = {
    apiKey,
    agentId,
    sessionSecret,
    dataDir: path.resolve(process.env.DATA_DIR || "./data"),
  };
  return cached;
}
