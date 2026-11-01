import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { Config } from "./config.ts";

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  models: string[];
}

// Estimates cost from configured rates only. Returns null when any model in
// use has no configured rate, rather than guessing.
export function estimateCost(cfg: Config, perModel: Record<string, Omit<TokenTotals, "models">>): { usd: number | null; basis: string } {
  const entries = Object.entries(perModel);
  if (entries.length === 0) return { usd: null, basis: "no usage" };
  let total = 0;
  for (const [model, t] of entries) {
    const key = Object.keys(cfg.pricing.models).find((k) => model.startsWith(k));
    if (!key) return { usd: null, basis: `no rate configured for ${model}` };
    const r = cfg.pricing.models[key];
    total += (t.inputTokens * r.inputPerMTok + t.outputTokens * r.outputPerMTok +
      t.cacheReadTokens * r.cacheReadPerMTok + t.cacheCreationTokens * r.cacheWritePerMTok) / 1e6;
  }
  return { usd: total, basis: `config rates (asOf ${cfg.pricing.asOf ?? "unknown"})` };
}

const projectsDir = resolve(homedir(), ".claude", "projects");

// Reads per-message usage from a Claude Code transcript. The JSONL format is
// not a documented interface, so results are labelled as such and any parse
// failure yields null (Unknown) rather than partial numbers.
export async function readTranscriptUsage(path: string, excludeSidechain: boolean):
  Promise<{ totals: TokenTotals; perModel: Record<string, Omit<TokenTotals, "models">>; lastModel: string | null } | null> {
  const full = resolve(path);
  if (!full.toLowerCase().startsWith((projectsDir + sep).toLowerCase())) return null;
  let text: string;
  try { text = await readFile(full, "utf8"); } catch { return null; }
  const byMsg = new Map<string, { model: string; u: Record<string, number> }>();
  let lastModel: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let o: Record<string, any>;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "assistant" || !o.message?.usage) continue;
    if (excludeSidechain && o.isSidechain === true) continue;
    const model = String(o.message.model ?? "unknown");
    if (model === "<synthetic>") continue;
    lastModel = model;
    // Streaming writes one line per content block sharing message.id; keep the last.
    byMsg.set(String(o.message.id ?? o.uuid), { model, u: o.message.usage });
  }
  if (byMsg.size === 0) return null;
  const perModel: Record<string, Omit<TokenTotals, "models">> = {};
  for (const { model, u } of byMsg.values()) {
    const m = (perModel[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    m.inputTokens += u.input_tokens ?? 0;
    m.outputTokens += u.output_tokens ?? 0;
    m.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    m.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
  }
  const totals: TokenTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, models: Object.keys(perModel) };
  for (const m of Object.values(perModel)) {
    totals.inputTokens += m.inputTokens; totals.outputTokens += m.outputTokens;
    totals.cacheReadTokens += m.cacheReadTokens; totals.cacheCreationTokens += m.cacheCreationTokens;
  }
  return { totals, perModel, lastModel };
}
