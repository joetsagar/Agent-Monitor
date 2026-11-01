import { execFile, type ChildProcess } from "node:child_process";
import { APP_ROOT } from "./config.ts";
import { join } from "node:path";
import type { WidgetUsageRow, WidgetUsageSnapshot } from "../shared/types.ts";
export type { WidgetUsageRow, WidgetUsageProvider, WidgetUsageSnapshot } from "../shared/types.ts";
interface Options {
  runner?: () => Promise<unknown>;
  now?: () => number;
  refreshMs?: number;
}
const PROVIDERS = [{ id: "claude", name: "Claude" }, { id: "codex", name: "Codex" }, { id: "kilo", name: "Kilo Code" }] as const;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const obj = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const ERROR_MESSAGES = new Set([
  "Usage-Widget is unavailable on this PC", "Can't read Kilo usage – retrying in 2 min",
  ...["Claude", "Codex"].flatMap((name) => [
    `${name} login missing – ${name === "Claude" ? "open Claude Code" : "run codex login"}`,
    `${name} login needs attention – ${name === "Claude" ? "open Claude Code" : "run codex login"}`,
    `${name} login expired – ${name === "Claude" ? "open Claude Code" : "run codex login"}`,
    `Can't reach ${name} – retrying in 2 min`,
  ]),
]);
const safeError = (value: unknown) => typeof value === "string" && ERROR_MESSAGES.has(value) ? value : "Usage check unavailable; retry in a moment";

function publicRows(value: unknown, id: string): WidgetUsageRow[] {
  if (!Array.isArray(value)) throw new Error("Invalid usage rows");
  return value.slice(0, 8).map((raw) => {
    const row = obj(raw);
    // Labels are fixed by the existing widget, not arbitrary provider strings.
    const label = id === "kilo" ? "Tokens (7 days)" : row.label === "Session (5 hours)" ? "Session (5 hours)" : row.label === "Weekly (7 days)" ? "Weekly (7 days)" : null;
    if (!label) throw new Error("Invalid usage window");
    const date = typeof row.resetsAt === "string" && Number.isFinite(Date.parse(row.resetsAt)) ? new Date(row.resetsAt).toISOString() : null;
    return { label, percent: id === "kilo" ? null : finite(row.percent), tokens: id === "kilo" ? finite(row.tokens) : null,
      resetsAt: date, windowSeconds: finite(row.windowSeconds) };
  });
}

export class WidgetUsageService {
  private runner: () => Promise<unknown>;
  private now: () => number;
  private refreshMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private child: ChildProcess | null = null;
  private pending: Promise<WidgetUsageSnapshot> | null = null;
  private stopped = false;
  private state: WidgetUsageSnapshot = { updatedAt: null, refreshing: false,
    providers: PROVIDERS.map((p) => ({ ...p, status: "loading", error: null, rows: [], stale: false })) };

  constructor(options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.refreshMs = Math.max(1000, options.refreshMs ?? 120_000);
    this.runner = options.runner ?? (() => this.runBridge());
  }

  getSnapshot(): WidgetUsageSnapshot { return structuredClone(this.state); }

  start() {
    if (this.timer) return;
    this.stopped = false;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // This service owns exactly this child process. Never kill by process name.
    try { this.child?.kill(); } catch { /* The child may have exited during shutdown. */ }
    this.child = null;
  }

  refresh(): Promise<WidgetUsageSnapshot> {
    if (this.pending) return this.pending;
    if (this.stopped) return Promise.resolve(this.getSnapshot());
    this.state.refreshing = true;
    this.pending = this.update().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async update(): Promise<WidgetUsageSnapshot> {
    try {
      const payload = obj(await this.runner());
      if (!Array.isArray(payload.providers)) throw new Error("Invalid usage response");
      const providers = payload.providers.map(obj);
      this.state.providers = this.state.providers.map((previous) => {
        const incoming = providers.find((p) => p.id === previous.id);
        if (incoming?.status === "ok") {
          try { return { ...previous, status: "ok", rows: publicRows(incoming.rows, previous.id), error: null, stale: false }; }
          catch { /* malformed data must not erase a good last reading */ }
        }
        return { ...previous, status: "error", error: safeError(incoming?.error), stale: previous.rows.length > 0 };
      });
    } catch {
      // Exceptions can contain stderr or environment paths; never expose them.
      this.state.providers = this.state.providers.map((p) => ({ ...p, status: "error", error: "Usage check unavailable; retry in a moment", stale: p.rows.length > 0 }));
    } finally {
      this.state.updatedAt = this.now();
      this.state.refreshing = false;
    }
    return this.getSnapshot();
  }

  private runBridge(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.child = execFile("python", [join(APP_ROOT, "scripts", "usage_bridge.py")], {
        cwd: APP_ROOT, windowsHide: true, timeout: 70_000, maxBuffer: 64 * 1024,
      }, (error, stdout) => {
        this.child = null;
        if (error) return reject(new Error("Usage bridge unavailable"));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Invalid usage response")); }
      });
    });
  }
}
