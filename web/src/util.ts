import { useEffect, useState } from "react";
import { formatUsdInGbp } from "./currency";
import type { Agent, AgentStatus, Interaction, UsageRecord } from "../../shared/types";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function relTime(ts: number | null | undefined, now: number): string {
  if (ts == null) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function minutesSince(ts: number, now: number): number {
  return Math.max(1, Math.floor((now - ts) / 60000));
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export function fmtNum(n: number | null): string {
  return n == null ? "Unknown" : n.toLocaleString();
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Working", waiting: "Waiting for you", blocked: "Blocked", idle: "Idle",
  failed: "Failed", completed: "Completed", cancelled: "Cancelled",
};

export const ACTIVE_STATUSES: AgentStatus[] = ["working", "waiting", "blocked", "idle"];
export const ENDED_STATUSES: AgentStatus[] = ["completed", "cancelled"];

export function isEnded(a: Agent): boolean { return ENDED_STATUSES.includes(a.status); }

export function statusClass(s: AgentStatus): string {
  switch (s) {
    case "working": return "st-working";
    case "waiting": case "blocked": return "st-attention";
    case "failed": return "st-failed";
    case "completed": return "st-ok";
    default: return "st-neutral";
  }
}

export function stableSort(agents: Agent[]): Agent[] {
  return agents.slice().sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function agentTitle(a: Agent): string {
  return a.role === "lead" ? `${a.name}` : a.name;
}

export interface UsageTotals {
  input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null;
  cost: number | null; costUnknownCount: number; counted: number; basis: string[];
}

function addN(a: number | null, b: number | null): number | null {
  return b == null ? a : (a ?? 0) + b;
}

/** Sums ONLY records that are not already included in a parent total. */
export function sumUsage(records: UsageRecord[]): UsageTotals {
  const t: UsageTotals = { input: null, output: null, cacheRead: null, cacheWrite: null, cost: null, costUnknownCount: 0, counted: 0, basis: [] };
  for (const r of records) {
    if (r.includedInParent) continue;
    t.counted++;
    t.input = addN(t.input, r.inputTokens);
    t.output = addN(t.output, r.outputTokens);
    t.cacheRead = addN(t.cacheRead, r.cacheReadTokens);
    t.cacheWrite = addN(t.cacheWrite, r.cacheCreationTokens);
    if (r.costEstimateUsd == null) t.costUnknownCount++;
    else t.cost = (t.cost ?? 0) + r.costEstimateUsd;
    if (r.costBasis && !t.basis.includes(r.costBasis)) t.basis.push(r.costBasis);
  }
  return t;
}

export function fmtCost(n: number | null): string {
  return formatUsdInGbp(n);
}

export function interactionTypeLabel(i: Interaction): string {
  if (!i.interactive) return "Read-only: answer in VS Code";
  return i.kind === "question" ? "Question" : i.kind === "permission" ? "Permission" : "Review";
}

export function interactionSummary(i: Interaction): string {
  const r = i.request;
  if (r.type === "question") return r.questions.map((q) => q.question).join(" / ");
  if (r.type === "permission") return `${r.toolName}: ${r.command ?? r.filePath ?? r.title ?? r.description ?? ""}`.trim();
  return r.resultText.split("\n")[0].slice(0, 200) || "Review agent result";
}

export const NEEDS_YOU: Interaction["status"][] = ["pending", "delivering", "failed"];

function normPath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") { if (parts.length === 0) parts.push(seg); continue; }
    if (seg === "..") { if (parts.length > 1) parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join("/").toLowerCase();
}

/** vscode:// link for a file, or null when the path is outside the session folder and the allowed roots. */
export function fileLink(path: string, cwd: string | undefined, roots: string[] = []): string | null {
  const abs = /^([a-zA-Z]:[\\/]|\/)/.test(path) ? path : cwd ? `${cwd}/${path}` : null;
  if (!abs) return null;
  const n = normPath(abs);
  const ok = [cwd, ...roots].some((r) => { if (!r) return false; const b = normPath(r); return n === b || n.startsWith(b + "/"); });
  return ok ? "vscode://file/" + encodeURI(abs.replace(/\\/g, "/")) : null;
}

export function folderLink(cwd: string): string {
  return "vscode://file/" + encodeURI(cwd.replace(/\\/g, "/"));
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export function pretty(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

// ---------- safe storage ----------
export function lsGet(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
export function lsSet(key: string, v: string): void { try { localStorage.setItem(key, v); } catch { /* ignore */ } }

const DRAFT_KEY = "agent-monitor-drafts";
let drafts: Record<string, unknown> | null = null;
function loadDrafts(): Record<string, unknown> {
  if (drafts) return drafts;
  try { drafts = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "{}") as Record<string, unknown>; } catch { drafts = {}; }
  return drafts;
}
export function getDraft<T>(id: string): T | undefined { return loadDrafts()[id] as T | undefined; }
export function setDraft(id: string, v: unknown): void {
  const d = loadDrafts();
  if (v === undefined) delete d[id]; else d[id] = v;
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* ignore */ }
}
