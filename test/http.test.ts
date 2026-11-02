// HTTP security and reload behaviour against a real server process on a
// spare port with a throwaway data directory.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 4399;
const data = mkdtempSync(join(tmpdir(), "am-http-"));
const vault = join(data, "vault"), transcripts = join(data, "transcripts"), config = join(data, "test-config.json");
mkdirSync(vault); mkdirSync(transcripts);
writeFileSync(config, JSON.stringify({ allowedRoots: [data], archiving: { vaultPath: vault, claudeProjectsDir: transcripts } }));
let proc: ChildProcess;

function startServer(): Promise<void> {
  proc = spawn(process.execPath, [join(root, "server", "index.ts")], { env: { ...process.env, AGENT_MONITOR_CONFIG: config, AGENT_MONITOR_PORT: String(port), AGENT_MONITOR_DATA: data, AGENT_MONITOR_CODEX_ENABLED: "0", AGENT_MONITOR_KILO_ENABLED: "0", AGENT_MONITOR_WIDGET_USAGE_ENABLED: "0" }, stdio: "pipe" });
  return new Promise((res) => proc.stdout!.on("data", (d) => { if (String(d).includes("listening")) res(); }));
}

// node:http lets us set Host freely (fetch does not).
function req(path: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((res, rej) => {
    const r = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...o.headers } }, (resp) => {
      let b = ""; resp.on("data", (c) => (b += c)); resp.on("end", () => { let j; try { j = JSON.parse(b); } catch { j = b; } res({ status: resp.statusCode!, body: j }); });
    });
    r.on("error", rej);
    if (o.body !== undefined) r.end(JSON.stringify(o.body)); else r.end();
  });
}

test.before(startServer);
test.after(() => { proc.kill(); });

test("rejects foreign Host headers (DNS rebinding)", async () => {
  assert.equal((await req("/api/bootstrap", { headers: { host: "attacker.example:4399" } })).status, 403);
});

test("rejects cross-origin writes even with a valid token", async () => {
  const token = readFileSync(join(data, "token"), "utf8").trim();
  const r = await req("/api/sessions", { method: "POST", headers: { origin: "http://attacker.example", "x-agent-monitor-token": token }, body: {} });
  assert.equal(r.status, 403);
});

test("requires the token for reads and writes", async () => {
  assert.equal((await req("/api/snapshot")).status, 401);
  assert.equal((await req("/api/hooks", { method: "POST", body: {} })).status, 401);
});

test("query token is accepted only for /api/stream; other routes need the header", async () => {
  const token = readFileSync(join(data, "token"), "utf8").trim();
  const q = encodeURIComponent(token);
  // SSE never ends, so resolve on the response headers and drop the connection.
  const stream = (path: string, headers: Record<string, string> = {}) => new Promise<number>((res, rej) => {
    const r = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (x) => { res(x.statusCode!); x.destroy(); });
    r.on("error", rej); r.end();
  });
  assert.equal(await stream(`/api/stream?token=${q}`), 200);
  assert.equal(await stream("/api/stream"), 401);
  assert.equal(await stream("/api/stream", { "x-agent-monitor-token": token }), 200);
  assert.equal((await req(`/api/snapshot?token=${q}`)).status, 401);
  assert.equal((await req(`/api/widget-usage?token=${q}`)).status, 401);
  assert.equal((await req("/api/snapshot", { headers: { "x-agent-monitor-token": token } })).status, 200);
});

test("bootstrap sends no CORS headers", async () => {
  const r = await new Promise<Record<string, unknown>>((res) => request({ host: "127.0.0.1", port, path: "/api/bootstrap", headers: { host: `127.0.0.1:${port}` } }, (x) => { x.resume(); res(x.headers); }).end());
  assert.equal(r["access-control-allow-origin"], undefined);
});

test("usage sidebar endpoint requires local authentication and refresh rejects foreign origins", async () => {
  assert.equal((await req("/api/widget-usage")).status, 401);
  const token = readFileSync(join(data, "token"), "utf8").trim();
  const headers = { "x-agent-monitor-token": token };
  const usage = await req("/api/widget-usage", { headers });
  assert.equal(usage.status, 200);
  assert.deepEqual(usage.body.providers.map((p: any) => p.id), ["claude", "codex", "kilo"]);
  assert.equal((await req("/api/widget-usage/refresh", { method: "POST", headers: { ...headers, origin: "https://example.com" } })).status, 403);
  assert.equal((await req("/api/widget-usage/refresh", { method: "POST", headers })).status, 202);
});

test("managed sessions are refused outside allowed roots", async () => {
  const token = readFileSync(join(data, "token"), "utf8").trim();
  const r = await req("/api/sessions", { method: "POST", headers: { "x-agent-monitor-token": token, "content-type": "application/json" }, body: { projectPath: "C:\\Windows", prompt: "x" } });
  assert.equal(r.status, 403);
});

test("pending requests survive a browser reload and a backend restart (hooks-owned)", async () => {
  const token = readFileSync(join(data, "token"), "utf8").trim();
  const H = { "x-agent-monitor-token": token, "content-type": "application/json" };
  // A read-only hooks request: pending until resolved in the original session.
  await req("/api/hooks", { method: "POST", headers: H, body: { ts: 1, payload: { session_id: "X", hook_event_name: "PermissionRequest", cwd: tmpdir(), tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" } } });
  const s1 = await req("/api/snapshot", { headers: H });
  assert.equal(s1.body.interactions.filter((i: any) => i.status === "pending").length, 1);
  const s2 = await req("/api/snapshot", { headers: H }); // a browser reload is just a new snapshot
  assert.equal(s2.body.interactions[0].id, s1.body.interactions[0].id);
  proc.kill();
  await new Promise((r) => setTimeout(r, 500));
  await startServer();
  const s3 = await req("/api/snapshot", { headers: H });
  // Hooks requests are not owned by this backend, so a restart leaves them pending.
  assert.equal(s3.body.interactions[0].status, "pending");
});

test("archive-to-vault and exact-tab close receipt work over authenticated HTTP without clearing failures", async () => {
  const token = readFileSync(join(data, "token"), "utf8").trim(), headers = { "x-agent-monitor-token": token };
  assert.equal((await req("/api/vscode/pending")).status, 401);
  assert.equal((await req("/api/sessions/nope/archive", { method: "POST", body: { lastEventAt: 1 } })).status, 401);
  assert.equal((await req("/api/sessions/nope/archive", { method: "POST", headers: { ...headers, origin: "http://attacker.example" }, body: { lastEventAt: 1 } })).status, 403);
  writeFileSync(join(transcripts, "archive-fixture.jsonl"), [
    { type: "user", sessionId: "archive-fixture", cwd: data, message: { content: "HTTP user" } },
    { type: "assistant", sessionId: "archive-fixture", message: { content: "HTTP answer" } }
  ].map(row => JSON.stringify(row)).join("\n"));
  await req("/api/hooks", { method: "POST", headers, body: { ts: 100, payload: { session_id: "archive-fixture", hook_event_name: "Stop", cwd: data, last_assistant_message: "HTTP answer" } } });
  const snapshot = await req("/api/snapshot", { headers });
  const session = snapshot.body.sessions.find((s: any) => s.runtimeSessionId === "archive-fixture");
  const url = `/api/sessions/${encodeURIComponent(session.id)}/archive`;
  assert.equal((await req(url, { method: "POST", headers, body: {} })).status, 400);
  const saved = await req(url, { method: "POST", headers, body: { lastEventAt: session.lastEventAt } });
  assert.equal(saved.status, 200); assert.equal(saved.body.closeStatus, "pending");
  assert.ok(saved.body.archivePath.startsWith(vault)); assert.ok(readFileSync(saved.body.archivePath, "utf8").includes("HTTP answer"));
  const jobs = await req("/api/vscode/pending", { headers }); assert.ok(jobs.body.some((j: any) => j.id === saved.body.jobId));
  const jobPath = `/api/vscode/jobs/${saved.body.jobId}`;
  assert.equal((await req(jobPath + "/claim", { method: "POST", headers, body: { clientId: "fixture-window" } })).status, 200);
  assert.equal((await req(jobPath + "/ack", { method: "POST", headers, body: { clientId: "different-window", closed: true } })).status, 409);
  assert.equal((await req(jobPath + "/ack", { method: "POST", headers, body: { clientId: "fixture-window", closed: true } })).status, 200);
  assert.equal((await req(jobPath, { headers })).body.closeStatus, "closed");
  assert.ok((await req("/api/snapshot", { headers })).body.sessions.some((s: any) => s.id === session.id));
});

test("malformed input gives 4xx rather than 500", async () => {
  const token = readFileSync(join(data, "token"), "utf8").trim(), headers = { "x-agent-monitor-token": token };
  assert.equal((await req("/%E0%A4%A")).status, 400);
  // Non-object JSON bodies are treated as empty rather than crashing handlers.
  const r = await new Promise<number>((res, rej) => {
    const q = request({ host: "127.0.0.1", port, path: "/api/vscode/jobs/x/claim", method: "POST", headers: { host: `127.0.0.1:${port}`, ...headers } }, (x) => { x.resume(); res(x.statusCode!); });
    q.on("error", rej); q.end("null");
  });
  assert.equal(r, 400);
});
