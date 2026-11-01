import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { query, type CanUseTool, type PermissionResult, type PermissionUpdate, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.ts";
import { loadDotEnvKey } from "./config.ts";
import type { Store } from "./store.ts";
import type {
  Agent, Interaction, InteractionResponse, PermissionRequestPayload, QuestionItem, Session, StartSessionRequest,
} from "../shared/types.ts";
import { applyPlanTool, changedFile, describeTool, isTestCommand, noteChangedFile, shortText } from "./activity.ts";
import { sanitize } from "./redact.ts";

// Backend-managed Claude sessions via the Claude Agent SDK. These support
// two-way interaction: canUseTool callbacks stay pending until the user
// responds in the browser, and the response resolves exactly that callback.

const MANAGED_CAPS = { answerQuestions: true, approvePermissions: true, sendMessages: true, cancel: true, resume: true };

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;
  push(text: string) {
    const m: SDKUserMessage = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage;
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false }); else this.items.push(m);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

interface Run {
  sessionId: string;
  q: Query;
  input: InputQueue;
  attemptId: string;
  abort: AbortController;
  cancelled: boolean;
  turnStartedAt: number;
  turnChangedFiles: Set<string>;
  turnCount: number;
}

interface Pending {
  resolve: (r: PermissionResult) => void;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

export class ManagedAdapter {
  private store: Store;
  private cfg: Config;
  private runs = new Map<string, Run>();
  private pending = new Map<string, Pending>();
  private toolUses = new Map<string, { sessionId: string; agentId: string; name: string; input: Record<string, unknown> }>();
  private taskToAgent = new Map<string, string>(); // SDK task_id / agentID -> our agent id
  // Agent tool calls that have SDK task lifecycle events; those decide completion,
  // because a backgrounded worker's tool_result only means "launched".
  private trackedTasks = new Set<string>();
  private seq = 0;

  constructor(store: Store, cfg: Config) {
    this.store = store;
    this.cfg = cfg;
  }

  isManagedRuntimeSession(runtimeSessionId: string): boolean {
    for (const s of this.store.sessions.values()) if (s.source === "managed" && s.runtimeSessionId === runtimeSessionId) return true;
    return false;
  }

  // After a backend restart no runtime callback survives. Reconcile persisted
  // state with that fact instead of showing stale "pending" requests.
  reconcileOnStartup() {
    for (const s of this.store.sessions.values()) {
      if (s.source !== "managed") continue;
      if (["starting", "running", "idle", "waiting"].includes(s.runtimeState)) {
        this.store.patchSession(s.id, { runtimeState: "interrupted", runtimeStateDetail: "Backend restarted; the runtime process ended. Send a message to resume this session." });
        for (const a of this.store.agents.values()) {
          if (a.sessionId === s.id && (a.status === "working" || a.status === "waiting")) {
            this.store.patchAgent(a.id, { status: a.role === "lead" ? "idle" : "cancelled", currentAction: "Interrupted by backend restart", currentActionAt: Date.now() });
          }
        }
      }
    }
    for (const i of this.store.interactions.values()) {
      const s = this.store.sessions.get(i.sessionId);
      if (s?.source !== "managed") continue;
      if (i.status === "pending" || i.status === "delivering") {
        this.store.transition(i.id, ["pending", "delivering"], i.kind === "review" ? "pending" : "expired",
          { statusDetail: i.kind === "review" ? i.statusDetail : "Expired: the backend restarted, so the runtime request no longer exists. Resume the session to continue." });
      }
    }
  }

  // ---- lifecycle ----
  start(req: StartSessionRequest): Session {
    const cwd = this.checkPath(req.projectPath);
    if (!req.prompt?.trim()) throw new ApiError(400, "prompt is required");
    const project = this.store.projectFor(cwd);
    const now = Date.now();
    const s: Session = {
      id: "m_" + randomUUID(), projectId: project.id, source: "managed", runtimeSessionId: null,
      title: req.title?.trim() || shortText(req.prompt, 80), cwd, model: null, authSource: null,
      billingMode: this.cfg.billingMode, runtimeState: "starting", runtimeStateDetail: null,
      permissionMode: req.permissionMode ?? "default", startedAt: now, lastEventAt: now, endedAt: null,
      capabilities: MANAGED_CAPS, claudeCodeVersion: null,
    };
    this.store.putSession(s);
    const lead = this.store.ensureAgent(s.id, null, { ts: now, name: "lead", role: "lead", assignedTask: shortText(req.prompt, 300) });
    this.ev(s.id, lead.id, "session_start", `Managed session started (${this.cfg.billingMode} billing mode)`, "info", true);
    this.launch(s, req.prompt, { model: req.model || this.cfg.defaultModel, loadSettings: req.loadSettings ?? true, resume: undefined });
    return s;
  }

  sendMessage(sessionId: string, text: string) {
    const s = this.store.sessions.get(sessionId);
    if (!s || s.source !== "managed") throw new ApiError(404, "managed session not found");
    if (!text?.trim()) throw new ApiError(400, "message text is required");
    const run = this.runs.get(sessionId);
    const lead = this.store.agentId(sessionId, null);
    if (run) {
      run.input.push(text);
    } else {
      if (!s.runtimeSessionId) throw new ApiError(409, "session never initialised; start a new session instead");
      this.ev(sessionId, lead, "resume", "Resuming session with a new message", "info", true);
      this.launch(s, text, { model: s.model ?? this.cfg.defaultModel, loadSettings: true, resume: s.runtimeSessionId });
    }
    this.store.patchAgent(lead, { status: "working", currentAction: "Message sent; waiting for the agent", currentActionAt: Date.now(), assignedTask: shortText(text, 300) }, Date.now());
    this.ev(sessionId, lead, "prompt", `Message sent from browser: ${shortText(text, 120)}`, "info");
  }

  async cancel(sessionId: string) {
    const run = this.runs.get(sessionId);
    if (!run) throw new ApiError(409, "session is not running");
    run.cancelled = true;
    try { await run.q.interrupt(); } catch { /* fall through to hard stop */ }
    run.input.close();
    run.abort.abort();
  }

  end(sessionId: string) {
    const run = this.runs.get(sessionId);
    if (!run) throw new ApiError(409, "session is not running");
    run.input.close(); // lets the runtime finish cleanly
  }

  shutdown() {
    for (const run of this.runs.values()) { run.input.close(); run.abort.abort(); }
  }

  private checkPath(p: string): string {
    if (!p) throw new ApiError(400, "projectPath is required");
    const full = resolve(p);
    if (!existsSync(full) || !statSync(full).isDirectory()) throw new ApiError(400, "projectPath must be an existing directory");
    const ok = this.cfg.allowedRoots.some((r) => full.toLowerCase() === r.toLowerCase() || full.toLowerCase().startsWith(r.toLowerCase() + sep));
    if (!ok) throw new ApiError(403, `projectPath is outside allowedRoots (${this.cfg.allowedRoots.join(", ")})`);
    return full;
  }

  private childEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      // Never inherit credentials implicitly, and never inherit the variables
      // of a Claude Code session this backend may have been launched from.
      if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID|CLAUDE_EFFORT)/.test(k)) continue;
      env[k] = v;
    }
    if (this.cfg.billingMode === "api") {
      const key = loadDotEnvKey() ?? process.env.ANTHROPIC_API_KEY;
      if (!key) throw new ApiError(400, "billingMode is \"api\" but no ANTHROPIC_API_KEY is in .env or the backend environment");
      env.ANTHROPIC_API_KEY = key;
    }
    env.CLAUDE_AGENT_SDK_CLIENT_APP = "agent-monitor/0.1";
    return env;
  }

  private launch(s: Session, prompt: string, o: { model: string; loadSettings: boolean; resume: string | undefined }) {
    const input = new InputQueue();
    input.push(prompt);
    const abort = new AbortController();
    const attemptId = this.store.startAttempt(s.id, o.resume ? "resume" : "start");
    let q: Query;
    try {
      q = query({
        prompt: input,
        options: {
          cwd: s.cwd, model: o.model, env: this.childEnv(), abortController: abort,
          permissionMode: (s.permissionMode as "default") ?? "default",
          settingSources: o.loadSettings ? ["user", "project", "local"] : [],
          resume: o.resume,
          canUseTool: this.canUseTool(s.id),
          stderr: (d) => { if (/error/i.test(d)) this.ev(s.id, this.store.agentId(s.id, null), "stderr", shortText(d, 300), "error"); },
        },
      });
    } catch (e) {
      this.store.endAttempt(attemptId, "failed to start");
      this.store.patchSession(s.id, { runtimeState: "failed", runtimeStateDetail: String(e) });
      throw e;
    }
    const run: Run = { sessionId: s.id, q, input, attemptId, abort, cancelled: false, turnStartedAt: Date.now(), turnChangedFiles: new Set(), turnCount: 0 };
    this.runs.set(s.id, run);
    this.store.patchSession(s.id, { runtimeState: "starting", runtimeStateDetail: o.resume ? "Resuming" : null, endedAt: null });
    void this.consume(run);
  }

  private async consume(run: Run) {
    const sid = run.sessionId;
    let outcome = "ended";
    try {
      for await (const m of run.q) this.onMessage(run, m);
      this.store.patchSession(sid, { runtimeState: run.cancelled ? "cancelled" : "ended", endedAt: Date.now(), runtimeStateDetail: run.cancelled ? "Cancelled from the browser" : "Runtime process ended" });
    } catch (e) {
      outcome = run.cancelled ? "cancelled" : "error";
      const msg = shortText(e instanceof Error ? e.message : String(e), 400);
      this.store.patchSession(sid, { runtimeState: run.cancelled ? "cancelled" : "failed", runtimeStateDetail: run.cancelled ? "Cancelled from the browser" : msg, endedAt: Date.now() });
      if (!run.cancelled) {
        const lead = this.store.agentId(sid, null);
        this.store.patchAgent(lead, { status: "failed", lastResult: { text: `Runtime error: ${msg}`, provenance: "runtime", ok: false, at: Date.now() } }, Date.now());
        this.ev(sid, lead, "runtime_error", `Runtime error: ${msg}`, "error", true);
      }
    } finally {
      this.runs.delete(sid);
      this.store.endAttempt(run.attemptId, outcome);
      const now = Date.now();
      for (const a of this.store.agents.values()) {
        if (a.sessionId !== sid) continue;
        if (a.status === "working" || a.status === "waiting") {
          this.store.patchAgent(a.id, { status: run.cancelled ? "cancelled" : a.role === "lead" ? "idle" : "cancelled", currentAction: run.cancelled ? "Cancelled" : "Runtime process ended", currentActionAt: now }, now);
        }
        // An idle lead whose runtime has ended is finished for now; it moves to Results.
        if (a.role === "lead" && a.status === "idle" && this.store.sessions.get(sid)?.runtimeState === "ended") {
          this.store.patchAgent(a.id, { status: "completed", endedAt: now, currentAction: "Session ended (send a message to resume)", currentActionAt: now }, now);
        }
      }
      for (const [id] of this.pending) {
        const i = this.store.interactions.get(id);
        if (i?.sessionId === sid) { this.pending.delete(id); this.store.transition(id, ["pending", "delivering"], "cancelled", { statusDetail: "Session ended before a response was delivered" }); }
      }
      if (run.cancelled) this.ev(sid, this.store.agentId(sid, null), "cancelled", "Session cancelled from the browser (runtime confirmed stop)", "info", true);
    }
  }

  // ---- runtime messages ----
  private agentFor(sid: string, parentToolUseId: string | null | undefined): string {
    if (!parentToolUseId) return this.store.agentId(sid, null);
    const id = this.store.agentId(sid, parentToolUseId);
    if (!this.store.agents.has(id)) {
      const d = this.toolUses.get(parentToolUseId);
      this.store.ensureAgent(sid, parentToolUseId, {
        ts: Date.now(), name: String(d?.input.subagent_type ?? "worker"), role: String(d?.input.subagent_type ?? "subagent"),
        assignedTask: d ? shortText(d.input.description ?? d.input.prompt, 300) : null,
      });
    }
    return id;
  }

  private onMessage(run: Run, m: SDKMessage) {
    const sid = run.sessionId;
    const now = Date.now();
    const lead = this.store.agentId(sid, null);
    if (m.type === "system" && m.subtype === "init") {
      this.store.patchSession(sid, { runtimeSessionId: m.session_id, model: m.model, authSource: m.apiKeySource, claudeCodeVersion: m.claude_code_version, runtimeState: "running", permissionMode: m.permissionMode });
      this.store.patchAgent(lead, { model: m.model, modelSource: "runtime (init)" });
      const allowed = this.cfg.billingMode === "api" ? ["ANTHROPIC_API_KEY"] : ["none", "oauth"];
      if (!allowed.includes(m.apiKeySource)) {
        this.ev(sid, lead, "billing_guard", `Stopped: runtime reported auth source "${m.apiKeySource}", which does not match billing mode "${this.cfg.billingMode}"`, "error", true);
        run.cancelled = false;
        run.input.close();
        run.abort.abort();
        this.store.patchSession(sid, { runtimeStateDetail: `Billing guard: auth source ${m.apiKeySource} not allowed in ${this.cfg.billingMode} mode` });
        return;
      }
      this.ev(sid, lead, "init", `Runtime initialised: model ${m.model}, Claude Code ${m.claude_code_version}, auth source "${m.apiKeySource}"`, "info");
      return;
    }
    if (m.type === "system" && m.subtype === "session_state_changed") {
      const map = { idle: "idle", running: "running", requires_action: "waiting" } as const;
      this.store.patchSession(sid, { runtimeState: map[m.state] });
      return;
    }
    if (m.type === "system" && m.subtype === "task_started") {
      const aid = this.agentFor(sid, m.tool_use_id ?? m.task_id);
      this.taskToAgent.set(m.task_id, aid);
      if (m.tool_use_id) this.trackedTasks.add(m.tool_use_id);
      this.store.patchAgent(aid, { assignedTask: shortText(m.description, 300), role: m.subagent_type ?? "subagent", name: m.subagent_type ?? "worker", status: "working" }, now);
      this.ev(sid, aid, "subagent_start", `Task assigned to ${m.subagent_type ?? "worker"}: ${shortText(m.description, 200)}`, "info", true);
      return;
    }
    if (m.type === "system" && m.subtype === "task_progress") {
      const aid = this.taskToAgent.get(m.task_id) ?? this.agentFor(sid, m.tool_use_id ?? m.task_id);
      if (m.last_tool_name) this.store.patchAgent(aid, { currentAction: `Using ${m.last_tool_name}`, currentActionAt: now }, now);
      this.taskUsage(sid, aid, m.usage);
      return;
    }
    if (m.type === "system" && m.subtype === "task_notification") {
      const aid = this.taskToAgent.get(m.task_id) ?? this.agentFor(sid, m.tool_use_id ?? m.task_id);
      const status = m.status === "completed" ? "completed" : m.status === "failed" ? "failed" : "cancelled";
      this.store.patchAgent(aid, { status, endedAt: now, currentAction: `Run ${m.status}`, currentActionAt: now, lastResult: { text: shortText(m.summary, 500), provenance: "agent-reported", ok: m.status === "completed" ? null : false, at: now } }, now);
      if (m.usage) this.taskUsage(sid, aid, m.usage);
      this.ev(sid, aid, "subagent_stop", `Worker ${m.status}: ${shortText(m.summary, 200)} (agent-reported)`, m.status === "failed" ? "error" : "info", true);
      return;
    }
    if (m.type === "assistant") {
      const aid = this.agentFor(sid, m.parent_tool_use_id);
      const model = (m.message as { model?: string }).model;
      if (model && model !== "<synthetic>") {
        const a = this.store.agents.get(aid);
        if (a && a.model !== model) this.store.patchAgent(aid, { model, modelSource: "runtime (assistant message)" });
      }
      for (const b of m.message.content as any[]) {
        if (b.type === "text" && b.text?.trim()) {
          this.ev(sid, aid, "assistant_text", shortText(b.text, 400), "info", false, { text: b.text });
        } else if (b.type === "tool_use") {
          const input = (b.input ?? {}) as Record<string, unknown>;
          this.toolUses.set(b.id, { sessionId: sid, agentId: aid, name: b.name, input });
          this.store.patchAgent(aid, { status: "working", currentAction: describeTool(b.name, input), currentActionAt: now }, now);
          this.ev(sid, aid, "tool_start", describeTool(b.name, input), "pending", false, { input }, b.name, b.id);
        }
      }
      return;
    }
    if (m.type === "user") {
      const content = (m.message as { content: unknown }).content;
      if (!Array.isArray(content)) return;
      for (const b of content as any[]) {
        if (b.type !== "tool_result") continue;
        const tu = this.toolUses.get(b.tool_use_id);
        const aid = tu?.agentId ?? this.agentFor(sid, m.parent_tool_use_id);
        const name = tu?.name ?? "tool";
        const input = tu?.input ?? {};
        const failed = b.is_error === true;
        const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? "").join("\n") : "";
        const i = this.store.interactionByToolUse(sid, b.tool_use_id);
        if (i) {
          this.store.transition(i.id, ["delivered"], "resumed", { statusDetail: failed && i.kind === "permission" ? "Agent received the denial and continued" : "Agent received the response and continued" });
        }
        const test = isTestCommand(name, input);
        const what = describeTool(name, input);
        const a = this.store.agents.get(aid);
        const patch: Partial<Agent> = {};
        if (failed) {
          patch.errorCount = (a?.errorCount ?? 0) + 1;
          patch.lastResult = { text: `${what} failed: ${shortText(text, 300)}`, provenance: "runtime", ok: false, at: now };
        } else if (test) {
          patch.lastResult = { text: `${what} exited successfully`, provenance: "runtime", ok: true, at: now };
        }
        if (Object.keys(patch).length) this.store.patchAgent(aid, patch, now);
        if (!failed) {
          const f = changedFile(name, input);
          if (f) { noteChangedFile(this.store, aid, f); run.turnChangedFiles.add(f); }
          applyPlanTool(this.store, aid, name, input, m.tool_use_result, now);
        }
        if (name === "Agent" || name === "Task") {
          const wid = this.store.agentId(sid, b.tool_use_id);
          const w = this.store.agents.get(wid);
          if (w && w.status !== "completed" && w.status !== "failed" && !this.trackedTasks.has(b.tool_use_id) && !/^Async agent launched/i.test(text)) {
            this.store.patchAgent(wid, { status: failed ? "failed" : "completed", endedAt: now, currentAction: "Run finished", currentActionAt: now, lastResult: { text: shortText(text, 500), provenance: "agent-reported", ok: failed ? false : null, at: now } }, now);
          }
        }
        this.ev(sid, aid, failed ? "tool_fail" : "tool_end",
          test ? `Test command ${failed ? "FAILED" : "passed"} (runtime result): ${what}` : failed ? `Failed: ${what} — ${shortText(text, 200)}` : what,
          failed ? "error" : "ok", test || (failed && (name === "Bash" || name === "PowerShell")), { input, output: text }, name, b.tool_use_id);
      }
      return;
    }
    if (m.type === "result") {
      run.turnCount++;
      const ok = m.subtype === "success" && !m.is_error;
      const text = m.subtype === "success" ? m.result : `Turn ended with ${m.subtype}`;
      this.store.patchAgent(lead, {
        status: ok ? "idle" : "failed", currentAction: ok ? "Turn complete; waiting for your next message" : `Turn failed (${m.subtype})`, currentActionAt: now,
        lastResult: { text: shortText(text, 600), provenance: ok ? "agent-reported" : "runtime", ok: ok ? null : false, at: now },
      }, now);
      this.store.patchSession(sid, { runtimeState: ok ? "idle" : "failed" });
      this.sessionUsage(sid, m);
      this.ev(sid, lead, ok ? "turn_end" : "turn_error", ok ? `Lead turn finished: ${shortText(text, 200)} (agent-reported)` : `Turn failed: ${m.subtype}`, ok ? "info" : "error", true,
        { subtype: m.subtype, num_turns: m.num_turns, total_cost_usd: m.total_cost_usd, usage: m.usage, modelUsage: m.modelUsage, permission_denials: m.permission_denials });
      // A turn can end while background workers still run; review only once they finish.
      const activeWorkers = [...this.store.agents.values()].some((a) => a.sessionId === sid && a.role !== "lead" && (a.status === "working" || a.status === "waiting"));
      if (ok && !activeWorkers) {
        this.createReview(sid, lead, text, [...run.turnChangedFiles]);
        run.turnChangedFiles = new Set();
      }
      return;
    }
  }

  // The SDK result carries session-level usage for the whole query process,
  // including subagents. It is recorded once per session (latest snapshot
  // replaces earlier ones) so nothing is summed twice.
  private sessionUsage(sid: string, m: Extract<SDKMessage, { type: "result" }>) {
    const mu = m.modelUsage ?? {};
    const models = Object.keys(mu);
    if (models.length === 0) return;
    let input = 0, output = 0, cr = 0, cc = 0;
    for (const u of Object.values(mu)) { input += u.inputTokens; output += u.outputTokens; cr += u.cacheReadInputTokens; cc += u.cacheCreationInputTokens; }
    const run = this.runs.get(sid);
    // Each resume starts a new process with its own counters; earlier attempts are kept separately.
    const id = `sdk:${sid}:${run?.attemptId ?? "x"}`;
    const basis = [...new Set(Object.values(mu).map((u) => u.costBasis ?? "unknown"))].join(", ");
    this.store.putUsage({
      id, sessionId: sid, agentId: null, source: "sdk-result",
      sourceNote: "Reported by the Claude Agent SDK result message for this runtime process (includes its subagents)",
      model: models.join(", "), inputTokens: input, outputTokens: output, cacheReadTokens: cr, cacheCreationTokens: cc,
      totalTokens: input + output + cr + cc,
      costEstimateUsd: m.total_cost_usd ?? null,
      costBasis: `SDK-computed API-equivalent estimate (price table: ${basis})${this.cfg.billingMode === "subscription" ? "; not a subscription charge" : ""}`,
      includedInParent: false, measuredAt: Date.now(),
    });
  }

  private taskUsage(sid: string, aid: string, u: { total_tokens: number; tool_uses: number; duration_ms: number }) {
    this.store.putUsage({
      id: `task:${aid}`, sessionId: sid, agentId: aid, source: "sdk-task",
      sourceNote: `Worker total reported by the SDK (${u.tool_uses} tool uses, ${Math.round(u.duration_ms / 1000)}s). Already included in the session total.`,
      model: this.store.agents.get(aid)?.model ?? null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
      totalTokens: u.total_tokens, costEstimateUsd: null, costBasis: null, includedInParent: true, measuredAt: Date.now(),
    });
  }

  private createReview(sid: string, lead: string, text: string, files: string[]) {
    const s = this.store.sessions.get(sid)!;
    for (const i of this.store.interactions.values()) {
      if (i.sessionId === sid && i.kind === "review" && i.status === "pending") this.store.transition(i.id, ["pending"], "cancelled", { statusDetail: "Superseded by a newer turn" });
    }
    const now = Date.now();
    this.store.putInteraction({
      id: randomUUID(), sessionId: sid, agentId: lead, projectId: s.projectId, kind: "review", status: "pending",
      statusDetail: null, interactive: true, toolUseId: null, createdAt: now, updatedAt: now, expiresAt: null,
      request: {
        type: "review", resultText: shortText(text, 8000), changedFiles: files, turnOk: true,
        note: "Accept records your review decision only. It does not merge, commit or publish anything. Request changes sends your message to the agent as a new instruction.",
      },
      response: null,
    });
  }

  // ---- interactions ----
  private canUseTool(sid: string): CanUseTool {
    return async (toolName, input, opts) => {
      const now = Date.now();
      const aid = (opts.agentID && this.taskToAgent.get(opts.agentID)) || (opts.agentID ? this.agentFor(sid, opts.agentID) : this.store.agentId(sid, null));
      const s = this.store.sessions.get(sid)!;
      const isQ = toolName === "AskUserQuestion";
      const scopeOptions = [{ id: "once", label: "Approve once", explanation: "Allows only this exact call." }];
      const suggestions = (opts.suggestions ?? []);
      if (!opts.suppressAlwaysAllowRule) {
        suggestions.forEach((sg, n) => {
          // Only rule/directory grants scoped to this session; never mode switches or persisted settings.
          if (sg.destination !== "session" || (sg.type !== "addRules" && sg.type !== "addDirectories")) return;
          scopeOptions.push({ id: `session:${n}`, label: "Approve for this session", explanation: `Runtime-proposed rule, kept only for this session (not written to settings): ${describeUpdate(sg)}` });
        });
      }
      const request = isQ
        ? { type: "question" as const, questions: (input.questions ?? []) as QuestionItem[], allowFreeText: true }
        : {
          type: "permission" as const, toolName, title: opts.title ?? null, displayName: opts.displayName ?? null,
          description: opts.description ?? null, decisionReason: opts.decisionReason ?? null, blockedPath: opts.blockedPath ?? null,
          command: typeof input.command === "string" ? input.command : null,
          filePath: typeof input.file_path === "string" ? input.file_path : null,
          cwd: s.cwd, input: sanitize(input), scopeOptions,
        } satisfies PermissionRequestPayload;
      const i: Interaction = {
        id: randomUUID(), sessionId: sid, agentId: aid, projectId: s.projectId, kind: isQ ? "question" : "permission",
        status: "pending", statusDetail: null, interactive: true, toolUseId: opts.toolUseID ?? null,
        createdAt: now, updatedAt: now, expiresAt: null, request, response: null, clientRequestId: null,
      };
      this.store.putInteraction(i);
      this.store.patchAgent(aid, { status: "waiting", currentAction: isQ ? "Waiting for your answer" : `Waiting for permission: ${describeTool(toolName, input)}`, currentActionAt: now }, now);
      this.store.patchSession(sid, { runtimeState: "waiting" });
      this.ev(sid, aid, isQ ? "question" : "permission_request", isQ ? `Asked: ${shortText((request as any).questions?.[0]?.question, 160)}` : `Permission requested: ${describeTool(toolName, input)}`, "pending", false, undefined, toolName, opts.toolUseID);
      return new Promise<PermissionResult>((resolvePromise) => {
        this.pending.set(i.id, { resolve: resolvePromise, input, suggestions });
        opts.signal.addEventListener("abort", () => {
          if (!this.pending.has(i.id)) return;
          this.pending.delete(i.id);
          this.store.transition(i.id, ["pending", "delivering"], "cancelled", { statusDetail: "The runtime cancelled this request" });
          resolvePromise({ behavior: "deny", message: "Request cancelled" });
        });
      });
    };
  }

  respond(id: string, response: InteractionResponse, clientRequestId: string | undefined): Interaction {
    const i = this.store.interactions.get(id);
    if (!i) throw new ApiError(404, "interaction not found");
    if (clientRequestId && i.clientRequestId === clientRequestId && i.status !== "pending") return i; // idempotent retry
    if (!i.interactive) throw new ApiError(409, "This request can only be answered in the original session");
    if (i.status !== "pending") throw new ApiError(409, `Request is already ${i.status}`);
    if (response?.type !== i.kind) throw new ApiError(400, `response type must be ${i.kind}`);

    if (i.kind === "review") return this.respondReview(i, response as Extract<InteractionResponse, { type: "review" }>, clientRequestId);

    const result = this.buildResult(i, response);
    const claimed = this.store.transition(id, ["pending"], "delivering", { response: sanitize(response), clientRequestId: clientRequestId ?? null });
    if (!claimed) throw new ApiError(409, "Request was answered concurrently");
    const p = this.pending.get(id);
    if (!p) {
      return this.store.transition(id, ["delivering"], "failed", { statusDetail: "The runtime request no longer exists (session ended or backend restarted)" })!;
    }
    this.pending.delete(id);
    p.resolve(result(p));
    const agentNow = Date.now();
    this.store.patchAgent(i.agentId, { status: "working", currentAction: "Response delivered; waiting for the agent to continue", currentActionAt: agentNow }, agentNow);
    this.store.patchSession(i.sessionId, { runtimeState: "running" });
    const label = response.type === "permission" ? (response.decision === "approve" ? `Approved (${response.scope ?? "once"})` : "Denied") : "Answered";
    this.ev(i.sessionId, i.agentId, "interaction_answered", `${label} from browser: ${i.kind}`, "info", true);
    return this.store.transition(id, ["delivering"], "delivered", { statusDetail: "Handed to the runtime; waiting for the agent to continue" })!;
  }

  private buildResult(i: Interaction, response: InteractionResponse): (p: Pending) => PermissionResult {
    if (response.type === "question" && i.request.type === "question") {
      const qs = i.request.questions;
      const answers: Record<string, string | string[]> = {};
      for (const q of qs) {
        const a = response.answers?.[q.question];
        const empty = a === undefined || (Array.isArray(a) ? a.length === 0 || a.some((x) => !String(x).trim()) : !String(a).trim());
        if (empty) throw new ApiError(400, `An answer is required for: ${q.question}`);
        if (Array.isArray(a) && !q.multiSelect && a.length > 1) throw new ApiError(400, `Only one answer is allowed for: ${q.question}`);
        answers[q.question] = Array.isArray(a) ? a.map(String) : String(a);
      }
      return (p) => ({ behavior: "allow", updatedInput: { ...p.input, questions: qs, answers } });
    }
    if (response.type === "permission" && i.request.type === "permission") {
      if (response.decision === "deny") {
        const msg = response.message?.trim() ? `The user denied this action: ${response.message.trim()}` : "The user denied this action from Agent Monitor.";
        return () => ({ behavior: "deny", message: msg });
      }
      if (response.decision !== "approve") throw new ApiError(400, "decision must be approve or deny");
      const scope = response.scope ?? "once";
      if (!i.request.scopeOptions.some((o) => o.id === scope)) throw new ApiError(400, `scope ${scope} is not offered for this request`);
      return (p) => {
        const n = scope.startsWith("session:") ? Number(scope.slice(8)) : -1;
        const upd = n >= 0 && p.suggestions[n] ? [p.suggestions[n]] : undefined;
        return { behavior: "allow", updatedInput: p.input, ...(upd ? { updatedPermissions: upd } : {}) };
      };
    }
    throw new ApiError(400, "invalid response");
  }

  private respondReview(i: Interaction, r: Extract<InteractionResponse, { type: "review" }>, clientRequestId: string | undefined): Interaction {
    if (r.decision === "request_changes") {
      if (!r.message?.trim()) throw new ApiError(400, "Describe the changes you want");
      if (!this.store.transition(i.id, ["pending"], "delivering", { response: sanitize(r), clientRequestId: clientRequestId ?? null })) throw new ApiError(409, "Already decided");
      try {
        this.sendMessage(i.sessionId, r.message.trim());
      } catch (e) {
        return this.store.transition(i.id, ["delivering"], "failed", { statusDetail: `Could not send to the agent: ${(e as Error).message}`, response: null })!;
      }
      this.ev(i.sessionId, i.agentId, "review_decision", "Review: changes requested (sent to agent)", "info", true);
      return this.store.transition(i.id, ["delivering"], "delivered", { statusDetail: "Change request sent to the agent as a new message" })!;
    }
    if (r.decision !== "accept") throw new ApiError(400, "decision must be accept or request_changes");
    const out = this.store.transition(i.id, ["pending"], "decided", { response: sanitize(r), clientRequestId: clientRequestId ?? null, statusDetail: "Accepted by you. Nothing was merged or published." });
    if (!out) throw new ApiError(409, "Already decided");
    const a = this.store.agents.get(i.agentId);
    if (a?.lastResult) this.store.patchAgent(a.id, { lastResult: { ...a.lastResult, provenance: "user-checked", ok: true } });
    this.ev(i.sessionId, i.agentId, "review_decision", "Review: deliverable accepted by user", "ok", true);
    return out;
  }

  private ev(sid: string, aid: string, kind: string, summary: string, status: "ok" | "error" | "info" | "pending", milestone = false, detail?: unknown, toolName?: string, toolUseId?: string) {
    this.store.addEvent({ dedupeKey: `m:${sid}:${Date.now()}:${++this.seq}`, sessionId: sid, agentId: aid, ts: Date.now(), kind, summary, status, milestone, detail, toolName, toolUseId });
  }
}

function describeUpdate(u: PermissionUpdate): string {
  if (u.type === "addRules" || u.type === "replaceRules") return `${u.behavior} ${u.rules.map((r) => r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName).join(", ")}`;
  if (u.type === "addDirectories") return `add directories ${u.directories.join(", ")}`;
  if (u.type === "setMode") return `switch permission mode to ${u.mode}`;
  return u.type;
}
