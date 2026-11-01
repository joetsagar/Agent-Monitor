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
await cdp("Emulation.setDeviceMetricsOverride", {width:1240,height:820,deviceScaleFactor:1,mobile:false});
await cdp("Page.navigate", {url:"http://127.0.0.1:4317/?demo=1"});
await sleep(1000);
await ev(`localStorage.removeItem('agent-monitor-cleared-v1'); location.reload()`);
await sleep(1200);
check("live view renders without navigation", await ev(`!!document.querySelector('.stk') && !Array.from(document.querySelectorAll('button')).some(b=>/^(Overview|New session)$/.test(b.textContent.trim()))`));
check("all three usage providers present", await ev(`document.querySelectorAll('.usage-provider').length===3`));
check("four account limit bars", await ev(`document.querySelectorAll('.usage-track').length===4`));
check("Kilo is tokens-only", await ev(`document.querySelector('.provider-kilo').textContent.includes('tokens over the last 7 days') && !document.querySelector('.provider-kilo .usage-track')`));
check("usage stays to right of live activity", await ev(`document.querySelector('.usage-sidebar').getBoundingClientRect().left >= document.querySelector('.monitor-column').getBoundingClientRect().right`));
check("no horizontal overflow at 1240px", await ev(`document.documentElement.scrollWidth<=innerWidth+1`));
await shot('desktop-live-demo.png');
await ev(`document.querySelector('.needs-btn').click()`);
check("requests available directly from live", await ev(`!!document.querySelector('#pending-requests .row-btn') && !!document.querySelector('.stk')`));
await ev(`Array.from(document.querySelectorAll('#pending-requests .row-btn')).find(b=>b.textContent.includes('Question')).click()`);
await sleep(300);
check("live request opens question drawer", await ev(`!!document.querySelector('.drawer input[type=radio]') && !!document.querySelector('.drawer input[type=checkbox]')`));
await key('Escape','Escape');
await sleep(200);
check("Escape closes drawer", await ev(`!document.querySelector('.drawer')`));
await ev(`document.querySelector('.needs-btn').click()`);
const before = await ev(`document.querySelectorAll('.stk-pane').length`);
await ev(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith('Clear finished')).click()`);
await sleep(150);
check("clear finished hides eligible sessions and preserves active panels", await ev(`document.querySelectorAll('.stk-pane').length > 0 && Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith('Clear finished')).disabled && Array.from(document.querySelectorAll('button')).some(b=>b.textContent.startsWith('Show cleared'))`));
await ev(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith('Show cleared')).click()`);
await sleep(150);
check("show cleared restores panels", await ev(`document.querySelectorAll('.stk-pane').length`)===before);
await cdp("Emulation.setDeviceMetricsOverride", {width:390,height:900,deviceScaleFactor:1,mobile:false});
await sleep(200);
check("narrow layout has no horizontal overflow", await ev(`document.documentElement.scrollWidth<=innerWidth+1`));
check("sidebar moves below on small screens", await ev(`document.querySelector('.usage-sidebar').getBoundingClientRect().top >= document.querySelector('.monitor-column').getBoundingClientRect().bottom -1`));
await shot('desktop-narrow.png');
await cdp("Emulation.setDeviceMetricsOverride", {width:1240,height:820,deviceScaleFactor:1,mobile:false});
await cdp("Page.navigate", {url:"http://127.0.0.1:4317/"});
await sleep(1500);
const usage=await ev(`(async()=>{const b=await(await fetch('/api/bootstrap')).json();const u=await(await fetch('/api/widget-usage',{headers:{'x-agent-monitor-token':b.token}})).json();return u.providers.map(p=>({id:p.id,status:p.status,rows:p.rows.length}));})()`);
check("real usage readers returned allowance rows", Array.isArray(usage)&&usage.every(p=>p.status==='ok'&&p.rows>0),JSON.stringify(usage));
check("live sidebar is not simulated", await ev(`document.querySelector('.usage-sidebar').innerText.includes('Account limits') && !document.querySelector('.usage-sidebar').innerText.includes('Simulated')`));
await shot('desktop-live-real.png');
ws.close();proc.kill();
console.log(`${results.filter(Boolean).length}/${results.length} desktop UI checks passed`);
process.exit(results.every(Boolean)?0:1);
