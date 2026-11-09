import { createHash, randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { NormEvent, Store } from "./store.ts";
import type { Agent, QuestionItem, Session } from "../shared/types.ts";
import { applyPlanTool, changedFile, describeTool, isTestCommand, noteChangedFile, shortText } from "./activity.ts";
import { estimateCost, readTranscriptUsage } from "./usage.ts";
import { sanitize } from "./redact.ts";

// Observation adapter for Claude Code sessions started elsewhere (VS Code,
// terminal). Hooks are one-way here: requests are shown read-only and must be
// answered in the original session. Hook payloads arrive asynchronously and
// may be duplicated or out of order; the forwarder stamps `ts` at fire time.

const OBSERVE_CAPS = { answerQuestions: false, approvePermissions: false, sendMessages: false, cancel: false, resume: false };

type HookPayload = Record<string, any> & { session_id: string; hook_event_name: string; cwd?: string };

export class HooksAdapter {
  private store: Store;
  private cfg: Config;
  // Agent tool calls waiting to be matched to a SubagentStart (same session).
  private pendingDelegations = new Map<string, { toolUseId: string; type: string; description: string; ts: number }[]>();

  constructor(store: Store, cfg: Config) {
    this.store = store;
    this.cfg = cfg;
  }

  // Called after a /clear wipe: forget delegations that belonged to wiped sessions.
  reset() { this.pendingDelegations.clear(); }

  ingest(body: { ts?: number; payload: HookPayload }): { accepted: boolean; duplicate?: boolean; ignored?: string } {
    const p = body.payload;
    if (!p || typeof p.session_id !== "string" || typeof p.hook_event_name !== "string") return { accepted: false };
    const ts = Number.isFinite(body.ts) ? Number(body.ts) : Date.now();
    const ev = p.hook_event_name;
    // Late or replayed hooks from before the last /clear must not bring old sessions back.
    if (ts < this.store.clearedAt) return { accepted: true, ignored: "before clear" };
    const dedupeKey = "hook:" + createHash("sha1").update(JSON.stringify([ev, p.session_id, p.agent_id ?? "", p.tool_use_id ?? "", ts, p.prompt_id ?? ""])).digest("hex");
    if (this.store.hasEvent(dedupeKey)) return { accepted: true, duplicate: true };

    const session = this.ensureSession(p, ts);
    const agentRuntimeId: string | null = p.agent_id ?? null;
    const agent = this.store.ensureAgent(session.id, agentRuntimeId, { ts, role: p.agent_type ?? (agentRuntimeId ? "subagent" : "lead"), name: p.agent_type ?? (agentRuntimeId ? "worker" : "lead") });
    const base = { dedupeKey, sessionId: session.id, agentId: agent.id, ts };
    const add = (e: Omit<NormEvent, "dedupeKey" | "sessionId" | "agentId" | "ts">) => this.store.addEvent({ ...base, ...e });
    this.store.setServer({ hooksEventsReceived: this.store.server.hooksEventsReceived + 1, lastHookEventAt: Date.now() });

    const toolName: string | undefined = p.tool_name;
    const input = (p.tool_input ?? {}) as Record<string, unknown>;
    const toolUseId: string | null = p.tool_use_id ?? null;

    switch (ev) {
      case "SessionStart": {
        if (p.model) this.store.patchSession(session.id, { model: String(p.model) });
        if (p.model) this.store.patchAgent(agent.id, { model: String(p.model), modelSource: "SessionStart hook" });
        this.store.patchSession(session.id, { runtimeState: "running", endedAt: null });
        add({ kind: "session_start", summary: `Session ${p.source ?? "started"} (observed via hooks)`, status: "info", milestone: true });
        break;
      }
      case "UserPromptSubmit": {
        this.store.patchAgent(agent.id, { status: "working", assignedTask: shortText(p.prompt, 300) || agent.assignedTask, currentAction: "Working on prompt", currentActionAt: ts, endedAt: null }, ts);
        this.store.patchSession(session.id, { runtimeState: "running", endedAt: null });
        add({ kind: "prompt", summary: "User prompt submitted", status: "info", detail: { prompt: p.prompt } });
        break;
      }
      case "PreToolUse": {
        if (!toolName) break;
        if (this.store.hasEvent(`hook-post:${session.id}:${toolUseId}`)) {
          add({ kind: "tool_start", toolName, toolUseId, summary: describeTool(toolName, input), status: "info", detail: { input } });
          break; // arrived after its own completion; don't regress state
        }
        this.store.patchAgent(agent.id, { status: toolName === "AskUserQuestion" ? "waiting" : "working", currentAction: describeTool(toolName, input), currentActionAt: ts }, ts);
        if (toolName === "Agent" || toolName === "Task") {
          const list = this.pendingDelegations.get(session.id) ?? [];
          list.push({ toolUseId: toolUseId ?? "", type: String(input.subagent_type ?? "general-purpose"), description: shortText(input.description ?? input.prompt, 300), ts });
          this.pendingDelegations.set(session.id, list);
        }
        if (toolName === "AskUserQuestion" && Array.isArray(input.questions)) {
          this.readOnlyInteraction(session, agent, toolUseId, ts, {
            type: "question", questions: input.questions as QuestionItem[], allowFreeText: true,
          });
        }
        add({ kind: "tool_start", toolName, toolUseId, summary: describeTool(toolName, input), status: "pending", detail: { input } });
        break;
      }
      case "PermissionRequest": {
        this.store.patchAgent(agent.id, { status: "waiting", currentAction: `Waiting for permission: ${describeTool(toolName ?? "tool", input)}`, currentActionAt: ts }, ts);
        this.store.patchSession(session.id, { runtimeState: "waiting" });
        this.readOnlyInteraction(session, agent, toolUseId, ts, {
          type: "permission", toolName: toolName ?? "unknown", title: null, displayName: null, description: null,
          decisionReason: null, blockedPath: null,
          command: typeof input.command === "string" ? input.command : null,
          filePath: typeof input.file_path === "string" ? input.file_path : null,
          cwd: p.cwd ?? session.cwd, input: sanitize(input), scopeOptions: [],
        });
        add({ kind: "permission_request", toolName, toolUseId, summary: `Permission requested in session: ${describeTool(toolName ?? "tool", input)}`, status: "pending" });
        break;
      }
      case "PostToolUse":
      case "PostToolUseFailure": {
        if (!toolName) break;
        this.store.addEvent({ ...base, dedupeKey: `hook-post:${session.id}:${toolUseId}`, kind: "marker", summary: "", status: "info" });
        const resp = p.tool_response as Record<string, any> | undefined;
        const exit = typeof resp?.exitCode === "number" ? resp.exitCode : typeof resp?.exit_code === "number" ? resp.exit_code : null;
        const failed = ev === "PostToolUseFailure" || (exit !== null && exit !== 0) || resp?.interrupted === true;
        this.resolveElsewhere(session.id, toolUseId, failed ? "Tool call failed or was rejected in the session" : "Answered in the original session");
        const test = isTestCommand(toolName, input);
        const what = describeTool(toolName, input);
        const err = failed ? shortText(p.error ?? resp?.stderr ?? "failed", 300) : null;
        const patch: Partial<Agent> = { status: "working", currentAction: what, currentActionAt: ts };
        if (failed) {
          patch.errorCount = agent.errorCount + 1;
          patch.lastResult = { text: `${what} failed${exit !== null ? ` (exit ${exit})` : ""}: ${err}`, provenance: "runtime", ok: false, at: ts };
        } else if (test) {
          patch.lastResult = { text: `${what} exited successfully`, provenance: "runtime", ok: true, at: ts };
        }
        this.store.patchAgent(agent.id, patch, ts);
        if (this.store.sessions.get(session.id)?.runtimeState === "waiting") this.store.patchSession(session.id, { runtimeState: "running" });
        if (!failed) {
          const f = changedFile(toolName, input);
          if (f) noteChangedFile(this.store, agent.id, f);
          applyPlanTool(this.store, agent.id, toolName, input, resp, ts);
        }
        add({
          kind: failed ? "tool_fail" : "tool_end", toolName, toolUseId,
          summary: test ? `Test command ${failed ? "FAILED" : "passed"} (runtime exit status): ${what}` : failed ? `Failed: ${what}${err ? " — " + err : ""}` : what,
          status: failed ? "error" : "ok",
          milestone: test || (failed && (toolName === "Bash" || toolName === "PowerShell")),
          detail: { input, response: resp, error: p.error },
        });
        break;
      }
      case "PermissionDenied": {
        this.resolveElsewhere(session.id, toolUseId, "Denied by the runtime");
        add({ kind: "permission_denied", toolName, toolUseId, summary: `Permission denied by runtime: ${describeTool(toolName ?? "tool", input)}`, status: "error", milestone: true, detail: { reason: p.reason } });
        break;
      }
      case "Notification": {
        const type = String(p.notification_type ?? "");
        if (type === "idle_prompt") this.store.patchAgent(agent.id, { status: "idle", currentAction: "Waiting for your next prompt in the session", currentActionAt: ts }, ts);
        add({ kind: "notification", summary: shortText(p.message ?? type, 200), status: "info", detail: { type, title: p.title } });
        break;
      }
      case "SubagentStart": {
        const list = this.pendingDelegations.get(session.id) ?? [];
        const idx = list.findIndex((d) => d.type === p.agent_type);
        const d = idx >= 0 ? list.splice(idx, 1)[0] : list.shift();
        this.store.patchAgent(agent.id, {
          name: String(p.agent_type ?? "worker"), role: String(p.agent_type ?? "subagent"),
          assignedTask: d?.description ?? agent.assignedTask, status: "working",
          currentAction: "Starting", currentActionAt: ts,
        }, ts);
        add({ kind: "subagent_start", summary: `Task assigned to ${p.agent_type ?? "worker"}: ${d?.description ?? "(description not observed)"}`, status: "info", milestone: true });
        break;
      }
      case "SubagentStop": {
        const text = shortText(p.last_assistant_message ?? "", 500);
        this.store.patchAgent(agent.id, {
          status: "completed", endedAt: ts, currentAction: "Run finished", currentActionAt: ts,
          lastResult: text ? { text, provenance: "agent-reported", ok: null, at: ts } : agent.lastResult,
        }, ts);
        add({ kind: "subagent_stop", summary: `${agent.name} finished its run${text ? ": " + text : ""} (agent-reported; not independently checked)`, status: "info", milestone: true });
        if (p.agent_transcript_path) void this.updateUsage(session.id, agent.id, String(p.agent_transcript_path), false);
        break;
      }
      case "Stop": {
        const text = shortText(p.last_assistant_message ?? "", 500);
        this.store.patchAgent(agent.id, {
          status: "idle", currentAction: "Turn ended; waiting for next prompt", currentActionAt: ts,
          lastResult: text ? { text, provenance: "agent-reported", ok: null, at: ts } : agent.lastResult,
        }, ts);
        this.store.patchSession(session.id, { runtimeState: "idle" });
        add({ kind: "turn_end", summary: `Lead turn ended${text ? ": " + text : ""}`, status: "info", milestone: true });
        if (p.transcript_path) void this.updateUsage(session.id, agent.id, String(p.transcript_path), true);
        break;
      }
      case "StopFailure": {
        this.store.patchAgent(agent.id, { status: "failed", lastResult: { text: `Turn failed: ${shortText(p.error ?? p.reason ?? "unknown error", 300)}`, provenance: "runtime", ok: false, at: ts } }, ts);
        add({ kind: "turn_error", summary: `Turn failed: ${shortText(p.error ?? p.reason ?? "unknown error", 200)}`, status: "error", milestone: true, detail: p });
        break;
      }
      case "SessionEnd": {
        this.store.patchSession(session.id, { runtimeState: "ended", endedAt: ts });
        for (const a of this.store.agents.values()) {
          if (a.sessionId !== session.id || a.status === "failed" || a.status === "completed") continue;
          this.store.patchAgent(a.id, { status: "completed", endedAt: ts, currentAction: "Session ended", currentActionAt: ts }, ts);
        }
        for (const i of this.store.interactions.values()) {
          if (i.sessionId === session.id && i.status === "pending") this.store.transition(i.id, ["pending"], "cancelled", { statusDetail: "Session ended" });
        }
        add({ kind: "session_end", summary: `Session ended (${p.reason ?? "unknown reason"})`, status: "info", milestone: true });
        if (p.transcript_path) void this.updateUsage(session.id, this.store.agentId(session.id, null), String(p.transcript_path), true);
        break;
      }
      case "TaskCompleted":
        add({ kind: "task_completed", summary: `Task completed: ${shortText(p.task_subject ?? p.task_id ?? "", 200)} (agent-reported)`, status: "ok", milestone: true, detail: p });
        break;
      default:
        add({ kind: ev.toLowerCase(), summary: ev, status: "info" });
    }
    return { accepted: true };
  }

  private ensureSession(p: HookPayload, ts: number): Session {
    const id = `hooks:${p.session_id}`;
    let s = this.store.sessions.get(id);
    if (!s) {
      const cwd = String(p.cwd ?? "unknown");
      const project = this.store.projectFor(cwd);
      s = {
        id, projectId: project.id, source: "vscode-hooks", runtimeSessionId: p.session_id,
        title: `${project.name} — Claude Code session`, cwd, model: null, authSource: null, billingMode: null,
        runtimeState: "running", runtimeStateDetail: "Observed via hooks; interaction happens in the original session",
        permissionMode: p.permission_mode ?? null, startedAt: ts, lastEventAt: ts, endedAt: null,
        capabilities: OBSERVE_CAPS, claudeCodeVersion: null,
      };
      this.store.putSession(s);
    } else if (p.permission_mode && p.permission_mode !== s.permissionMode) {
      this.store.patchSession(id, { permissionMode: p.permission_mode });
    }
    return s;
  }

  private readOnlyInteraction(session: Session, agent: Agent, toolUseId: string | null, ts: number, request: any) {
    if (toolUseId && this.store.interactionByToolUse(session.id, toolUseId)) return;
    this.store.putInteraction({
      id: randomUUID(), sessionId: session.id, agentId: agent.id, projectId: session.projectId,
      kind: request.type, status: "pending", statusDetail: "Answer this in the original Claude Code session (VS Code). Hooks cannot deliver a response.",
      interactive: false, toolUseId, createdAt: ts, updatedAt: ts, expiresAt: null, request, response: null,
    });
  }

  private resolveElsewhere(sessionId: string, toolUseId: string | null, detail: string) {
    if (!toolUseId) return;
    const i = this.store.interactionByToolUse(sessionId, toolUseId);
    if (i) this.store.transition(i.id, ["pending"], "answered_elsewhere", { statusDetail: detail });
  }

  private async updateUsage(sessionId: string, agentId: string, path: string, isLead: boolean) {
    if (!this.cfg.readTranscriptUsage) return;
    const r = await readTranscriptUsage(path, isLead);
    if (!r) return;
    const cost = estimateCost(this.cfg, r.perModel);
    this.store.putUsage({
      id: `transcript:${agentId}`, sessionId, agentId, source: "transcript",
      sourceNote: "Summed from the Claude Code transcript file (undocumented format; may change between versions)",
      model: r.totals.models.join(", ") || null,
      inputTokens: r.totals.inputTokens, outputTokens: r.totals.outputTokens,
      cacheReadTokens: r.totals.cacheReadTokens, cacheCreationTokens: r.totals.cacheCreationTokens,
      totalTokens: r.totals.inputTokens + r.totals.outputTokens + r.totals.cacheReadTokens + r.totals.cacheCreationTokens,
      costEstimateUsd: cost.usd, costBasis: cost.basis, includedInParent: false, measuredAt: Date.now(),
    });
    const a = this.store.agents.get(agentId);
    if (a && r.lastModel && a.modelSource !== "SessionStart hook") this.store.patchAgent(agentId, { model: r.lastModel, modelSource: "transcript" });
    if (isLead && r.lastModel) this.store.patchSession(sessionId, { model: r.lastModel });
  }
}
