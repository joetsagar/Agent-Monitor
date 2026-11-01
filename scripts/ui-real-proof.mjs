// REAL vertical slice through the browser UI: starts a managed session with
// the New session form, then answers a question, approves one command and
// denies another by clicking in the page. Costs a small amount of usage.
// Usage: node scripts/ui-real-proof.mjs <outDir> [model]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2];
const model = process.argv[3] ?? "haiku";
mkdirSync(out, { recursive: true });
const sandbox = join(root, "data", "sandbox-ui");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
const token = readFileSync(join(root, "data", "token"), "utf8").trim();
const api = async (p) => (await fetch("http://127.0.0.1:4317" + p, { headers: { "x-agent-monitor-token": token } })).json();

const proc = spawn("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", ["--headless", "--disable-gpu", "--remote-debugging-port=9335", `--user-data-dir=${join(out, "prof-real")}`, "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 40; i++) { try { targets = await (await fetch("http://127.0.0.1:9335/json")).json(); break; } catch { await sleep(250); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const waiting = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (x) => (await cdp("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result.result?.value;
const type = async (selector, text) => { await ev(`document.querySelector(${JSON.stringify(selector)}).focus()`); await cdp("Input.insertText", { text }); };
const shot = async (n) => writeFileSync(join(out, n), Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
const until = async (expr, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return; await sleep(500); } throw new Error("timeout: " + what); };
const clickButton = (re, scope = "document") => ev(`(() => { const b=[...${scope}.querySelectorAll('button')].find(b=>${re}.test(b.textContent.trim()) && !b.disabled); if(!b) return false; b.click(); return true; })()`);
const t0 = Date.now();
const results = [];
const check = (n, ok, info = "") => { results.push(ok); console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ok ? "PASS" : "FAIL", n, info); };
const drawerText = () => ev(`document.querySelector('.drawer')?.innerText ?? ''`);

await cdp("Page.enable");
await cdp("Page.navigate", { url: "http://127.0.0.1:4317/" });
await until(`/Live/.test(document.body.innerText)`, 15000, "connected");
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Overview').click()`); // app opens on Live activity

// 1. Start the session from the UI form.
await clickButton("/^New session$/");
await sleep(300);
await ev(`(() => { const i=document.querySelector("form input[type=text]"); i.focus(); i.select(); })()`); // replace the pre-filled root
await cdp("Input.insertText", { text: sandbox });
await type("form textarea", "Step 1: use the AskUserQuestion tool to ask me which filename to use, offering exactly the options 'alpha.txt' and 'beta.txt'. Step 2: use the Bash tool to run exactly: echo hello > <chosen filename>. Step 3: use the Bash tool to run exactly: rm <chosen filename>. If a step is denied, do not retry it or try alternatives; finish with one sentence saying what happened.");
await ev(`(() => { const m=[...document.querySelectorAll('form input[type=text]')][1]; m.focus(); m.select(); })()`);
await cdp("Input.insertText", { text: model });
await ev(`(() => { const c=document.querySelector('form input[type=checkbox]'); if (c.checked) c.click(); })()`); // keep the proof independent of user settings
console.log("form before start:", await ev(`JSON.stringify([...document.querySelectorAll('form input, form textarea')].map(e=>e.type+'='+(e.type==='checkbox'?e.checked:e.value.slice(0,40))))`));
console.log("start clicked:", await clickButton("/^Start session$/", "document.querySelector('form')"));
await sleep(2000);
await shot("real-after-start.png");
const before = Date.now();
await until(`[...document.querySelectorAll('.row-btn')].some(b=>/Question/.test(b.textContent) && /sandbox-ui/.test(b.textContent))`, 120000, "question in Needs you");
check("session started from the UI; question appears in Needs you", true);
const sess = (await api("/api/snapshot")).sessions.filter((s) => s.cwd === sandbox && s.startedAt >= before - 5000).sort((a, b) => b.startedAt - a.startedAt)[0];
check("runtime-reported model and auth", !!sess?.model && sess.authSource === "none", `${sess?.model} auth=${sess?.authSource}`);

// 2. Answer the question in the drawer.
await ev(`[...document.querySelectorAll('.row-btn')].find(b=>/Question/.test(b.textContent) && /sandbox-ui/.test(b.textContent)).click()`);
await until(`!!document.querySelector('.drawer input[type=radio]')`, 10000, "question form");
await ev(`(() => { const r=[...document.querySelectorAll('.drawer input[type=radio]')].find(r=>/beta/.test(r.closest('label')?.textContent ?? '')); r.click(); })()`);
await shot("real-question.png");
await clickButton("/^Send answers$/", "document.querySelector('.drawer')");
await until(`/agent continued/i.test(document.querySelector('.drawer')?.innerText ?? '')`, 60000, "question resumed in UI");
check("question: UI shows Agent continued (runtime-confirmed)", true);
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

// 3. Approve the first command.
const permRow = `[...document.querySelectorAll('.row-btn')].find(b=>/Permission/.test(b.textContent) && /sandbox-ui/.test(b.textContent))`;
await until(`!!${permRow}`, 120000, "permission 1");
await ev(`${permRow}.click()`);
await until(`/Approve once/.test(document.querySelector('.drawer')?.innerText ?? '')`, 10000, "permission drawer");
const p1 = await drawerText();
check("permission 1 shows the exact command with the chosen answer", /echo hello > beta\.txt/.test(p1));
await shot("real-permission.png");
await clickButton("/^Approve once$/", "document.querySelector('.drawer')");
// The drawer can also show the earlier, already-answered question, so wait on this request's own panel.
await until(`[...document.querySelectorAll('.drawer section.ix')].some(x=>/echo hello > beta\.txt/.test(x.innerText) && /agent continued/i.test(x.innerText))`, 60000, "approve resumed");
check("approve: this request's panel shows Agent continued; file exists", existsSync(join(sandbox, "beta.txt")));
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

// 4. Deny the second command with a reason.
await until(`!!${permRow}`, 120000, "permission 2");
await ev(`${permRow}.click()`);
await until(`/rm beta\\.txt/.test(document.querySelector('.drawer')?.innerText ?? '')`, 10000, "permission 2 drawer");
await type(".drawer label input[type=text]", "Keep the file.");
await clickButton("/^Deny$/", "document.querySelector('.drawer')");
await until(`[...document.querySelectorAll('.drawer section.ix')].some(x=>/rm beta\.txt/.test(x.innerText) && /agent continued/i.test(x.innerText))`, 60000, "deny resumed");
check("deny: UI shows Agent continued; file was kept", existsSync(join(sandbox, "beta.txt")));
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

// 5. Turn ends: review appears, and server state agrees with the UI.
let snap;
for (let i = 0; i < 120; i++) { snap = await api("/api/snapshot"); if (snap.interactions.some((x) => x.sessionId === sess.id && x.kind === "review" && x.status === "pending")) break; await sleep(1000); }
const ix = snap.interactions.filter((i) => i.sessionId === sess.id);
check("server: question + 2 permissions resumed, 1 review pending", ix.filter((i) => i.status === "resumed").length === 3 && ix.some((i) => i.kind === "review" && i.status === "pending"), ix.map((i) => `${i.kind}:${i.status}`).join(", "));
await shot("real-overview.png");
await fetch(`http://127.0.0.1:4317/api/sessions/${sess.id}/end`, { method: "POST", headers: { "x-agent-monitor-token": token, origin: "http://127.0.0.1:4317" } });
ws.close(); proc.kill();
console.log(`\n${results.filter(Boolean).length}/${results.length} real UI checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
