import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { APP_ROOT, loadConfig, loadToken } from "./config.ts";
import { openDb } from "./db.ts";
import { Store } from "./store.ts";
import { HooksAdapter } from "./hooks-adapter.ts";
import { CodexAdapter } from "./codex-adapter.ts";
import { WidgetUsageService } from "./widget-usage.ts";
import { ApiError, ManagedAdapter } from "./managed-adapter.ts";
import type { InteractionResponse, StartSessionRequest } from "../shared/types.ts";

const cfg = loadConfig();
const token = loadToken(cfg.dataDir);
const db = openDb(cfg.dataDir);
const store = new Store(db, {
  startedAt: Date.now(), version: "0.1.0", billingMode: cfg.billingMode, managedSessionsEnabled: true,
  hooksEventsReceived: 0, lastHookEventAt: null, staleAfterMs: cfg.staleAfterMs, aiSummaries: false,
});
const hooks = new HooksAdapter(store, cfg);
const managed = new ManagedAdapter(store, cfg);
managed.reconcileOnStartup();
const codex = new CodexAdapter(store, cfg);
const widgetUsage = new WidgetUsageService();

const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);
const allowedOrigins = new Set([`http://127.0.0.1:${cfg.port}`, `http://localhost:${cfg.port}`, "http://127.0.0.1:5173", "http://localhost:5173"]);
const webDist = join(APP_ROOT, "web", "dist");
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2" };

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 2_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new ApiError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (n === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ApiError(400, "invalid JSON"); }
}

// DNS-rebinding and cross-site protection. Every request must target a
// loopback host name; browsers must send an allowed Origin on writes.
function checkRequest(req: IncomingMessage, write: boolean, url: URL): void {
  // Vite's dev proxy rewrites Host to the target; Origin is still checked below.
  if (!allowedHosts.has(String(req.headers.host ?? ""))) throw new ApiError(403, "host not allowed");
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) throw new ApiError(403, "origin not allowed");
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none" && !(origin && allowedOrigins.has(origin))) throw new ApiError(403, "cross-site request blocked");
  const needsToken = write || url.pathname.startsWith("/api/") && url.pathname !== "/api/bootstrap" && url.pathname !== "/api/health";
  if (needsToken) {
    const t = String(req.headers["x-agent-monitor-token"] ?? url.searchParams.get("token") ?? "");
    if (!t || !safeEq(t, token)) throw new ApiError(401, "missing or invalid token");
  }
}

const sseClients = new Set<ServerResponse>();
store.subscribe((m) => {
  const line = `data: ${JSON.stringify(m)}\n\n`;
  for (const c of sseClients) c.write(line);
});
setInterval(() => { for (const c of sseClients) c.write(": ping\n\n"); }, 20_000).unref();
setInterval(() => store.refreshStale(), 30_000).unref();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";
  const write = method !== "GET" && method !== "HEAD";
  try {
    checkRequest(req, write, url);
    const p = url.pathname;

    if (p === "/api/health") return send(res, 200, { ok: true, startedAt: store.server.startedAt });
    if (p === "/api/bootstrap" && method === "GET") {
      // Only readable same-origin: no CORS headers are ever sent.
      return send(res, 200, { token, port: cfg.port, allowedRoots: cfg.allowedRoots, defaultModel: cfg.defaultModel, billingMode: cfg.billingMode });
    }
    if (p === "/api/stream" && method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      store.refreshStale();
      res.write(`retry: 2000\ndata: ${JSON.stringify({ type: "snapshot", data: store.snapshot() })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (p === "/api/snapshot" && method === "GET") return send(res, 200, store.snapshot());
    if (p === "/api/widget-usage" && method === "GET") return send(res, 200, widgetUsage.getSnapshot());
    if (p === "/api/widget-usage/refresh" && method === "POST") {
      if (process.env.AGENT_MONITOR_WIDGET_USAGE_ENABLED !== "0") void widgetUsage.refresh();
      return send(res, 202, widgetUsage.getSnapshot());
    }
    if (p === "/api/hooks" && method === "POST") {
      const body = await readBody(req);
      const sid = body?.payload?.session_id;
      // A managed session that also loads user hooks must not appear twice.
      if (typeof sid === "string" && managed.isManagedRuntimeSession(sid)) return send(res, 202, { accepted: true, ignored: "managed session" });
      return send(res, 202, hooks.ingest(body));
    }
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/api\/agents\/([^/]+)\/events$/)) && method === "GET") {
      const id = decodeURIComponent(m[1]);
      if (!store.agents.has(id)) throw new ApiError(404, "agent not found");
      return send(res, 200, store.eventsForAgent(id, Math.min(Number(url.searchParams.get("limit") ?? 300), 2000), url.searchParams.get("children") === "1"));
    }
    if ((m = p.match(/^\/api\/interactions\/([^/]+)\/respond$/)) && method === "POST") {
      const body = await readBody(req) as { response: InteractionResponse; clientRequestId?: string };
      return send(res, 200, managed.respond(decodeURIComponent(m[1]), body.response, body.clientRequestId));
    }
    if (p === "/api/sessions" && method === "POST") {
      return send(res, 201, managed.start(await readBody(req) as StartSessionRequest));
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/(message|cancel|end)$/)) && method === "POST") {
      const sid = decodeURIComponent(m[1]);
      if (m[2] === "message") managed.sendMessage(sid, (await readBody(req)).text);
      else if (m[2] === "cancel") await managed.cancel(sid);
      else managed.end(sid);
      return send(res, 202, { ok: true, session: store.sessions.get(sid) });
    }
    if ((m = p.match(/^\/api\/projects\/([^/]+)$/)) && method === "PATCH") {
      const b = await readBody(req);
      const patch: { name?: string; objective?: string | null } = {};
      if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim().slice(0, 120);
      if (b.objective === null || typeof b.objective === "string") patch.objective = b.objective ? String(b.objective).slice(0, 2000) : null;
      const out = store.updateProject(decodeURIComponent(m[1]), patch);
      return out ? send(res, 200, out) : send(res, 404, { error: "project not found" });
    }
    if (p === "/api/shutdown" && method === "POST") {
      send(res, 202, { ok: true });
      return shutdown();
    }
    if (p.startsWith("/api/")) throw new ApiError(404, "not found");

    // Static UI (built). Paths are confined to web/dist.
    if (method !== "GET") throw new ApiError(405, "method not allowed");
    if (!existsSync(webDist)) {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("UI not built. Run: npm run build (or npm run dev for the Vite dev server on :5173)");
    }
    let file = resolve(webDist, "." + decodeURIComponent(p));
    if (!file.startsWith(webDist + sep) && file !== webDist) throw new ApiError(403, "forbidden");
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDist, "index.html");
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream", "x-content-type-options": "nosniff",
      "cache-control": extname(file) === ".html" ? "no-store" : "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      "x-frame-options": "DENY", "referrer-policy": "no-referrer",
    });
    res.end(readFileSync(file));
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
});

const pidFile = join(cfg.dataDir, "server.pid");
server.listen(cfg.port, cfg.host, () => {
  codex.start();
  if (process.env.AGENT_MONITOR_WIDGET_USAGE_ENABLED !== "0") widgetUsage.start();
  writeFileSync(pidFile, String(process.pid));
  console.log(`Agent Monitor listening on http://${cfg.host}:${cfg.port}  (billing mode: ${cfg.billingMode}; data: ${cfg.dataDir})`);
});

function shutdown() {
  codex.stop();
  widgetUsage.stop();
  console.log("Shutting down; ending managed runtime processes");
  managed.shutdown();
  try { unlinkSync(pidFile); } catch { /* already gone */ }
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
