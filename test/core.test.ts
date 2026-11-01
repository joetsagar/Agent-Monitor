// Backend logic tests. No model calls: the SDK callback is invoked directly
// and runtime messages are fed to the adapter as the SDK would emit them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { HooksAdapter } from "../server/hooks-adapter.ts";
import { ManagedAdapter, ApiError } from "../server/managed-adapter.ts";
import { redact } from "../server/redact.ts";
import type { Config } from "../server/config.ts";
import type { Session } from "../shared/types.ts";

function setup(dir = mkdtempSync(join(tmpdir(), "am-test-"))) {
  const cfg: Config = {
    host: "127.0.0.1", port: 0, dataDir: dir, billingMode: "subscription", defaultModel: "haiku",
    allowedRoots: [tmpdir()], staleAfterMs: 60_000, readTranscriptUsage: false,
    pricing: { asOf: null, note: "", models: {} },
  };
  const store = new Store(openDb(dir), {
    startedAt: Date.now(), version: "t", billingMode: "subscription", managedSessionsEnabled: true,
    hooksEventsReceived: 0, lastHookEventAt: null, staleAfterMs: 60_000, aiSummaries: false,
  });
  return { dir, cfg, store, hooks: new HooksAdapter(store, cfg), managed: new ManagedAdapter(store, cfg) };
}

const hook = (ev: string, extra: Record<string, unknown> = {}, ts = Date.now()) =>
  ({ ts, payload: { session_id: "S1", hook_event_name: ev, cwd: tmpdir(), ...extra } });

// Creates a managed session record without spawning a runtime.
function fakeManaged(store: Store, managed: ManagedAdapter) {
  const p = store.projectFor(tmpdir());
  const s: Session = {
    id: "m_test", projectId: p.id, source: "managed", runtimeSessionId: "R1", title: "t", cwd: tmpdir(),
    model: null, authSource: "none", billingMode: "subscription", runtimeState: "running", runtimeStateDetail: null,
    permissionMode: "default", startedAt: Date.now(), lastEventAt: Date.now(), endedAt: null,
    capabilities: { answerQuestions: true, approvePermissions: true, sendMessages: true, cancel: true, resume: true }, claudeCodeVersion: null,
  };
  store.putSession(s);
  store.ensureAgent(s.id, null, { ts: Date.now(), name: "lead", role: "lead" });
  const run = { sessionId: s.id, turnChangedFiles: new Set(), turnCount: 0, attemptId: "a" };
  const m = managed as any;
  return {
    s,
    ask: (tool: string, input: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
      m.canUseTool(s.id)(tool, input, { signal: new AbortController().signal, toolUseID: "tu_" + Math.random(), ...opts }),
    feed: (msg: unknown) => m.onMessage(run, msg),
  };
}

test("duplicate hook deliveries are stored once", () => {
  const { store, hooks } = setup();
  const e = hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" }, 1000);
  hooks.ingest(e);
  assert.equal(hooks.ingest(e).duplicate, true);
  assert.equal(store.eventsForAgent("hooks:S1/lead").filter((x) => x.kind === "tool_start").length, 1);
});

test("out-of-order: a late PreToolUse does not regress the current action", () => {
  const { store, hooks } = setup();
  hooks.ingest(hook("PostToolUse", { tool_name: "Read", tool_input: { file_path: "b.ts" }, tool_use_id: "t2" }, 2000));
  hooks.ingest(hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "old" }, tool_use_id: "t1" }, 1000));
  hooks.ingest(hook("PreToolUse", { tool_name: "Read", tool_input: { file_path: "b.ts" }, tool_use_id: "t2" }, 1900));
  const a = store.agents.get("hooks:S1/lead")!;
  assert.equal(a.currentAction, "Read b.ts");
  assert.equal(a.lastActivityAt, 2000);
});

test("failed commands remain failed; later successes do not mark them ok", () => {
  const { store, hooks } = setup();
  hooks.ingest(hook("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "t1", error: "Exit code 1" }, 1000));
  hooks.ingest(hook("PostToolUse", { tool_name: "Read", tool_input: { file_path: "x" }, tool_use_id: "t2" }, 2000));
  const a = store.agents.get("hooks:S1/lead")!;
  assert.equal(a.lastResult?.ok, false);
  assert.equal(a.errorCount, 1);
  const ms = store.milestones().find((m) => m.toolUseId === "t1")!;
  assert.match(ms.summary, /FAILED/);
  assert.equal(ms.status, "error");
});

test("missing usage and model remain Unknown (null)", () => {
  const { store, hooks } = setup();
  hooks.ingest(hook("SessionStart", { source: "startup" }));
  hooks.ingest(hook("Stop", { last_assistant_message: "done" }));
  assert.equal(store.agents.get("hooks:S1/lead")!.model, null);
  assert.equal(store.usage.size, 0);
});

test("subtask progress only exists when the agent defined subtasks", () => {
  const { store, hooks } = setup();
  hooks.ingest(hook("UserPromptSubmit", { prompt: "go" }, 1000));
  assert.equal(store.agents.get("hooks:S1/lead")!.subtasks, null);
  hooks.ingest(hook("PostToolUse", { tool_name: "TodoWrite", tool_use_id: "t", tool_input: { todos: [
    { content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }] } }, 2000));
  assert.deepEqual(store.agents.get("hooks:S1/lead")!.subtasks, { total: 3, completed: 1, inProgress: 1, source: "TodoWrite" });
});

test("VS Code requests are read-only and resolve as answered elsewhere", () => {
  const { store, hooks, managed } = setup();
  hooks.ingest(hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm x" }, tool_use_id: "t9" }, 1000));
  const i = [...store.interactions.values()][0];
  assert.equal(i.interactive, false);
  assert.throws(() => managed.respond(i.id, { type: "permission", decision: "approve" }, "c"), (e: ApiError) => e.status === 409);
  hooks.ingest(hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "rm x" }, tool_use_id: "t9" }, 2000));
  assert.equal(store.interactions.get(i.id)!.status, "answered_elsewhere");
});

test("subagent attribution via hooks links the delegation description", () => {
  const { store, hooks } = setup();
  hooks.ingest(hook("PreToolUse", { tool_name: "Agent", tool_input: { subagent_type: "Explore", description: "Find config" }, tool_use_id: "ta" }, 1000));
  hooks.ingest(hook("SubagentStart", { agent_id: "w1", agent_type: "Explore" }, 1100));
  hooks.ingest(hook("PreToolUse", { agent_id: "w1", agent_type: "Explore", tool_name: "Grep", tool_input: { pattern: "port" }, tool_use_id: "tg" }, 1200));
  const w = store.agents.get("hooks:S1/w1")!;
  assert.equal(w.parentAgentId, "hooks:S1/lead");
  assert.equal(w.assignedTask, "Find config");
  assert.equal(w.currentAction, "Grep port");
});

test("question: delivered on respond, resumed only after the runtime continues", async () => {
  const { store, managed } = setup();
  const f = fakeManaged(store, managed);
  const questions = [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiSelect: false }];
  const pending = f.ask("AskUserQuestion", { questions }, { toolUseID: "tq" });
  const i = [...store.interactions.values()].find((x) => x.kind === "question")!;
  assert.equal(store.agents.get(i.agentId)!.status, "waiting");
  assert.throws(() => managed.respond(i.id, { type: "question", answers: {} }, "c0"), (e: ApiError) => e.status === 400);
  assert.equal(store.interactions.get(i.id)!.status, "pending", "validation failure leaves request answerable");
  assert.throws(() => managed.respond(i.id, { type: "question", answers: { "Which?": ["A", "B"] } }, "c0"), (e: ApiError) => e.status === 400);
  const out = managed.respond(i.id, { type: "question", answers: { "Which?": "B" } }, "c1");
  assert.equal(out.status, "delivered");
  const result = await pending;
  assert.deepEqual(result, { behavior: "allow", updatedInput: { questions, answers: { "Which?": "B" } } });
  assert.throws(() => managed.respond(i.id, { type: "question", answers: { "Which?": "A" } }, "c2"), (e: ApiError) => e.status === 409);
  assert.equal(managed.respond(i.id, { type: "question", answers: { "Which?": "B" } }, "c1").status, "delivered", "same clientRequestId retry is idempotent");
  f.feed({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tq", content: "ok" }] } });
  assert.equal(store.interactions.get(i.id)!.status, "resumed");
});

test("permission approve and deny are handled separately", async () => {
  const { store, managed } = setup();
  const f = fakeManaged(store, managed);
  const sugg = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "session" },
    { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "localSettings" },
    { type: "setMode", mode: "acceptEdits", destination: "session" }];
  const p1 = f.ask("Bash", { command: "npm test" }, { toolUseID: "tb1", suggestions: sugg });
  const i1 = [...store.interactions.values()].find((x) => x.toolUseId === "tb1")!;
  assert.deepEqual((i1.request as any).scopeOptions.map((o: any) => o.id), ["once", "session:0"], "no persisted or mode-switch scopes offered");
  assert.throws(() => managed.respond(i1.id, { type: "permission", decision: "approve", scope: "session:1" }, "x"), (e: ApiError) => e.status === 400);
  managed.respond(i1.id, { type: "permission", decision: "approve", scope: "session:0" }, "a");
  const r1: any = await p1;
  assert.equal(r1.behavior, "allow");
  assert.deepEqual(r1.updatedPermissions, [sugg[0]]);

  const p2 = f.ask("Bash", { command: "rm -rf build" }, { toolUseID: "tb2", suggestions: sugg, suppressAlwaysAllowRule: true });
  const i2 = [...store.interactions.values()].find((x) => x.toolUseId === "tb2")!;
  assert.deepEqual((i2.request as any).scopeOptions.map((o: any) => o.id), ["once"]);
  managed.respond(i2.id, { type: "permission", decision: "deny", message: "not now" }, "d");
  assert.deepEqual(await p2, { behavior: "deny", message: "The user denied this action: not now" });
  f.feed({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tb2", is_error: true, content: "denied" }] } });
  assert.equal(store.interactions.get(i2.id)!.status, "resumed");
  assert.match(store.interactions.get(i2.id)!.statusDetail!, /denial/);
});

test("backend restart expires pending runtime requests; responses are rejected", () => {
  const { dir, store, managed } = setup();
  const f = fakeManaged(store, managed);
  void f.ask("Bash", { command: "ls" }, { toolUseID: "tr" });
  const id = [...store.interactions.values()][0].id;
  const after = setup(dir); // new process: same DB, no live callbacks
  after.managed.reconcileOnStartup();
  assert.equal(after.store.interactions.get(id)!.status, "expired");
  assert.equal(after.store.sessions.get("m_test")!.runtimeState, "interrupted");
  assert.throws(() => after.managed.respond(id, { type: "permission", decision: "approve" }, "z"), (e: ApiError) => e.status === 409);
});

test("delivery fails visibly when the runtime callback is gone", () => {
  const { store, managed } = setup();
  const f = fakeManaged(store, managed);
  void f.ask("Bash", { command: "ls" }, { toolUseID: "tg" });
  const id = [...store.interactions.values()][0].id;
  (managed as any).pending.clear();
  assert.equal(managed.respond(id, { type: "permission", decision: "approve" }, "q").status, "failed");
});

test("worker usage reported by the SDK is marked as included in the session total", () => {
  const { store, managed } = setup();
  const f = fakeManaged(store, managed);
  f.feed({ type: "system", subtype: "task_started", task_id: "k1", tool_use_id: "ta", description: "sub", subagent_type: "Explore" });
  f.feed({ type: "system", subtype: "task_notification", task_id: "k1", tool_use_id: "ta", status: "completed", summary: "done", output_file: "", usage: { total_tokens: 500, tool_uses: 2, duration_ms: 1000 } });
  const u = [...store.usage.values()].find((x) => x.source === "sdk-task")!;
  assert.equal(u.includedInParent, true);
  assert.equal(store.agents.get("m_test/ta")!.status, "completed");
  assert.equal(store.agents.get("m_test/ta")!.lastResult!.provenance, "agent-reported");
});

test("review accept records a decision only; nothing is sent to the runtime", () => {
  const { store, managed } = setup();
  const f = fakeManaged(store, managed);
  f.feed({ type: "result", subtype: "success", is_error: false, result: "Implemented X", num_turns: 1, total_cost_usd: 0.01, usage: {}, modelUsage: {} });
  const r = [...store.interactions.values()].find((x) => x.kind === "review")!;
  const out = managed.respond(r.id, { type: "review", decision: "accept" }, "r1");
  assert.equal(out.status, "decided");
  assert.match(out.statusDetail!, /Nothing was merged or published/);
  assert.equal(store.agents.get("m_test/lead")!.lastResult!.provenance, "user-checked");
});

test("redaction removes common secret formats", () => {
  const out = redact({ cmd: "curl -H 'Authorization: Bearer abc.def' sk-ant-api03-AAAAAAAAAAAAAAAA", password: "hunter2", nested: ["ghp_aaaaaaaaaaaaaaaaaaaaaaaa"] });
  const s = JSON.stringify(out);
  assert.ok(!s.includes("hunter2") && !s.includes("AAAAAAAAAAAAAAAA") && !s.includes("ghp_aaaa") && !s.includes("abc.def"), s);
});
