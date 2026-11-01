import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface PricingRate {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export interface Config {
  codex?: { enabled?: boolean; sessionsDir?: string; pollIntervalMs?: number; lookbackDays?: number; maxFiles?: number };
  host: string;
  port: number;
  dataDir: string;
  billingMode: "subscription" | "api";
  defaultModel: string;
  allowedRoots: string[]; // managed sessions and file links are restricted to these
  staleAfterMs: number;
  readTranscriptUsage: boolean;
  pricing: { asOf: string | null; note: string; models: Record<string, PricingRate> };
}

const DEFAULTS: Config = {
  host: "127.0.0.1",
  port: 4317,
  dataDir: join(APP_ROOT, "data"),
  billingMode: "subscription",
  defaultModel: "sonnet",
  allowedRoots: [resolve(APP_ROOT, "..")],
  staleAfterMs: 5 * 60_000,
  readTranscriptUsage: true,
  pricing: { asOf: null, note: "No rates configured", models: {} },
};

export function loadConfig(): Config {
  const file = process.env.AGENT_MONITOR_CONFIG ?? join(APP_ROOT, "config", "agent-monitor.json");
  let cfg: Config = { ...DEFAULTS };
  if (existsSync(file)) {
    const user = JSON.parse(readFileSync(file, "utf8"));
    cfg = { ...cfg, ...user, pricing: { ...cfg.pricing, ...(user.pricing ?? {}) } };
  }
  if (process.env.AGENT_MONITOR_PORT) cfg.port = Number(process.env.AGENT_MONITOR_PORT);
  if (process.env.AGENT_MONITOR_DATA) cfg.dataDir = process.env.AGENT_MONITOR_DATA;
  if (process.env.AGENT_MONITOR_CODEX_ENABLED === "0") cfg.codex = { ...cfg.codex, enabled: false };
  cfg.allowedRoots = cfg.allowedRoots.map((r) => resolve(r));
  if (cfg.billingMode !== "subscription" && cfg.billingMode !== "api") {
    throw new Error(`billingMode must be "subscription" or "api", got ${cfg.billingMode}`);
  }
  mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}

// Local auth token for state-changing requests and hook ingestion.
// Lives in the data dir so the hook forwarder can read it.
export function loadToken(dataDir: string): string {
  const f = join(dataDir, "token");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  const t = randomBytes(24).toString("hex");
  writeFileSync(f, t, { mode: 0o600 });
  return t;
}

// Optional .env for API billing mode. Only read when billingMode is "api".
export function loadDotEnvKey(): string | null {
  const f = join(APP_ROOT, ".env");
  if (!existsSync(f)) return null;
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}
