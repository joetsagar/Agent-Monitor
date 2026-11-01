import { readdir, stat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import type { Agent, Session } from "../shared/types.ts";
import { shortText, applyPlanTool, noteChangedFile } from "./activity.ts";
import { sanitize } from "./redact.ts";

// Best-effort observer of local Codex JSONL rollouts, NOT a control connection.
// Only explicit public activity records are consumed. Reasoning, instructions,
// credentials, arbitrary response messages and raw tool outputs are never saved.
type Obj = Record<string, any>;
interface Tail { offset: number; pending: string; decoder: StringDecoder; meta: Obj | null; dropping: boolean; ignored?: boolean; inherited?: boolean }
const CAPS = { answerQuestions: false, approvePermissions: false, sendMessages: false, cancel: false, resume: false };
const PUBLIC_EVENTS = new Set(["task_started", "task_complete", "turn_aborted", "agent_message", "user_message", "token_count", "thread_settings_applied", "error"]);
const TOOLS = new Set(["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"]);
const within = (path: string, root: string) => { const r = relative(resolve(root), resolve(path)); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
const object = (v: unknown): Obj => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const parse = (v: unknown): Obj => { if (typeof v !== "string") return object(v); try { return object(JSON.parse(v)); } catch { return {}; } };

export class CodexAdapter {
  private store: Store;
  private cfg: Config;
  private tails = new Map<string, Tail>();
  private metas = new Map<string, Obj>();
  private calls = new Map<string, { name: string; input: Obj }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private stopped = false;
  private lastDiscovery = 0;
  private lastEventAt: number | null = null;
  readonly sessionsDir: string;

  constructor(store: Store, cfg: Config) {
    this.store = store; this.cfg = cfg;
    this.sessionsDir = resolve(cfg.codex?.sessionsDir ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"));
  }

  start() {
    if (this.cfg.codex?.enabled === false) { this.report("disabled"); return; }
    void this.poll();
    this.timer = setInterval(() => void this.poll(), Math.max(250, this.cfg.codex?.pollIntervalMs ?? 1000));
    this.timer.unref();
  }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); }

  private report(status: "watching" | "unavailable" | "disabled", error: string | null = null) {
    this.store.setServer({ codex: { enabled: status !== "disabled", status, filesTracked: [...this.tails.values()].filter((t) => t.meta).length,
      lastScanAt: status === "watching" ? Date.now() : null, lastEventAt: this.lastEventAt, error } });
  }

  // Discovery is infrequent; append reads are bounded and never re-read a whole
  // growing log. Partial UTF-8 and partial JSON lines survive polling boundaries.
  async poll() {
    if (this.busy || this.stopped || this.cfg.codex?.enabled === false) return;
    this.busy = true;
    try {
      if (!this.lastDiscovery || Date.now() - this.lastDiscovery >= 5000) {
        const found: { path: string; mtime: number }[] = [];
        const cutoff = Date.now() - Math.max(1, this.cfg.codex?.lookbackDays ?? 2) * 86_400_000;
        let visited = 0;
        const walk = async (dir: string, depth = 0): Promise<void> => {
          if (depth > 4) return;
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (++visited > 20_000 || this.stopped) return;
            const path = join(dir, entry.name);
            if (entry.isDirectory()) await walk(path, depth + 1);
            else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
              try { const s = await stat(path); if (s.mtimeMs >= cutoff) found.push({ path, mtime: s.mtimeMs }); } catch { /* removed */ }
            }
          }
        };
        await walk(this.sessionsDir);
        const selected = found.sort((a, b) => b.mtime - a.mtime).slice(0, Math.max(1, this.cfg.codex?.maxFiles ?? 40));
        const selectedPaths = new Set(selected.map((f) => f.path));
        for (const path of this.tails.keys()) if (!selectedPaths.has(path)) this.tails.delete(path);
        for (const { path } of selected) {
          if (!this.tails.has(path)) this.tails.set(path, { offset: 0, pending: "", decoder: new StringDecoder("utf8"), meta: null, dropping: false });
        }
        this.lastDiscovery = Date.now();
      }
      for (const [path, tail] of this.tails) {
        if (this.stopped) break;
        try { await this.readTail(path, tail); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") this.tails.delete(path);
          else throw error;
        }
      }
      if (!this.stopped) this.report("watching");
    } catch (error) {
      this.report("unavailable", (error as NodeJS.ErrnoException).code === "ENOENT" ? "Local Codex sessions directory not found" : "Could not read local Codex sessions");
    } finally { this.busy = false; }
  }

  private async readTail(path: string, tail: Tail) {
    if (tail.ignored) return;
    const f = await open(path, "r");
    try {
      const size = (await f.stat()).size;
      if (size < tail.offset) { tail.offset = 0; tail.pending = ""; tail.decoder = new StringDecoder("utf8"); tail.meta = null; tail.dropping = false; tail.inherited = false; }
      if (size === tail.offset) return;
      const buffer = Buffer.alloc(Math.min(size - tail.offset, 1024 * 1024));
      const { bytesRead } = await f.read(buffer, 0, buffer.length, tail.offset);
      tail.offset += bytesRead;
      const text = tail.pending + tail.decoder.write(buffer.subarray(0, bytesRead));
      const lines = text.split("\n"); tail.pending = lines.pop() ?? "";
      for (const line of lines) {
        if (tail.dropping) { tail.dropping = false; continue; }
        if (line.length > 2_000_000) continue;
        let row: Obj; try { row = JSON.parse(line); } catch { continue; }
        if (row.type === "session_meta") {
          const meta = object(row.payload);
          // Forked worker logs include a copy of their parent's metadata and
          // history. The first header owns this file, not the copied header.
          if (tail.meta && meta.id !== tail.meta.id) { tail.inherited = true; continue; }
          // Only collect projects explicitly covered by allowedRoots.
          if (typeof meta.id === "string" && typeof meta.cwd === "string" && this.cfg.allowedRoots.some((r) => within(meta.cwd, r))) {
            // Keep only metadata required for attribution; never instructions.
            tail.meta = { id: meta.id, cwd: meta.cwd, source: meta.source, timestamp: meta.timestamp,
              agent_nickname: meta.agent_nickname, agent_role: meta.agent_role, cli_version: meta.cli_version };
            this.metas.set(meta.id, tail.meta);
          } else { tail.ignored = true; tail.pending = ""; break; }
        } else if (tail.meta) {
          if (tail.inherited) {
            const p = object(row.payload);
            const created = Date.parse(tail.meta.timestamp);
            const ownTurn = row.type === "event_msg" && p.type === "task_started" &&
              typeof p.started_at === "number" && p.started_at >= Math.floor(created / 1000) && p.turn_attribution?.parent_turn_id;
            if (!ownTurn) continue;
            tail.inherited = false;
          }
          this.ingest(tail.meta, row);
        }
      }
      if (tail.pending.length > 2_000_000) { tail.pending = ""; tail.dropping = true; }
    } finally { await f.close(); }
  }

  // Also exposed for deterministic tests; all input still goes through the same
  // whitelist and path checks as real files.
  ingest(meta: Obj, row: Obj) {
    if (typeof meta.id !== "string" || typeof meta.cwd !== "string" || !this.cfg.allowedRoots.some((r) => within(meta.cwd, r))) return;
    const p = object(row.payload);
    if (!(row.type === "turn_context" || row.type === "event_msg" && PUBLIC_EVENTS.has(p.type) || row.type === "response_item" && TOOLS.has(p.type))) return;
    this.metas.set(meta.id, meta);
    const sub = object(object(meta.source).subagent);
    const spawn = object(sub.thread_spawn ?? sub.spawn);
    const parent = typeof spawn.parent_thread_id === "string" ? spawn.parent_thread_id : null;
    // Internal helper sessions without an attributable parent aren't workers.
    if (Object.keys(sub).length && !parent) return;
    let rootId = parent ?? meta.id;
    const seen = new Set([meta.id]);
    while (!seen.has(rootId)) {
      seen.add(rootId);
      const next = object(object(object(this.metas.get(rootId)?.source).subagent).thread_spawn).parent_thread_id;
      if (typeof next !== "string") break;
      rootId = next;
    }
    const ts = Date.parse(row.timestamp);
    if (!Number.isFinite(ts)) return;
    const sid = `cx_${rootId}`;
    const rootMeta = this.metas.get(rootId) ?? meta;
    let session = this.store.sessions.get(sid);
    if (!session) {
      const project = this.store.projectFor(rootMeta.cwd);
      session = { id: sid, projectId: project.id, source: "codex-local", runtimeSessionId: rootId, title: "Codex session", cwd: rootMeta.cwd,
        model: null, authSource: null, billingMode: null, runtimeState: "idle", runtimeStateDetail: "Observed from local Codex logs; respond in Codex",
        permissionMode: null, startedAt: Date.parse(rootMeta.timestamp) || ts, lastEventAt: ts, endedAt: null, capabilities: CAPS, claudeCodeVersion: null } satisfies Session;
      this.store.putSession(session);
    }
    const workerRole = String(meta.agent_role ?? spawn.agent_role ?? "subagent");
    const workerName = shortText(meta.agent_role ?? spawn.agent_role ?? (typeof spawn.agent_path === "string" ? spawn.agent_path.split("/").filter(Boolean).at(-1) : null) ?? meta.agent_nickname ?? spawn.agent_nickname ?? "Worker", 200);
    const agent = this.store.ensureAgent(sid, parent ? meta.id : null, { ts, role: parent ? workerRole : "lead",
      name: parent ? workerName : "lead" });
    if (parent && agent.name !== workerName) this.store.patchAgent(agent.id, { name: workerName, role: workerRole });
    const key = "codex:" + createHash("sha256").update(meta.id + JSON.stringify(row)).digest("hex");
    const callId = typeof p.call_id === "string" ? p.call_id : null;
    const callKey = `${meta.id}:${callId}`;
    if (row.type === "response_item" && ["function_call", "custom_tool_call"].includes(p.type)) {
      this.calls.set(callKey, { name: String(p.name ?? "Tool"), input: p.type === "custom_tool_call" ? { command: String(p.input ?? "") } : parse(p.arguments) });
    }
    if (this.store.hasEvent(key)) return;
    // Replaying on restart must not regress a newer stored runtime state.
    const fresh = ts >= agent.lastActivityAt;
    const patch = (v: Partial<Agent>) => { if (fresh) this.store.patchAgent(agent.id, sanitize(v), ts); };
    const add = (kind: string, summary: string, status: "ok" | "error" | "info" | "pending" = "info", extra: Obj = {}) => {
      this.store.addEvent({ dedupeKey: key, sessionId: sid, agentId: agent.id, ts, kind, summary, status, ...extra });
      this.lastEventAt = Math.max(this.lastEventAt ?? 0, ts);
    };
    const model = row.type === "turn_context" ? p.model : p.type === "thread_settings_applied" ? p.thread_settings?.model : null;
    if (typeof model === "string" && fresh) {
      patch({ model, modelSource: "local Codex runtime log" });
      if (!parent) this.store.patchSession(sid, { model, permissionMode: p.approval_policy ?? p.thread_settings?.approval_policy ?? null });
      add("marker", "Codex model context"); return;
    }
    if (row.type === "response_item") {
      const call = this.calls.get(callKey);
      const name = call?.name ?? "Tool";
      if (["function_call", "custom_tool_call"].includes(p.type)) {
        const input = call?.input ?? {};
        const command = input.cmd ?? input.command ?? input.file_path ?? input.path ?? input.query;
        const summary = name === "exec" && typeof command === "string" ? `Run tools: ${[...command.matchAll(/tools\.([A-Za-z0-9_]+)/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "JavaScript"}` : `${name}${typeof command === "string" ? `: ${shortText(command, 180)}` : ""}`;
        patch({ status: "working", currentAction: summary, currentActionAt: ts, endedAt: null });
        if (fresh && !parent) this.store.patchSession(sid, { runtimeState: "running", endedAt: null });
        add("tool_start", summary, "pending", { toolName: name, toolUseId: callId, detail: { input } });
        if (fresh && name.endsWith("update_plan") && Array.isArray(input.plan)) applyPlanTool(this.store, agent.id, "TodoWrite", { todos: input.plan.map((t: Obj) => ({ content: t.step, status: t.status })) }, null, ts);
        if (fresh && name.endsWith("apply_patch")) {
          for (const m of String(input.command ?? p.input ?? "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
            const path = resolve(meta.cwd, m[1].trim());
            if (this.cfg.allowedRoots.some((r) => within(path, r))) noteChangedFile(this.store, agent.id, path);
          }
        }
      } else {
        // Extract outcome only. Never copy arbitrary tool output into the DB.
        const output = parse(p.output);
        const code = typeof output.exit_code === "number" ? output.exit_code : typeof output.exitCode === "number" ? output.exitCode : null;
        const failed = p.is_error === true || output.isError === true || code !== null && code !== 0;
        add(failed ? "tool_fail" : "tool_end", `${name} ${failed ? "failed" : "returned"}${code !== null ? ` (exit ${code})` : ""}`, failed ? "error" : "ok", { toolName: name, toolUseId: callId });
        if (failed) patch({ errorCount: agent.errorCount + 1 });
        this.calls.delete(callKey);
      }
      return;
    }
    switch (p.type) {
      case "task_started":
        patch({ status: "working", endedAt: null, currentAction: "Codex turn started", currentActionAt: ts });
        if (fresh && !parent) this.store.patchSession(sid, { runtimeState: "running", endedAt: null });
        add("session_start", "Codex turn started (local observation)", "info", { milestone: true }); break;
      case "user_message":
        // Do not import user prompts or IDE-injected context; public assistant
        // activity is enough to monitor the turn without copying private input.
        add("prompt", "Message received in Codex"); break;
      case "agent_message":
        if (p.phase === "analysis") break;
        if (typeof p.message !== "string") break;
        add("assistant_text", shortText(p.message, 400), "info", { detail: { text: p.message } });
        patch({ currentAction: shortText(p.message, 180), currentActionAt: ts }); break;
      case "task_complete": {
        const text = typeof p.last_agent_message === "string" ? p.last_agent_message : "Codex turn finished";
        patch({ status: parent ? "completed" : "idle", endedAt: parent ? ts : null, currentAction: "Turn finished", currentActionAt: ts,
          lastResult: { text: sanitize(shortText(text, 2000)), provenance: "agent-reported", ok: null, at: ts } });
        if (fresh && !parent) this.store.patchSession(sid, { runtimeState: "idle" });
        add("turn_end", shortText(text, 400), "info", { milestone: true, detail: { text } }); break;
      }
      case "turn_aborted":
        patch({ status: "cancelled", endedAt: ts, currentAction: "Turn interrupted in Codex", currentActionAt: ts });
        if (fresh && !parent) this.store.patchSession(sid, { runtimeState: "interrupted" });
        add("cancelled", "Turn interrupted in Codex", "info", { milestone: true }); break;
      case "error":
        patch({ status: "failed", errorCount: agent.errorCount + 1, currentAction: "Codex reported an error", currentActionAt: ts });
        if (fresh && !parent) this.store.patchSession(sid, { runtimeState: "failed" });
        add("error", "Codex reported an error; check the original session", "error", { milestone: true }); break;
      case "token_count": {
        const u = object(p.info?.total_token_usage);
        const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
        if (!Object.keys(u).length) break;
        const id = `${agent.id}:codex-usage`;
        if (ts >= (this.store.usage.get(id)?.measuredAt ?? 0)) this.store.putUsage({ id, sessionId: sid, agentId: parent ? agent.id : null,
          source: "codex-transcript", sourceNote: "Cumulative local Codex log usage (undocumented format); cached input is separated from input. Worker usage may overlap the lead and is not added again.",
          model: agent.model, inputTokens: num(u.input_tokens) !== null ? Math.max(0, u.input_tokens - (num(u.cached_input_tokens) ?? 0)) : null,
          cacheReadTokens: num(u.cached_input_tokens), cacheCreationTokens: num(u.cache_write_input_tokens), outputTokens: num(u.output_tokens), totalTokens: num(u.total_tokens),
          costEstimateUsd: null, costBasis: "Unknown: no verified Codex cost reported by local logs", includedInParent: !!parent, measuredAt: ts });
        add("marker", "Codex usage updated"); break;
      }
    }
  }
}
