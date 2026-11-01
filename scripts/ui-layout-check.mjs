// Drives a headless Edge over the DevTools protocol to check interactive UI
// behaviour in demo mode (no server writes, no model calls).
// Usage: node scripts/ui-check.mjs <outDir>
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const proc = spawn(edge, ["--headless", "--disable-gpu", "--remote-debugging-port=9333", `--user-data-dir=${join(out, "prof")}`, "--window-size=1400,1000", "about:blank"], { stdio: "ignore", windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 40; i++) { try { targets = await (await fetch("http://127.0.0.1:9333/json")).json(); break; } catch { await sleep(250); } }
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const waiting = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expr) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
const shot = async (name) => writeFileSync(join(out, name), Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
const key = async (k, code) => { for (const type of ["keyDown", "keyUp"]) await cdp("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: { Tab: 9, Escape: 27, Enter: 13 }[k] }); };
const results = [];
const check = (n, ok, info = "") => { results.push(ok); console.log(ok ? "PASS" : "FAIL", n, info); };


await cdp("Page.enable");
await cdp("Page.navigate", {url:"http://127.0.0.1:4317/?demo=1"});
await sleep(2000);
// Live activity is the only view.
await sleep(700);
check("worker panels rendered", await ev(`document.querySelectorAll('.stk-workers .stk-pane').length > 0`));
check("independent worker borders", await ev(`Array.from(document.querySelectorAll('.stk-workers .stk-pane')).every(p=>getComputedStyle(p).borderTopStyle==='solid')`));
check("no CSS text clamping", await ev(`Array.from(document.querySelectorAll('.stk-clamp')).every(p=>getComputedStyle(p).webkitLineClamp==='none')`));
check("no title ellipsis", await ev(`Array.from(document.querySelectorAll('.stk-name,.stk-meta')).every(p=>getComputedStyle(p).textOverflow!=='ellipsis')`));
check("wide layout no horizontal overflow", await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
await shot("live-wide.png");
await cdp("Emulation.setDeviceMetricsOverride", {width:800,height:1000,deviceScaleFactor:1,mobile:false});
await sleep(400);
check("800px keeps two worker columns", await ev(`Array.from(document.querySelectorAll('.stk-workers')).every(p=>getComputedStyle(p).gridTemplateColumns.split(' ').length===2)`));
await shot("live-800.png");
await cdp("Emulation.setDeviceMetricsOverride", {width:390,height:900,deviceScaleFactor:1,mobile:false});
await sleep(400);
check("390px workers stack", await ev(`Array.from(document.querySelectorAll('.stk-workers')).every(p=>getComputedStyle(p).gridTemplateColumns.split(' ').length===1)`));
check("compact worker logs", await ev(`Array.from(document.querySelectorAll('.stk-workers .stk-log')).every(p=>p.getBoundingClientRect().height <= 111)`));
check("390px no horizontal overflow", await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
await shot("live-narrow.png");
ws.close();proc.kill();
console.log(`${results.filter(Boolean).length}/${results.length} layout checks passed`);
process.exit(results.every(Boolean)?0:1);
