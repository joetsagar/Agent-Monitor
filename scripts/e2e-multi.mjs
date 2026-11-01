// Real multi-agent check: a worker's permission request must be attributed to
// the worker; usage across two turns must not be double counted; the session
// keeps working with no browser (SSE) client connected.
// Usage: node scripts/e2e-multi.mjs [model]   (costs a small amount of usage)
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = "http://127.0.0.1:4317";
const token = readFileSync(join(root, "data", "token"), "utf8").trim();
const H = { "content-type": "application/json", "x-agent-monitor-token": token, origin: base };
const sandbox = join(root, "data", "sandbox-multi");
mkdirSync(sandbox, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const results = [];
const check = (n, ok, info = "") => { results.push(ok); log(ok ? "PASS" : "FAIL", n, info); };
const snap = async () => (await fetch(`${base}/api/snapshot`, { headers: H })).json();
const post = async (p, b) => { const r = await fetch(base + p, { method: "POST", headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const poll = async (fn, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { const s = await snap(); const v = fn(s); if (v) return [v, s]; await new Promise((r) => setTimeout(r, 1000)); } throw new Error("timeout: " + what); };

// No SSE client is connected during this script: polling snapshots only.
const s = (await post("/api/sessions", { projectPath: sandbox, model: process.argv[2] ?? "haiku", loadSettings: false, title: "Multi-agent proof",
  prompt: "Use the Agent tool exactly once with subagent_type 'general-purpose' and description 'Write marker file'. Tell the subagent to use the Bash tool to run exactly: echo worker > marker.txt  and then report done. After it returns, reply with one short sentence." })).body;
const sid = s.id;
log("session", sid);
const [perm, s1] = await poll((x) => x.interactions.find((i) => i.sessionId === sid && i.kind === "permission" && i.status === "pending"), 180000, "worker permission");
const agent = s1.agents.find((a) => a.id === perm.agentId);
log("permission from agent", perm.agentId, agent?.role, perm.request.command);
check("worker permission attributed to the worker, not the lead", agent && agent.role !== "lead" && agent.parentAgentId === `${sid}/lead`, `${agent?.name} task=${agent?.assignedTask}`);
const r = await post(`/api/interactions/${perm.id}/respond`, { response: { type: "permission", decision: "approve", scope: "once" }, clientRequestId: "m1" });
check("approve delivered", r.body.status === "delivered");
const [, sMid] = await poll((x) => x.sessions.find((y) => y.id === sid && y.runtimeState === "idle") && x.agents.find((a) => a.id === perm.agentId), 120000, "lead idle");
const wMid = sMid.agents.find((a) => a.id === perm.agentId);
log("worker status when lead first idle:", wMid.status, "| reviews pending:", sMid.interactions.filter((i) => i.sessionId === sid && i.kind === "review" && i.status === "pending").length);
check("worker not shown completed merely because the launch call returned", wMid.status !== "completed" || sMid.events === undefined && wMid.lastResult && !/Async agent launched/.test(wMid.lastResult.text), wMid.lastResult?.text?.slice(0, 60));
const [, s2] = await poll((x) => { const a = x.agents.find((a) => a.id === perm.agentId); return a && (a.status === "completed" || a.status === "failed") && x.interactions.find((i) => i.sessionId === sid && i.kind === "review" && i.status === "pending"); }, 180000, "worker done + review");
const w = s2.agents.find((a) => a.id === perm.agentId);
check("worker finished with agent-reported result", w.status === "completed" && w.lastResult?.provenance === "agent-reported", w.lastResult?.text?.slice(0, 80));
check("interaction resumed", s2.interactions.find((i) => i.id === perm.id).status === "resumed");
const u1 = s2.usage.filter((u) => u.sessionId === sid);
log("usage after turn 1:", JSON.stringify(u1.map((u) => [u.source, u.totalTokens, u.costEstimateUsd, u.includedInParent])));
const ev1 = await (await fetch(`${base}/api/agents/${encodeURIComponent(sid + "/lead")}/events?limit=500`, { headers: H })).json();
const cost1 = ev1.find((e) => e.kind === "turn_end")?.detail?.total_cost_usd;
await post(`/api/sessions/${sid}/message`, { text: "Reply with just the word OK." });
await poll((x) => x.interactions.find((i) => i.sessionId === sid && i.kind === "review" && i.status === "pending" && !s2.interactions.some((o) => o.id === i.id)), 120000, "turn 2 end");
const ev2 = await (await fetch(`${base}/api/agents/${encodeURIComponent(sid + "/lead")}/events?limit=500`, { headers: H })).json();
const costs = ev2.filter((e) => e.kind === "turn_end").map((e) => e.detail?.total_cost_usd);
log("SDK total_cost_usd per result (newest first):", costs, "turn1 =", cost1);
check("SDK result cost is cumulative per process (so latest replaces, never summed)", costs.length >= 2 && costs.every((c, k) => k === 0 || costs[k - 1] > c), JSON.stringify(costs));
const s3 = await snap();
const sessUsage = s3.usage.filter((u) => u.sessionId === sid && !u.includedInParent);
check("one non-included usage record for the session", sessUsage.length === 1, JSON.stringify(sessUsage.map((u) => [u.id, u.totalTokens, u.costEstimateUsd])));
await post(`/api/sessions/${sid}/end`, {});
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
