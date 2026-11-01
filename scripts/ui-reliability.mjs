// REAL reliability checks through the browser: reload with a pending request,
// connection loss during response delivery, and backend restart reconnect.
// Usage: node scripts/ui-reliability.mjs <outDir> [model]   (small usage)
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2];
const model = process.argv[3] ?? "haiku";
const base = "http://127.0.0.1:4317";
const token = readFileSync(join(root, "data", "token"), "utf8").trim();
const H = { "x-agent-monitor-token": token, "content-type": "application/json", origin: base };
const api = async (p, body) => (await fetch(base + p, body === undefined ? { headers: H } : { method: "POST", headers: H, body: JSON.stringify(body) })).json();
const sandbox = join(root, "data", "sandbox-reliability");
mkdirSync(sandbox, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const results = [];
const check = (n, ok, info = "") => { results.push(ok); console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ok ? "PASS" : "FAIL", n, info); };

const edge = spawn("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", ["--headless", "--disable-gpu", "--remote-debugging-port=9337", `--user-data-dir=${join(out, "prof-rel")}`, "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 40; i++) { try { targets = await (await fetch("http://127.0.0.1:9337/json")).json(); break; } catch { await sleep(250); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const waiting = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (x) => (await cdp("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result.result?.value;
const until = async (expr, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await sleep(400); } throw new Error("timeout: " + what); };
const offline = (on) => cdp("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
const header = () => ev(`document.querySelector('header, .top')?.innerText ?? ''`);

await cdp("Page.enable");
await cdp("Network.enable");
await cdp("Page.navigate", { url: base + "/" });
await until(`/Live/.test(document.body.innerText)`, 15000, "connected");
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Overview').click()`); // app opens on Live activity

const s = await api("/api/sessions", { projectPath: sandbox, model, loadSettings: false, title: "Reliability check",
  prompt: "Use the AskUserQuestion tool to ask me which colour I prefer, offering exactly the options 'red' and 'blue'. Then reply with one sentence naming my choice and stop." });
const row = `[...document.querySelectorAll('.row-btn')].find(b=>/Question/.test(b.textContent) && /sandbox-reliability/.test(b.textContent))`;
await until(`!!${row}`, 120000, "question row");
const ixId = (await api("/api/snapshot")).interactions.find((i) => i.sessionId === s.id && i.kind === "question").id;

// 1. Reload keeps the pending request.
await cdp("Page.reload");
await sleep(1500);
await until(`/Live/.test(document.body.innerText)`, 15000, "reconnected after reload");
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Overview').click()`);
await sleep(300);
check("reload: pending question still listed in Needs you", await ev(`!!${row}`));

// 2. Connection loss during delivery.
await ev(`${row}.click()`);
await until(`!!document.querySelector('.drawer input[type=radio]')`, 10000, "question form");
await ev(`[...document.querySelectorAll('.drawer input[type=radio]')].find(r=>/blue/.test(r.closest('label')?.textContent ?? '')).click()`);
await offline(true);
await ev(`[...document.querySelectorAll('.drawer button')].find(b=>/^Send answers$/.test(b.textContent.trim())).click()`);
await until(`/network error/i.test(document.querySelector('.drawer')?.innerText ?? '')`, 15000, "network error shown");
check("offline send: UI shows a network error, nothing claimed delivered", !/agent continued|delivered to runtime/i.test(await ev(`document.querySelector('.drawer').innerText`)));
check("offline send: selection kept", await ev(`[...document.querySelectorAll('.drawer input[type=radio]')].some(r=>r.checked && /blue/.test(r.closest('label')?.textContent ?? ''))`));
// Network emulation blocks new requests but does not cut an already-open event stream,
// so the header correctly stays Live here; a real outage is checked in step 3.
check("server: request still pending (nothing was delivered)", (await api("/api/snapshot")).interactions.find((i) => i.id === ixId).status === "pending");
await offline(false);
await until(`/Live/.test(document.querySelector('header, .top')?.innerText ?? '')`, 20000, "live again");
await ev(`[...document.querySelectorAll('.drawer button')].find(b=>/^Send answers$/.test(b.textContent.trim())).click()`);
await until(`/agent continued/i.test(document.querySelector('.drawer')?.innerText ?? '')`, 60000, "resumed after retry");
const lead = encodeURIComponent(`${s.id}/lead`);
const answered = (await api(`/api/agents/${lead}/events?limit=200`)).filter((e) => e.kind === "interaction_answered").length;
check("retry after reconnect: delivered once, agent continued", answered === 1 && (await api("/api/snapshot")).interactions.find((i) => i.id === ixId).status === "resumed", `answers recorded=${answered}`);

// 3. Backend restart: browser reconnects and reconciles.
for (let i = 0; i < 60; i++) { const snap = await api("/api/snapshot"); if (snap.sessions.find((x) => x.id === s.id)?.runtimeState === "idle") break; await sleep(1000); }
await api(`/api/sessions/${s.id}/end`, {});
await sleep(1500);
await fetch(base + "/api/shutdown", { method: "POST", headers: H });
await sleep(2500);
check("backend down: header shows Reconnecting", /reconnecting/i.test(await header()));
spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "start.ps1"), "-NoBrowser"], { stdio: "ignore" });
await until(`/Live/.test(document.querySelector('header, .top')?.innerText ?? '')`, 30000, "live after restart");
await sleep(1000);
check("backend restarted: header Live again and snapshot reloaded", await ev(`[...document.querySelectorAll('option')].some(o=>/sandbox-reliability/.test(o.textContent))`));
const after = await api("/api/snapshot");
check("after restart: the answered request stays resumed (not re-opened)", after.interactions.find((i) => i.id === ixId).status === "resumed");

ws.close(); edge.kill();
console.log(`\n${results.filter(Boolean).length}/${results.length} reliability checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
