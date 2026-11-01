// Real integration proof over the browser-facing API: starts a managed
// session, answers a clarification, approves one permission and denies
// another, checking each transition is confirmed by the runtime.
// Usage: node scripts/e2e-proof.mjs [model]   (costs a small amount of usage)
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = "http://127.0.0.1:4317";
const token = readFileSync(join(root, "data", "token"), "utf8").trim();
const H = { "content-type": "application/json", "x-agent-monitor-token": token, origin: base };
const sandbox = join(root, "data", "sandbox-proof");
mkdirSync(sandbox, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const results = [];
const check = (name, ok, info = "") => { results.push({ name, ok }); log(ok ? "PASS" : "FAIL", name, info); };

const state = { interactions: new Map(), sessions: new Map(), agents: new Map(), events: [] };
const waiters = [];
function onMsg(m) {
  if (m.type === "snapshot") {
    for (const i of m.data.interactions) state.interactions.set(i.id, i);
    for (const s of m.data.sessions) state.sessions.set(s.id, s);
  } else if (m.type === "interaction") state.interactions.set(m.data.id, m.data);
  else if (m.type === "session") state.sessions.set(m.data.id, m.data);
  else if (m.type === "agent") state.agents.set(m.data.id, m.data);
  else if (m.type === "event") state.events.push(m.data);
  for (const w of [...waiters]) if (w.pred()) { waiters.splice(waiters.indexOf(w), 1); w.res(); }
}
const until = (pred, ms = 120000, what = "condition") => new Promise((res, rej) => {
  if (pred()) return res();
  const w = { pred, res };
  waiters.push(w);
  setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); rej(new Error("timeout waiting for " + what)); } }, ms).unref();
});

// Minimal SSE client (Node has no EventSource).
const ac = new AbortController();
(async () => {
  const r = await fetch(`${base}/api/stream?token=${token}`, { signal: ac.signal });
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let k;
    while ((k = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, k); buf = buf.slice(k + 2);
      for (const line of block.split("\n")) if (line.startsWith("data: ")) onMsg(JSON.parse(line.slice(6)));
    }
  }
})().catch(() => {});

const post = async (path, body) => {
  const r = await fetch(base + path, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

const model = process.argv[2] ?? "haiku";
const s = (await post("/api/sessions", {
  projectPath: sandbox, model, loadSettings: false, title: "Integration proof",
  prompt: "Step 1: use the AskUserQuestion tool to ask me which filename to use, offering exactly the options 'alpha.txt' and 'beta.txt'. " +
    "Step 2: use the Bash tool to run exactly: echo hello > <chosen filename>. " +
    "Step 3: use the Bash tool to run exactly: rm <chosen filename>. " +
    "If a step is denied, do not retry it or try alternatives; finish with one sentence saying what happened.",
})).body;
log("session started", s.id);
const sid = s.id;
const pendingOf = (kind) => [...state.interactions.values()].find((i) => i.sessionId === sid && i.kind === kind && i.status === "pending");

// 1. Clarification
await until(() => pendingOf("question"), 120000, "question");
const q = pendingOf("question");
const sess = state.sessions.get(sid);
check("session attributed (runtime session id + auth source)", !!sess.runtimeSessionId && sess.authSource === "none", `runtime=${sess.runtimeSessionId} auth=${sess.authSource} model=${sess.model}`);
check("question pending with options", q.request.questions[0].options.length >= 2, q.request.questions[0].question);
const qq = q.request.questions[0];
const answer = qq.options.find((o) => o.label.includes("beta"))?.label ?? qq.options[1].label;
const r1 = await post(`/api/interactions/${q.id}/respond`, { response: { type: "question", answers: { [qq.question]: answer } }, clientRequestId: "c1" });
check("question answer accepted -> delivered", r1.status === 200 && r1.body.status === "delivered", `${r1.status} ${r1.body.status}`);
const dup = await post(`/api/interactions/${q.id}/respond`, { response: { type: "question", answers: { [qq.question]: "alpha.txt" } }, clientRequestId: "c2" });
check("duplicate submission rejected", dup.status === 409, `${dup.status} ${dup.body.error}`);
const retry = await post(`/api/interactions/${q.id}/respond`, { response: { type: "question", answers: { [qq.question]: answer } }, clientRequestId: "c1" });
check("same-request retry is idempotent", retry.status === 200, `${retry.status} ${retry.body.status}`);
await until(() => state.interactions.get(q.id).status === "resumed", 60000, "question resumed");
check("question resumed (runtime emitted tool_result)", true);

// 2. Permission approve
await until(() => pendingOf("permission"), 120000, "permission #1");
const p1 = pendingOf("permission");
check("permission #1 shows command + cwd", !!p1.request.command && !!p1.request.cwd, `cmd=${p1.request.command} cwd=${p1.request.cwd} scopes=${p1.request.scopeOptions.map((o) => o.id)}`);
check("answer used by agent", p1.request.command.includes(answer), `expected ${answer}`);
const a1 = await post(`/api/interactions/${p1.id}/respond`, { response: { type: "permission", decision: "approve", scope: "once" }, clientRequestId: "p1" });
check("approve delivered", a1.status === 200 && a1.body.status === "delivered");
await until(() => state.interactions.get(p1.id).status === "resumed", 60000, "permission #1 resumed");
const end1 = state.events.find((e) => e.toolUseId === p1.toolUseId && e.kind === "tool_end");
check("approved command ran (tool_end ok)", !!end1 && existsSync(join(sandbox, answer)), end1?.summary);

// 3. Permission deny
await until(() => pendingOf("permission"), 120000, "permission #2");
const p2 = pendingOf("permission");
log("permission #2:", p2.request.command);
const d2 = await post(`/api/interactions/${p2.id}/respond`, { response: { type: "permission", decision: "deny", message: "Keep the file." }, clientRequestId: "p2" });
check("deny delivered", d2.status === 200 && d2.body.status === "delivered");
await until(() => state.interactions.get(p2.id).status === "resumed", 60000, "permission #2 resumed");
const fail2 = state.events.find((e) => e.toolUseId === p2.toolUseId && e.kind === "tool_fail");
check("denied command did not run (tool_fail, file kept)", !!fail2 && existsSync(join(sandbox, answer)), fail2?.summary);

// 4. Turn end + review request
await until(() => [...state.interactions.values()].some((i) => i.sessionId === sid && i.kind === "review" && i.status === "pending"), 120000, "review");
const lead = state.agents.get(`${sid}/lead`);
check("turn ended; lead idle with agent-reported result", lead.status === "idle" && lead.lastResult?.provenance === "agent-reported", lead.lastResult?.text);
log("SDK usage:", (await (await fetch(`${base}/api/snapshot`, { headers: H })).json()).usage.filter((u) => u.sessionId === sid).map((u) => `${u.source} tokens=${u.totalTokens} est=$${u.costEstimateUsd} (${u.costBasis})`).join("; "));

await post(`/api/sessions/${sid}/end`, {});
await until(() => ["ended", "cancelled"].includes(state.sessions.get(sid).runtimeState), 30000, "session end");
check("session ended cleanly", true, state.sessions.get(sid).runtimeState);
ac.abort();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
