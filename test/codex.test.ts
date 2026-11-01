import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../server/codex-adapter.ts";
import { Store } from "../server/store.ts";
import { openDb } from "../server/db.ts";
import type { Config } from "../server/config.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "am-codex-"));
  const logs = join(dir, "sessions"); mkdirSync(logs);
  const cfg: Config = { host: "127.0.0.1", port: 0, dataDir: dir, billingMode: "subscription", defaultModel: "sonnet", allowedRoots: [dir], staleAfterMs: 60_000,
    readTranscriptUsage: true, pricing: { asOf: null, note: "", models: {} }, codex: { sessionsDir: logs } };
  const db = openDb(dir);
  const store = new Store(db, { startedAt: Date.now(), version: "test", billingMode: "subscription", managedSessionsEnabled: true, hooksEventsReceived: 0, lastHookEventAt: null, staleAfterMs: 60_000, aiSummaries: false });
  const adapter = new CodexAdapter(store, cfg);
  const meta = { id: "ROOT", cwd: dir, timestamp: "2026-10-31T22:00:00Z", source: "vscode" };
  return { dir, logs, cfg, db, store, adapter, meta };
}
const row = (type: string, payload: object, n = 1) => ({ timestamp: new Date(Date.UTC(2026, 9, 31, 22, 0, n)).toISOString(), type, payload });

test("Codex lead model, live tools, turn completion, read-only capabilities and replay", () => {
  const { adapter, store, meta, db } = setup();
  const rows = [row("event_msg", { type: "task_started" }), row("turn_context", { model: "gpt-6.1-sol" }, 2),
    row("response_item", { type: "function_call", name: "exec_command", call_id: "C", arguments: JSON.stringify({ cmd: "node --test" }) }, 3),
    row("response_item", { type: "function_call_output", call_id: "C", output: JSON.stringify({ exit_code: 1, output: "not imported" }) }, 4),
    row("event_msg", { type: "task_complete", last_agent_message: "Fixed the failure" }, 5)];
  rows.forEach((r) => adapter.ingest(meta, r));
  const s = store.sessions.get("cx_ROOT")!;
  assert.equal(s.source, "codex-local"); assert.equal(s.model, "gpt-6.1-sol"); assert.equal(s.runtimeState, "idle");
  assert.ok(Object.values(s.capabilities).every((v) => v === false));
  const lead = store.agents.get("cx_ROOT/lead")!;
  assert.equal(lead.status, "idle"); assert.equal(lead.errorCount, 1);
  assert.ok(store.eventsForAgent(lead.id).some((e) => e.kind === "tool_fail"));
  const count = store.eventsForAgent(lead.id).length;
  rows.forEach((r) => adapter.ingest(meta, r));
  assert.equal(store.eventsForAgent(lead.id).length, count); assert.equal(lead.status, "idle");
  db.close();
});

test("Codex ignores reasoning, instructions, raw output, analysis messages and outside roots; redacts public text", () => {
  const { adapter, store, meta, db } = setup();
  adapter.ingest(meta, row("response_item", { type: "reasoning", summary: "PRIVATE REASONING" }));
  adapter.ingest(meta, row("response_item", { type: "message", role: "system", content: "PRIVATE INSTRUCTIONS" }));
  adapter.ingest({ ...meta, cwd: join(meta.cwd, "..", "elsewhere") }, row("event_msg", { type: "task_started" }));
  assert.equal(store.sessions.size, 0);
  adapter.ingest(meta, row("event_msg", { type: "agent_message", phase: "analysis", message: "PRIVATE ANALYSIS" }));
  adapter.ingest(meta, row("event_msg", { type: "agent_message", phase: "commentary", message: "Working with sk-ant-12345678901234567890" }, 2));
  adapter.ingest(meta, row("response_item", { type: "custom_tool_call_output", call_id: "C", output: "PRIVATE RAW OUTPUT" }, 3));
  const stored = JSON.stringify(db.prepare("SELECT data FROM entities").all()) + JSON.stringify(db.prepare("SELECT summary,detail FROM events").all());
  for (const privateText of ["PRIVATE REASONING", "PRIVATE INSTRUCTIONS", "PRIVATE ANALYSIS", "PRIVATE RAW OUTPUT", "12345678901234567890"]) assert.ok(!stored.includes(privateText));
  assert.ok(stored.includes("REDACTED"));
  db.close();
});

test("Codex child attribution and cumulative usage do not double count", () => {
  const { adapter, store, meta, db } = setup();
  adapter.ingest(meta, row("event_msg", { type: "task_started" }));
  const child = { ...meta, id: "CHILD", agent_nickname: "Researcher", source: { subagent: { thread_spawn: { parent_thread_id: "ROOT" } } } };
  adapter.ingest(child, row("event_msg", { type: "task_started" }, 2));
  const usage = (input: number) => ({ type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: 25, output_tokens: 10, total_tokens: input + 10 } } });
  adapter.ingest(meta, row("event_msg", usage(100), 3));
  adapter.ingest(meta, row("event_msg", usage(150), 4));
  adapter.ingest(child, row("event_msg", usage(40), 5));
  assert.equal(store.sessions.size, 1);
  const worker = store.agents.get("cx_ROOT/CHILD")!;
  assert.equal(worker.parentAgentId, "cx_ROOT/lead"); assert.equal(worker.name, "Researcher");
  const records = [...store.usage.values()]; assert.equal(records.length, 2);
  assert.equal(records.find((r) => r.agentId === null)?.inputTokens, 125);
  assert.equal(records.filter((r) => !r.includedInParent).reduce((sum, r) => sum + (r.totalTokens ?? 0), 0), 160);
  assert.equal(records.find((r) => r.agentId === worker.id)?.includedInParent, true);
  assert.ok(records.every((r) => r.costEstimateUsd === null));
  adapter.ingest({ ...child, source: { subagent: { thread_spawn: { parent_thread_id: "ROOT", agent_path: "/root/research" } } } }, row("event_msg", { type: "task_started" }, 6));
  assert.equal(worker.name, "research");
  db.close();
});

test("Codex tail handles partial UTF-8/JSON, appends, restart dedupe and truncation", async () => {
  const { adapter, store, meta, db, logs, cfg } = setup();
  const file = join(logs, "rollout.jsonl");
  const header = JSON.stringify({ type: "session_meta", payload: { ...meta, instructions: "NEVER IMPORT" } }) + "\n";
  const activity = Buffer.from(JSON.stringify(row("event_msg", { type: "agent_message", message: "Hello 🧪" })) + "\n");
  const split = activity.indexOf(Buffer.from("🧪")) + 2;
  writeFileSync(file, Buffer.concat([Buffer.from(header), activity.subarray(0, split)]));
  await adapter.poll(); assert.equal(store.eventsForAgent("cx_ROOT/lead").length, 0);
  appendFileSync(file, activity.subarray(split)); await adapter.poll();
  assert.equal(store.eventsForAgent("cx_ROOT/lead")[0].summary, "Hello 🧪");
  const again = new CodexAdapter(store, cfg); await again.poll();
  assert.equal(store.eventsForAgent("cx_ROOT/lead").length, 1);
  appendFileSync(file, JSON.stringify(row("event_msg", { type: "task_complete", last_agent_message: "Done" }, 2)) + "\n");
  await adapter.poll(); assert.equal(store.sessions.get("cx_ROOT")?.runtimeState, "idle");
  writeFileSync(file, header + JSON.stringify(row("event_msg", { type: "task_started" }, 3)) + "\n");
  await adapter.poll(); assert.equal(store.sessions.get("cx_ROOT")?.runtimeState, "running");
  assert.equal(readFileSync(file, "utf8").startsWith(header), true);
  assert.equal(store.server.codex?.status, "watching");
  adapter.stop(); again.stop(); db.close();
});

test("missing Codex logs report unavailable without breaking the server", async () => {
  const { store, cfg, db } = setup();
  const adapter = new CodexAdapter(store, { ...cfg, codex: { sessionsDir: join(cfg.dataDir, "missing") } });
  await adapter.poll(); assert.equal(store.server.codex?.status, "unavailable");
  assert.equal(store.sessions.size, 0); adapter.stop(); db.close();
});

test("forked worker logs preserve their identity and skip copied parent history", async () => {
  const { adapter, store, meta, db, logs } = setup();
  const child = { ...meta, id: "WORKER", source: { subagent: { thread_spawn: { parent_thread_id: "ROOT", agent_path: "/root/design" } } } };
  const records = [row("session_meta", child), row("session_meta", { ...meta, timestamp: "2026-10-31T21:00:00Z" }),
    row("event_msg", { type: "task_started", started_at: Date.parse("2026-10-31T21:00:00Z") / 1000 }, 2),
    row("event_msg", { type: "agent_message", message: "COPIED PARENT HISTORY" }, 3),
    row("event_msg", { type: "task_started", started_at: Date.parse(meta.timestamp) / 1000 + 4, turn_attribution: { parent_turn_id: "PARENT_TURN" } }, 4),
    row("event_msg", { type: "agent_message", message: "Designing the interface" }, 5)];
  writeFileSync(join(logs, "child.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await adapter.poll();
  const worker = store.agents.get("cx_ROOT/WORKER")!;
  assert.equal(worker.name, "design"); assert.equal(worker.parentAgentId, "cx_ROOT/lead");
  assert.ok(!JSON.stringify(store.eventsForAgent(worker.id)).includes("COPIED PARENT HISTORY"));
  assert.equal(store.eventsForAgent(worker.id)[0].summary, "Designing the interface");
  adapter.stop(); db.close();
});
