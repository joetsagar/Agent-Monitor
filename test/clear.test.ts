// /clear: SessionStart source=clear archives everything, wipes the monitor, and
// the clear watermark keeps old history from coming back.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { openDb } from "../server/db.ts";
import { HooksAdapter } from "../server/hooks-adapter.ts";
import { CodexAdapter } from "../server/codex-adapter.ts";
import { ArchiveService } from "../server/archive-service.ts";
import { ClearService } from "../server/clear-service.ts";
import type { Config } from "../server/config.ts";
import type { StreamMessage } from "../shared/types.ts";

const info = (_dir: string) => ({ startedAt: 1, version: "t", billingMode: "subscription" as const, managedSessionsEnabled: true, hooksEventsReceived: 0, lastHookEventAt: null, staleAfterMs: 60_000, aiSummaries: false as const });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "am-clear-")), logs = join(dir, "logs"), vault = join(dir, "vault");
  mkdirSync(logs); mkdirSync(vault);
  const cfg: Config = { host: "127.0.0.1", port: 0, dataDir: dir, billingMode: "subscription", defaultModel: "sonnet", allowedRoots: [dir], staleAfterMs: 60_000,
    readTranscriptUsage: false, pricing: { asOf: null, note: "", models: {} }, codex: { sessionsDir: logs }, archiving: { vaultPath: vault, claudeProjectsDir: logs } };
  const make = () => { const store = new Store(openDb(dir), info(dir)), hooks = new HooksAdapter(store, cfg);
    return { store, hooks, clearer: new ClearService(store, new ArchiveService(store, cfg), hooks) }; };
  return { dir, logs, vault, cfg, make };
}
const hook = (dir: string, sid: string, ev: string, ts: number, extra: Record<string, unknown> = {}) =>
  ({ ts, payload: { session_id: sid, hook_event_name: ev, cwd: dir, ...extra } });
const claudeLog = (logs: string, dir: string, sid: string) => writeFileSync(join(logs, `${sid}.jsonl`), [
  { type: "user", sessionId: sid, cwd: dir, timestamp: "2026-11-01T10:00:00Z", message: { content: "hello old chat" } },
  { type: "assistant", sessionId: sid, cwd: dir, timestamp: "2026-11-01T10:00:01Z", message: { content: [{ type: "text", text: "old answer" }] } },
].map((r) => JSON.stringify(r)).join("\n") + "\n");
const archived = (vault: string) => { const out: string[] = []; const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name)); }; walk(vault); return out; };

test("SessionStart source=clear archives all sessions then wipes everything, broadcasting an empty snapshot", async () => {
  const { dir, logs, vault, make } = setup();
  const { store, hooks, clearer } = make();
  claudeLog(logs, dir, "OLD");
  hooks.ingest(hook(dir, "OLD", "UserPromptSubmit", 1000, { prompt: "hi" }));
  hooks.ingest(hook(dir, "OLD", "PreToolUse", 1100, { tool_name: "AskUserQuestion", tool_use_id: "q1", tool_input: { questions: [{ question: "?", options: [] }] } }));
  // A running managed session is not killed or wiped.
  store.putSession({ ...store.sessions.get("hooks:OLD")!, id: "m_live", source: "managed", runtimeSessionId: null, runtimeState: "running", lastEventAt: 1200 });
  store.ensureAgent("m_live", null, { ts: 1200 });
  const msgs: StreamMessage[] = []; store.subscribe((m) => msgs.push(m));
  const trigger = hook(dir, "NEW", "SessionStart", 5000, { source: "clear" });
  assert.equal(clearer.isTrigger(trigger), true);
  assert.equal(clearer.isTrigger(hook(dir, "NEW", "SessionStart", 5000, { source: "startup" })), false);
  assert.equal(clearer.isTrigger(hook(dir, "NEW", "SessionStart", 5000, { source: "resume" })), false);
  const r = await clearer.run(5000);
  assert.equal(r.archived, 1); assert.deepEqual(r.failed, []);
  assert.equal(archived(vault).length, 1);
  assert.match(readFileSync(archived(vault)[0], "utf8"), /old answer/);
  assert.ok(existsSync(join(logs, "OLD.jsonl")), "source transcript is never deleted");
  assert.deepEqual([...store.sessions.keys()], ["m_live"]);
  assert.deepEqual([...store.agents.keys()], ["m_live/lead"]);
  assert.equal(store.interactions.size, 0);
  assert.equal(store.eventsForAgent("hooks:OLD/lead").length, 0);
  const snap = msgs.find((m) => m.type === "snapshot");
  assert.ok(snap && snap.type === "snapshot" && snap.data.sessions.length === 1 && snap.data.interactions.length === 0);
  // The trigger delivered again (duplicate) must not wipe the new chat.
  hooks.ingest(trigger);
  assert.equal(clearer.isTrigger(trigger), false);
  assert.ok(store.sessions.has("hooks:NEW"));
});

test("with no live sessions the monitor is completely empty after /clear", async () => {
  const { dir, logs, make } = setup();
  const { store, hooks, clearer } = make();
  claudeLog(logs, dir, "A");
  hooks.ingest(hook(dir, "A", "UserPromptSubmit", 1000, { prompt: "hi" }));
  hooks.ingest(hook(dir, "B", "UserPromptSubmit", 1001, { prompt: "no transcript" }));
  const r = await clearer.run(5000);
  assert.equal(r.removed, 2); assert.equal(r.archived, 2); assert.deepEqual(r.failed, []); // B had no transcript: nothing to save, not an error
  for (const m of [store.sessions, store.agents, store.tasks, store.interactions, store.usage, store.projects]) assert.equal(m.size, 0);
  assert.equal(store.milestones().length, 0);
});

test("old sessions do not reappear after restart, late hooks or Codex rescans; new activity shows", async () => {
  const { dir, logs, make, cfg } = setup();
  const first = make();
  first.hooks.ingest(hook(dir, "OLD", "UserPromptSubmit", 1000, { prompt: "hi" }));
  await first.clearer.run(5000);
  // Late hook from the old chat, fired before the clear.
  assert.equal(first.hooks.ingest(hook(dir, "OLD", "Stop", 4000)).ignored, "before clear");
  assert.equal(first.store.sessions.size, 0);
  // Backend restart: DB reloaded, watermark persisted.
  const second = make();
  assert.equal(second.store.clearedAt, 5000);
  assert.equal(second.store.sessions.size, 0);
  assert.equal(second.hooks.ingest(hook(dir, "OLD", "Stop", 4999)).ignored, "before clear");
  // Codex rescan of old logs (offset 0 after restart) is ignored; fresh rows show.
  const codex = new CodexAdapter(second.store, cfg);
  const meta = { id: "CX", cwd: dir, timestamp: "2026-01-01T00:00:00Z", source: "vscode" };
  const oldRow = { timestamp: new Date(2000).toISOString(), type: "event_msg", payload: { type: "task_started" } };
  codex.ingest(meta, oldRow);
  assert.equal(second.store.sessions.size, 0);
  codex.ingest(meta, { ...oldRow, timestamp: new Date(6000).toISOString() });
  assert.ok(second.store.sessions.has("cx_CX"));
  // Normal hook activity after the clear (including the new chat's SessionStart).
  second.hooks.ingest(hook(dir, "NEW", "SessionStart", 5000, { source: "clear" }));
  second.hooks.ingest(hook(dir, "NEW", "UserPromptSubmit", 5100, { prompt: "next" }));
  assert.equal(second.store.agents.get("hooks:NEW/lead")!.status, "working");
  assert.deepEqual([...second.store.sessions.keys()].sort(), ["cx_CX", "hooks:NEW"]);
});
