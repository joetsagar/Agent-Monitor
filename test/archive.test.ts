import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { Store } from "../server/store.ts";
import { openDb } from "../server/db.ts";
import { ArchiveService } from "../server/archive-service.ts";
import { readConversation } from "../server/conversation-archive.ts";
import type { Config } from "../server/config.ts";
import type { Session } from "../shared/types.ts";
const require = createRequire(import.meta.url);
const { matches, codexId, bindable } = require("../vscode-companion/match.cjs");
function setup(source: Session["source"] = "codex-local") {
  const dir = mkdtempSync(join(tmpdir(), "am-archive-")), logs = join(dir, "logs"), vault = join(dir, "vault");
  mkdirSync(logs); mkdirSync(vault);
  const cfg: Config = { host: "127.0.0.1", port: 0, dataDir: dir, billingMode: "subscription", defaultModel: "sonnet", allowedRoots: [dir], staleAfterMs: 60000,
    readTranscriptUsage: true, pricing: { asOf: null, note: "", models: {} }, codex: { sessionsDir: logs, archivedSessionsDir: join(dir, "archived") }, archiving: { vaultPath: vault, claudeProjectsDir: logs }, kilo: { databasePath: join(dir, "kilo.db") } };
  const db = openDb(dir), store = new Store(db, { startedAt: 1, version: "test", billingMode: "subscription", managedSessionsEnabled: true, hooksEventsReceived: 0, lastHookEventAt: null, staleAfterMs: 60000, aiSummaries: false });
  const session: Session = { id: "test-root", projectId: store.projectFor(dir).id, source, runtimeSessionId: "root", title: "test", cwd: dir, model: null, authSource: null, billingMode: null,
    runtimeState: "idle", runtimeStateDetail: null, permissionMode: null, startedAt: 1, lastEventAt: 100, endedAt: null,
    capabilities: { answerQuestions: false, approvePermissions: false, sendMessages: false, cancel: false, resume: false }, claudeCodeVersion: null };
  store.putSession(session); store.ensureAgent(session.id, null, { ts: 100, status: "idle" });
  const archive = new ArchiveService(store, cfg);
  function codex(id = "root", text = "answer") {
    const file = join(logs, `rollout-${id}.jsonl`);
    writeFileSync(file, [
      { type: "session_meta", payload: { id, cwd: dir, timestamp: "2026-01-01T00:00:00Z" } },
      { type: "response_item", timestamp: "2026-01-01T00:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "user request" }] } },
      { type: "response_item", timestamp: "2026-01-01T00:00:02Z", payload: { type: "message", role: "assistant", channel: "analysis", content: [{ type: "text", text: "PRIVATE REASONING" }] } },
      { type: "response_item", timestamp: "2026-01-01T00:00:03Z", payload: { type: "function_call_output", output: "PRIVATE TOOL LOG" } },
      { type: "response_item", timestamp: "2026-01-01T00:00:04Z", payload: { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text }] } }
    ].map(r => JSON.stringify(r)).join("\n") + "\n"); return file;
  }
  return { dir, logs, vault, cfg, db, store, session, archive, codex, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("archive saves full untruncated public conversation, redacts secrets, verifies receipt before closing, retries idempotently", async () => {
  const x = setup(); try {
    const long = "word ".repeat(4000) + "TAIL ```text\npassword=secret12345\nsk-proj-testkey1234567890-abcdef\nBearer independentcredential12345\nEND";
    const file = x.codex("root", long), original = readFileSync(file, "utf8");
    const result = await x.archive.archive(x.session.id, 100);
    assert.equal(result.closeStatus, "pending");
    const text = readFileSync(result.archivePath!, "utf8");
    assert.ok(text.includes("word ".repeat(4000))); assert.ok(text.includes("END"));
    assert.ok(text.includes("user request")); assert.ok(text.includes("[REDACTED]"));
    for (const excluded of ["secret12345", "testkey1234567890", "independentcredential12345", "PRIVATE REASONING", "PRIVATE TOOL LOG"]) assert.ok(!text.includes(excluded));
    assert.equal(readFileSync(file, "utf8"), original);
    assert.equal(await x.archive.claim(result.jobId!, "window-one"), true);
    assert.equal(await x.archive.claim(result.jobId!, "window-two"), false);
    assert.equal(x.archive.acknowledge(result.jobId!, "window-two", true), false);
    assert.equal(x.archive.acknowledge(result.jobId!, "window-one", true), true);
    assert.equal(x.archive.result(result.jobId!)?.closeStatus, "closed");
    const retry = await x.archive.archive(x.session.id, 100);
    assert.equal(retry.archivePath, result.archivePath);
    assert.equal(await x.archive.claim(retry.jobId!, "window-one"), true);
    assert.equal(x.archive.acknowledge(retry.jobId!, "window-one", false, true), true);
    assert.equal(x.archive.result(retry.jobId!)?.closeStatus, "no_tab");
  } finally { x.close(); }
});

test("archive refuses active, changed, missing or malformed conversations without issuing close jobs", async () => {
  const x = setup(); try {
    x.codex(); x.store.patchSession(x.session.id, { runtimeState: "running" });
    await assert.rejects(x.archive.archive(x.session.id, 100), /active or changed/);
    x.store.patchSession(x.session.id, { runtimeState: "idle" });
    await assert.rejects(x.archive.archive(x.session.id, 99), /active or changed/);
    x.store.patchAgent("test-root/lead", { status: "working" });
    await assert.rejects(x.archive.archive(x.session.id, 100), /active or changed/);
    x.store.patchAgent("test-root/lead", { status: "idle" });
    writeFileSync(join(x.logs, "rollout-root.jsonl"), "{broken");
    await assert.rejects(x.archive.archive(x.session.id, 100), /malformed/);
    rmSync(join(x.logs, "rollout-root.jsonl"));
    const gone = await x.archive.archive(x.session.id, 100);
    assert.equal(gone.closeStatus, "no_transcript"); assert.equal(gone.archivePath, null);
    assert.equal(x.archive.pending().length, 0);
  } finally { x.close(); }
});

test("source activity after export and manually edited vault files prevent closing", async () => {
  const x = setup(); try {
    const file = x.codex(); const result = await x.archive.archive(x.session.id, 100);
    appendFileSync(file, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n");
    assert.equal(await x.archive.claim(result.jobId!, "window-one"), false);
    assert.equal(x.archive.result(result.jobId!)?.closeStatus, "failed");
    const retry = await x.archive.archive(x.session.id, 100);
    appendFileSync(retry.archivePath!, "\nmanual edit");
    assert.equal(await x.archive.claim(retry.jobId!, "window-one"), false);
    await assert.rejects(x.archive.archive(x.session.id, 100), /verified/);
    assert.ok(readFileSync(retry.archivePath!, "utf8").includes("manual edit"));
  } finally { x.close(); }
});

test("Claude hook and managed conversations export user/assistant text and keep original logs", async () => {
  for (const source of ["vscode-hooks", "managed"] as const) {
    const x = setup(source); try {
      const file = join(x.logs, "root.jsonl");
      writeFileSync(file, [
        { type: "user", sessionId: "root", cwd: x.dir, message: { content: "Claude user" } },
        { type: "assistant", sessionId: "root", message: { content: [{ type: "thinking", thinking: "PRIVATE" }, { type: "text", text: "Claude answer" }] } }
      ].map(r => JSON.stringify(r)).join("\n"));
      const result = await x.archive.archive(x.session.id, 100);
      assert.equal(result.closeStatus, source === "managed" ? "not_applicable" : "pending");
      const text = readFileSync(result.archivePath!, "utf8");
      assert.ok(text.includes("Claude user") && text.includes("Claude answer")); assert.ok(!text.includes("PRIVATE"));
      assert.ok(readFileSync(file, "utf8").includes("PRIVATE"));
    } finally { x.close(); }
  }
});

test("Kilo database exports ordered public text read-only, without reasoning and tool outputs", async () => {
  const x = setup("kilo-local"); const source = new DatabaseSync(x.cfg.kilo!.databasePath!);
  try {
    source.exec("CREATE TABLE session(id TEXT,directory TEXT,time_updated INTEGER,time_archived INTEGER); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT)");
    source.prepare("INSERT INTO session VALUES(?,?,100,NULL)").run("root", x.dir);
    for (const [i, role] of ["user", "assistant"].entries()) {
      source.prepare("INSERT INTO message VALUES(?,?,?,100,?)").run(String(i), "root", i, JSON.stringify({ role }));
      source.prepare("INSERT INTO part VALUES(?,?,?,?,100,?)").run(String(i), String(i), "root", i, JSON.stringify({ type: "text", text: `${role} Kilo message` }));
    }
    source.prepare("INSERT INTO part VALUES('private','1','root',3,100,?)").run(JSON.stringify({ type: "reasoning", text: "PRIVATE" }));
    const changes = source.prepare("SELECT total_changes() n").get();
    const result = await x.archive.archive(x.session.id, 100), text = readFileSync(result.archivePath!, "utf8");
    assert.ok(text.indexOf("user Kilo message") < text.indexOf("assistant Kilo message")); assert.ok(!text.includes("PRIVATE"));
    assert.deepEqual(source.prepare("SELECT total_changes() n").get(), changes);
    assert.equal(await x.archive.claim(result.jobId!, "window-one"), true);
  } finally { source.close(); x.close(); }
});

test("missing worker conversation is skipped; unwritable vault prevents clearing", async () => {
  const x = setup(); try {
    x.codex(); x.store.ensureAgent(x.session.id, "worker", { ts: 100, status: "completed" });
    const skipped = await x.archive.archive(x.session.id, 100);
    assert.ok(skipped.archivePath && !readFileSync(skipped.archivePath, "utf8").includes("worker answer"));
    x.codex("worker", "worker answer");
    const result = await x.archive.archive(x.session.id, 100);
    assert.ok(readFileSync(result.archivePath!, "utf8").includes("worker answer"));
    x.cfg.archiving!.vaultPath = join(x.dir, "missing-vault");
    await assert.rejects(x.archive.archive(x.session.id, 100));
  } finally { x.close(); }
});

test("VS Code matching closes only exact Codex URI or an explicitly linked provider tab", () => {
  const codex = { input: { viewType: "chatgpt.conversationEditor", uri: { scheme: "openai-codex", authority: "route", path: "/local/abc" } } };
  const job = { source: "codex-local", runtimeSessionId: "abc", sessionId: "cx_abc" };
  assert.equal(codexId(codex.input), "abc"); assert.equal(matches(codex, job, new Map()), true);
  assert.equal(matches(codex, { ...job, runtimeSessionId: "other" }, new Map()), false);
  assert.equal(codexId({ ...codex.input, uri: { ...codex.input.uri, scheme: "file" } }), null);
  const claude = { input: { viewType: "claudeVSCodePanel" } }, other = { input: { viewType: "claudeVSCodePanel" } };
  const linked = new Map([["s", claude]]), claudeJob = { source: "vscode-hooks", sessionId: "s" };
  assert.equal(matches(claude, claudeJob, linked), true); assert.equal(matches(other, claudeJob, linked), false);
  assert.equal(matches(claude, { source: "kilo-local", sessionId: "s" }, linked), false);
  assert.equal(bindable({ viewType: "kilo-code.new.TabPanel" }, "kilo-local"), true);
  assert.equal(bindable({ viewType: "kilo-code.new.AgentManagerPanel" }, "kilo-local"), false);
});

test("Codex sessions silent for 6h are treated as interrupted so they can be cleared", () => {
  const x = setup(); try {
    x.store.patchSession(x.session.id, { runtimeState: "running" });
    x.store.patchAgent("test-root/lead", { status: "working" });
    x.store.refreshStale(100 + 5 * 3600_000);
    assert.equal(x.store.agents.get("test-root/lead")?.status, "working");
    x.store.refreshStale(100 + 7 * 3600_000);
    assert.equal(x.store.agents.get("test-root/lead")?.status, "cancelled");
    assert.equal(x.store.sessions.get(x.session.id)?.runtimeState, "interrupted");
  } finally { x.close(); }
});
