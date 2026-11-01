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
await cdp("Page.navigate", { url: "http://127.0.0.1:4317/?demo=1" });
await sleep(3000);
// Open the request tray in the live-only interface.
await ev(`document.querySelector('.needs-btn')?.click()`);
await sleep(500);

// Open the simulated question from Needs-you.
const opened = await ev(`(() => { const b=[...document.querySelectorAll('.row-btn')].find(b=>b.textContent.includes('Question')); if(!b) return false; b.focus(); b.click(); return true; })()`);
check("needs-you question row opens drawer", opened && await ev(`!!document.querySelector('.drawer')`));
await sleep(500);
check("focus moved into drawer", await ev(`document.querySelector('.drawer').contains(document.activeElement)`), await ev(`document.activeElement.outerHTML.slice(0,80)`));
const form = await ev(`(() => { const d=document.querySelector('.drawer'); return { radios: d.querySelectorAll('input[type=radio]').length, checks: d.querySelectorAll('input[type=checkbox]').length, text: d.innerText.slice(0,400) }; })()`);
check("single-select uses radios, multi-select uses checkboxes", form.radios > 0 && form.checks > 0, `radios=${form.radios} checks=${form.checks}`);
await shot("drawer-question.png");

// Submit with nothing selected must not send.
const sendDisabled = await ev(`(() => { const b=[...document.querySelectorAll('.drawer button')].find(b=>/^send/i.test(b.textContent.trim())); return b ? b.disabled : null; })()`);
check("Send disabled until all questions are answered", sendDisabled === true, String(sendDisabled));

// Answer: pick first radio and first checkbox, send, watch statuses.
await ev(`(() => { const d=document.querySelector('.drawer'); d.querySelector('input[type=radio]').click(); d.querySelector('input[type=checkbox]').click(); })()`);
await sleep(200);
await ev(`[...document.querySelectorAll('.drawer button')].find(b=>/^send/i.test(b.textContent.trim())).click()`);
await sleep(150);
const sending = await ev(`document.querySelector('.drawer').innerText`);
check("shows Sending while in flight and blocks a second click", /sending/i.test(sending) && await ev(`!![...document.querySelectorAll('.drawer button')].find(b=>/send/i.test(b.textContent)&&b.disabled) || !/^send$/im.test(document.querySelector('.drawer').innerText)`));
let seen = "";
for (let i = 0; i < 20; i++) { await sleep(500); const t = await ev(`document.querySelector('.drawer').innerText`); if (/delivered/i.test(t)) seen += "D"; if (/agent continued|resumed/i.test(t)) { seen += "R"; break; } }
check("progresses Delivered then Agent continued", seen.includes("D") && seen.endsWith("R"), seen);
await shot("drawer-question-resumed.png");

// Escape closes and focus returns.
await key("Escape", "Escape");
await sleep(300);
check("Esc closes drawer", !(await ev(`!!document.querySelector('.drawer')`)));
check("focus returns to opener, or to main when the opener is gone", await ev(`(() => { const a=document.activeElement; return !!a && a !== document.body && (a.classList.contains('row-btn') || a.tagName==='MAIN'); })()`), await ev(`document.activeElement?.className`));

// Permission: exact command, Approve once + session scope as secondary.
await ev(`[...document.querySelectorAll('.row-btn')].find(b=>b.textContent.includes('Permission')).click()`);
await sleep(500);
const perm = await ev(`document.querySelector('.drawer').innerText`);
check("permission shows command, cwd, Approve once, Deny", /node scripts\/migrate\.js/.test(perm) && /approve once/i.test(perm) && /deny/i.test(perm) && /working dir/i.test(perm));
await shot("drawer-permission.png");
// Failure path preserves the draft: type a deny reason containing "fail".
await ev(`document.querySelector('.drawer label input[type=text]').focus()`);
await cdp("Input.insertText", { text: "please fail this" });
await sleep(200);
console.log("  typed value:", await ev(`document.querySelector('.drawer label input[type=text]')?.value`));
await ev(`[...document.querySelectorAll('.drawer button')].find(b=>/^deny/i.test(b.textContent.trim())).click()`);
let sawFailed = false, kept;
for (let i = 0; i < 30; i++) {
  await sleep(300);
  const t = await ev(`document.querySelector('.drawer')?.innerText ?? ''`);
  if (/simulated delivery failure/i.test(t)) sawFailed = true;
  kept = await ev(`document.querySelector('.drawer label input[type=text]')?.value`);
  if (sawFailed && kept !== undefined) break;
}
const failText = sawFailed ? "failed" : "";
check("failed delivery is shown and the draft is kept", /fail/i.test(failText) && kept === "please fail this", `draft=${kept}`);
await key("Escape", "Escape");

// Keyboard: Tab through the page shows a visible focus ring.
await ev(`document.body.focus()`);
await key("Tab", "Tab"); await key("Tab", "Tab");
const outline = await ev(`(() => { const s=getComputedStyle(document.activeElement); return s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor; })()`);
check("keyboard focus is visible", !/none/.test(outline) && !/ 0px/.test(outline), outline);

// Live activity view + narrow width.
// Live activity is the only view.
await sleep(800);
await shot("live-activity.png");
await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
// Remain in the live-only view.
await sleep(600);
check("no horizontal scroll at 390px", await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`), await ev(`document.documentElement.scrollWidth + ' vs ' + window.innerWidth`));
await shot("narrow.png");

ws.close(); proc.kill();
console.log(`\n${results.filter(Boolean).length}/${results.length} UI checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
